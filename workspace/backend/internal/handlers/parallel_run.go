package handlers

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/hub"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

/*
PARALLEL MODE, END TO END.

Before this file parallel mode only chose whom to wake. The woken agents were
not told which task was theirs, nothing recorded that a batch existed, and when
the last one finished nothing happened -- the user read four replies and merged
by hand. A batch is now a record with one lane per agent:

 1. start: when a human message fans out to 2+ agents, a batch is created. If
    the channel's folder is a git repository every lane gets its own worktree
    on its own branch (parallel/<batch>/<agent>), so agents cannot overwrite
    each other and scopes stop mattering. Otherwise the lanes share the folder
    and the board's scope check still guards the start.
 2. dispatch: the routed message carries `parallel_batch` metadata -- for each
    agent its task, its working directory and its branch. The adapter runs that
    turn in the lane's directory and reports back when the turn ends.
 3. finish: a lane that reports done has its worktree committed. When every
    lane is terminal the batch merges each committed branch into the base
    branch, keeps the branches that conflict (and everything, if the base tree
    has uncommitted work), removes merged worktrees, and posts one summary to
    the channel -- waking the master, when the channel has one, to review it.
 4. recovery: a lane can be retried on its own worktree; a lane silent past the
    timeout is failed by the scheduler so the batch can still finish.
*/

const (
	laneRunning  = "running"
	laneDone     = "done"
	laneFailed   = "failed"
	laneMerged   = "merged"
	laneConflict = "conflict"
	laneKept     = "kept"

	batchRunning = "running"
	batchDone    = "done"
)

// ParallelLaneTimeout is how long a lane may stay running before the scheduler
// fails it. Overridable with PARALLEL_LANE_TIMEOUT_SECONDS.
func ParallelLaneTimeout() time.Duration {
	if v := strings.TrimSpace(os.Getenv("PARALLEL_LANE_TIMEOUT_SECONDS")); v != "" {
		var secs int
		if _, err := fmt.Sscanf(v, "%d", &secs); err == nil && secs > 0 {
			return time.Duration(secs) * time.Second
		}
	}
	return 45 * time.Minute
}

var branchSafe = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

func laneBranch(batchID, agent string) string {
	return fmt.Sprintf("parallel/%s/%s", batchID[:8], strings.Trim(branchSafe.ReplaceAllString(agent, "-"), "-"))
}

// gitRepoRoot returns the top of the git repository containing dir, or "".
func gitRepoRoot(dir string) string {
	if strings.TrimSpace(dir) == "" {
		return ""
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return ""
	}
	out, err := runGitTimeout(dir, 5*time.Second, "rev-parse", "--show-toplevel")
	if err != nil {
		return ""
	}
	return filepath.Clean(strings.TrimSpace(out))
}

// runningBatch is the channel's unfinished batch, if any. A second batch is
// never started on top of one: its lanes would be branched from a base the
// first batch is about to merge into.
func runningBatch(tx *gorm.DB, workspaceID, channelName string) *models.ParallelBatchRecord {
	var b models.ParallelBatchRecord
	if tx.Where("workspace_id = ? AND channel_name = ? AND status = ?", workspaceID, channelName, batchRunning).
		Order("created_at DESC").Limit(1).Find(&b).RowsAffected == 0 {
		return nil
	}
	return &b
}

// laneTasksFromBoard gives each assignee the text of its open board tasks.
func laneTasksFromBoard(todos []models.TodoRecord, agents []string) (map[string]string, map[string]string) {
	tasks := map[string]string{}
	scopes := map[string]string{}
	for _, agent := range agents {
		var lines []string
		for _, t := range todos {
			if !strings.EqualFold(strings.TrimSpace(t.Assignee), agent) {
				continue
			}
			lines = append(lines, "- "+strings.TrimSpace(t.Content))
			if s := effectiveScope(t); s != "" {
				scopes[agent] = s
			}
		}
		tasks[agent] = strings.Join(lines, "\n")
	}
	return tasks, scopes
}

// laneTasksFromMessage splits "@a do X @b do Y" into per-agent instructions,
// using the composer's mention_segments when present and the whole message
// for everyone otherwise.
func laneTasksFromMessage(req *SendEventRequest, agents []string) map[string]string {
	content, _ := req.Payload["content"].(string)
	tasks := map[string]string{}
	for _, a := range agents {
		tasks[a] = strings.TrimSpace(content)
	}
	var raw []interface{}
	if v, ok := req.Metadata["mention_segments"].([]interface{}); ok {
		raw = v
	} else if v, ok := req.Payload["mention_segments"].([]interface{}); ok {
		raw = v
	}
	for _, item := range raw {
		seg, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		agent, _ := seg["agent"].(string)
		instruction, _ := seg["instruction"].(string)
		for _, a := range agents {
			if strings.EqualFold(a, agent) && strings.TrimSpace(instruction) != "" {
				tasks[a] = strings.TrimSpace(instruction)
			}
		}
	}
	return tasks
}

type laneDispatch struct {
	Task       string `json:"task"`
	WorkingDir string `json:"working_dir,omitempty"`
	Branch     string `json:"branch,omitempty"`
	Scope      string `json:"scope,omitempty"`
}

// startParallelBatch records a batch for agents woken together and returns the
// metadata the routed message carries. Returns nil when no batch should be
// started (fewer than two agents, or one is already running).
func startParallelBatch(tx *gorm.DB, workspaceID string, channel *models.Channel, origin string, agents []string, tasks, scopes map[string]string) map[string]interface{} {
	if len(agents) < 2 || runningBatch(tx, workspaceID, channel.Name) != nil {
		return nil
	}
	batch := models.ParallelBatchRecord{
		ID:          uuid.NewString(),
		WorkspaceID: workspaceID,
		ChannelName: channel.Name,
		Isolation:   "shared",
		Origin:      origin,
		Status:      batchRunning,
	}

	repo := ""
	if channel.WorkingDir != nil {
		repo = gitRepoRoot(*channel.WorkingDir)
	}
	lanes := make([]models.ParallelLaneRecord, 0, len(agents))
	now := time.Now().UTC()
	for _, agent := range agents {
		lanes = append(lanes, models.ParallelLaneRecord{
			ID: uuid.NewString(), BatchID: batch.ID, Agent: agent,
			Task: tasks[agent], Scope: scopes[agent], Status: laneRunning, StartedAt: now,
		})
	}

	if repo != "" {
		base, _ := runGitTimeout(repo, 5*time.Second, "rev-parse", "--abbrev-ref", "HEAD")
		created := []string{}
		ok := true
		for i := range lanes {
			branch := laneBranch(batch.ID, lanes[i].Agent)
			path := GenerateAgentWorktreePath(workspaceID, "p"+batch.ID[:8], lanes[i].Agent)
			if _, err := CreateGitWorktree(repo, path, branch, "HEAD", true); err != nil {
				fmt.Printf("[parallel] worktree for %s failed, falling back to a shared folder: %v\n", lanes[i].Agent, err)
				ok = false
				break
			}
			created = append(created, path)
			lanes[i].Branch = branch
			lanes[i].WorktreePath = path
		}
		if ok {
			batch.Isolation = "worktree"
			batch.RepoDir = repo
			batch.BaseBranch = strings.TrimSpace(base)
		} else {
			// All or nothing: a half-isolated batch would let the shared lanes
			// overwrite each other without the scope check that shared mode needs.
			for i, path := range created {
				_ = RemoveGitWorktree(repo, path, true)
				_, _ = runGit(repo, "branch", "-D", lanes[i].Branch)
			}
			for i := range lanes {
				lanes[i].Branch, lanes[i].WorktreePath = "", ""
			}
		}
	}

	if err := tx.Create(&batch).Error; err != nil {
		return nil
	}
	dispatch := map[string]laneDispatch{}
	for i := range lanes {
		if err := tx.Create(&lanes[i]).Error; err != nil {
			return nil
		}
		dispatch[lanes[i].Agent] = laneDispatch{
			Task: lanes[i].Task, WorkingDir: lanes[i].WorktreePath, Branch: lanes[i].Branch, Scope: lanes[i].Scope,
		}
	}
	_ = PublishWorkspaceStateEvent(workspaceID, "workspace.parallel.batch", "system:parallel", channel.Name, gin.H{"batch_id": batch.ID, "status": batch.Status})
	return map[string]interface{}{
		"batch_id":  batch.ID,
		"isolation": batch.Isolation,
		"lanes":     dispatch,
	}
}

// postChannelMessage inserts a message event and broadcasts it, the same way
// routines post into a channel. `targets` wakes exactly those agents.
func postChannelMessage(workspaceID, channelName, source, content string, targets []string, extra map[string]interface{}) {
	payload := map[string]interface{}{"content": content, "message_type": "chat"}
	metadata := map[string]interface{}{}
	for k, v := range extra {
		metadata[k] = v
	}
	if len(targets) > 0 {
		metadata["target_agents"] = targets
	}
	payloadBytes, _ := json.Marshal(payload)
	metadataBytes, _ := json.Marshal(metadata)
	id := uuid.NewString()
	ts := time.Now().UnixMilli()
	rec := models.EventRecord{
		ID: id, NetworkID: workspaceID, Type: "workspace.message.posted", Source: source,
		Target: "channel/" + channelName, Payload: payloadBytes, Metadata: metadataBytes,
		Timestamp: ts, Visibility: "channel",
	}
	if err := db.DB.Create(&rec).Error; err != nil {
		fmt.Printf("[parallel] could not post to %s: %v\n", channelName, err)
		return
	}
	full, _ := json.Marshal(gin.H{
		"id": id, "network": workspaceID, "type": rec.Type, "source": source,
		"target": rec.Target, "payload": payload, "metadata": metadata, "timestamp": ts,
	})
	if hub.GlobalHub != nil {
		hub.GlobalHub.Broadcast(hub.BroadcastMsg{WorkspaceID: workspaceID, ChannelName: rec.Target, Payload: string(full)})
	}
}

// commitLane commits whatever the lane changed in its worktree. Returns the
// commit sha, "" when nothing changed.
func commitLane(lane *models.ParallelLaneRecord) (string, error) {
	if lane.WorktreePath == "" {
		return "", nil
	}
	status, err := runGit(lane.WorktreePath, "status", "--porcelain")
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(status) == "" {
		return "", nil
	}
	if _, err := runGit(lane.WorktreePath, "add", "-A"); err != nil {
		return "", err
	}
	subject := strings.TrimSpace(strings.SplitN(strings.TrimPrefix(lane.Task, "- "), "\n", 2)[0])
	if len([]rune(subject)) > 60 {
		subject = string([]rune(subject)[:60]) + "…"
	}
	msg := fmt.Sprintf("parallel(%s): %s", lane.Agent, subject)
	if _, err := runGit(lane.WorktreePath, "-c", "user.name=52hz "+lane.Agent, "-c", "user.email=agent@52hz.local", "commit", "-m", msg); err != nil {
		return "", err
	}
	return runGit(lane.WorktreePath, "rev-parse", "HEAD")
}

type laneCompleteRequest struct {
	Status string `json:"status"` // done | failed
	Error  string `json:"error"`
	Reply  string `json:"reply"`
}

// CompleteParallelLane handles POST /v1/parallel-batches/:batch_id/lanes/:agent/complete,
// sent by the adapter when the lane's turn ends.
func CompleteParallelLane(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	var req laneCompleteRequest
	_ = c.ShouldBindJSON(&req)
	var batch models.ParallelBatchRecord
	if db.DB.Where("id = ? AND workspace_id = ?", c.Param("batch_id"), workspace.ID).Limit(1).Find(&batch).RowsAffected == 0 {
		c.JSON(404, gin.H{"error": "batch not found"})
		return
	}
	agent := agentNameFromSource(c.Param("agent"))
	var lane models.ParallelLaneRecord
	if db.DB.Where("batch_id = ? AND agent = ?", batch.ID, agent).Limit(1).Find(&lane).RowsAffected == 0 {
		c.JSON(404, gin.H{"error": "lane not found"})
		return
	}
	if lane.Status != laneRunning {
		c.JSON(200, gin.H{"lane": lane, "ignored": "lane is not running"})
		return
	}
	finishLane(&batch, &lane, req.Status == laneFailed, req.Error, req.Reply)
	c.JSON(200, gin.H{"lane": lane})
}

// finishLane marks a lane terminal (committing a successful worktree) and
// finalizes the batch when it was the last one running.
func finishLane(batch *models.ParallelBatchRecord, lane *models.ParallelLaneRecord, failed bool, errText, reply string) {
	now := time.Now().UTC()
	lane.FinishedAt = &now
	lane.Reply = truncateRunes(strings.TrimSpace(reply), 4000)
	if failed {
		lane.Status = laneFailed
		lane.Error = truncateRunes(errText, 1000)
	} else {
		sha, err := commitLane(lane)
		if err != nil {
			lane.Status = laneFailed
			lane.Error = "commit failed: " + truncateRunes(err.Error(), 500)
		} else {
			lane.Status = laneDone
			lane.Commit = strings.TrimSpace(sha)
		}
	}
	db.DB.Save(lane)
	// A board batch was dispatched from this agent's open tasks; a lane that
	// finished closes them, or the next message would start the same batch.
	if lane.Status == laneDone && batch.Origin == "board" {
		db.DB.Model(&models.TodoRecord{}).
			Where("workspace_id = ? AND channel_name = ? AND assignee = ? AND status IN ?", batch.WorkspaceID, batch.ChannelName, lane.Agent, openTodoStatuses).
			Updates(map[string]interface{}{"status": "completed", "completed_at": now})
		_ = PublishWorkspaceStateEvent(batch.WorkspaceID, "workspace.todos.updated", "system:parallel", batch.ChannelName, gin.H{"assignee": lane.Agent})
	}
	_ = PublishWorkspaceStateEvent(batch.WorkspaceID, "workspace.parallel.lane", "system:parallel", batch.ChannelName, gin.H{"batch_id": batch.ID, "lane": lane})

	var running int64
	db.DB.Model(&models.ParallelLaneRecord{}).Where("batch_id = ? AND status = ?", batch.ID, laneRunning).Count(&running)
	if running == 0 {
		finalizeBatch(batch)
	}
}

// finalizeBatch merges finished lanes back and posts the summary.
func finalizeBatch(batch *models.ParallelBatchRecord) {
	var lanes []models.ParallelLaneRecord
	db.DB.Where("batch_id = ?", batch.ID).Order("agent").Find(&lanes)

	baseDirty := ""
	if batch.Isolation == "worktree" {
		if st, err := runGit(batch.RepoDir, "status", "--porcelain", "--untracked-files=no"); err == nil && strings.TrimSpace(st) != "" {
			baseDirty = "the project folder has uncommitted changes"
		}
	}
	for i := range lanes {
		lane := &lanes[i]
		if batch.Isolation != "worktree" || lane.Status != laneDone {
			continue
		}
		switch {
		case lane.Commit == "":
			// Nothing to merge: the lane changed no files.
			lane.Status = laneMerged
		case baseDirty != "":
			lane.Status = laneKept
		default:
			if _, err := runGit(batch.RepoDir, "merge", "--no-ff", "--no-edit", lane.Branch); err != nil {
				_, _ = runGit(batch.RepoDir, "merge", "--abort")
				lane.Status = laneConflict
				lane.Error = "merge conflict: " + truncateRunes(err.Error(), 300)
			} else {
				lane.Status = laneMerged
			}
		}
		if lane.Status == laneMerged {
			_ = RemoveGitWorktree(batch.RepoDir, lane.WorktreePath, true)
			_, _ = runGit(batch.RepoDir, "branch", "-D", lane.Branch)
		}
		db.DB.Save(lane)
	}

	now := time.Now().UTC()
	batch.Status = batchDone
	batch.FinishedAt = &now
	batch.Summary = batchSummary(batch, lanes, baseDirty)
	db.DB.Save(batch)
	_ = PublishWorkspaceStateEvent(batch.WorkspaceID, "workspace.parallel.batch", "system:parallel", batch.ChannelName, gin.H{"batch_id": batch.ID, "status": batch.Status})

	// Wake the master to review, unless the master was itself one of the lanes
	// (then it has already seen its own part and the summary is for the human).
	var targets []string
	var channel models.Channel
	if db.DB.Where("workspace_id = ? AND name = ?", batch.WorkspaceID, batch.ChannelName).Limit(1).Find(&channel).RowsAffected > 0 &&
		channel.MasterAgent != nil && *channel.MasterAgent != "" {
		isLane := false
		for _, l := range lanes {
			if strings.EqualFold(l.Agent, *channel.MasterAgent) {
				isLane = true
			}
		}
		if !isLane {
			targets = []string{*channel.MasterAgent}
		}
	}
	content := batch.Summary
	if len(targets) > 0 {
		content += "\n\n@" + targets[0] + " please review the combined result above: check the merged changes fit together, and resolve or report anything listed as a conflict or failure."
	}
	postChannelMessage(batch.WorkspaceID, batch.ChannelName, "system:parallel", content, targets, map[string]interface{}{
		"parallel_summary": gin.H{"batch_id": batch.ID},
	})
}

func batchSummary(batch *models.ParallelBatchRecord, lanes []models.ParallelLaneRecord, baseDirty string) string {
	var b strings.Builder
	b.WriteString("**Parallel batch finished**")
	if batch.Isolation == "worktree" && batch.BaseBranch != "" {
		b.WriteString(fmt.Sprintf(" — merged into `%s`", batch.BaseBranch))
	}
	b.WriteString("\n\n")
	icon := map[string]string{laneMerged: "✅", laneKept: "⏸", laneConflict: "⚠️", laneFailed: "❌", laneDone: "✅"}
	for _, l := range lanes {
		b.WriteString(fmt.Sprintf("%s **@%s** — %s", icon[l.Status], l.Agent, l.Status))
		if l.Branch != "" && l.Status != laneMerged {
			b.WriteString(fmt.Sprintf(" · branch `%s`", l.Branch))
		}
		if l.Error != "" {
			b.WriteString(" · " + l.Error)
		}
		b.WriteString("\n")
		if l.Reply != "" {
			b.WriteString("  > " + strings.ReplaceAll(truncateRunes(l.Reply, 280), "\n", " ") + "\n")
		}
	}
	if baseDirty != "" {
		b.WriteString(fmt.Sprintf("\nNothing was merged automatically because %s. Merge each branch with `git merge <branch>` when ready.\n", baseDirty))
	}
	var manual []string
	for _, l := range lanes {
		if l.Status == laneConflict {
			manual = append(manual, fmt.Sprintf("`git merge %s`", l.Branch))
		}
	}
	if len(manual) > 0 {
		b.WriteString("\nConflicting branches were kept; merge them by hand: " + strings.Join(manual, ", ") + "\n")
	}
	return strings.TrimSpace(b.String())
}

// RetryParallelLane handles POST /v1/parallel-batches/:batch_id/lanes/:agent/retry.
// Only a failed lane can be retried; it runs again on its own worktree.
func RetryParallelLane(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	var batch models.ParallelBatchRecord
	if db.DB.Where("id = ? AND workspace_id = ?", c.Param("batch_id"), workspace.ID).Limit(1).Find(&batch).RowsAffected == 0 {
		c.JSON(404, gin.H{"error": "batch not found"})
		return
	}
	var lane models.ParallelLaneRecord
	if db.DB.Where("batch_id = ? AND agent = ?", batch.ID, agentNameFromSource(c.Param("agent"))).Limit(1).Find(&lane).RowsAffected == 0 {
		c.JSON(404, gin.H{"error": "lane not found"})
		return
	}
	if lane.Status != laneFailed {
		c.JSON(409, gin.H{"error": "only a failed lane can be retried"})
		return
	}
	if lane.WorktreePath != "" {
		if _, err := os.Stat(lane.WorktreePath); err != nil {
			c.JSON(409, gin.H{"error": "the lane's worktree no longer exists"})
			return
		}
	}
	lane.Status = laneRunning
	lane.Error = ""
	lane.FinishedAt = nil
	lane.Attempts++
	lane.StartedAt = time.Now().UTC()
	db.DB.Save(&lane)
	if batch.Status != batchRunning {
		batch.Status = batchRunning
		batch.FinishedAt = nil
		db.DB.Save(&batch)
	}
	postChannelMessage(workspace.ID, batch.ChannelName, "system:parallel",
		fmt.Sprintf("Retrying @%s's part of the parallel batch (attempt %d).\n\n%s", lane.Agent, lane.Attempts, lane.Task),
		[]string{lane.Agent},
		map[string]interface{}{"parallel_batch": map[string]interface{}{
			"batch_id":  batch.ID,
			"isolation": batch.Isolation,
			"lanes": map[string]laneDispatch{lane.Agent: {
				Task: lane.Task, WorkingDir: lane.WorktreePath, Branch: lane.Branch, Scope: lane.Scope,
			}},
		}})
	c.JSON(200, gin.H{"lane": lane})
}

// ExpireStaleParallelLanes fails lanes that have been running past the
// timeout, so one hung agent cannot keep a batch open forever. Called by the
// scheduler.
func ExpireStaleParallelLanes() {
	if db.DB == nil {
		return
	}
	cutoff := time.Now().UTC().Add(-ParallelLaneTimeout())
	var stale []models.ParallelLaneRecord
	db.DB.Where("status = ? AND started_at < ?", laneRunning, cutoff).Find(&stale)
	for i := range stale {
		var batch models.ParallelBatchRecord
		if db.DB.Where("id = ?", stale[i].BatchID).Limit(1).Find(&batch).RowsAffected == 0 {
			continue
		}
		finishLane(&batch, &stale[i], true, fmt.Sprintf("timed out after %s without finishing", ParallelLaneTimeout()), "")
	}
}

// latestBatchView is the channel's most recent batch with its lanes, for the UI.
func latestBatchView(workspaceID, channelName string) gin.H {
	var batch models.ParallelBatchRecord
	if db.DB.Where("workspace_id = ? AND channel_name = ?", workspaceID, channelName).
		Order("created_at DESC").Limit(1).Find(&batch).RowsAffected == 0 {
		return nil
	}
	var lanes []models.ParallelLaneRecord
	db.DB.Where("batch_id = ?", batch.ID).Order("agent").Find(&lanes)
	return gin.H{"batch": batch, "lanes": lanes}
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
