package handlers

import (
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

/*
DELEGATION: AN AGENT HANDS WORK TO OTHER AGENTS, ISOLATED, AND HEARS BACK.

Before this, an agent could only delegate by writing "@bob ..." in its reply.
That woke bob in the shared project folder, with no branch, no review and no
way for the delegator to learn how it went. A delegation is now a parallel
batch (parallel_run.go) with origin "agent":

  - every lane gets its own git worktree and branch, as a human-started batch
    does, and its own mode/model from the saved profile it was given
    (work_profiles.go), so a Review lane cannot edit;
  - when the batch reaches review, or finishes, the summary is addressed to
    the delegator (delegatorNote), so it wakes with the result;
  - the merge still waits for the user's click -- an agent never merges.

Two ways in: the workspace_delegate tool (POST /delegations), and an agent
naming two or more agents in a parallel-mode thread (agentFanOut), which used
to run them one after another in the shared folder, uncommitted and unreviewed.

Guardrails: 1..maxDelegationLanes lanes, one agent per lane, every lane agent
online, one unfinished batch per channel (which is also why a lane cannot
delegate further: its own batch is still running), and in a project folder
that is not a git repository two editing lanes need disjoint scopes.
*/

// maxDelegationLanes caps one delegation. Lanes are long-running agent turns,
// each with a worktree and a port; past a handful nobody reviews them properly.
const maxDelegationLanes = 4

// maxDelegationTaskRunes bounds one lane's task text. A brief longer than this
// is a document; put it in a file or the knowledge base and point at it.
const maxDelegationTaskRunes = 8000

// DelegationTask is one lane of a delegation: either a saved profile or an
// agent by name (optionally with a mode), the task, and optionally the folder
// it is confined to.
type DelegationTask struct {
	Profile string `json:"profile,omitempty"`
	Agent   string `json:"agent,omitempty"`
	Mode    string `json:"mode,omitempty"`
	Task    string `json:"task"`
	Scope   string `json:"scope,omitempty"`
}

// DelegateRequest is POST /v1/workspaces/:workspace_id/delegations.
type DelegateRequest struct {
	Channel string           `json:"channel"`
	Source  string           `json:"source"`
	Tasks   []DelegationTask `json:"tasks"`
}

type delegationError struct {
	status int
	msg    string
}

func (e *delegationError) Error() string { return e.msg }

func delegationFail(status int, format string, args ...interface{}) *delegationError {
	return &delegationError{status: status, msg: fmt.Sprintf(format, args...)}
}

// delegationMu serialises the running-batch check and the batch insert of the
// tool path, so two delegations fired at once in one channel cannot both pass.
var delegationMu sync.Mutex

// workspaceAgents maps every lower-cased agent name in the workspace to its
// canonical spelling.
func workspaceAgents(database *gorm.DB, workspaceID string) map[string]string {
	var members []models.WorkspaceMember
	database.Where("workspace_id = ?", workspaceID).Find(&members)
	out := map[string]string{}
	for _, m := range members {
		if m.AgentName != "" && m.AgentName != noResponseAgent {
			out[strings.ToLower(m.AgentName)] = m.AgentName
		}
	}
	return out
}

func sortedValues(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for _, v := range m {
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}

// sharedFolderConflicts lists the pairs of editing lanes whose scopes overlap
// when the channel's project folder is NOT a git repository -- there the lanes
// share the folder, so only disjoint scopes keep them off each other's files.
// Review (plan) lanes do not edit and never conflict. No folder, or a git
// folder (one worktree per lane), means no conflicts.
func sharedFolderConflicts(channel *models.Channel, lanes []laneSpec, messageMode string) []string {
	if channel.WorkingDir == nil || strings.TrimSpace(*channel.WorkingDir) == "" || gitRepoRoot(*channel.WorkingDir) != "" {
		return nil
	}
	var conflicts []string
	for i := 0; i < len(lanes); i++ {
		for j := i + 1; j < len(lanes); j++ {
			a, b := lanes[i], lanes[j]
			if laneMode(a, messageMode) == "plan" || laneMode(b, messageMode) == "plan" {
				continue
			}
			if scopesOverlap(a.Scope, b.Scope) {
				conflicts = append(conflicts, fmt.Sprintf("@%s (%s) and @%s (%s)", a.Agent, scopeLabel(a.Scope), b.Agent, scopeLabel(b.Scope)))
			}
		}
	}
	return conflicts
}

func laneMode(l laneSpec, messageMode string) string {
	if l.Mode != "" {
		return l.Mode
	}
	return messageMode
}

func scopeLabel(scope string) string {
	if scope == "" {
		return "no scope: the whole folder"
	}
	return scope
}

// laneScope is a lane's declared scope, or the one its task text names.
func laneScope(declared, task string) string {
	if s := normaliseScope(declared); s != "" {
		return s
	}
	return inferScope(task)
}

// planDelegation validates a delegation and resolves each task to a lane.
func planDelegation(database *gorm.DB, workspaceID string, channel *models.Channel, delegator string, tasks []DelegationTask) ([]laneSpec, *delegationError) {
	if len(tasks) == 0 {
		return nil, delegationFail(http.StatusBadRequest, "give at least one task")
	}
	if len(tasks) > maxDelegationLanes {
		return nil, delegationFail(http.StatusBadRequest, "at most %d tasks per delegation (got %d); combine related work into one task", maxDelegationLanes, len(tasks))
	}
	agents := workspaceAgents(database, workspaceID)
	var profiles []models.WorkProfile
	database.Where("workspace_id = ?", workspaceID).Order("name").Find(&profiles)
	byName := map[string]models.WorkProfile{}
	profileNames := make([]string, 0, len(profiles))
	for _, p := range profiles {
		byName[strings.ToLower(p.Name)] = p
		profileNames = append(profileNames, p.Name)
	}

	lanes := make([]laneSpec, 0, len(tasks))
	seen := map[string]int{}
	for i, t := range tasks {
		n := i + 1
		task := strings.TrimSpace(t.Task)
		if task == "" {
			return nil, delegationFail(http.StatusBadRequest, "task %d is empty", n)
		}
		if len([]rune(task)) > maxDelegationTaskRunes {
			return nil, delegationFail(http.StatusBadRequest, "task %d is longer than %d characters; put the details in a file and point at it", n, maxDelegationTaskRunes)
		}
		profileName, agentName := strings.TrimSpace(t.Profile), strings.TrimPrefix(strings.TrimSpace(t.Agent), "@")
		var lane laneSpec
		switch {
		case profileName != "" && agentName != "":
			return nil, delegationFail(http.StatusBadRequest, "task %d: give either profile or agent, not both", n)
		case profileName != "":
			p, ok := byName[strings.ToLower(profileName)]
			if !ok {
				if len(profileNames) == 0 {
					return nil, delegationFail(http.StatusBadRequest, "task %d: no profile %q -- this workspace has no saved profiles; name an agent instead", n, profileName)
				}
				return nil, delegationFail(http.StatusBadRequest, "task %d: no profile %q; saved profiles: %s", n, profileName, strings.Join(profileNames, ", "))
			}
			if strings.TrimSpace(t.Mode) != "" {
				return nil, delegationFail(http.StatusBadRequest, "task %d: mode comes from profile %q; leave mode out or name an agent instead", n, p.Name)
			}
			canonical, ok := agents[strings.ToLower(p.Agent)]
			if !ok {
				return nil, delegationFail(http.StatusBadRequest, "task %d: profile %q points at @%s, which is no longer in this workspace", n, p.Name, p.Agent)
			}
			lane = laneSpec{Agent: canonical, Profile: p.Name, Mode: p.Mode, Model: p.Model}
		case agentName != "":
			canonical, ok := agents[strings.ToLower(agentName)]
			if !ok {
				return nil, delegationFail(http.StatusBadRequest, "task %d: no agent @%s in this workspace; agents: %s", n, agentName, strings.Join(sortedValues(agents), ", "))
			}
			mode := strings.ToLower(strings.TrimSpace(t.Mode))
			if mode == "" {
				mode = "execute"
			}
			if !validWorkMode(mode) {
				return nil, delegationFail(http.StatusBadRequest, "task %d: mode must be execute or plan", n)
			}
			lane = laneSpec{Agent: canonical, Mode: mode}
		default:
			return nil, delegationFail(http.StatusBadRequest, "task %d: give a profile or an agent", n)
		}
		if prev, dup := seen[strings.ToLower(lane.Agent)]; dup {
			// One agent runs one turn per channel at a time (the adapter's
			// channel worker), so two lanes for it would just run in sequence
			// on two branches -- give it one task with both parts instead.
			return nil, delegationFail(http.StatusBadRequest, "tasks %d and %d both go to @%s; each lane needs a different agent, so combine them into one task", prev, n, lane.Agent)
		}
		seen[strings.ToLower(lane.Agent)] = n
		lane.Task = task
		lane.Scope = laneScope(t.Scope, task)
		lanes = append(lanes, lane)
	}

	names := make([]string, 0, len(lanes))
	for _, l := range lanes {
		names = append(names, l.Agent)
	}
	online := onlineParticipants(database, workspaceID, names)
	var offline []string
	for _, name := range names {
		if !online[name] {
			offline = append(offline, "@"+name)
		}
	}
	if len(offline) > 0 {
		return nil, delegationFail(http.StatusConflict, "%s %s offline, so the work would sit unstarted; pick another profile or agent", strings.Join(offline, ", "), pluralVerb(len(offline)))
	}

	if b := runningBatch(database, workspaceID, channel.Name); b != nil {
		return nil, busyChannelError(database, b, delegator)
	}
	if conflicts := sharedFolderConflicts(channel, lanes, "execute"); len(conflicts) > 0 {
		return nil, delegationFail(http.StatusBadRequest,
			"this thread's folder is not a git repository, so the lanes would share it and these editing lanes overlap: %s. Give each one a scope (a folder only it changes), or make all but one a review (plan) lane",
			strings.Join(conflicts, "; "))
	}
	return lanes, nil
}

func pluralVerb(n int) string {
	if n == 1 {
		return "is"
	}
	return "are"
}

// busyChannelError explains why no batch can start: the channel's batch b is
// unfinished. A caller that is itself a running lane of b gets the depth rule.
func busyChannelError(database *gorm.DB, b *models.ParallelBatchRecord, caller string) *delegationError {
	var lane models.ParallelLaneRecord
	if caller != "" && database.Where("batch_id = ? AND LOWER(agent) = LOWER(?) AND status = ?", b.ID, caller, laneRunning).
		Limit(1).Find(&lane).RowsAffected > 0 {
		return delegationFail(http.StatusConflict,
			"you are running a lane of batch %s, and a lane cannot delegate further. Finish your part and say in your summary what else is needed", b.ID[:8])
	}
	if b.Status == batchReview {
		return delegationFail(http.StatusConflict,
			"batch %s in this thread is waiting for the user to merge or discard it; nothing new can start until they do. Tell the user, and delegate again after", b.ID[:8])
	}
	return delegationFail(http.StatusConflict,
		"batch %s is still running in this thread; only one batch runs per thread. Wait for its result (you are told if you started it) or ask the user", b.ID[:8])
}

// delegationDispatchText is the visible message that starts a delegation's
// lanes. Each lane's adapter puts its own part in front of it.
func delegationDispatchText(batch *models.ParallelBatchRecord, lanes []models.ParallelLaneRecord) string {
	var b strings.Builder
	noun := "task"
	if len(lanes) > 1 {
		noun = "tasks"
	}
	b.WriteString(fmt.Sprintf("**@%s delegated %d %s** (batch `%s`", batch.DelegatedBy, len(lanes), noun, batch.ID[:8]))
	if batch.Isolation == "worktree" {
		b.WriteString(", each in its own worktree")
	}
	b.WriteString(")\n\n")
	for _, l := range lanes {
		b.WriteString("- **@" + l.Agent + "**")
		var tags []string
		if l.Profile != "" {
			tags = append(tags, "profile `"+l.Profile+"`")
		}
		if l.Mode == "plan" {
			tags = append(tags, "Review")
		} else if l.Mode == "execute" {
			tags = append(tags, "Fix")
		}
		if l.Model != "" {
			tags = append(tags, "`"+l.Model+"`")
		}
		if len(tags) > 0 {
			b.WriteString(" (" + strings.Join(tags, ", ") + ")")
		}
		b.WriteString(": " + strings.ReplaceAll(truncateRunes(l.Task, 200), "\n", " ") + "\n")
	}
	return strings.TrimSpace(b.String())
}

// delegatorNote is what an agent-started batch tells its delegator when it
// reaches review or finishes, appended to the summary that wakes it. "" for
// batches nobody delegated.
func delegatorNote(batch *models.ParallelBatchRecord) string {
	if batch.DelegatedBy == "" {
		return ""
	}
	switch batch.Status {
	case batchReview:
		return fmt.Sprintf("@%s — this is the work you delegated (batch `%s`). Nothing is merged: the user reviews each lane above and clicks Merge or Discard. "+
			"Tell the user in a few lines what each lane did and what to check before merging. Do not merge, redo or re-delegate this work yourself. "+
			"Each lane's full reply is in this thread; workspace_delegation_status(\"%s\") returns them too.",
			batch.DelegatedBy, batch.ID[:8], batch.ID[:8])
	case batchDone:
		return fmt.Sprintf("@%s — the work you delegated (batch `%s`) has finished; the summary above says what was merged. "+
			"Check that it fits together and report the outcome to the user. Anything listed as failed or conflicting is the user's call: "+
			"do not delegate it again without asking them.",
			batch.DelegatedBy, batch.ID[:8])
	}
	return ""
}

// DelegateTasks handles POST /v1/workspaces/:workspace_id/delegations: an
// agent (workspace_delegate) starts a batch of lanes in its current thread.
func DelegateTasks(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	var req DelegateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	delegator := agentNameFromSource(strings.TrimSpace(req.Source))
	if delegator == "" || strings.Contains(delegator, ":") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "source must name the delegating agent, e.g. 52hz:alice"})
		return
	}
	channelName := strings.TrimPrefix(strings.TrimSpace(req.Channel), "channel/")
	var channel models.Channel
	if channelName == "" || db.DB.Where("workspace_id = ? AND name = ?", workspace.ID, channelName).Limit(1).Find(&channel).RowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "channel not found: " + channelName})
		return
	}

	delegationMu.Lock()
	lanes, derr := planDelegation(db.DB, workspace.ID, &channel, delegator, req.Tasks)
	if derr != nil {
		delegationMu.Unlock()
		c.JSON(derr.status, gin.H{"error": derr.msg})
		return
	}
	batch, records, err := createBatch(db.DB, workspace.ID, &channel, batchSpec{Origin: "agent", DelegatedBy: delegator, MinLanes: 1, Lanes: lanes})
	delegationMu.Unlock()
	if err == errBatchRunning {
		derr := busyChannelError(db.DB, runningBatch(db.DB, workspace.ID, channel.Name), delegator)
		c.JSON(derr.status, gin.H{"error": derr.msg})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not start the delegation: " + err.Error()})
		return
	}

	ptrs := make([]*models.ParallelLaneRecord, len(records))
	targets := make([]string, len(records))
	for i := range records {
		ptrs[i] = &records[i]
		targets[i] = records[i].Agent
	}
	meta := batchMeta(batch, ptrs...)
	publishBatchStarted(workspace.ID, channel.Name, meta)
	postChannelMessage(workspace.ID, channel.Name, "system:parallel", delegationDispatchText(batch, records), targets, map[string]interface{}{
		"parallel_batch": meta,
		"delegation":     gin.H{"batch_id": batch.ID, "delegated_by": delegator},
	})
	c.JSON(http.StatusOK, ParallelRunView{Batch: *batch, Lanes: records})
}

// findBatch loads a batch of the workspace by its id or the 8-character prefix
// every message shows.
func findBatch(workspaceID, id string) (*models.ParallelBatchRecord, bool) {
	id = strings.Trim(strings.TrimSpace(id), "`")
	if id == "" {
		return nil, false
	}
	var batch models.ParallelBatchRecord
	q := db.DB.Where("workspace_id = ?", workspaceID)
	if len(id) < 36 {
		if len(id) < 8 {
			return nil, false
		}
		q = q.Where("id LIKE ?", id+"%")
	} else {
		q = q.Where("id = ?", id)
	}
	if q.Order("created_at DESC").Limit(1).Find(&batch).RowsAffected == 0 {
		return nil, false
	}
	return &batch, true
}

// GetDelegation handles GET /v1/workspaces/:workspace_id/delegations/:batch_id
// (workspace_delegation_status): the batch with every lane.
func GetDelegation(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	batch, found := findBatch(workspace.ID, c.Param("batch_id"))
	if !found {
		c.JSON(http.StatusNotFound, gin.H{"error": "no batch " + c.Param("batch_id")})
		return
	}
	lanes := []models.ParallelLaneRecord{}
	db.DB.Where("batch_id = ?", batch.ID).Order("agent").Find(&lanes)
	c.JSON(http.StatusOK, ParallelRunView{Batch: *batch, Lanes: lanes})
}

// CancelDelegation handles POST /v1/workspaces/:workspace_id/delegations/:batch_id/cancel
// (workspace_cancel_delegation). Only the agent that delegated the batch may
// cancel it, and only while it runs; a batch in review is the user's to decide.
func CancelDelegation(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	var req struct {
		Source string `json:"source"`
	}
	_ = c.ShouldBindJSON(&req)
	caller := agentNameFromSource(strings.TrimSpace(req.Source))
	batch, found := findBatch(workspace.ID, c.Param("batch_id"))
	if !found {
		c.JSON(http.StatusNotFound, gin.H{"error": "no batch " + c.Param("batch_id")})
		return
	}
	if batch.DelegatedBy == "" || !strings.EqualFold(batch.DelegatedBy, caller) {
		who := "the user"
		if batch.DelegatedBy != "" {
			who = "@" + batch.DelegatedBy + " (who delegated it) or the user"
		}
		c.JSON(http.StatusForbidden, gin.H{"error": fmt.Sprintf("batch %s can only be stopped by %s", batch.ID[:8], who)})
		return
	}
	switch batch.Status {
	case batchRunning:
	case batchReview:
		c.JSON(http.StatusConflict, gin.H{"error": fmt.Sprintf("batch %s has finished and is waiting for the user to merge or discard it; that is their decision", batch.ID[:8])})
		return
	default:
		c.JSON(http.StatusConflict, gin.H{"error": fmt.Sprintf("batch %s is already %s", batch.ID[:8], batch.Status)})
		return
	}
	stopped := stopBatch(batch, "@"+batch.DelegatedBy, caller)
	lanes := []models.ParallelLaneRecord{}
	db.DB.Where("batch_id = ?", batch.ID).Order("agent").Find(&lanes)
	c.JSON(http.StatusOK, gin.H{"batch": batch, "lanes": lanes, "stopped": stopped})
}

// runningLaneAgents is the set (lower-cased) of agents running a lane of the
// channel's running batch. Such an agent is busy in its own worktree: an
// @mention of it must not wake it again in the shared folder.
func runningLaneAgents(database *gorm.DB, workspaceID, channelName string) map[string]bool {
	b := runningBatch(database, workspaceID, channelName)
	if b == nil || b.Status != batchRunning {
		return nil
	}
	var names []string
	database.Model(&models.ParallelLaneRecord{}).Where("batch_id = ? AND status = ?", b.ID, laneRunning).Pluck("agent", &names)
	out := map[string]bool{}
	for _, n := range names {
		out[strings.ToLower(n)] = true
	}
	return out
}

// agentFanOut turns an agent's reply that names two or more other agents in a
// parallel-mode thread into a delegated batch, the same as workspace_delegate:
// each named agent gets its part of the text in its own worktree, and the
// sender hears back when the batch is ready for review. Returns the
// parallel_batch metadata the routed reply carries, or a refusal to show in
// the thread (nothing is dispatched then).
func agentFanOut(tx *gorm.DB, workspaceID string, channel *models.Channel, req *SendEventRequest, sender string, targets, candidates []string) (map[string]interface{}, string) {
	names := "@" + strings.Join(targets, ", @")
	if b := runningBatch(tx, workspaceID, channel.Name); b != nil {
		return nil, fmt.Sprintf("@%s handed work to %s, but nothing was dispatched: %s", sender, names, busyChannelError(tx, b, sender).msg)
	}
	online := onlineParticipants(tx, workspaceID, targets)
	var offline []string
	for _, t := range targets {
		if !online[t] {
			offline = append(offline, "@"+t)
		}
	}
	if len(offline) > 0 {
		return nil, fmt.Sprintf("@%s handed work to %s, but nothing was dispatched: %s %s offline.", sender, names, strings.Join(offline, ", "), pluralVerb(len(offline)))
	}

	// Each agent's part is the text after its @name; an agent named with no
	// words of its own ("@bob @carol: review this") gets the whole message.
	// Either way the adapter puts the part in front of the whole message.
	tasks := laneTasksFromMessage(req, targets)
	content, _ := req.Payload["content"].(string)
	for _, seg := range parseAgentPipeline(content, candidates) {
		if part := strings.TrimSpace(seg.Instruction); part != "" {
			for _, t := range targets {
				if strings.EqualFold(t, seg.Agent) {
					tasks[t] = part
				}
			}
		}
	}
	messageMode, _ := req.Metadata["agent_mode"].(string)
	if messageMode == "" {
		messageMode = "execute"
	}
	spec := batchSpec{Origin: "agent", DelegatedBy: sender, MinLanes: 2}
	for _, t := range targets {
		spec.Lanes = append(spec.Lanes, laneSpec{Agent: t, Task: tasks[t], Scope: inferScope(tasks[t])})
	}
	if conflicts := sharedFolderConflicts(channel, spec.Lanes, messageMode); len(conflicts) > 0 {
		return nil, fmt.Sprintf("@%s handed work to %s, but nothing was dispatched: this thread's folder is not a git repository, so they would share it, and these parts overlap: %s. "+
			"Name the folder each one owns, or use a git project folder.", sender, names, strings.Join(conflicts, "; "))
	}
	batch, lanes, err := createBatch(tx, workspaceID, channel, spec)
	if err != nil {
		return nil, fmt.Sprintf("@%s handed work to %s, but the batch could not start: %v", sender, names, err)
	}
	ptrs := make([]*models.ParallelLaneRecord, len(lanes))
	for i := range lanes {
		ptrs[i] = &lanes[i]
	}
	return batchMeta(batch, ptrs...), ""
}
