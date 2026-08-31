package handlers

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// WorktreeEntry describes one active Git worktree attached to a repository.
type WorktreeEntry struct {
	Path        string `json:"path"`
	HEAD        string `json:"head"`
	Branch      string `json:"branch,omitempty"`
	Bare        bool   `json:"bare,omitempty"`
	Detached    bool   `json:"detached,omitempty"`
	Locked      bool   `json:"locked,omitempty"`
	LockReason  string `json:"lock_reason,omitempty"`
	Prunable    bool   `json:"prunable,omitempty"`
	PruneReason string `json:"prune_reason,omitempty"`
}

// GetAgentWorktreeRoot returns the root directory for temporary agent worktrees.
func GetAgentWorktreeRoot(workspaceID string) string {
	cleanWS := strings.ReplaceAll(workspaceID, "..", "")
	if cleanWS == "" {
		cleanWS = "default"
	}
	return filepath.Join(os.TempDir(), "52hz_worktrees", cleanWS)
}

// GenerateAgentWorktreePath creates a deterministic filesystem path for an agent turn.
func GenerateAgentWorktreePath(workspaceID, taskID, agentName string) string {
	cleanTask := strings.ReplaceAll(taskID, "..", "")
	cleanAgent := strings.ReplaceAll(agentName, "..", "")
	if cleanTask == "" {
		cleanTask = fmt.Sprintf("task_%d", time.Now().UnixMilli())
	}
	if cleanAgent == "" {
		cleanAgent = "agent"
	}
	return filepath.Join(GetAgentWorktreeRoot(workspaceID), fmt.Sprintf("%s_%s", cleanTask, cleanAgent))
}

// ListGitWorktrees lists all worktrees attached to repoDir using `git worktree list --porcelain`.
func ListGitWorktrees(repoDir string) ([]WorktreeEntry, error) {
	output, err := runGit(repoDir, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, fmt.Errorf("failed to list worktrees: %w", err)
	}

	var entries []WorktreeEntry
	var current *WorktreeEntry

	lines := strings.Split(output, "\n")
	for _, rawLine := range lines {
		line := strings.TrimRight(rawLine, "\r")
		if line == "" {
			if current != nil {
				entries = append(entries, *current)
				current = nil
			}
			continue
		}

		parts := strings.SplitN(line, " ", 2)
		key := parts[0]
		val := ""
		if len(parts) > 1 {
			val = parts[1]
		}

		switch key {
		case "worktree":
			if current != nil {
				entries = append(entries, *current)
			}
			current = &WorktreeEntry{Path: filepath.Clean(val)}
		case "HEAD":
			if current != nil {
				current.HEAD = val
			}
		case "branch":
			if current != nil {
				// branch refs/heads/foo -> foo
				current.Branch = strings.TrimPrefix(val, "refs/heads/")
			}
		case "bare":
			if current != nil {
				current.Bare = true
			}
		case "detached":
			if current != nil {
				current.Detached = true
			}
		case "locked":
			if current != nil {
				current.Locked = true
				current.LockReason = val
			}
		case "prunable":
			if current != nil {
				current.Prunable = true
				current.PruneReason = val
			}
		}
	}

	if current != nil {
		entries = append(entries, *current)
	}

	return entries, nil
}

// CreateGitWorktree adds a new worktree at targetPath.
// If newBranch is true, it creates a new branch named branchName from baseRef.
// If newBranch is false, it checks out existing branchName (or baseRef in detached HEAD mode).
func CreateGitWorktree(repoDir, targetPath, branchName, baseRef string, newBranch bool) (*WorktreeEntry, error) {
	if repoDir == "" {
		return nil, errors.New("repository directory cannot be empty")
	}
	if targetPath == "" {
		return nil, errors.New("target worktree path cannot be empty")
	}

	targetPath = filepath.Clean(targetPath)
	if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
		return nil, fmt.Errorf("failed to create parent directory for worktree: %w", err)
	}

	args := []string{"worktree", "add"}
	if newBranch && branchName != "" {
		args = append(args, "-b", branchName, targetPath)
		if baseRef != "" {
			args = append(args, baseRef)
		}
	} else if branchName != "" {
		args = append(args, targetPath, branchName)
	} else if baseRef != "" {
		args = append(args, "--detach", targetPath, baseRef)
	} else {
		args = append(args, targetPath)
	}

	output, err := runGit(repoDir, args...)
	if err != nil {
		return nil, fmt.Errorf("git worktree add failed: %w (output: %s)", err, output)
	}

	// Verify worktree creation and return entry
	worktrees, listErr := ListGitWorktrees(repoDir)
	if listErr == nil {
		for _, wt := range worktrees {
			if strings.EqualFold(wt.Path, targetPath) {
				return &wt, nil
			}
		}
	}

	return &WorktreeEntry{
		Path:   targetPath,
		Branch: branchName,
	}, nil
}

// RemoveGitWorktree safely removes a worktree and deletes leftover directories.
func RemoveGitWorktree(repoDir, targetPath string, force bool) error {
	if repoDir == "" || targetPath == "" {
		return errors.New("repository directory and worktree path cannot be empty")
	}

	targetPath = filepath.Clean(targetPath)
	args := []string{"worktree", "remove"}
	if force {
		args = append(args, "--force")
	}
	args = append(args, targetPath)

	output, err := runGit(repoDir, args...)
	if err != nil {
		// If git worktree remove fails because the directory was already manually deleted, prune it
		_ = PruneGitWorktrees(repoDir)
		_ = os.RemoveAll(targetPath)
		return fmt.Errorf("failed to remove worktree: %w (output: %s)", err, output)
	}

	_ = os.RemoveAll(targetPath)
	_ = PruneGitWorktrees(repoDir)
	return nil
}

// PruneGitWorktrees cleans up stale worktree administrative files in .git/worktrees.
func PruneGitWorktrees(repoDir string) error {
	if repoDir == "" {
		return errors.New("repository directory cannot be empty")
	}
	_, err := runGit(repoDir, "worktree", "prune")
	return err
}

// ---------------------------------------------------------------------------
// HTTP API Endpoints for Worktrees
// ---------------------------------------------------------------------------

// ListWorktreesHandler handles GET /v1/git/worktrees
func ListWorktreesHandler(c *gin.Context) {
	dir, ok := getGitDirForRequest(c)
	if !ok {
		return
	}

	worktrees, err := ListGitWorktrees(dir)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"repo_dir":  dir,
		"worktrees": worktrees,
	})
}

type createWorktreeRequest struct {
	TargetPath string `json:"target_path"`
	Branch     string `json:"branch"`
	BaseRef    string `json:"base_ref"`
	NewBranch  bool   `json:"new_branch"`
	TaskID     string `json:"task_id"`
	AgentName  string `json:"agent_name"`
}

// CreateWorktreeHandler handles POST /v1/git/worktrees
func CreateWorktreeHandler(c *gin.Context) {
	dir, ok := getGitDirForRequest(c)
	if !ok {
		return
	}

	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}

	var req createWorktreeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	targetPath := strings.TrimSpace(req.TargetPath)
	if targetPath == "" {
		targetPath = GenerateAgentWorktreePath(workspace.ID, req.TaskID, req.AgentName)
	}

	branchName := strings.TrimSpace(req.Branch)
	baseRef := strings.TrimSpace(req.BaseRef)
	if baseRef == "" {
		baseRef = "HEAD"
	}

	entry, err := CreateGitWorktree(dir, targetPath, branchName, baseRef, req.NewBranch)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"status":   "ok",
		"worktree": entry,
	})
}

type removeWorktreeRequest struct {
	Path  string `json:"path" binding:"required"`
	Force bool   `json:"force"`
}

// RemoveWorktreeHandler handles DELETE /v1/git/worktrees
func RemoveWorktreeHandler(c *gin.Context) {
	dir, ok := getGitDirForRequest(c)
	if !ok {
		return
	}

	var req removeWorktreeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Worktree path is required"})
		return
	}

	if err := RemoveGitWorktree(dir, req.Path, req.Force); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"status":  "ok",
		"message": "Worktree removed successfully",
	})
}
