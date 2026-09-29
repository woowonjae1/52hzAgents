package handlers

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

// activity.go serves Home's output panel: a calendar of the commits made in the
// workspace's own repositories, and the agent turns of a single day.
//
// Commits come from local git, never from a hosting service: the repositories
// are already on disk (channels and agents are bound to them), so this needs no
// account, works offline, and sees work that was never pushed. Which of those
// commits an agent made is answered from agent_turn_changes -- a commit whose
// time falls inside exactly one agent's turn on the same repository is that
// agent's. Nothing is guessed beyond that: a commit inside two agents' turns is
// reported as shared, and one inside none is reported as unattributed rather
// than as the human's.

const (
	activityDefaultWeeks = 16
	activityMaxWeeks     = 53
	activityMaxRepos     = 24
	activityMaxCommits   = 5000
	activityGitTimeout   = 10 * time.Second
	activityCacheTTL     = time.Minute
	activityMaxTurnSpan  = 7 * 24 * time.Hour
	// Git records commit times in whole seconds while turns are stamped in
	// milliseconds by a different clock read, so the window edges get a little
	// slack rather than dropping a commit made in a turn's last second.
	activityAttributionSlack = 5 * time.Second
)

// ActivityRepo is one repository the calendar read.
type ActivityRepo struct {
	Name string `json:"name"`
	Path string `json:"path"`
	// Email is the git identity commits were filtered by. Empty means the
	// repository has no user.email configured, so every commit in it counts.
	Email string `json:"email"`
	// Error is set when git could not be read; the repository contributes no
	// commits rather than failing the whole calendar.
	Error string `json:"error,omitempty"`
}

// ActivityCommit is one commit on the calendar.
type ActivityCommit struct {
	Hash string `json:"hash"`
	// Time is the author time in unix milliseconds. The client buckets it into
	// days in its own time zone.
	Time    int64  `json:"time"`
	Repo    string `json:"repo"`
	Subject string `json:"subject"`
	// Agent is set when the commit falls inside exactly one agent's turn.
	Agent string `json:"agent,omitempty"`
	// Shared is set when several agents had a turn open on the repository at
	// the time, so the commit cannot be pinned on one of them.
	Shared bool `json:"shared,omitempty"`
}

// ActivityCommitsResponse is GET /v1/workspaces/:id/activity/commits.
type ActivityCommitsResponse struct {
	Since   int64            `json:"since"`
	Repos   []ActivityRepo   `json:"repos"`
	Commits []ActivityCommit `json:"commits"`
}

// ActivityTurn is one agent turn on the day timeline.
type ActivityTurn struct {
	ID          string `json:"id"`
	AgentName   string `json:"agent_name"`
	ChannelName string `json:"channel_name"`
	Status      string `json:"status"`
	StartedAt   int64  `json:"started_at"`
	// FinishedAt is nil while the turn is running, and also when the agent
	// never reported back -- see EndUnknown.
	FinishedAt *int64 `json:"finished_at"`
	// EndUnknown marks a turn that was expired because its agent never
	// reported back. The time it was expired is not when the work ended, so it
	// is withheld rather than drawn as the turn's length.
	EndUnknown bool `json:"end_unknown"`
	Additions  int  `json:"additions"`
	Deletions  int  `json:"deletions"`
	FileCount  int  `json:"file_count"`
	Contended  bool `json:"contended"`
}

// ActivityTurnsResponse is GET /v1/workspaces/:id/activity/turns.
type ActivityTurnsResponse struct {
	Turns []ActivityTurn `json:"turns"`
}

type activityCacheEntry struct {
	at   time.Time
	resp ActivityCommitsResponse
}

var (
	activityCacheMu sync.Mutex
	activityCache   = map[string]activityCacheEntry{}
)

// GetActivityCommits handles GET /v1/workspaces/:workspace_id/activity/commits?weeks=16
func GetActivityCommits(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	weeks := activityDefaultWeeks
	if raw := strings.TrimSpace(c.Query("weeks")); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			weeks = n
		}
	}
	if weeks > activityMaxWeeks {
		weeks = activityMaxWeeks
	}

	cacheKey := workspace.ID + "/" + strconv.Itoa(weeks)
	if c.Query("refresh") == "" {
		activityCacheMu.Lock()
		entry, hit := activityCache[cacheKey]
		activityCacheMu.Unlock()
		if hit && time.Since(entry.at) < activityCacheTTL {
			c.JSON(http.StatusOK, entry.resp)
			return
		}
	}

	// One extra day so a client several hours behind UTC still gets the whole
	// of its first calendar day.
	since := time.Now().Add(-time.Duration(weeks)*7*24*time.Hour - 24*time.Hour)
	resp := collectActivityCommits(workspace.ID, since)

	activityCacheMu.Lock()
	activityCache[cacheKey] = activityCacheEntry{at: time.Now(), resp: resp}
	activityCacheMu.Unlock()
	c.JSON(http.StatusOK, resp)
}

// GetActivityTurns handles GET /v1/workspaces/:workspace_id/activity/turns?from=ms&to=ms
//
// Returns every turn that overlaps [from, to). The client sends its own local
// day bounds, so "a day" means the user's day, not the server's.
func GetActivityTurns(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	from, errFrom := strconv.ParseInt(c.Query("from"), 10, 64)
	to, errTo := strconv.ParseInt(c.Query("to"), 10, 64)
	if errFrom != nil || errTo != nil || to <= from {
		c.JSON(http.StatusBadRequest, gin.H{"error": "from and to must be unix milliseconds with from < to"})
		return
	}
	if time.Duration(to-from)*time.Millisecond > activityMaxTurnSpan {
		c.JSON(http.StatusBadRequest, gin.H{"error": "range is limited to 7 days"})
		return
	}

	var rows []models.AgentTurnChange
	// Changes and baselines are the bulk of a row and the timeline needs
	// neither, so they are not read.
	if err := db.DB.Model(&models.AgentTurnChange{}).
		Select("id", "agent_name", "channel_name", "status", "reason", "started_at", "finished_at",
			"additions", "deletions", "file_count", "contended").
		Where("workspace_id = ? AND status <> ? AND started_at < ? AND (finished_at IS NULL OR finished_at > ?)",
			workspace.ID, "queued", to, from).
		Order("started_at asc").
		Find(&rows).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load turns"})
		return
	}

	turns := make([]ActivityTurn, 0, len(rows))
	for _, row := range rows {
		turn := ActivityTurn{
			ID:          row.ID,
			AgentName:   row.AgentName,
			ChannelName: row.ChannelName,
			Status:      row.Status,
			StartedAt:   row.StartedAt,
			FinishedAt:  row.FinishedAt,
			Additions:   row.Additions,
			Deletions:   row.Deletions,
			FileCount:   row.FileCount,
			Contended:   row.Contended,
		}
		// Only an open turn is running. One that was settled without an end
		// time -- recorded as unavailable at dispatch because its folder is
		// not a repository -- has no known length either.
		if isExpiredTurn(row) || (row.FinishedAt == nil && row.Status != "open") {
			turn.FinishedAt = nil
			turn.EndUnknown = true
		}
		turns = append(turns, turn)
	}
	c.JSON(http.StatusOK, ActivityTurnsResponse{Turns: turns})
}

// isExpiredTurn reports a turn closed by expireStaleTurns rather than by its
// agent. Its finished_at is when the expiry ran, which says nothing about when
// the agent stopped.
func isExpiredTurn(row models.AgentTurnChange) bool {
	return row.Status == "unavailable" && row.Reason == staleTurnReason
}

// activityRepoRef is a repository found through one of the workspace's
// directories. Worktrees of one repository share a common git dir, which is
// what identifies the repository; a parallel lane's worktree and the channel's
// checkout are the same repo and must not be read, or counted, twice.
type activityRepoRef struct {
	key   string
	top   string
	email string
}

func collectActivityCommits(workspaceID string, since time.Time) ActivityCommitsResponse {
	resp := ActivityCommitsResponse{
		Since:   since.UnixMilli(),
		Repos:   []ActivityRepo{},
		Commits: []ActivityCommit{},
	}
	if db.DB == nil {
		return resp
	}

	repos, dirKeys := discoverActivityRepos(workspaceID, since)
	windows := loadActivityWindows(workspaceID, since, dirKeys)

	seen := map[string]bool{}
	for _, repo := range repos {
		info := ActivityRepo{Name: filepath.Base(repo.top), Path: repo.top, Email: repo.email}
		commits, err := readRepoCommits(repo, since)
		if err != nil {
			info.Error = err.Error()
		}
		resp.Repos = append(resp.Repos, info)
		for _, commit := range commits {
			if seen[commit.Hash] {
				continue
			}
			agent, shared := attributeCommit(windows[repo.key], commit.Time)
			commit.Agent, commit.Shared = agent, shared
			// The calendar is the user's own output plus their agents'. A
			// collaborator's commits pulled in through a remote branch are
			// neither, unless an agent's turn produced them.
			if repo.email != "" && !strings.EqualFold(commit.authorEmail, repo.email) && agent == "" && !shared {
				continue
			}
			seen[commit.Hash] = true
			resp.Commits = append(resp.Commits, commit.ActivityCommit)
		}
	}
	sort.Slice(resp.Commits, func(i, j int) bool { return resp.Commits[i].Time > resp.Commits[j].Time })
	return resp
}

// discoverActivityRepos collects the repositories behind every directory the
// workspace knows about: channel bindings, agent launch directories, and the
// directories agents actually worked in. It also returns which repository each
// of those directories resolved to, for matching turns to commits.
func discoverActivityRepos(workspaceID string, since time.Time) ([]*activityRepoRef, map[string]string) {
	var dirs []string
	var channelDirs, memberDirs, turnDirs []string
	_ = db.DB.Model(&models.Channel{}).Where("workspace_id = ? AND working_dir IS NOT NULL", workspaceID).
		Pluck("working_dir", &channelDirs).Error
	_ = db.DB.Model(&models.WorkspaceMember{}).Where("workspace_id = ? AND working_dir IS NOT NULL", workspaceID).
		Pluck("working_dir", &memberDirs).Error
	_ = db.DB.Model(&models.AgentTurnChange{}).Where("workspace_id = ? AND started_at >= ?", workspaceID, since.UnixMilli()).
		Distinct("working_dir").Pluck("working_dir", &turnDirs).Error
	dirs = append(dirs, channelDirs...)
	dirs = append(dirs, memberDirs...)
	dirs = append(dirs, turnDirs...)

	byKey := map[string]*activityRepoRef{}
	var order []*activityRepoRef
	dirKeys := map[string]string{}
	visited := map[string]bool{}
	for _, dir := range dirs {
		dir = strings.TrimSpace(dir)
		if dir == "" || visited[dir] {
			continue
		}
		visited[dir] = true
		if info, err := os.Stat(dir); err != nil || !info.IsDir() {
			continue
		}
		// Absolute paths from git itself: joining a relative common dir onto
		// the stored path would key the same repository two ways whenever the
		// stored path is spelled differently (a Windows 8.3 short name, a
		// symlink) from what git reports for a worktree of it.
		out, err := runGitTimeout(dir, 5*time.Second, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir")
		if err != nil {
			// git older than 2.31 has no --path-format.
			if out, err = runGitTimeout(dir, 5*time.Second, "rev-parse", "--show-toplevel", "--git-common-dir"); err != nil {
				continue
			}
		}
		lines := strings.Split(strings.ReplaceAll(out, "\r\n", "\n"), "\n")
		if len(lines) < 2 {
			continue
		}
		top := filepath.Clean(strings.TrimSpace(lines[0]))
		common := strings.TrimSpace(lines[1])
		if !filepath.IsAbs(common) {
			common = filepath.Join(dir, common)
		}
		key := repoKey(common)
		dirKeys[dir] = key

		if existing, ok := byKey[key]; ok {
			// Show the main checkout rather than whichever lane worktree
			// happened to be found first.
			if repoKey(filepath.Join(top, ".git")) == key {
				existing.top = top
			}
			continue
		}
		if len(order) >= activityMaxRepos {
			continue
		}
		email, _ := runGitTimeout(dir, 5*time.Second, "config", "user.email")
		ref := &activityRepoRef{key: key, top: top, email: strings.TrimSpace(email)}
		byKey[key] = ref
		order = append(order, ref)
	}
	return order, dirKeys
}

func repoKey(path string) string {
	key := filepath.Clean(path)
	if runtime.GOOS == "windows" {
		key = strings.ToLower(key)
	}
	return key
}

type repoCommit struct {
	ActivityCommit
	authorEmail string
}

func readRepoCommits(repo *activityRepoRef, since time.Time) ([]repoCommit, error) {
	// Branches, remote-tracking branches and tags -- not --all, which would
	// also walk refs/52hz/checkpoints and count every pre-turn snapshot as a
	// commit. Merges are left out: they record work, they are not work.
	out, err := runGitTimeout(repo.top, activityGitTimeout, "log",
		"--branches", "--remotes", "--tags", "--no-merges",
		"--since="+since.Format(time.RFC3339),
		"--max-count="+strconv.Itoa(activityMaxCommits),
		"--format=%H%x1f%at%x1f%ae%x1f%s")
	if err != nil {
		return nil, err
	}
	name := filepath.Base(repo.top)
	var commits []repoCommit
	for _, line := range strings.Split(out, "\n") {
		fields := strings.SplitN(strings.TrimRight(line, "\r"), "\x1f", 4)
		if len(fields) < 4 {
			continue
		}
		secs, err := strconv.ParseInt(fields[1], 10, 64)
		if err != nil {
			continue
		}
		commits = append(commits, repoCommit{
			ActivityCommit: ActivityCommit{Hash: fields[0], Time: secs * 1000, Repo: name, Subject: fields[3]},
			authorEmail:    fields[2],
		})
	}
	return commits, nil
}

// activityWindow is the span of one agent turn on one repository.
type activityWindow struct {
	agent      string
	start, end int64
}

// loadActivityWindows returns the turn windows per repository key. Only turns
// whose end is known take part: a turn expired for never reporting back has no
// real end, and stretching it to the expiry would claim commits it never made.
func loadActivityWindows(workspaceID string, since time.Time, dirKeys map[string]string) map[string][]activityWindow {
	var rows []models.AgentTurnChange
	_ = db.DB.Model(&models.AgentTurnChange{}).
		Select("agent_name", "working_dir", "status", "reason", "started_at", "finished_at").
		Where("workspace_id = ? AND status IN ? AND started_at >= ?",
			workspaceID, []string{"open", "closed", "unavailable", "cancelled"}, since.UnixMilli()-int64(24*time.Hour/time.Millisecond)).
		Find(&rows).Error

	now := time.Now().UnixMilli()
	windows := map[string][]activityWindow{}
	for _, row := range rows {
		key, ok := dirKeys[strings.TrimSpace(row.WorkingDir)]
		if !ok || isExpiredTurn(row) {
			continue
		}
		end := now
		if row.FinishedAt != nil {
			end = *row.FinishedAt
		} else if row.Status != "open" {
			continue
		}
		windows[key] = append(windows[key], activityWindow{agent: row.AgentName, start: row.StartedAt, end: end})
	}
	return windows
}

// attributeCommit names the agent whose turn contains the commit time. Several
// distinct agents means the commit is shared; none means it is unattributed.
func attributeCommit(windows []activityWindow, at int64) (agent string, shared bool) {
	slack := int64(activityAttributionSlack / time.Millisecond)
	for _, w := range windows {
		if at < w.start-slack || at > w.end+slack {
			continue
		}
		if agent == "" {
			agent = w.agent
		} else if agent != w.agent {
			return "", true
		}
	}
	return agent, false
}
