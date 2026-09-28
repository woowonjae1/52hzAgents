package handlers

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

/*
ROUTINE LIFECYCLE: PROPOSAL, APPROVAL, RUN OUTCOME, AUTO-PAUSE.

A routine used to go live the moment anything POSTed it, and nothing ever
stopped one. An agent scheduled itself a "Daily" summary on a 30-minute
interval, its agent went offline, and the routine failed 139 times in a row,
dropping a high-priority board task on every fire. The rules now:

  - A routine an agent creates starts as pending_approval and does not fire
    until a person approves it. A person creating one is not asked.
  - An agent may not schedule itself more often than every 15 minutes.
  - Three failed runs in a row pause the routine, with the reason on the row.
  - A run completes when the agent's TURN ends (its own turn-state report),
    and records what it produced: the last reply and the files it registered.
*/

const (
	RoutineStatusActive          = "active"
	RoutineStatusPaused          = "paused"
	RoutineStatusPendingApproval = "pending_approval"
	RoutineStatusCancelled       = "cancelled"

	// agentRoutineMinIntervalMinutes is the tightest interval an agent may
	// schedule. People keep the old 1-minute floor.
	agentRoutineMinIntervalMinutes = 15
	// routineAutoPauseAfter consecutive failed runs pause the routine.
	routineAutoPauseAfter = 3
	// routineResultMaxRunes bounds the stored reply excerpt.
	routineResultMaxRunes = 2000
	// routineLateCaptureWindow is how long after a run completes a late reply
	// or file registration is still attributed to it. The adapter registers the
	// files it wrote only AFTER it has reported the turn idle.
	routineLateCaptureWindow = 2 * time.Minute
	// routineTurnTolerance absorbs ordering noise between the run insert and
	// the agent's `running` report (both server clocks).
	routineTurnTolerance = time.Second
)

// isHumanRequester reports whether a CreateRoutine caller said it is a person.
// The UI sends requested_by = "human:<id>"; agents (MCP tool, curl, adapters)
// send nothing, so they fall on the proposal side by default.
func isHumanRequester(requestedBy string) bool {
	r := strings.ToLower(strings.TrimSpace(requestedBy))
	return strings.HasPrefix(r, "human:") || strings.HasPrefix(r, "user:")
}

// agentSourceVariants lists every spelling an agent's events are stored under.
func agentSourceVariants(agent string) []string {
	return []string{agent, "52hz:" + agent, "52hzAgents:" + agent, "agent:" + agent, "openagents:" + agent}
}

// RoutineScheduleText renders a routine's timing in plain English, e.g.
// "every 30 min", "daily at 10:00 (Asia/Shanghai)", "weekdays at 09:00".
func RoutineScheduleText(r *models.RoutineRecord) string {
	if r.ScheduleIntervalMinutes != nil && *r.ScheduleIntervalMinutes > 0 {
		m := *r.ScheduleIntervalMinutes
		switch {
		case m%1440 == 0 && m/1440 == 1:
			return "every 24 hours"
		case m%1440 == 0:
			return fmt.Sprintf("every %d days", m/1440)
		case m%60 == 0 && m/60 == 1:
			return "every hour"
		case m%60 == 0:
			return fmt.Sprintf("every %d hours", m/60)
		case m > 60:
			return fmt.Sprintf("every %dh %dm", m/60, m%60)
		default:
			return fmt.Sprintf("every %d min", m)
		}
	}
	h, mi := 0, 0
	if r.ScheduleHour != nil {
		h = *r.ScheduleHour
	}
	if r.ScheduleMinute != nil {
		mi = *r.ScheduleMinute
	}
	clock := fmt.Sprintf("%02d:%02d", h, mi)
	if r.Timezone != "" && !strings.EqualFold(r.Timezone, "UTC") {
		clock += " (" + r.Timezone + ")"
	} else {
		clock += " UTC"
	}
	var days []int
	if len(r.ScheduleDays) > 0 {
		_ = json.Unmarshal(r.ScheduleDays, &days)
	}
	names := []string{"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"}
	set := map[int]bool{}
	for _, d := range days {
		set[d] = true
	}
	switch {
	case len(set) == 0 || len(set) == 7:
		return "daily at " + clock
	case len(set) == 5 && set[0] && set[1] && set[2] && set[3] && set[4]:
		return "weekdays at " + clock
	case len(set) == 2 && set[5] && set[6]:
		return "weekends at " + clock
	}
	sorted := make([]int, 0, len(set))
	for d := range set {
		sorted = append(sorted, d)
	}
	sort.Ints(sorted)
	parts := make([]string, 0, len(sorted))
	for _, d := range sorted {
		if d >= 0 && d < len(names) {
			parts = append(parts, names[d])
		}
	}
	return strings.Join(parts, ", ") + " at " + clock
}

// noMention keeps system text from waking an agent: adapters treat any
// "@name" in a message as addressed to them.
func noMention(s string) string { return strings.ReplaceAll(s, "@", "") }

// postRoutineProposal announces an agent-created routine in the channel the
// agent was talking in (falling back to the routine's own channel). No target
// agents: this is for the person, and nobody should answer it.
func postRoutineProposal(r *models.RoutineRecord, channel string) {
	if channel == "" || !channelExists(r.WorkspaceID, channel) {
		channel = r.ChannelName
	}
	schedule := RoutineScheduleText(r)
	content := fmt.Sprintf(
		"%s proposed a recurring routine: \"%s\" (%s), %s. It will not run until you approve it.",
		r.CreatedBy, noMention(r.Name), r.ShortID, schedule)
	postChannelMessage(r.WorkspaceID, channel, "system:routine", content, nil, map[string]interface{}{
		"routine_proposal": map[string]interface{}{
			"routine_id":    r.ID,
			"short_id":      r.ShortID,
			"name":          r.Name,
			"schedule_text": schedule,
			"created_by":    r.CreatedBy,
		},
	})
}

func channelExists(workspaceID, name string) bool {
	var n int64
	db.DB.Model(&models.Channel{}).Where("workspace_id = ? AND name = ?", workspaceID, name).Count(&n)
	return n > 0
}

// loadRoutineForAction resolves :routine_id and authorizes the caller.
func loadRoutineForAction(c *gin.Context) (*models.RoutineRecord, *models.Workspace, bool) {
	var record models.RoutineRecord
	if err := db.DB.Where("id = ?", c.Param("routine_id")).First(&record).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Routine record not found"})
		return nil, nil, false
	}
	workspace, err := resolveWorkspace(record.WorkspaceID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Workspace not found"})
		return nil, nil, false
	}
	if !authorizeResourceOwner(c, workspace, record.CreatedBy) {
		return nil, nil, false
	}
	return &record, workspace, true
}

// ApproveRoutine handles POST /v1/routines/:routine_id/approve: a proposed
// routine goes live and gets its first fire time.
func ApproveRoutine(c *gin.Context) {
	record, workspace, ok := loadRoutineForAction(c)
	if !ok {
		return
	}
	next := nextRoutineFire(record)
	res := db.DB.Model(&models.RoutineRecord{}).
		Where("id = ? AND status = ?", record.ID, RoutineStatusPendingApproval).
		Updates(map[string]interface{}{
			"status":               RoutineStatusActive,
			"next_fires_at":        next,
			"paused_reason":        nil,
			"consecutive_failures": 0,
		})
	if res.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to approve routine"})
		return
	}
	if res.RowsAffected == 0 {
		c.JSON(http.StatusConflict, gin.H{"error": fmt.Sprintf("Routine is %s, not waiting for approval", record.Status), "status": record.Status})
		return
	}
	record.Status = RoutineStatusActive
	record.NextFiresAt = next
	record.PausedReason = nil
	record.ConsecutiveFailures = 0
	_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.routine.updated", record.CreatedBy, record.ChannelName, gin.H{"routine": record})
	c.JSON(http.StatusOK, record)
}

// RejectRoutine handles POST /v1/routines/:routine_id/reject: a proposed
// routine is cancelled without ever running.
func RejectRoutine(c *gin.Context) {
	record, workspace, ok := loadRoutineForAction(c)
	if !ok {
		return
	}
	res := db.DB.Model(&models.RoutineRecord{}).
		Where("id = ? AND status = ?", record.ID, RoutineStatusPendingApproval).
		Update("status", RoutineStatusCancelled)
	if res.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to reject routine"})
		return
	}
	if res.RowsAffected == 0 {
		c.JSON(http.StatusConflict, gin.H{"error": fmt.Sprintf("Routine is %s, not waiting for approval", record.Status), "status": record.Status})
		return
	}
	record.Status = RoutineStatusCancelled
	// "updated" as well as "cancelled": the workspace context refreshes its
	// routine list on updated, and the proposal card reads from that list.
	_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.routine.cancelled", record.CreatedBy, record.ChannelName, gin.H{"routine": record})
	_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.routine.updated", record.CreatedBy, record.ChannelName, gin.H{"routine": record})
	c.JSON(http.StatusOK, record)
}

// ---------------------------------------------------------------------------
// Run outcome
// ---------------------------------------------------------------------------

// runWindowEnd is the upper bound for attributing replies and files to a run.
func runWindowEnd(run *models.RoutineRunRecord, now time.Time) time.Time {
	if run.CompletedAt != nil {
		return run.CompletedAt.Add(routineLateCaptureWindow)
	}
	return now.Add(routineLateCaptureWindow)
}

// lastAgentReply finds the agent's last chat message in the run's channel
// inside [run start, end]. Thinking, status and tool-call events are skipped:
// only a chat message is a reply.
func lastAgentReply(run *models.RoutineRunRecord, end time.Time) (content, eventID string, ok bool) {
	var rows []models.EventRecord
	if err := db.DB.
		Where("network_id = ? AND target = ? AND type = ? AND source IN ? AND timestamp >= ? AND timestamp <= ?",
			run.WorkspaceID, "channel/"+run.ChannelName, "workspace.message.posted",
			agentSourceVariants(run.AgentName), run.StartedAt.UnixMilli()-routineTurnTolerance.Milliseconds(), end.UnixMilli()).
		Order("timestamp desc").Limit(50).Find(&rows).Error; err != nil {
		return "", "", false
	}
	for _, row := range rows {
		var payload map[string]interface{}
		if len(row.Payload) > 0 {
			_ = json.Unmarshal(row.Payload, &payload)
		}
		if messageType(payload) != "chat" {
			continue
		}
		text, _ := payload["content"].(string)
		if strings.TrimSpace(text) == "" {
			continue
		}
		return truncateRunes(strings.TrimSpace(text), routineResultMaxRunes), row.ID, true
	}
	return "", "", false
}

// filesRegisteredDuring lists files the agent registered in the run's channel
// inside [run start, end], oldest first, deduplicated. Compared in Go: the
// files table stores local time and runs store UTC, and SQLite compares the
// two as strings.
func filesRegisteredDuring(run *models.RoutineRunRecord, end time.Time) []string {
	var files []models.FileRecord
	if err := db.DB.
		Where("workspace_id = ? AND channel_name = ? AND uploaded_by IN ? AND status = ?",
			run.WorkspaceID, run.ChannelName, agentSourceVariants(run.AgentName), "active").
		Order("created_at asc").Limit(500).Find(&files).Error; err != nil {
		return nil
	}
	start := run.StartedAt.Add(-routineTurnTolerance)
	seen := map[string]bool{}
	var names []string
	for _, f := range files {
		if f.CreatedAt.Before(start) || f.CreatedAt.After(end) || seen[f.Filename] {
			continue
		}
		seen[f.Filename] = true
		names = append(names, f.Filename)
	}
	return names
}

// runOutcomeUpdates is the result/result_message_id/files_changed triple.
func runOutcomeUpdates(run *models.RoutineRunRecord, end time.Time) map[string]interface{} {
	updates := map[string]interface{}{}
	if text, id, ok := lastAgentReply(run, end); ok {
		updates["result"] = text
		updates["result_message_id"] = id
	}
	if files := filesRegisteredDuring(run, end); len(files) > 0 {
		updates["files_changed"] = strings.Join(files, "\n")
	}
	return updates
}

// CompleteRoutineRun lands a running run as completed, capturing its outcome.
// Returns false when the run had already left `running` (someone else settled
// it first). `via` is recorded in the state event for diagnosis.
func CompleteRoutineRun(run models.RoutineRunRecord, source, via string) bool {
	now := time.Now().UTC()
	updates := runOutcomeUpdates(&run, now)
	updates["status"] = "completed"
	updates["completed_at"] = &now
	res := db.DB.Model(&models.RoutineRunRecord{}).Where("id = ? AND status = ?", run.ID, "running").Updates(updates)
	if res.Error != nil || res.RowsAffected == 0 {
		return false
	}
	db.DB.Model(&models.RoutineRecord{}).Where("id = ?", run.RoutineID).Updates(map[string]interface{}{
		"last_run_status":      "completed",
		"last_run_error":       nil,
		"consecutive_failures": 0,
	})
	// Runs no longer open board tasks; this closes the ones older runs left.
	if err := db.DB.Model(&models.TodoRecord{}).Where("run_id = ? AND status = ?", run.ID, "in_progress").Updates(map[string]interface{}{
		"status":       "completed",
		"completed_at": &now,
		"updated_at":   now,
	}).Error; err != nil {
		log.Printf("routine run %s completed but its legacy tracking task could not be closed: %v", run.ID, err)
	}
	_ = PublishWorkspaceStateEvent(run.WorkspaceID, "workspace.routine.completed", source, run.ChannelName, gin.H{
		"run_id":       run.ID,
		"routine_id":   run.RoutineID,
		"routine_name": run.RoutineName,
		"routine":      gin.H{"id": run.RoutineID, "name": run.RoutineName},
		"status":       "completed",
		"via":          via,
	})
	return true
}

// FailRoutineRun lands a running run as failed. When countsTowardPause, the
// routine's consecutive-failure counter goes up and the routine is paused once
// it reaches routineAutoPauseAfter. A user stopping or deleting is not the
// routine failing, so those callers pass false.
func FailRoutineRun(run models.RoutineRunRecord, reason, source string, countsTowardPause bool) bool {
	now := time.Now().UTC()
	res := db.DB.Model(&models.RoutineRunRecord{}).Where("id = ? AND status = ?", run.ID, "running").Updates(map[string]interface{}{
		"status":       "failed",
		"error":        &reason,
		"completed_at": &now,
	})
	if res.Error != nil || res.RowsAffected == 0 {
		return false
	}
	db.DB.Model(&models.RoutineRecord{}).Where("id = ?", run.RoutineID).Updates(map[string]interface{}{
		"last_run_status": "failed",
		"last_run_error":  &reason,
	})
	cancelled := db.DB.Model(&models.TodoRecord{}).Where("run_id = ? AND status = ?", run.ID, "in_progress").Updates(map[string]interface{}{
		"status":       "cancelled",
		"error":        &reason,
		"completed_at": &now,
		"updated_at":   now,
	})
	_ = PublishWorkspaceStateEvent(run.WorkspaceID, "workspace.routine.failed", source, run.ChannelName, gin.H{
		"run_id":       run.ID,
		"routine_id":   run.RoutineID,
		"routine_name": run.RoutineName,
		"channel_name": run.ChannelName,
		"status":       "failed",
		"error":        reason,
	})
	if cancelled.Error == nil && cancelled.RowsAffected > 0 {
		_ = PublishWorkspaceStateEvent(run.WorkspaceID, "workspace.todos.updated", source, run.ChannelName, gin.H{
			"run_id": run.ID,
			"status": "cancelled",
			"error":  reason,
		})
	}
	if countsTowardPause {
		noteRoutineFailure(run.RoutineID, reason)
	}
	return true
}

// noteRoutineFailure bumps the failure streak and pauses at the threshold.
func noteRoutineFailure(routineID, reason string) {
	if err := db.DB.Model(&models.RoutineRecord{}).Where("id = ?", routineID).
		UpdateColumn("consecutive_failures", gorm.Expr("consecutive_failures + 1")).Error; err != nil {
		return
	}
	var r models.RoutineRecord
	if err := db.DB.Where("id = ?", routineID).First(&r).Error; err != nil {
		return
	}
	if r.ConsecutiveFailures < routineAutoPauseAfter || r.Status != RoutineStatusActive {
		return
	}
	pausedReason := fmt.Sprintf("Paused after %d failed runs in a row", r.ConsecutiveFailures)
	res := db.DB.Model(&models.RoutineRecord{}).Where("id = ? AND status = ?", r.ID, RoutineStatusActive).Updates(map[string]interface{}{
		"status":        RoutineStatusPaused,
		"paused_reason": pausedReason,
	})
	if res.Error != nil || res.RowsAffected == 0 {
		return
	}
	r.Status = RoutineStatusPaused
	r.PausedReason = &pausedReason
	content := fmt.Sprintf("Paused routine \"%s\" (%s) after %d failed runs in a row. Last error: %s. Resume it from Automations once the cause is fixed.",
		noMention(r.Name), r.ShortID, r.ConsecutiveFailures, noMention(reason))
	postChannelMessage(r.WorkspaceID, r.ChannelName, "system:routine", content, nil, map[string]interface{}{
		"routine_paused": map[string]interface{}{
			"routine_id": r.ID,
			"short_id":   r.ShortID,
			"name":       r.Name,
			"reason":     pausedReason,
			"last_error": reason,
		},
	})
	_ = PublishWorkspaceStateEvent(r.WorkspaceID, "workspace.routine.updated", "system:routine", r.ChannelName, gin.H{"routine": r})
	log.Printf("routine %s (%s) auto-paused after %d consecutive failures", r.ID, r.ShortID, r.ConsecutiveFailures)
}

// ---------------------------------------------------------------------------
// Turn-driven completion
// ---------------------------------------------------------------------------

/*
settleRoutineRunsForTurn closes the agent's running routine runs in a channel
when its turn there ends: idle completes them, error fails them (counting
toward auto-pause). Only a turn that STARTED after the run did can settle it:
the idle that ends a turn which was already under way when the routine fired
belongs to that earlier turn, and the routine's own message is still queued.
*/
func settleRoutineRunsForTurn(workspaceID, agentName, channel, state, errText string, turnStartedAt *time.Time, source string) {
	if db.DB == nil || turnStartedAt == nil || (state != models.AgentTurnIdle && state != models.AgentTurnError) {
		return
	}
	var runs []models.RoutineRunRecord
	if err := db.DB.Where("status = ? AND workspace_id = ? AND channel_name = ? AND agent_name = ?",
		"running", workspaceID, channel, agentName).Find(&runs).Error; err != nil {
		return
	}
	for _, run := range runs {
		if turnStartedAt.Before(run.StartedAt.Add(-routineTurnTolerance)) {
			continue
		}
		if state == models.AgentTurnIdle {
			CompleteRoutineRun(run, source, "turn_end")
			continue
		}
		reason := strings.TrimSpace(errText)
		if reason == "" {
			reason = "turn failed"
		}
		FailRoutineRun(run, "Agent turn failed: "+reason, source, true)
	}
}

// agentReportsTurns says whether this agent's adapter reports turn state at
// all. Adapters that predate turn reporting never write a row, and for them
// the first chat reply remains the completion signal.
func agentReportsTurns(workspaceID, agentName string) bool {
	var n int64
	if err := db.DB.Model(&models.AgentTurnState{}).
		Where("workspace_id = ? AND agent_name = ?", workspaceID, agentName).Count(&n).Error; err != nil {
		return false
	}
	return n > 0
}

// agentTurnRunningSince reports whether the agent has a turn running in the
// channel that started at or after `since`.
func agentTurnRunningSince(workspaceID, agentName, channel string, since time.Time) bool {
	var turn models.AgentTurnState
	if db.DB.Where("workspace_id = ? AND agent_name = ? AND channel_name = ?", workspaceID, agentName, channel).
		Limit(1).Find(&turn).RowsAffected == 0 {
		return false
	}
	return turn.State == models.AgentTurnRunning && turn.StartedAt != nil && !turn.StartedAt.Before(since.Add(-routineTurnTolerance))
}

// AgentTurnRunningSince is the exported form for the scheduler's sweep.
func AgentTurnRunningSince(workspaceID, agentName, channel string, since time.Time) bool {
	return agentTurnRunningSince(workspaceID, agentName, channel, since)
}

// AgentRepliedDuringRun reports whether the agent posted a chat reply in the
// run's channel since it started -- the sweep's fallback evidence that a run
// whose turn-end report never arrived did in fact get answered.
func AgentRepliedDuringRun(run *models.RoutineRunRecord) bool {
	_, _, ok := lastAgentReply(run, time.Now().UTC())
	return ok
}

// refreshRecentRunOutcome re-captures the outcome of the agent's most recently
// completed run in a channel when a reply or a file lands shortly after the
// run was settled (files are registered after the idle report).
func refreshRecentRunOutcome(workspaceID, agentName, channel string) {
	if db.DB == nil || agentName == "" || channel == "" {
		return
	}
	var run models.RoutineRunRecord
	if db.DB.Where("workspace_id = ? AND channel_name = ? AND agent_name = ? AND status = ?",
		workspaceID, channel, agentName, "completed").
		Order("started_at desc").Limit(1).Find(&run).RowsAffected == 0 {
		return
	}
	now := time.Now().UTC()
	if run.CompletedAt == nil || now.After(run.CompletedAt.Add(routineLateCaptureWindow)) {
		return
	}
	updates := runOutcomeUpdates(&run, runWindowEnd(&run, now))
	if len(updates) == 0 {
		return
	}
	db.DB.Model(&models.RoutineRunRecord{}).Where("id = ?", run.ID).Updates(updates)
}

// NoteRoutineRunFile attributes a file an agent just registered to its recent
// routine run in that channel. Called by the file upload handlers.
func NoteRoutineRunFile(workspaceID, uploadedBy string, channel *string) {
	if channel == nil || *channel == "" || !isAgentSource(uploadedBy) {
		return
	}
	refreshRecentRunOutcome(workspaceID, agentNameFromSource(uploadedBy), *channel)
}
