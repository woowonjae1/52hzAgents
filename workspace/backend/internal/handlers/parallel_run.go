package handlers

import (
	"encoding/json"
	"fmt"
	"net"
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
    agent its task, its working directory, its branch and a dev-server port of
    its own (so two lanes never fight over 3000/5173). The adapter runs that
    turn in the lane's directory and reports back when the turn ends.
 3. finish: a lane that reports done has its worktree committed. When every
    lane is terminal and any lane has changes, the batch waits in "review":
    each lane's diff against the base is recorded and the user is asked to
    merge or discard. Nothing lands on the base branch without that click --
    agents asked to "check" something routinely edit code as well.
 4. merge (on the user's say-so): each committed branch is merged into the base
    branch, conflicting branches are kept (and everything, if the base tree has
    uncommitted work), merged worktrees are removed, and one summary is posted
    -- waking the master, when the channel has one, to review it. Discard
    removes every lane's worktree and branch instead.
 5. recovery: a lane can be retried on its own worktree; a lane silent past the
    timeout is failed by the scheduler so the batch can still finish.
*/

const (
	laneRunning  = "running"
	laneDone     = "done"
	laneFailed   = "failed"
	laneMerged   = "merged"
	laneConflict = "conflict"
	laneKept     = "kept"
	// laneDiscarded: the user discarded the batch; worktree and branch removed.
	laneDiscarded = "discarded"

	batchRunning = "running"
	// batchReview: every lane is terminal and there is something to merge; the
	// batch waits for the user to merge or discard it.
	batchReview = "review"
	batchDone   = "done"
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

// runningBatch is the channel's unfinished batch, if any -- running or waiting
// for review. A second batch is never started on top of one: its lanes would be
// branched from a base the first batch is about to merge into.
func runningBatch(tx *gorm.DB, workspaceID, channelName string) *models.ParallelBatchRecord {
	var b models.ParallelBatchRecord
	if tx.Where("workspace_id = ? AND channel_name = ? AND status IN ?", workspaceID, channelName, []string{batchRunning, batchReview}).
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
	Port       int    `json:"port,omitempty"`
}

func dispatchFor(lane *models.ParallelLaneRecord) laneDispatch {
	return laneDispatch{Task: lane.Task, WorkingDir: lane.WorktreePath, Branch: lane.Branch, Scope: lane.Scope, Port: lane.Port}
}

// laneBasePort is where lane dev-server ports start: lane ports are
// laneBasePort+1, +2, ... Two lanes that each start a dev server would
// otherwise both grab 3000/5173 and the Preview could only show one.
const laneBasePort = 4100

// portFree reports whether nothing is listening on 127.0.0.1:port.
func portFree(port int) bool {
	l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return false
	}
	_ = l.Close()
	return true
}

// allocateLanePorts picks n distinct ports counting up from laneBasePort+1,
// skipping ports that are listening now or reserved by a lane of another
// running batch (whose server may simply not be up yet). Deterministic: the
// same machine state gives the same ports. Returns fewer than n only if the
// search window is exhausted; missing lanes get port 0.
func allocateLanePorts(tx *gorm.DB, n int) []int {
	reserved := map[int]bool{}
	var taken []int
	tx.Model(&models.ParallelLaneRecord{}).
		Joins("JOIN parallel_batches ON parallel_batches.id = parallel_lanes.batch_id").
		Where("parallel_batches.status = ? AND parallel_lanes.port > 0", batchRunning).
		Pluck("parallel_lanes.port", &taken)
	for _, p := range taken {
		reserved[p] = true
	}
	ports := make([]int, 0, n)
	for p := laneBasePort + 1; len(ports) < n && p <= laneBasePort+500; p++ {
		if !reserved[p] && portFree(p) {
			ports = append(ports, p)
		}
	}
	return ports
}

// startParallelBatch records a batch for agents woken together and returns the
// metadata the routed message carries. Returns nil when no batch should be
// started (fewer than two agents, or one is already running).
func startParallelBatch(tx *gorm.DB, workspaceID string, channel *models.Channel, origin string, agents []string, tasks, scopes map[string]string) map[string]interface{} {
	if len(agents) < 2 || runningBatch(tx, workspaceID, channel.Name) != nil {
		return nil
	}
	now := time.Now().UTC()
	batch := models.ParallelBatchRecord{
		ID:          uuid.NewString(),
		WorkspaceID: workspaceID,
		ChannelName: channel.Name,
		Isolation:   "shared",
		Origin:      origin,
		Status:      batchRunning,
		CreatedAt:   now,
	}

	repo := ""
	if channel.WorkingDir != nil {
		repo = gitRepoRoot(*channel.WorkingDir)
	}
	lanes := make([]models.ParallelLaneRecord, 0, len(agents))
	ports := allocateLanePorts(tx, len(agents))
	for i, agent := range agents {
		port := 0
		if i < len(ports) {
			port = ports[i]
		}
		lanes = append(lanes, models.ParallelLaneRecord{
			ID: uuid.NewString(), BatchID: batch.ID, Agent: agent,
			Task: tasks[agent], Scope: scopes[agent], Status: laneRunning, StartedAt: now, Port: port,
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
		dispatch[lanes[i].Agent] = dispatchFor(&lanes[i])
	}
	// No state event here: tx is the routing transaction, which holds SQLite's
	// only write lock, and PublishWorkspaceStateEvent writes through db.DB. The
	// caller publishes it once the transaction commits (publishBatchStarted).
	return map[string]interface{}{
		"batch_id":  batch.ID,
		"isolation": batch.Isolation,
		"lanes":     dispatch,
	}
}

// publishBatchStarted records and broadcasts that a batch started. It writes
// through db.DB, so it must run after the routing transaction has committed.
func publishBatchStarted(workspaceID, channelName string, meta map[string]interface{}) {
	_ = PublishWorkspaceStateEvent(workspaceID, "workspace.parallel.batch", "system:parallel", channelName,
		gin.H{"batch_id": meta["batch_id"], "status": batchRunning})
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
		// A failed lane goes back to its agent, in its worktree, once, with the
		// error -- before the user is asked to review a batch with a hole in it.
		if bounceFailedLanes(batch) {
			return
		}
		if !enterReview(batch) {
			finalizeBatch(batch)
		}
	}
}

// bounceFailedLanes redispatches every failed lane that still has its automatic
// retry. Returns true if any went back, i.e. the batch is running again.
func bounceFailedLanes(batch *models.ParallelBatchRecord) bool {
	var failed []models.ParallelLaneRecord
	db.DB.Where("batch_id = ? AND status = ?", batch.ID, laneFailed).Order("agent").Find(&failed)
	bounced := false
	for i := range failed {
		lane := &failed[i]
		if !canBounce(lane) {
			continue
		}
		diag := strings.TrimSpace(lane.Error)
		if diag == "" {
			diag = "unknown failure"
		}
		redispatchLane(batch, lane, fmt.Sprintf("Your part of the parallel batch failed (%s). Look at what went wrong and finish it.", diag))
		bounced = true
	}
	return bounced
}

// baseRef is what lane branches are compared against and merged into.
func baseRef(batch *models.ParallelBatchRecord) string {
	if b := strings.TrimSpace(batch.BaseBranch); b != "" && b != "HEAD" {
		return b
	}
	return "HEAD"
}

// laneAhead counts the commits on the lane's branch that the base lacks. This,
// not lane.Commit, is what decides whether there is anything to merge: an agent
// that committed on its own branch leaves the worktree clean, so commitLane
// returns "" although the branch carries work.
func laneAhead(batch *models.ParallelBatchRecord, lane *models.ParallelLaneRecord) int {
	if batch.Isolation != "worktree" || lane.Branch == "" {
		return 0
	}
	out, err := runGit(batch.RepoDir, "rev-list", "--count", baseRef(batch)+".."+lane.Branch)
	if err != nil {
		return 0
	}
	var n int
	_, _ = fmt.Sscanf(strings.TrimSpace(out), "%d", &n)
	return n
}

// enterReview parks a batch whose lanes have all ended and that has something
// to merge, recording each lane's diff and asking the user to merge or
// discard. Returns false when there is nothing to review (shared folder, or no
// lane changed anything), in which case the caller finalizes directly.
func enterReview(batch *models.ParallelBatchRecord) bool {
	if batch.Isolation != "worktree" {
		return false
	}
	var lanes []models.ParallelLaneRecord
	db.DB.Where("batch_id = ?", batch.ID).Order("agent").Find(&lanes)
	pending := 0
	for i := range lanes {
		lane := &lanes[i]
		if lane.Status != laneDone || laneAhead(batch, lane) == 0 {
			continue
		}
		pending++
		diffRange := baseRef(batch) + "..." + lane.Branch
		if st, err := runGit(batch.RepoDir, "diff", "--shortstat", diffRange); err == nil {
			lane.Diffstat = strings.TrimSpace(st)
		}
		if names, err := runGit(batch.RepoDir, "diff", "--name-only", diffRange); err == nil {
			files := strings.Split(strings.TrimSpace(names), "\n")
			if len(files) > 50 {
				files = append(files[:50], fmt.Sprintf("… and %d more", len(files)-50))
			}
			lane.ChangedFiles = strings.Join(files, "\n")
		}
		db.DB.Save(lane)
	}
	if pending == 0 {
		return false
	}

	batch.Status = batchReview
	batch.Summary = reviewSummary(batch, lanes)
	db.DB.Save(batch)
	_ = PublishWorkspaceStateEvent(batch.WorkspaceID, "workspace.parallel.batch", "system:parallel", batch.ChannelName, gin.H{"batch_id": batch.ID, "status": batch.Status})
	postChannelMessage(batch.WorkspaceID, batch.ChannelName, "system:parallel", batch.Summary, nil, map[string]interface{}{
		"parallel_summary": gin.H{"batch_id": batch.ID, "review": true},
	})
	return true
}

func reviewSummary(batch *models.ParallelBatchRecord, lanes []models.ParallelLaneRecord) string {
	var b strings.Builder
	b.WriteString(fmt.Sprintf("**Parallel batch ready for review** — nothing has been merged into `%s` yet. Review each lane, then Merge or Discard in the panel above.\n\n", baseRef(batch)))
	for _, l := range lanes {
		switch {
		case l.Status == laneFailed:
			b.WriteString(fmt.Sprintf("❌ **@%s** — failed", l.Agent))
			if l.Error != "" {
				b.WriteString(" · " + l.Error)
			}
		case l.Diffstat != "":
			b.WriteString(fmt.Sprintf("📝 **@%s** — %s · branch `%s`", l.Agent, l.Diffstat, l.Branch))
		default:
			b.WriteString(fmt.Sprintf("✅ **@%s** — no file changes", l.Agent))
		}
		b.WriteString("\n")
		if l.Reply != "" {
			b.WriteString("  > " + strings.ReplaceAll(truncateRunes(l.Reply, 280), "\n", " ") + "\n")
		}
	}
	return strings.TrimSpace(b.String())
}

func hasKeptLanes(batchID string) bool {
	var count int64
	db.DB.Model(&models.ParallelLaneRecord{}).Where("batch_id = ? AND status = ?", batchID, laneKept).Count(&count)
	return count > 0
}

// batchForReview loads the batch named in the URL and checks it is waiting for
// review, or is a finished batch with kept lanes ready for a re-merge.
func batchForReview(c *gin.Context) *models.ParallelBatchRecord {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return nil
	}
	var batch models.ParallelBatchRecord
	if db.DB.Where("id = ? AND workspace_id = ?", c.Param("batch_id"), workspace.ID).Limit(1).Find(&batch).RowsAffected == 0 {
		c.JSON(404, gin.H{"error": "batch not found"})
		return nil
	}
	if batch.Status != batchReview && !(batch.Status == batchDone && hasKeptLanes(batch.ID)) {
		c.JSON(409, gin.H{"error": "the batch is not waiting for review or re-merge", "status": batch.Status})
		return nil
	}
	return &batch
}

// MergeParallelBatch handles POST /v1/workspaces/:ws/parallel-batches/:batch_id/merge:
// the user approved the batch, so its lanes are merged into the base branch.
func MergeParallelBatch(c *gin.Context) {
	batch := batchForReview(c)
	if batch == nil {
		return
	}
	finalizeBatch(batch)
	c.JSON(200, gin.H{"batch": batch})
}

// DiscardParallelBatch handles POST /v1/workspaces/:ws/parallel-batches/:batch_id/discard:
// every lane's worktree and branch is removed and nothing is merged.
func DiscardParallelBatch(c *gin.Context) {
	batch := batchForReview(c)
	if batch == nil {
		return
	}
	discardBatch(batch)
	c.JSON(200, gin.H{"batch": batch})
}

func discardBatch(batch *models.ParallelBatchRecord) {
	var lanes []models.ParallelLaneRecord
	db.DB.Where("batch_id = ?", batch.ID).Order("agent").Find(&lanes)
	for i := range lanes {
		lane := &lanes[i]
		if lane.WorktreePath != "" {
			_ = RemoveGitWorktree(batch.RepoDir, lane.WorktreePath, true)
		}
		if lane.Branch != "" {
			_, _ = runGit(batch.RepoDir, "branch", "-D", lane.Branch)
		}
		if lane.Status == laneDone || lane.Status == laneFailed || lane.Status == laneKept {
			lane.Status = laneDiscarded
		}
		db.DB.Save(lane)
	}
	now := time.Now().UTC()
	batch.Status = batchDone
	batch.FinishedAt = &now
	batch.Summary = fmt.Sprintf("**Parallel batch discarded** — nothing was merged into `%s`; every lane's worktree and branch was removed.", baseRef(batch))
	db.DB.Save(batch)

	if batch.Origin == "board" {
		var laneAgents []string
		for _, l := range lanes {
			laneAgents = append(laneAgents, l.Agent)
		}
		if len(laneAgents) > 0 {
			db.DB.Model(&models.TodoRecord{}).
				Where("workspace_id = ? AND channel_name = ? AND assignee IN ? AND status = ?",
					batch.WorkspaceID, batch.ChannelName, laneAgents, "completed").
				Updates(map[string]interface{}{"status": "pending", "completed_at": gorm.Expr("NULL")})
			_ = PublishWorkspaceStateEvent(batch.WorkspaceID, "workspace.todos.updated", "system:parallel", batch.ChannelName, gin.H{"status": "pending"})
		}
	}

	_ = PublishWorkspaceStateEvent(batch.WorkspaceID, "workspace.parallel.batch", "system:parallel", batch.ChannelName, gin.H{"batch_id": batch.ID, "status": batch.Status})
	postChannelMessage(batch.WorkspaceID, batch.ChannelName, "system:parallel", batch.Summary, nil, map[string]interface{}{
		"parallel_summary": gin.H{"batch_id": batch.ID},
	})
}

// ParallelResumeMetadata is the `parallel_batch` metadata that wakes agent back
// into its lane of batchID -- for a timer the agent set from inside the lane to
// pause its own work. nil when that lane is no longer running (finished,
// failed or timed out), so the timer then fires as an ordinary reminder.
func ParallelResumeMetadata(batchID, agent string) map[string]interface{} {
	if db.DB == nil || strings.TrimSpace(batchID) == "" {
		return nil
	}
	var batch models.ParallelBatchRecord
	if db.DB.Where("id = ?", batchID).Limit(1).Find(&batch).RowsAffected == 0 {
		return nil
	}
	var lane models.ParallelLaneRecord
	if db.DB.Where("batch_id = ? AND LOWER(agent) = LOWER(?) AND status = ?", batchID, agent, laneRunning).
		Limit(1).Find(&lane).RowsAffected == 0 {
		return nil
	}
	return map[string]interface{}{
		"batch_id":  batch.ID,
		"isolation": batch.Isolation,
		"resume":    true,
		"lanes":     map[string]laneDispatch{lane.Agent: dispatchFor(&lane)},
	}
}

// mergeIdentityArgs supplies a committer for the merge commit when the host
// has no git identity. A --no-ff merge IS a commit; without one it failed with
// "Committer identity unknown" and every lane was reported as a conflict.
// A configured identity is left alone.
func mergeIdentityArgs(repo string) []string {
	if _, err := runGit(repo, "config", "user.email"); err == nil {
		if _, err := runGit(repo, "config", "user.name"); err == nil {
			return nil
		}
	}
	return []string{"-c", "user.name=52hzAgents", "-c", "user.email=bot@52hzagents.local"}
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
		if batch.Isolation != "worktree" || (lane.Status != laneDone && lane.Status != laneKept) {
			continue
		}
		switch {
		case laneAhead(batch, lane) == 0:
			// Nothing to merge: the lane's branch carries no commits.
			lane.Status = laneMerged
		case baseDirty != "":
			lane.Status = laneKept
		default:
			mergeArgs := append(mergeIdentityArgs(batch.RepoDir), "merge", "--no-ff", "--no-edit", lane.Branch)
			if _, err := runGit(batch.RepoDir, mergeArgs...); err != nil {
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
			if batch.Origin == "board" {
				now := time.Now().UTC()
				db.DB.Model(&models.TodoRecord{}).
					Where("workspace_id = ? AND channel_name = ? AND assignee = ? AND status IN ?",
						batch.WorkspaceID, batch.ChannelName, lane.Agent, openTodoStatuses).
					Updates(map[string]interface{}{"status": "completed", "completed_at": now})
			}
		}
		db.DB.Save(lane)
	}

	now := time.Now().UTC()
	batch.Status = batchDone
	batch.FinishedAt = &now
	batch.Summary = batchSummary(batch, lanes, baseDirty)
	db.DB.Save(batch)
	_ = PublishWorkspaceStateEvent(batch.WorkspaceID, "workspace.parallel.batch", "system:parallel", batch.ChannelName, gin.H{"batch_id": batch.ID, "status": batch.Status})

	// Wake the master to review, or bounce issues back to responsible lane agents
	var targets []string
	var channel models.Channel
	hasMaster := db.DB.Where("workspace_id = ? AND name = ?", batch.WorkspaceID, batch.ChannelName).Limit(1).Find(&channel).RowsAffected > 0 &&
		channel.MasterAgent != nil && *channel.MasterAgent != ""
	if hasMaster {
		isLane := false
		for _, l := range lanes {
			if strings.EqualFold(l.Agent, *channel.MasterAgent) {
				isLane = true
			}
		}
		if !isLane {
			targets = append(targets, *channel.MasterAgent)
		}
	}

	content := batch.Summary
	if hasMaster && len(targets) > 0 {
		content += "\n\n@" + *channel.MasterAgent + " please review the combined result above: check the merged changes fit together, and resolve or report anything listed as a conflict or failure."
	}
	postChannelMessage(batch.WorkspaceID, batch.ChannelName, "system:parallel", content, targets, map[string]interface{}{
		"parallel_summary": gin.H{"batch_id": batch.ID},
	})
	// A lane whose branch conflicts goes back to its agent, in its worktree, to
	// merge the base in and resolve it; it then returns to review like any lane.
	base := baseRef(batch)
	for i := range lanes {
		lane := &lanes[i]
		if lane.Status != laneConflict || !canBounce(lane) {
			continue
		}
		redispatchLane(batch, lane, fmt.Sprintf(
			"Your branch `%s` conflicts with `%s`, so it was not merged. For this run only: in your worktree run `git merge %s`, resolve every conflict, and leave the result uncommitted -- it is committed for you.",
			lane.Branch, base, base))
	}
}

func batchSummary(batch *models.ParallelBatchRecord, lanes []models.ParallelLaneRecord, baseDirty string) string {
	var b strings.Builder
	b.WriteString("**Parallel batch finished**")
	if batch.Isolation == "worktree" && batch.BaseBranch != "" {
		// The headline must say what the merge step actually did. Claiming
		// "merged into main" when every lane conflicted, failed or was kept
		// tells the user their work landed when none of it did.
		merged := 0
		for _, l := range lanes {
			if l.Status == laneMerged {
				merged++
			}
		}
		switch {
		case merged == 0:
			b.WriteString(fmt.Sprintf(" — nothing was merged into `%s`", batch.BaseBranch))
		case merged < len(lanes):
			b.WriteString(fmt.Sprintf(" — %d of %d lanes merged into `%s`", merged, len(lanes), batch.BaseBranch))
		default:
			b.WriteString(fmt.Sprintf(" — merged into `%s`", batch.BaseBranch))
		}
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

// StopParallelBatch handles POST /v1/workspaces/:workspace_id/parallel-batches/:batch_id/stop.
// Cancels all running lanes in the batch immediately and halts associated turns.
func StopParallelBatch(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	var batch models.ParallelBatchRecord
	if db.DB.Where("id = ? AND workspace_id = ?", c.Param("batch_id"), workspace.ID).Limit(1).Find(&batch).RowsAffected == 0 {
		c.JSON(404, gin.H{"error": "batch not found"})
		return
	}
	if batch.Status != batchRunning {
		c.JSON(409, gin.H{"error": "batch is not running"})
		return
	}

	var lanes []models.ParallelLaneRecord
	db.DB.Where("batch_id = ?", batch.ID).Find(&lanes)

	var channel models.Channel
	_ = db.DB.Where("id = ? OR name = ?", batch.ChannelName, batch.ChannelName).First(&channel).Error

	stoppedAny := false
	for i := range lanes {
		lane := &lanes[i]
		if lane.Status == laneRunning {
			lane.Status = laneFailed
			lane.Error = "Stopped by user"
			now := time.Now().UTC()
			lane.FinishedAt = &now
			db.DB.Save(lane)
			if channel.ID != "" {
				closeAgentTurn(workspace.ID, &channel, lane.Agent)
			}
			stoppedAny = true
			_ = PublishWorkspaceStateEvent(batch.WorkspaceID, "workspace.parallel.lane", "system:parallel", batch.ChannelName, gin.H{"batch_id": batch.ID, "lane": lane})
		}
	}

	anyDoneWithChanges := false
	for _, l := range lanes {
		if l.Status == laneDone && l.Diffstat != "" {
			anyDoneWithChanges = true
			break
		}
	}

	now := time.Now().UTC()
	if anyDoneWithChanges {
		batch.Status = batchReview
	} else {
		batch.Status = batchDone
		batch.FinishedAt = &now
	}
	db.DB.Save(&batch)

	_ = PublishWorkspaceStateEvent(batch.WorkspaceID, "workspace.parallel.batch", "system:parallel", batch.ChannelName, gin.H{"batch": batch})
	postChannelMessage(batch.WorkspaceID, batch.ChannelName, "system:parallel",
		"Parallel batch stopped by user.",
		nil,
		map[string]interface{}{"parallel_batch_stopped": true, "batch_id": batch.ID},
	)

	c.JSON(200, gin.H{"batch": batch, "stopped": stoppedAny})
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
	redispatchLane(&batch, &lane, fmt.Sprintf("Retrying @%s's part of the parallel batch (attempt %d).", lane.Agent, lane.Attempts+1))
	c.JSON(200, gin.H{"lane": lane})
}

// redispatchLane runs a lane again in its OWN worktree: the message carries the
// lane's parallel_batch metadata, so the adapter enters the worktree with the
// lane brief (no commits, no branch switching) exactly as on the first run.
// Waking the agent with a plain @mention instead would run it in the channel's
// project folder -- the main checkout -- with none of those rules.
func redispatchLane(batch *models.ParallelBatchRecord, lane *models.ParallelLaneRecord, note string) {
	lane.Status = laneRunning
	lane.Error = ""
	lane.FinishedAt = nil
	lane.Attempts++
	lane.StartedAt = time.Now().UTC()
	db.DB.Save(lane)
	if batch.Status != batchRunning {
		batch.Status = batchRunning
		batch.FinishedAt = nil
		db.DB.Save(batch)
	}
	_ = PublishWorkspaceStateEvent(batch.WorkspaceID, "workspace.parallel.lane", "system:parallel", batch.ChannelName, gin.H{"batch_id": batch.ID, "lane": lane})
	postChannelMessage(batch.WorkspaceID, batch.ChannelName, "system:parallel",
		strings.TrimSpace(note+"\n\n"+lane.Task),
		[]string{lane.Agent},
		map[string]interface{}{"parallel_batch": map[string]interface{}{
			"batch_id":  batch.ID,
			"isolation": batch.Isolation,
			"lanes":     map[string]laneDispatch{lane.Agent: dispatchFor(lane)},
		}})
}

// maxAutoBounces is how many times a lane is sent back automatically (after a
// failure, or to resolve a merge conflict) before it is left for the user. One:
// a lane that fails twice needs a person, and more would let a broken lane loop.
const maxAutoBounces = 1

// canBounce reports whether lane may be sent back on its own: it has not used
// its automatic retry, and its worktree (when it has one) still exists.
func canBounce(lane *models.ParallelLaneRecord) bool {
	if lane.Attempts > maxAutoBounces {
		return false
	}
	if lane.WorktreePath != "" {
		if _, err := os.Stat(lane.WorktreePath); err != nil {
			return false
		}
	}
	return true
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

// ParallelRunView is a batch that was actually started, with its lanes: the
// `run` of GET /v1/parallel-batch.
type ParallelRunView struct {
	Batch models.ParallelBatchRecord  `json:"batch"`
	Lanes []models.ParallelLaneRecord `json:"lanes"`
}

// latestBatchView is the channel's most recent batch with its lanes, for the UI.
func latestBatchView(workspaceID, channelName string) *ParallelRunView {
	var batch models.ParallelBatchRecord
	if db.DB.Where("workspace_id = ? AND channel_name = ?", workspaceID, channelName).
		Order("created_at DESC").Limit(1).Find(&batch).RowsAffected == 0 {
		return nil
	}
	lanes := []models.ParallelLaneRecord{}
	db.DB.Where("batch_id = ?", batch.ID).Order("agent").Find(&lanes)
	return &ParallelRunView{Batch: batch, Lanes: lanes}
}

func truncateRunes(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
