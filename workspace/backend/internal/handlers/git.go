package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

const gitCommandTimeout = 10 * time.Second

type gitFileChange struct {
	Path      string `json:"path"`
	Status    string `json:"status"` // "M", "A", "D", "R", "?"
	Staged    bool   `json:"staged"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
}

type gitStatusResponse struct {
	Available bool            `json:"available"` // false when the dir is not a git repo
	Reason    string          `json:"reason,omitempty"`
	Dir       string          `json:"dir"`
	DirName   string          `json:"dir_name"`
	Branch    string          `json:"branch"`
	Commit    string          `json:"commit,omitempty"`
	Ahead     int             `json:"ahead"`
	Behind    int             `json:"behind"`
	Files     []gitFileChange `json:"files"`
	Additions int             `json:"additions"`
	Deletions int             `json:"deletions"`
}

func findGitRepoRoot() (string, bool) {
	wd, err := os.Getwd()
	if err != nil {
		return "", false
	}
	dir := wd
	for {
		if stat, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			_ = stat
			return dir, true
		}
		parent := filepath.Dir(dir)
		if parent == dir || parent == "" {
			break
		}
		dir = parent
	}
	return "", false
}

func getGitDirForRequest(c *gin.Context) (string, bool) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return "", false
	}

	// A channel's own binding wins when the caller names one. Git state belongs
	// to the project you are working in, not to whichever agent happens to be in
	// the room — an agent's WorkingDir is fixed at launch and is identical
	// across every channel it joins, which made every channel report the same
	// repository. Resolved server-side from the channel row so a client can
	// never point git at an arbitrary path.
	if channelRef := strings.TrimSpace(c.Query("channel")); channelRef != "" {
		var channel models.Channel
		if err := db.DB.Where("workspace_id = ? AND (id = ? OR name = ?)", workspace.ID, channelRef, channelRef).
			First(&channel).Error; err == nil && channel.WorkingDir != nil {
			dir := strings.TrimSpace(*channel.WorkingDir)
			if dir != "" {
				if stat, err := os.Stat(dir); err == nil && stat.IsDir() {
					return dir, true
				}
			}
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": "Channel is not bound to a valid working directory"})
		return "", false
	}

	agentName := strings.TrimSpace(c.Query("agent_name"))
	if agentName != "" {
		var member models.WorkspaceMember
		if err := db.DB.Where("workspace_id = ? AND agent_name = ?", workspace.ID, agentName).
			First(&member).Error; err == nil && member.WorkingDir != nil {
			dir := strings.TrimSpace(*member.WorkingDir)
			if dir != "" {
				if stat, err := os.Stat(dir); err == nil && stat.IsDir() {
					return dir, true
				}
			}
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": "Agent working directory not found or invalid"})
		return "", false
	}

	dir, found := findGitRepoRoot()
	if !found {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No git repository found for this workspace"})
		return "", false
	}

	return dir, true
}

func sanitizeGitFilePath(dir, p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" {
		return "", errors.New("file path cannot be empty")
	}

	// Prevent flag injection
	if strings.HasPrefix(p, "-") {
		return "", errors.New("file path cannot start with hyphen")
	}

	// Prevent path traversal
	if filepath.IsAbs(p) {
		return "", errors.New("absolute paths are not allowed")
	}

	cleanRel := filepath.ToSlash(filepath.Clean(p))
	if cleanRel == ".." || strings.HasPrefix(cleanRel, "../") || strings.Contains(cleanRel, "/../") {
		return "", errors.New("path traversal (..) is not allowed")
	}

	// Boundary check against working directory
	absTargetDir, err1 := filepath.Abs(dir)
	absFullPath, err2 := filepath.Abs(filepath.Join(dir, cleanRel))
	if err1 != nil || err2 != nil {
		return "", errors.New("invalid file path")
	}

	rel, err := filepath.Rel(absTargetDir, absFullPath)
	if err != nil || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return "", errors.New("file path is outside working directory")
	}

	return cleanRel, nil
}

func runGit(dir string, args ...string) (string, error) {
	return runGitTimeout(dir, gitCommandTimeout, args...)
}

// runGitTimeout is runGit with an explicit budget. Turn-change fingerprinting
// runs on the request path that dispatches work to an agent, so it needs a much
// tighter deadline than the interactive git endpoints.
func runGitTimeout(dir string, timeout time.Duration, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir

	var stdoutBuf, stderrBuf bytes.Buffer
	cmd.Stdout = &stdoutBuf
	cmd.Stderr = &stderrBuf

	err := cmd.Run()
	stdout := strings.TrimRight(stdoutBuf.String(), "\r\n")
	stderr := strings.TrimRight(stderrBuf.String(), "\r\n")

	if err != nil {
		if stderr != "" {
			return stdout, errors.New(stderr)
		}
		return stdout, err
	}
	return stdout, nil
}

// GitStatus handles GET /v1/git/status
func GitStatus(c *gin.Context) {
	dir, ok := getGitDirForRequest(c)
	if !ok {
		return
	}

	resp := gitStatusResponse{Dir: dir, DirName: filepath.Base(dir), Files: []gitFileChange{}}

	if _, err := runGit(dir, "rev-parse", "--is-inside-work-tree"); err != nil {
		resp.Available = false
		resp.Reason = "not a git repository"
		c.JSON(http.StatusOK, resp)
		return
	}
	resp.Available = true

	if branch, err := runGit(dir, "rev-parse", "--abbrev-ref", "HEAD"); err == nil {
		resp.Branch = branch
	}
	if commit, err := runGit(dir, "rev-parse", "--short", "HEAD"); err == nil {
		resp.Commit = commit
	}
	if counts, err := runGit(dir, "rev-list", "--left-right", "--count", "@{upstream}...HEAD"); err == nil {
		if parts := strings.Fields(counts); len(parts) == 2 {
			resp.Behind, _ = strconv.Atoi(parts[0])
			resp.Ahead, _ = strconv.Atoi(parts[1])
		}
	}

	lineStats := map[string][2]int{}
	for _, staged := range []bool{false, true} {
		args := []string{"diff", "--numstat"}
		if staged {
			args = append(args, "--cached")
		}
		out, err := runGit(dir, args...)
		if err != nil || out == "" {
			continue
		}
		for _, line := range strings.Split(out, "\n") {
			cols := strings.Split(line, "\t")
			if len(cols) < 3 {
				continue
			}
			adds, _ := strconv.Atoi(cols[0])
			dels, _ := strconv.Atoi(cols[1])
			prev := lineStats[cols[2]]
			lineStats[cols[2]] = [2]int{prev[0] + adds, prev[1] + dels}
		}
	}

	porcelain, err := runGit(dir, "status", "--porcelain=v1", "-z")
	if err != nil {
		c.JSON(http.StatusOK, resp)
		return
	}
	for _, record := range strings.Split(porcelain, "\x00") {
		if len(record) < 4 {
			continue
		}
		indexStatus := record[0:1]
		workStatus := record[1:2]
		path := record[3:]

		staged := indexStatus != " " && indexStatus != "?"
		letter := indexStatus
		if !staged {
			letter = workStatus
		}
		stats := lineStats[path]
		resp.Files = append(resp.Files, gitFileChange{
			Path:      path,
			Status:    strings.TrimSpace(letter),
			Staged:    staged,
			Additions: stats[0],
			Deletions: stats[1],
		})
		resp.Additions += stats[0]
		resp.Deletions += stats[1]
	}

	c.JSON(http.StatusOK, resp)
}

// GetGitStatus alias for GitStatus
var GetGitStatus = GitStatus

type GitBranchItem struct {
	Name      string `json:"name"`
	IsCurrent bool   `json:"is_current"`
	IsRemote  bool   `json:"is_remote"`
	Commit    string `json:"commit"`
	Subject   string `json:"subject"`
}

// ListGitBranches handles GET /v1/git/branches
func ListGitBranches(c *gin.Context) {
	dir, ok := getGitDirForRequest(c)
	if !ok {
		return
	}

	output, err := runGit(dir, "branch", "-a", "--format=%(HEAD)|%(refname)|%(refname:short)|%(objectname:short)|%(contents:subject)")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to list git branches: " + err.Error()})
		return
	}

	branches := []GitBranchItem{}
	currentBranch := ""

	if output != "" {
		lines := strings.Split(output, "\n")
		for _, line := range lines {
			parts := strings.SplitN(line, "|", 5)
			if len(parts) < 5 {
				continue
			}
			isHEAD := strings.TrimSpace(parts[0]) == "*"
			fullRef := strings.TrimSpace(parts[1])
			shortRef := strings.TrimSpace(parts[2])
			commitHash := strings.TrimSpace(parts[3])
			subject := strings.TrimSpace(parts[4])

			isRemote := strings.HasPrefix(fullRef, "refs/remotes/")

			if isHEAD {
				currentBranch = shortRef
			}

			branches = append(branches, GitBranchItem{
				Name:      shortRef,
				IsCurrent: isHEAD,
				IsRemote:  isRemote,
				Commit:    commitHash,
				Subject:   subject,
			})
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"current":  currentBranch,
		"branches": branches,
	})
}

type GitCommitItem struct {
	Hash        string `json:"hash"`
	ShortHash   string `json:"short_hash"`
	AuthorName  string `json:"author_name"`
	AuthorEmail string `json:"author_email"`
	Timestamp   int64  `json:"timestamp"`
	DateISO     string `json:"date_iso"`
	Subject     string `json:"subject"`
}

// GetGitLog handles GET /v1/git/log
func GetGitLog(c *gin.Context) {
	dir, ok := getGitDirForRequest(c)
	if !ok {
		return
	}

	limitStr := c.DefaultQuery("limit", "20")
	limit, err := strconv.Atoi(limitStr)
	if err != nil || limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}

	output, err := runGit(dir, "log", "-n", strconv.Itoa(limit), "--pretty=format:%H|%h|%an|%ae|%at|%s")
	if err != nil {
		c.JSON(http.StatusOK, gin.H{
			"commits": []GitCommitItem{},
			"error":   "No commits found: " + err.Error(),
		})
		return
	}

	commits := []GitCommitItem{}
	if output != "" {
		lines := strings.Split(output, "\n")
		for _, line := range lines {
			parts := strings.SplitN(line, "|", 6)
			if len(parts) < 6 {
				continue
			}
			ts, _ := strconv.ParseInt(parts[4], 10, 64)
			dateISO := time.Unix(ts, 0).Format(time.RFC3339)

			commits = append(commits, GitCommitItem{
				Hash:        parts[0],
				ShortHash:   parts[1],
				AuthorName:  parts[2],
				AuthorEmail: parts[3],
				Timestamp:   ts,
				DateISO:     dateISO,
				Subject:     parts[5],
			})
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"commits": commits,
	})
}

// GetGitDiff handles GET /v1/git/diff
func GetGitDiff(c *gin.Context) {
	dir, ok := getGitDirForRequest(c)
	if !ok {
		return
	}

	staged := c.Query("staged") == "true"
	filePath := c.Query("file")

	args := []string{"diff"}
	if staged {
		args = append(args, "--staged")
	}
	if filePath != "" {
		cleanPath, err := sanitizeGitFilePath(dir, filePath)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		args = append(args, "--", cleanPath)
	}

	output, err := runGit(dir, args...)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to get diff: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"diff":   output,
		"staged": staged,
		"file":   filePath,
	})
}

type stageRequest struct {
	Files []string `json:"files"`
	All   bool     `json:"all"`
}

// StageGitFiles handles POST /v1/git/stage
func StageGitFiles(c *gin.Context) {
	dir, ok := getGitDirForRequest(c)
	if !ok {
		return
	}

	var req stageRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if !req.All && len(req.Files) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No files specified to stage. Set 'all': true to stage all changes."})
		return
	}

	args := []string{"add"}
	if req.All {
		args = append(args, ".")
	} else {
		args = append(args, "--")
		for _, f := range req.Files {
			cleanPath, err := sanitizeGitFilePath(dir, f)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
				return
			}
			args = append(args, cleanPath)
		}
	}

	output, err := runGit(dir, args...)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to stage files: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"status": "ok",
		"output": output,
	})
}

// UnstageGitFiles handles POST /v1/git/unstage
func UnstageGitFiles(c *gin.Context) {
	dir, ok := getGitDirForRequest(c)
	if !ok {
		return
	}

	var req stageRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if !req.All && len(req.Files) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No files specified to unstage. Set 'all': true to unstage all changes."})
		return
	}

	args := []string{"restore", "--staged"}
	if req.All {
		args = append(args, ".")
	} else {
		args = append(args, "--")
		for _, f := range req.Files {
			cleanPath, err := sanitizeGitFilePath(dir, f)
			if err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
				return
			}
			args = append(args, cleanPath)
		}
	}

	output, err := runGit(dir, args...)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to unstage files: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"status": "ok",
		"output": output,
	})
}

type commitRequest struct {
	Message   string `json:"message" binding:"required"`
	AutoStage bool   `json:"auto_stage"`
}

// CreateGitCommit handles POST /v1/git/commit
func CreateGitCommit(c *gin.Context) {
	dir, ok := getGitDirForRequest(c)
	if !ok {
		return
	}

	var req commitRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Commit message is required"})
		return
	}

	message := strings.TrimSpace(req.Message)
	if message == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Commit message cannot be empty"})
		return
	}

	if req.AutoStage {
		if _, err := runGit(dir, "add", "."); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to auto-stage files: " + err.Error()})
			return
		}
	}

	// Prepare commit args. If git user identity is not configured on the host, provide a clean fallback.
	commitArgs := []string{"commit", "-m", message}
	if _, err := runGit(dir, "config", "user.name"); err != nil {
		commitArgs = []string{"-c", "user.name=52hzAgents", "-c", "user.email=bot@52hzagents.local", "commit", "-m", message}
	}

	output, err := runGit(dir, commitArgs...)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to commit: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"status": "ok",
		"output": output,
	})
}

// ---------------------------------------------------------------------------
// Remote operations
//
// These are the only git commands here that leave the machine, which changes
// two things: they need a much longer deadline than local plumbing, and they
// must never block on an interactive credential prompt — this runs inside a
// server process with no terminal attached, so a prompt would hang the request
// until the timeout instead of returning something the user can act on.
// ---------------------------------------------------------------------------

const gitNetworkTimeout = 60 * time.Second

func runGitNet(dir string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), gitNetworkTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	// GIT_TERMINAL_PROMPT=0 makes git fail with "could not read Username" rather
	// than waiting forever; the empty ASKPASS vars stop any GUI helper from
	// popping a dialog on the server's desktop.
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=", "SSH_ASKPASS=")

	var stdoutBuf, stderrBuf bytes.Buffer
	cmd.Stdout = &stdoutBuf
	cmd.Stderr = &stderrBuf

	err := cmd.Run()
	stdout := strings.TrimRight(stdoutBuf.String(), "\r\n")
	stderr := strings.TrimRight(stderrBuf.String(), "\r\n")

	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return stdout, errors.New("operation timed out after " + gitNetworkTimeout.String() + " (the remote may be unreachable, or it asked for credentials)")
		}
		if stderr != "" {
			return stdout, errors.New(stderr)
		}
		return stdout, err
	}
	return stdout, nil
}

// FetchGitRemote handles POST /v1/git/fetch. Read-only against the working
// tree: it refreshes the remote-tracking refs so ahead/behind become truthful.
func FetchGitRemote(c *gin.Context) {
	dir, ok := getGitDirForRequest(c)
	if !ok {
		return
	}

	output, err := runGitNet(dir, "fetch", "--prune")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to fetch: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"status": "ok", "output": output})
}

// PullGitRemote handles POST /v1/git/pull.
func PullGitRemote(c *gin.Context) {
	dir, ok := getGitDirForRequest(c)
	if !ok {
		return
	}

	// --ff-only on purpose: a UI button must not silently create a merge commit
	// or start a rebase in someone's checkout. Diverged history is a decision a
	// human makes in a terminal, so surface the refusal instead of guessing.
	output, err := runGitNet(dir, "pull", "--ff-only")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to pull: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"status": "ok", "output": output})
}

// PushGitRemote handles POST /v1/git/push.
func PushGitRemote(c *gin.Context) {
	dir, ok := getGitDirForRequest(c)
	if !ok {
		return
	}

	head, err := runGit(dir, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to resolve current branch: " + err.Error()})
		return
	}
	branch := strings.TrimSpace(head)
	if branch == "" || branch == "HEAD" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Cannot push from a detached HEAD — check out a branch first"})
		return
	}

	// -u so the first push of a new local branch sets its upstream instead of
	// failing with "no upstream configured". Never --force from a button.
	output, err := runGitNet(dir, "push", "-u", "origin", branch)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to push: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"status": "ok", "output": output, "branch": branch})
}

type checkoutRequest struct {
	Branch string `json:"branch" binding:"required"`
	Create bool   `json:"create"`
}

// CheckoutGitBranch handles POST /v1/git/checkout
func CheckoutGitBranch(c *gin.Context) {
	dir, ok := getGitDirForRequest(c)
	if !ok {
		return
	}

	var req checkoutRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Branch name is required"})
		return
	}

	branch := strings.TrimSpace(req.Branch)
	if branch == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Branch name cannot be empty"})
		return
	}

	if strings.HasPrefix(branch, "-") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Branch name cannot start with hyphen"})
		return
	}

	args := []string{"checkout"}
	if req.Create {
		args = append(args, "-b")
	}
	args = append(args, "--", branch)

	output, err := runGit(dir, args...)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to checkout branch: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"status": "ok",
		"branch": branch,
		"output": output,
	})
}

type discardRequest struct {
	Files []string `json:"files" binding:"required"`
}

// DiscardGitChanges handles POST /v1/git/discard
func DiscardGitChanges(c *gin.Context) {
	dir, ok := getGitDirForRequest(c)
	if !ok {
		return
	}

	var req discardRequest
	if err := c.ShouldBindJSON(&req); err != nil || len(req.Files) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "File paths are required for discard"})
		return
	}

	args := []string{"restore", "--"}
	for _, f := range req.Files {
		cleanPath, err := sanitizeGitFilePath(dir, f)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		args = append(args, cleanPath)
	}

	output, err := runGit(dir, args...)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to discard changes: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"status": "ok",
		"output": output,
	})
}

type rollbackTurnRequest struct {
	TurnID string `json:"turn_id" binding:"required"`
	Force  bool   `json:"force"`
}

// RollbackTurnChanges handles POST /v1/git/turn-rollback
// It selectively rolls back ONLY the files modified by this specific turn,
// leaving all unrelated files and manual user uncommitted edits safe and intact.
func RollbackTurnChanges(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}

	var req rollbackTurnRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "turn_id is required"})
		return
	}

	var turn models.AgentTurnChange
	if err := db.DB.Where("id = ? AND workspace_id = ?", req.TurnID, workspace.ID).First(&turn).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Turn change record not found"})
		return
	}

	// 1. Guard against double-rollback
	if turn.Status == "rolled_back" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Turn has already been rolled back"})
		return
	}

	if turn.WorkingDir == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Turn has no associated working directory"})
		return
	}

	dir := turn.WorkingDir
	if stat, err := os.Stat(dir); err != nil || !stat.IsDir() {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Working directory no longer exists on disk"})
		return
	}

	var files []turnFileChange
	if len(turn.Changes) > 0 {
		_ = json.Unmarshal(turn.Changes, &files)
	}

	if len(files) == 0 {
		c.JSON(http.StatusOK, gin.H{
			"status":   "ok",
			"message":  "No file changes recorded in this turn to rollback",
			"reverted": []string{},
		})
		return
	}

	var baselineSnap turnSnapshot
	if len(turn.Baseline) > 0 {
		_ = json.Unmarshal(turn.Baseline, &baselineSnap)
	}

	baseCommit := turn.BaseCommit
	revertedPaths := []string{}
	failedPaths := map[string]string{}

	for _, file := range files {
		cleanRel, err := sanitizeGitFilePath(dir, file.Path)
		if err != nil {
			failedPaths[file.Path] = err.Error()
			continue
		}

		fullPath := filepath.Join(dir, cleanRel)

		// 2. Reject rollback if the agent already committed this change to git history
		if file.Committed {
			failedPaths[cleanRel] = "File change was already committed to git history by the agent; use git revert or reset instead"
			continue
		}

		// 3. Staged addition (A status): remove file and unstage from index so no AD state remains
		if file.Status == "A" {
			_ = os.Remove(fullPath)
			if _, rmErr := runGit(dir, "rm", "--cached", "-f", "--", cleanRel); rmErr == nil || os.IsNotExist(rmErr) {
				revertedPaths = append(revertedPaths, cleanRel)
			} else {
				failedPaths[cleanRel] = fmt.Sprintf("failed to unstage from git index: %v", rmErr)
			}
			continue
		}

		// 4. Untracked file (? status): check for directory contention
		if file.Status == "?" {
			if turn.Contended && !req.Force {
				failedPaths[cleanRel] = "Directory had concurrent agent contention during this turn; untracked file may belong to another agent. Pass force=true to delete."
				continue
			}
			if err := os.Remove(fullPath); err == nil || os.IsNotExist(err) {
				revertedPaths = append(revertedPaths, cleanRel)
			} else {
				failedPaths[cleanRel] = fmt.Sprintf("failed to delete untracked file: %v", err)
			}
			continue
		}

		// 5. PreExisting files: check snapshot availability and untracked status at baseline
		if file.PreExisting {
			if baseCommit == "" {
				failedPaths[cleanRel] = "File contained pre-existing uncommitted human edits and no pre-turn snapshot commit is available; refusing to overwrite"
				continue
			}
			// If file was untracked (?) at baseline, git stash create did not capture it
			if baseFile, ok := baselineSnap.Files[file.Path]; ok && baseFile.Status == "?" {
				failedPaths[cleanRel] = "File was untracked (not git added) before the task started; snapshot does not contain it, refusing to overwrite"
				continue
			}
		}

		// 6. Modified or Deleted files: restore from pre-turn snapshot (git stash create commit) or baseCommit
		if baseCommit != "" {
			if _, err := runGit(dir, "checkout", baseCommit, "--", cleanRel); err == nil {
				revertedPaths = append(revertedPaths, cleanRel)
			} else if _, err2 := runGit(dir, "restore", "--", cleanRel); err2 == nil {
				revertedPaths = append(revertedPaths, cleanRel)
			} else {
				failedPaths[cleanRel] = fmt.Sprintf("git checkout: %v, git restore: %v", err, err2)
			}
		} else {
			if _, err := runGit(dir, "restore", "--", cleanRel); err == nil {
				revertedPaths = append(revertedPaths, cleanRel)
			} else {
				failedPaths[cleanRel] = fmt.Sprintf("git restore: %v", err)
			}
		}
	}

	// Update turn status in DB to indicate rollback
	db.DB.Model(&turn).Updates(map[string]interface{}{
		"status": "rolled_back",
	})

	_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.git.turn.rolled_back", turn.AgentName, turn.ChannelName, gin.H{
		"turn_id":  turn.ID,
		"reverted": revertedPaths,
		"failed":   failedPaths,
	})

	c.JSON(http.StatusOK, gin.H{
		"status":   "ok",
		"turn_id":  turn.ID,
		"reverted": revertedPaths,
		"failed":   failedPaths,
	})
}
