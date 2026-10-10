package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/evaluator"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/hub"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"gorm.io/gorm"
)

var (
	rrMutex       sync.Mutex
	rrIndexMap    = make(map[string]int) // channelID -> last routed index
	pipelineRegex = regexp.MustCompile(`(?i)(?:^|[^\w@])[#/]?@([a-zA-Z0-9_-]+)`)
)

func parseStructuredSegments(raw []interface{}, participants []string) []models.PipelineStep {
	if len(raw) < 2 {
		return nil
	}
	allowed := make(map[string]string, len(participants)*2)
	for _, p := range participants {
		pLower := strings.ToLower(p)
		allowed[pLower] = p
		trimmed := strings.TrimSuffix(strings.TrimSuffix(pLower, "-agent"), "_agent")
		if trimmed != "" && trimmed != pLower {
			if _, exists := allowed[trimmed]; !exists {
				allowed[trimmed] = p
			}
		}
	}

	var steps []models.PipelineStep
	for _, item := range raw {
		m, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		rawAgent, _ := m["agent"].(string)
		rawAgent = strings.TrimPrefix(strings.TrimSpace(rawAgent), "@")
		if strings.ToLower(rawAgent) == "knowledge" || rawAgent == "" {
			continue
		}
		agentName, ok := allowed[strings.ToLower(rawAgent)]
		if !ok {
			agentName = rawAgent
		}
		instruction, _ := m["instruction"].(string)
		steps = append(steps, models.PipelineStep{
			Agent:       agentName,
			Instruction: strings.TrimSpace(instruction),
			Status:      "pending",
			MaxRetries:  3,
			RetryCount:  0,
		})
	}
	if len(steps) < 2 {
		return nil
	}
	return steps
}

func parseAgentPipeline(content string, participants []string) []models.PipelineStep {
	if len(participants) < 2 {
		return nil
	}
	allowed := make(map[string]string, len(participants)*2)
	for _, p := range participants {
		pLower := strings.ToLower(p)
		allowed[pLower] = p
		trimmed := strings.TrimSuffix(strings.TrimSuffix(pLower, "-agent"), "_agent")
		if trimmed != "" && trimmed != pLower {
			if _, exists := allowed[trimmed]; !exists {
				allowed[trimmed] = p
			}
		}
	}

	matches := pipelineRegex.FindAllStringSubmatchIndex(content, -1)
	if len(matches) < 2 {
		return nil
	}

	type validMatch struct {
		agentName string
		atStart   int
		afterName int
	}
	var valid []validMatch
	for _, m := range matches {
		nameStart, nameEnd := m[2], m[3]
		rawName := strings.ToLower(content[nameStart:nameEnd])
		if rawName == "knowledge" {
			continue
		}
		// If followed immediately by a colon and non-whitespace, it's not a bare mention or pipeline step (e.g. @knowledge:spec)
		if nameEnd < len(content) && content[nameEnd] == ':' && nameEnd+1 < len(content) && content[nameEnd+1] != ' ' && content[nameEnd+1] != '\n' && content[nameEnd+1] != '\r' {
			continue
		}
		agentName, ok := allowed[rawName]
		if !ok {
			continue
		}
		// Find actual '@' index within the match prefix
		matchedStr := content[m[0]:m[1]]
		atOffset := strings.Index(matchedStr, "@")
		if atOffset < 0 {
			atOffset = 0
		}
		valid = append(valid, validMatch{
			agentName: agentName,
			atStart:   m[0] + atOffset,
			afterName: m[1],
		})
	}

	if len(valid) < 2 {
		return nil
	}

	var segments []models.PipelineStep
	for i := 0; i < len(valid); i++ {
		instructionStart := valid[i].afterName
		var instructionEnd int
		if i+1 < len(valid) {
			instructionEnd = valid[i+1].atStart
		} else {
			instructionEnd = len(content)
		}

		instruction := strings.TrimSpace(content[instructionStart:instructionEnd])
		instruction = strings.TrimPrefix(instruction, "：")
		instruction = strings.TrimPrefix(instruction, ":")
		instruction = strings.TrimSpace(instruction)

		cleanText := strings.Trim(instruction, " 0123456789。，,.:：;；\r\n\t()-、")
		if len([]rune(cleanText)) < 3 {
			// Skip fragment mentions like "。\n2. " or "完成后 "
			continue
		}

		segments = append(segments, models.PipelineStep{
			Agent:       valid[i].agentName,
			Instruction: instruction,
			Status:      "pending",
			MaxRetries:  3,
			RetryCount:  0,
		})
	}

	if len(segments) < 2 {
		return nil
	}
	return segments
}

// startPipeline persists a freshly parsed relay chain for a channel, replacing
// whatever chain that channel had. Step 0 starts out running because
// routeMessage returns it as the target of the message that opened the chain.
func startPipeline(tx *gorm.DB, workspaceID, channelID, startedBy string, steps []models.PipelineStep) string {
	database := tx
	if database == nil {
		database = db.DB
	}
	nowMs := time.Now().UnixMilli()
	steps[0].Status = "running"
	steps[0].StartedAt = &nowMs
	if steps[0].MaxRetries <= 0 {
		steps[0].MaxRetries = 3
	}

	encoded, err := json.Marshal(steps)
	if err != nil {
		log.Printf("pipeline: failed to encode chain for channel %s: %v", channelID, err)
		return ""
	}

	clearPipeline(database, channelID)
	record := models.ChannelPipeline{
		ID:           uuid.NewString(),
		WorkspaceID:  workspaceID,
		ChannelID:    channelID,
		Steps:        encoded,
		CurrentIndex: 0,
		Status:       "running",
		StartedBy:    startedBy,
	}
	if err := database.Create(&record).Error; err != nil {
		log.Printf("pipeline: failed to persist chain for channel %s: %v", channelID, err)
		return ""
	}
	return record.ID
}

// clearPipeline drops the channel's chain completely.
func clearPipeline(tx *gorm.DB, channelID string) {
	database := tx
	if database == nil {
		database = db.DB
	}
	if err := database.Where("channel_id = ?", channelID).Delete(&models.ChannelPipeline{}).Error; err != nil {
		log.Printf("pipeline: failed to clear chain for channel %s: %v", channelID, err)
	}
}

// pausePipeline suspends the pipeline without deleting its progress, allowing safe human-in-the-loop takeover.
func pausePipeline(tx *gorm.DB, channelID string) {
	database := tx
	if database == nil {
		database = db.DB
	}
	if err := database.Model(&models.ChannelPipeline{}).
		Where("channel_id = ? AND status IN ?", channelID, []string{"running", "retrying"}).
		Update("status", "paused").Error; err != nil {
		log.Printf("pipeline: failed to pause chain for channel %s: %v", channelID, err)
	}
}

// GetChannelPipeline handles GET /v1/channels/:channel_id/pipeline
func GetChannelPipeline(c *gin.Context) {
	channelID := c.Param("channel_id")
	if channelID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "channel_id is required"})
		return
	}

	var record models.ChannelPipeline
	if err := db.DB.Where("channel_id = ?", channelID).First(&record).Error; err != nil {
		c.JSON(http.StatusOK, gin.H{"active": false})
		return
	}

	var steps []models.PipelineStep
	if len(record.Steps) > 0 {
		_ = json.Unmarshal(record.Steps, &steps)
	}

	c.JSON(http.StatusOK, gin.H{
		"active":            record.Status == "running" || record.Status == "retrying" || record.Status == "paused",
		"id":                record.ID,
		"status":            record.Status,
		"current_index":     record.CurrentIndex,
		"total_retries":     record.TotalRetries,
		"max_total_retries": record.MaxTotalRetries,
		"started_by":        record.StartedBy,
		"steps":             steps,
	})
}

// PauseChannelPipeline handles POST /v1/channels/:channel_id/pipeline/pause
func PauseChannelPipeline(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	channelID := c.Param("channel_id")
	if channelID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "channel_id is required"})
		return
	}

	var record models.ChannelPipeline
	if err := db.DB.Where("channel_id = ? AND status IN ?", channelID, []string{"running", "retrying"}).First(&record).Error; err != nil {
		c.JSON(http.StatusOK, gin.H{"status": "not_running"})
		return
	}

	db.DB.Model(&record).Update("status", "paused")

	var channel models.Channel
	if err := db.DB.Where("id = ?", channelID).First(&channel).Error; err == nil {
		RelayPipelineAlert(workspace.ID, "channel/"+channel.Name, "⏸️ 管线已暂停，等待用户人工干预。点击恢复或继续对话。")
	}

	c.JSON(http.StatusOK, gin.H{"status": "paused"})
}

// ResumeChannelPipeline handles POST /v1/channels/:channel_id/pipeline/resume
func ResumeChannelPipeline(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	channelID := c.Param("channel_id")
	if channelID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "channel_id is required"})
		return
	}

	var record models.ChannelPipeline
	if err := db.DB.Where("channel_id = ? AND status IN ?", channelID, []string{"paused", "halted_user"}).First(&record).Error; err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No paused or halted pipeline found for this channel"})
		return
	}

	var steps []models.PipelineStep
	if err := json.Unmarshal(record.Steps, &steps); err != nil || len(steps) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Pipeline has unreadable steps"})
		return
	}

	idx := record.CurrentIndex
	if idx < 0 || idx >= len(steps) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Pipeline index out of range"})
		return
	}

	db.DB.Model(&record).Update("status", "running")

	var channel models.Channel
	if err := db.DB.Where("id = ?", channelID).First(&channel).Error; err == nil {
		targetChan := "channel/" + channel.Name
		currentAgent := steps[idx].Agent
		resumeMsg := fmt.Sprintf("▶️ 管线已恢复执行，当前步骤 [%d/%d] 继续由 @%s 推进。", idx+1, len(steps), currentAgent)
		RelayPipelineAlert(workspace.ID, targetChan, resumeMsg)
	}

	c.JSON(http.StatusOK, gin.H{"status": "resumed", "current_index": idx, "agent": steps[idx].Agent})
}

// HaltChannelPipeline handles POST /v1/channels/:channel_id/pipeline/halt
func HaltChannelPipeline(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	channelID := c.Param("channel_id")
	if channelID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "channel_id is required"})
		return
	}

	var record models.ChannelPipeline
	if err := db.DB.Where("channel_id = ? AND status IN ?", channelID, []string{"running", "retrying", "paused"}).First(&record).Error; err != nil {
		c.JSON(http.StatusOK, gin.H{"status": "not_running"})
		return
	}

	nowMs := time.Now().UnixMilli()
	db.DB.Model(&record).Updates(map[string]interface{}{
		"status": "halted_user",
	})

	var channel models.Channel
	if err := db.DB.Where("id = ?", channelID).First(&channel).Error; err == nil {
		RelayPipelineAlert(workspace.ID, "channel/"+channel.Name, "Pipeline execution was stopped by user.")
		StopActiveRoutineRunsAndTasks(workspace.ID, "", channel.Name)

		// Halt active agent turn and send stop control to current pipeline agent
		var steps []models.PipelineStep
		if err := json.Unmarshal(record.Steps, &steps); err == nil && record.CurrentIndex >= 0 && record.CurrentIndex < len(steps) {
			currentAgent := steps[record.CurrentIndex].Agent
			if currentAgent != "" {
				closeAgentTurn(workspace.ID, &channel, currentAgent)
				emitAgentControlEvent(workspace.ID, currentAgent, "stop", gin.H{"channel": channel.Name})
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{"status": "halted", "finished_at": nowMs})
}

// CheckAndTriggerNextPipelineStep is the trigger for adapters that do not report
// turn state: their chat reply is the only sign the turn ended.
func CheckAndTriggerNextPipelineStep(workspaceID string, target string, source string) {
	if !strings.HasPrefix(target, "channel/") {
		return
	}
	EvaluatePipelineStep(workspaceID, strings.TrimPrefix(target, "channel/"), agentNameFromSource(source), "", 0)
}

// pipelineEvalLocks serialises step evaluation per channel. Evaluation runs
// the verification command, and a turn-end report and a chat message can
// arrive for the same step at nearly the same time.
var pipelineEvalLocks sync.Map // channel ID -> *sync.Mutex

// pipelineTurnTolerance absorbs clock skew between when a step was dispatched
// and when the adapter reported its turn as started.
const pipelineTurnTolerance = 2 * time.Second

// EvaluatePipelineStep judges the attempt the current step of channelName's
// chain is waiting on, once actor's turn there has ended.
//
//   - turnError is the adapter's error when the turn failed, "" otherwise.
//   - turnStartedMs is when that turn started (0 when unknown). A turn that
//     started before this attempt was dispatched is an older turn ending, not
//     this attempt, and is ignored.
//
// Adapters that report turn state call this from the turn-end report; older
// adapters still go through CheckAndTriggerNextPipelineStep on their reply.
func EvaluatePipelineStep(workspaceID, channelName, actor, turnError string, turnStartedMs int64) {
	if actor == "" || channelName == "" {
		return
	}
	target := "channel/" + channelName

	var channel models.Channel
	if err := db.DB.Where("workspace_id = ? AND name = ?", workspaceID, channelName).First(&channel).Error; err != nil {
		return
	}
	lockAny, _ := pipelineEvalLocks.LoadOrStore(channel.ID, &sync.Mutex{})
	lock := lockAny.(*sync.Mutex)
	lock.Lock()
	defer lock.Unlock()

	var record models.ChannelPipeline
	if err := db.DB.Where("channel_id = ? AND status = ?", channel.ID, "running").First(&record).Error; err != nil {
		return
	}

	var steps []models.PipelineStep
	if err := json.Unmarshal(record.Steps, &steps); err != nil {
		log.Printf("pipeline: chain %s has unreadable steps: %v", record.ID, err)
		return
	}
	idx := record.CurrentIndex
	if idx < 0 || idx >= len(steps) {
		log.Printf("pipeline: chain %s has out-of-range index %d of %d steps", record.ID, idx, len(steps))
		return
	}
	if !strings.EqualFold(steps[idx].Agent, actor) {
		return
	}
	attemptStart := steps[idx].AttemptStartedAt
	if attemptStart == nil {
		attemptStart = steps[idx].StartedAt
	}
	if turnStartedMs > 0 && attemptStart != nil && turnStartedMs < *attemptStart-pipelineTurnTolerance.Milliseconds() {
		return
	}

	// 1. The agent's replies in THIS attempt -- not thinking previews, status
	// lines or tool output, and not what an earlier attempt said.
	turnMessages := pipelineAttemptReplies(workspaceID, target, actor, attemptStart)

	// 2. Judge the attempt against the state from before the step began.
	dir := resolveTurnDir(workspaceID, &channel, actor)
	var verificationCmd string
	if channel.VerificationCmd != nil {
		verificationCmd = strings.TrimSpace(*channel.VerificationCmd)
	}
	var baseline *evaluator.VerificationRunResult
	if s := steps[idx].Baseline; s != nil {
		baseline = &evaluator.VerificationRunResult{ExitCode: s.ExitCode, Errors: s.Errors}
	} else if steps[idx].RetryCount == 0 && verificationCmd != "" {
		// Only on the first attempt: the turn's own baseline was taken when
		// the step was dispatched. A retry's turn baseline would include the
		// failure the first attempt left behind -- which is how a retry that
		// changed nothing used to pass as "no new errors".
		baseline = waitForTurnBaseline(workspaceID, channel.ID, actor, 35*time.Second)
		if baseline != nil {
			steps[idx].Baseline = &models.VerifySnapshot{ExitCode: baseline.ExitCode, Errors: baseline.Errors}
		}
	}
	evalRes := evaluator.EvaluateStep(actor, steps[idx], turnError, dir, verificationCmd, baseline)
	steps[idx].VerifiedBy = evalRes.VerifiedBy
	nowMs := time.Now().UnixMilli()

	// 3. Handle Failures with Bounded Self-Correction Loop & Spend Budget Gate
	if evalRes.Status == evaluator.EvalFail {
		maxRetries := steps[idx].MaxRetries
		if maxRetries <= 0 {
			maxRetries = 3
		}
		maxPipelineRetries := record.MaxTotalRetries
		if maxPipelineRetries <= 0 {
			maxPipelineRetries = 6
		}
		errDetailStr := strings.Join(evalRes.ErrorDetails, "\n")
		steps[idx].LastError = &errDetailStr

		if record.TotalRetries >= maxPipelineRetries {
			// Pipeline-level retry budget exhausted to prevent run-away token burn
			steps[idx].Status = "failed"
			steps[idx].FinishedAt = &nowMs
			if !savePipelineSteps(&record, idx, steps, map[string]interface{}{"status": "halted_budget"}) {
				return
			}
			haltMsg := fmt.Sprintf("[Pipeline halted: retry budget used up] %d of %d retries across the pipeline are spent.\nLast error:\n> %s\nA person needs to take over.",
				record.TotalRetries, maxPipelineRetries, strings.Join(evalRes.ErrorDetails, "\n> "))
			RelayPipelineAlert(workspaceID, target, haltMsg)
			return
		}

		if steps[idx].RetryCount < maxRetries {
			steps[idx].RetryCount++
			steps[idx].Status = "retrying"
			steps[idx].AttemptStartedAt = &nowMs
			if !savePipelineSteps(&record, idx, steps, map[string]interface{}{"total_retries": record.TotalRetries + 1}) {
				return
			}
			// The feedback alone is not enough for an agent whose session did
			// not survive: restate what the step is.
			feedback := evalRes.FeedbackMessage
			if instr := strings.TrimSpace(steps[idx].Instruction); instr != "" {
				feedback += "\n\nYour task for this step (unchanged):\n> " + strings.ReplaceAll(instr, "\n", "\n> ")
			}
			relaySelfCorrection(workspaceID, target, actor, feedback, pipelineTaskID(record.ID, idx))
			return
		}

		// Retries exhausted: fail the pipeline and halt
		steps[idx].Status = "failed"
		steps[idx].FinishedAt = &nowMs
		if !savePipelineSteps(&record, idx, steps, map[string]interface{}{"status": "failed"}) {
			return
		}
		haltMsg := fmt.Sprintf("[Pipeline halted] Step %d (@%s) failed after %d attempts.\nErrors:\n> %s\nA person needs to take over.",
			idx+1, actor, steps[idx].RetryCount+1, strings.Join(evalRes.ErrorDetails, "\n> "))
		RelayPipelineAlert(workspaceID, target, haltMsg)
		return
	}

	// 4. Handle Pass: Extract structured deliverable and advance to next step
	deliverable := evaluator.ExtractDeliverable(actor, steps[idx], turnMessages, dir)
	steps[idx].Deliverable = deliverable
	steps[idx].Status = "done"
	steps[idx].FinishedAt = &nowMs

	nextIdx := idx + 1
	nextStatus := "running"
	if nextIdx >= len(steps) {
		nextIdx = idx
		nextStatus = "completed"
	} else {
		steps[nextIdx].Status = "running"
		steps[nextIdx].StartedAt = &nowMs
		// The run that just passed is the state the next step starts from.
		if evalRes.Final != nil {
			steps[nextIdx].Baseline = &models.VerifySnapshot{ExitCode: evalRes.Final.ExitCode, Errors: evalRes.Final.Errors}
		}
	}

	if !savePipelineSteps(&record, idx, steps, map[string]interface{}{"current_index": nextIdx, "status": nextStatus}) || nextStatus == "completed" {
		return
	}

	// Settle the finished agent's turn to release working directory and prevent contention for the next agent
	closeAgentTurn(workspaceID, &channel, actor)

	relayPipelineStep(workspaceID, target, steps[nextIdx], actor, deliverable, pipelineTaskID(record.ID, nextIdx))
}

// savePipelineSteps writes steps plus extra columns with a compare-and-swap on
// (current_index, status=running), so two evaluations racing for the same
// attempt cannot both retry it or advance the chain twice. It reports whether
// this caller won.
func savePipelineSteps(record *models.ChannelPipeline, idx int, steps []models.PipelineStep, extra map[string]interface{}) bool {
	encoded, err := json.Marshal(steps)
	if err != nil {
		log.Printf("pipeline: failed to encode chain %s: %v", record.ID, err)
		return false
	}
	updates := map[string]interface{}{"steps": encoded}
	for k, v := range extra {
		updates[k] = v
	}
	result := db.DB.Model(&models.ChannelPipeline{}).
		Where("id = ? AND current_index = ? AND status = ?", record.ID, idx, "running").
		Updates(updates)
	if result.Error != nil {
		log.Printf("pipeline: failed to update chain %s: %v", record.ID, result.Error)
		return false
	}
	return result.RowsAffected > 0
}

// pipelineAttemptReplies returns actor's chat replies in target since the
// attempt started, oldest first. Thinking previews, status lines and tool
// output are message types of their own and are left out: the handoff
// summary was once built from a "thinking..." status line.
func pipelineAttemptReplies(workspaceID, target, actor string, since *int64) []string {
	var events []models.EventRecord
	q := db.DB.Where("network_id = ? AND target = ? AND type LIKE ?", workspaceID, target, "workspace.message%")
	if since != nil {
		q = q.Where("timestamp >= ?", *since)
	}
	q.Order("timestamp desc, id desc").Limit(200).Find(&events)

	var replies []string
	for i := len(events) - 1; i >= 0; i-- {
		ev := events[i]
		if !isAgentSource(ev.Source) || !strings.EqualFold(agentNameFromSource(ev.Source), actor) {
			continue
		}
		var p map[string]interface{}
		if json.Unmarshal(ev.Payload, &p) != nil {
			continue
		}
		if mt, _ := p["message_type"].(string); mt != "" && mt != "chat" {
			continue
		}
		if c, ok := p["content"].(string); ok && strings.TrimSpace(c) != "" {
			replies = append(replies, c)
		}
	}
	return replies
}

// waitForTurnBaseline returns the baseline verification recorded when actor's
// latest turn was dispatched. It is captured in the background, so a fast
// agent can finish first; wait for a capture that is still running rather
// than judge the step with no baseline at all.
func waitForTurnBaseline(workspaceID, channelID, actor string, maxWait time.Duration) *evaluator.VerificationRunResult {
	deadline := time.Now().Add(maxWait)
	for {
		if res := GetLatestTurnBaselineVerify(workspaceID, channelID, actor); res != nil {
			return res
		}
		if !turnBaselinePending(workspaceID, channelID, actor) || time.Now().After(deadline) {
			return nil
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// settlePipelineForTurn evaluates the pipeline step a finished turn belongs
// to, in the background: evaluation runs the verification command, which
// must not hold up the adapter's turn report.
func settlePipelineForTurn(workspaceID, agentName, channel, state, errText string, turnStartedAt *time.Time) {
	if state != models.AgentTurnIdle && state != models.AgentTurnError {
		return
	}
	if state == models.AgentTurnIdle {
		errText = ""
	} else if strings.TrimSpace(errText) == "" {
		errText = "turn failed"
	}
	var startedMs int64
	if turnStartedAt != nil {
		startedMs = turnStartedAt.UnixMilli()
	}
	go EvaluatePipelineStep(workspaceID, channel, agentName, errText, startedMs)
}

// relaySelfCorrection posts diagnostic feedback to the same agent to prompt self-repair.
func relaySelfCorrection(workspaceID, target, agentName, feedbackMessage, taskID string) {
	go func() {
		time.Sleep(500 * time.Millisecond)

		nowUnixMs := time.Now().UnixNano() / int64(time.Millisecond)
		eventID := uuid.New().String()
		promptContent := "@" + agentName + "\n" + feedbackMessage

		payload := map[string]interface{}{
			"content":      promptContent,
			"sender_name":  "Pipeline Evaluator",
			"sender_type":  "pipeline",
			"message_type": "chat",
		}
		metadata := map[string]interface{}{
			"target_agents": []string{agentName},
			"pipeline_step": true,
			"self_correct":  true,
			"task_id":       taskID,
		}

		payloadBytes, _ := json.Marshal(payload)
		metaBytes, _ := json.Marshal(metadata)

		eventRec := models.EventRecord{
			ID:         eventID,
			NetworkID:  workspaceID,
			Type:       "workspace.message.posted",
			Source:     "system:evaluator",
			Target:     target,
			Payload:    payloadBytes,
			Metadata:   metaBytes,
			Timestamp:  nowUnixMs,
			Visibility: "channel",
		}
		_ = db.DB.Create(&eventRec)

		recordRelayTurn(workspaceID, target, agentName, taskID, eventID)

		fullEvent, _ := json.Marshal(gin.H{
			"id":        eventID,
			"event_id":  eventID,
			"network":   workspaceID,
			"type":      "workspace.message.posted",
			"source":    "system:evaluator",
			"target":    target,
			"payload":   payload,
			"metadata":  metadata,
			"timestamp": nowUnixMs,
			"status":    "confirmed",
		})
		if hub.GlobalHub != nil {
			hub.GlobalHub.Broadcast(hub.BroadcastMsg{
				WorkspaceID: workspaceID,
				ChannelName: target,
				Payload:     string(fullEvent),
			})
		}
	}()
}

// RelayPipelineAlert broadcasts a critical pipeline notification/error to the channel.
func RelayPipelineAlert(workspaceID, target, alertContent string) {
	go func() {
		nowUnixMs := time.Now().UnixNano() / int64(time.Millisecond)
		eventID := uuid.New().String()

		payload := map[string]interface{}{
			"content":      alertContent,
			"sender_name":  "Pipeline Supervisor",
			"sender_type":  "pipeline",
			"message_type": "chat",
		}
		metadata := map[string]interface{}{
			"pipeline_alert": true,
		}

		payloadBytes, _ := json.Marshal(payload)
		metaBytes, _ := json.Marshal(metadata)

		eventRec := models.EventRecord{
			ID:         eventID,
			NetworkID:  workspaceID,
			Type:       "workspace.message.posted",
			Source:     "system:pipeline",
			Target:     target,
			Payload:    payloadBytes,
			Metadata:   metaBytes,
			Timestamp:  nowUnixMs,
			Visibility: "channel",
		}
		_ = db.DB.Create(&eventRec)

		fullEvent, _ := json.Marshal(gin.H{
			"id":        eventID,
			"event_id":  eventID,
			"network":   workspaceID,
			"type":      "workspace.message.posted",
			"source":    "system:pipeline",
			"target":    target,
			"payload":   payload,
			"metadata":  metadata,
			"timestamp": nowUnixMs,
			"status":    "confirmed",
		})
		if hub.GlobalHub != nil {
			hub.GlobalHub.Broadcast(hub.BroadcastMsg{
				WorkspaceID: workspaceID,
				ChannelName: target,
				Payload:     string(fullEvent),
			})
		}
	}()
}

// relayPipelineStep posts the next hop's instruction into the channel as if the
// user had sent it, waking exactly that agent with structured deliverable context.
func relayPipelineStep(workspaceID string, target string, nextSeg models.PipelineStep, prevActor string, prevDeliverable *models.PipelineDeliverable, taskID string) {
	go func() {
		time.Sleep(500 * time.Millisecond)

		nowUnixMs := time.Now().UnixNano() / int64(time.Millisecond)
		eventID := uuid.New().String()
		promptContent := evaluator.FormatRelayPrompt(nextSeg.Agent, prevActor, prevDeliverable, nextSeg.Instruction)

		payload := map[string]interface{}{
			"content":      promptContent,
			"sender_name":  "Pipeline Relay",
			"sender_type":  "pipeline",
			"message_type": "chat",
			"deliverable":  prevDeliverable,
		}
		metadata := map[string]interface{}{
			"target_agents": []string{nextSeg.Agent},
			"pipeline_step": true,
			"auto_relay":    true,
			"task_id":       taskID,
			"deliverable":   prevDeliverable,
		}

		payloadBytes, _ := json.Marshal(payload)
		metaBytes, _ := json.Marshal(metadata)

		eventRec := models.EventRecord{
			ID:         eventID,
			NetworkID:  workspaceID,
			Type:       "workspace.message.posted",
			Source:     "human:pipeline",
			Target:     target,
			Payload:    payloadBytes,
			Metadata:   metaBytes,
			Timestamp:  nowUnixMs,
			Visibility: "channel",
		}

		if err := db.DB.Create(&eventRec).Error; err == nil {
			recordRelayTurn(workspaceID, target, nextSeg.Agent, taskID, eventID)

			fullEvent := gin.H{
				"id":         eventRec.ID,
				"event_id":   eventRec.ID,
				"network":    workspaceID,
				"type":       eventRec.Type,
				"source":     eventRec.Source,
				"target":     eventRec.Target,
				"payload":    payload,
				"metadata":   metadata,
				"timestamp":  eventRec.Timestamp,
				"visibility": eventRec.Visibility,
				"status":     "confirmed",
			}
			fullEventBytes, _ := json.Marshal(fullEvent)
			hub.GlobalHub.Broadcast(hub.BroadcastMsg{
				WorkspaceID: workspaceID,
				ChannelName: target,
				Payload:     string(fullEventBytes),
			})
		}
	}()
}

const noResponseAgent = "__no_response__"

var errSessionRevoked = errors.New("session_revoked")
var mentionPattern = regexp.MustCompile(`(?i)(?:^|[^\w@])@([A-Za-z0-9_-]+)`)

// routeMessage applies the original WorkspaceMod routing rules to one chat
// event. It returns routed=false for operational/status events, which must be
// persisted and shown in the UI but must never wake another agent.
func routeMessage(tx *gorm.DB, workspaceID string, channel *models.Channel, req *SendEventRequest) (targets []string, routed bool, err error) {
	if req.Type != "workspace.message.posted" || channel == nil {
		return nil, false, nil
	}
	if _, explicit := req.Metadata["target_agents"]; explicit {
		return nil, false, nil
	}

	database := tx
	if database == nil {
		database = db.DB
	}

	if isAgentSource(req.Source) {
		if err := validateMessageSession(workspaceID, req.Source, req.Metadata); err != nil {
			return nil, false, err
		}
	}

	// An absent type is legacy chat. Every named non-chat event (status,
	// thinking, errors, queue controls and approval events) is informational;
	// it must not be used as conversational input for another agent.
	if messageType(req.Payload) != "chat" {
		return nil, false, nil
	}
	if !isHumanSource(req.Source) && !isAgentSource(req.Source) {
		return nil, false, nil
	}

	// Retrieve all workspace agents to support global @mentions and multi-agent pipelines
	var wsMembers []models.WorkspaceMember
	database.Where("workspace_id = ?", workspaceID).Find(&wsMembers)
	allWorkspaceAgents := make([]string, 0, len(wsMembers))
	for _, m := range wsMembers {
		if m.AgentName != "" && m.AgentName != noResponseAgent {
			allWorkspaceAgents = append(allWorkspaceAgents, m.AgentName)
		}
	}

	var memberships []models.ChannelMember
	if err := database.Where("channel_id = ?", channel.ID).Order("agent_name ASC").Find(&memberships).Error; err != nil {
		return []string{noResponseAgent}, true, nil
	}
	participants := make([]string, 0, len(memberships))
	for _, member := range memberships {
		if member.AgentName != noResponseAgent {
			participants = append(participants, member.AgentName)
		}
	}

	if len(participants) == 0 {
		if len(allWorkspaceAgents) == 1 {
			participants = allWorkspaceAgents
		}
	}

	// For mention resolution and multi-agent pipeline detection, allow any workspace agent
	availableCandidates := allWorkspaceAgents
	if len(availableCandidates) == 0 {
		availableCandidates = participants
	}

	content, _ := req.Payload["content"].(string)
	mentions := mentionedAgents(content, req.Payload, availableCandidates)
	online := onlineParticipants(database, workspaceID, availableCandidates)

	// If human message contains multi-agent pipeline (@agent1 ... @agent2 ... @agent3 ...)
	if isHumanSource(req.Source) {
		// 0. Direct Decision Response routing: When a human submits an answer to an ApprovalCard/decision question,
		// directly route the answer back to the agent who asked the question (from source_message_id).
		if req.Metadata != nil {
			if decResp, ok := req.Metadata["decision_response"].(map[string]interface{}); ok {
				if sourceMsgID, ok := decResp["source_message_id"].(string); ok && sourceMsgID != "" {
					var sourceEvent models.EventRecord
					if err := database.Where("network_id = ? AND id = ?", workspaceID, sourceMsgID).First(&sourceEvent).Error; err == nil {
						targetAgent := agentNameFromSource(sourceEvent.Source)
						if targetAgent != "" && targetAgent != noResponseAgent {
							// Ensure target agent is joined to the channel
							var cm models.ChannelMember
							if err := database.Where("channel_id = ? AND agent_name = ?", channel.ID, targetAgent).First(&cm).Error; err != nil {
								_ = database.Create(&models.ChannelMember{
									ChannelID: channel.ID,
									AgentName: targetAgent,
								}).Error
							}
							req.Metadata["is_decision_response"] = true
							return []string{targetAgent}, true, nil
						}
					}
				}
			}
		}

		var segments []models.PipelineStep
		// 1. Direct structured mention_segments check (deterministic, 0ms, no NLP guessing)
		if req.Metadata != nil {
			if rawSegments, ok := req.Metadata["mention_segments"].([]interface{}); ok && len(rawSegments) >= 2 {
				segments = parseStructuredSegments(rawSegments, availableCandidates)
			}
		}
		if len(segments) < 2 && req.Payload != nil {
			if rawSegments, ok := req.Payload["mention_segments"].([]interface{}); ok && len(rawSegments) >= 2 {
				segments = parseStructuredSegments(rawSegments, availableCandidates)
			}
		}

		// 2. Positional regex parsing fallback if structured segments were not supplied
		if len(segments) < 2 {
			segments = parseAgentPipeline(content, availableCandidates)
		}

		// In parallel mode "@a do x @b do y" is the batch itself -- each lane
		// takes its own instruction (laneTasksFromMessage). Starting a
		// sequential pipeline here ran b after a, in the shared folder, with
		// no worktrees: the parallel branch below was never reached.
		parallelMode := strings.EqualFold(strings.TrimSpace(channel.OrchestrationMode), "parallel")
		if len(segments) >= 2 && !parallelMode {
			if pipelineID := startPipeline(database, workspaceID, channel.ID, req.Source, segments); pipelineID != "" && req.Metadata != nil {
				// Turn attribution groups every retry of a step under that
				// step's key. Step 0 is dispatched through the event handler
				// rather than a relay, so its key travels in metadata to keep
				// it grouped with the retries relaySelfCorrection will send.
				req.Metadata["task_id"] = pipelineTaskID(pipelineID, 0)
			}
			return []string{segments[0].Agent}, true, nil
		}
		// Suspend running pipeline instead of destroying it when human intervenes
		pausePipeline(database, channel.ID)
	}

	// Agent-sourced messages: only route if the agent explicitly @mentions
	// another agent. Without a mention, the reply is stored but must NOT wake
	// another agent — otherwise every agent reply triggers the next agent's
	// turn, creating an infinite echo storm.
	// In master mode, the master orchestrates the channel: worker replies route
	// back to master and master's unmentioned completion yields noResponseAgent.
	mode := strings.ToLower(strings.TrimSpace(channel.OrchestrationMode))
	isMasterMode := mode == "master" && channel.MasterAgent != nil && strings.TrimSpace(*channel.MasterAgent) != ""
	if isAgentSource(req.Source) {
		// If a sequential pipeline is actively running in this channel, pipeline steps are strictly
		// governed and sequenced by CheckAndTriggerNextPipelineStep. Do NOT allow conversational mentions
		// or worker responses inside an agent's turn to bypass the pipeline sequence and spawn parallel turns.
		var activePipeline models.ChannelPipeline
		if err := database.Where("channel_id = ? AND status IN ?", channel.ID, []string{"running", "retrying"}).First(&activePipeline).Error; err == nil {
			return nil, false, nil
		}

		if !isMasterMode {
			if len(mentions) > 0 {
				sender := agentNameFromSource(req.Source)
				var nextTargets []string
				// An agent running a lane is busy in its own worktree. Naming it
				// ("I've asked @bob to ...") must not wake it a second time, in
				// the shared folder, outside its lane.
				busy := runningLaneAgents(database, workspaceID, channel.Name)
				for _, m := range mentions {
					if !strings.EqualFold(m, sender) && !busy[strings.ToLower(m)] {
						nextTargets = append(nextTargets, m)
					}
				}
				// In parallel mode an agent handing work to several agents is a
				// delegation: they get worktrees, the merge waits for the user,
				// and the sender hears back. Woken plainly, they ran one after
				// another in the shared folder, uncommitted and unreviewed.
				if mode == "parallel" && len(nextTargets) >= 2 {
					meta, refusal := agentFanOut(database, workspaceID, channel, req, sender, nextTargets, availableCandidates)
					channelName := channel.Name
					if refusal != "" {
						req.deferUntilCommitted(func() {
							postChannelMessage(workspaceID, channelName, "system:parallel", refusal, nil, map[string]interface{}{"delegation_refused": true})
						})
						return nil, false, nil
					}
					if req.Metadata == nil {
						req.Metadata = map[string]interface{}{}
					}
					req.Metadata["parallel_batch"] = meta
					req.deferUntilCommitted(func() { publishBatchStarted(workspaceID, channelName, meta) })
				}
				if len(nextTargets) > 0 {
					for _, target := range nextTargets {
						var cm models.ChannelMember
						if err := database.Where("channel_id = ? AND agent_name = ?", channel.ID, target).First(&cm).Error; err != nil {
							_ = database.Create(&models.ChannelMember{
								ChannelID: channel.ID,
								AgentName: target,
							}).Error
						}
					}
					return nextTargets, true, nil
				}
			}
			return nil, false, nil
		}
	}

	if len(participants) == 0 {
		return []string{noResponseAgent}, true, nil
	}
	if mode == "parallel" {
		/*
			Naming several agents IS the assignment.

			The board is the durable way to split work, but it is not the only
			one: in parallel mode "@a @b do this" is a human saying both, now,
			and that is the whole point of the mode. Requiring a scoped board
			row before anything can run would make the quick case impossible
			and push people back to the modes this one exists to replace.

			Mentions are checked first and skip the scope test on purpose. The
			scope check protects a batch the BOARD implies, where nobody has
			looked at the overlap; naming two agents in one sentence is the
			human having looked.
		*/
		if isHumanSource(req.Source) && len(mentions) > 0 {
			if meta := startParallelBatch(tx, workspaceID, channel, "mention", mentions, laneTasksFromMessage(req, mentions), nil); meta != nil {
				req.Metadata["parallel_batch"] = meta
				channelName := channel.Name
				req.deferUntilCommitted(func() { publishBatchStarted(workspaceID, channelName, meta) })
			}
			return mentions, true, nil
		}
		// A git folder isolates every lane in its own worktree, so overlapping
		// scopes cannot collide there and do not block the batch.
		isolated := channel.WorkingDir != nil && gitRepoRoot(*channel.WorkingDir) != ""
		wake, conflicts := parallelTargets(workspaceID, channel.Name, participants, agentNameFromSource(req.Source))
		if len(conflicts) > 0 && !isolated {
			// Refuse the batch rather than start it. Waking agents whose scopes
			// overlap is the one failure this mode exists to prevent, and it is
			// silent: the work looks fine until two of them write the same file.
			// The conflicts are served by GetParallelBatch for the UI to show.
			for _, conflict := range conflicts {
				fmt.Printf("[parallel] channel=%s refused: %s\n", channel.Name, conflict.String())
			}
			return []string{noResponseAgent}, true, nil
		}
		if len(wake) > 0 {
			if isHumanSource(req.Source) {
				tasks, scopes := laneTasksFromBoard(loadOpenBatch(workspaceID, channel.Name), wake)
				if meta := startParallelBatch(tx, workspaceID, channel, "board", wake, tasks, scopes); meta != nil {
					req.Metadata["parallel_batch"] = meta
					channelName := channel.Name
					req.deferUntilCommitted(func() { publishBatchStarted(workspaceID, channelName, meta) })
				}
			}
			return wake, true, nil
		}
		// No open batch. Fall through, so a channel parked in parallel mode
		// still answers an ordinary question between batches.
	}
	if len(mentions) > 0 && isHumanSource(req.Source) {
		// Fast path: when the PERSON names an agent, that agent does it -- in
		// Dynamic without asking the router, in Master without going through the
		// master. The master only gets what nobody was named for.
		//
		// Human messages only. An agent naming another agent in its reply keeps
		// the mode's own rules below (masterTargets / router / fallback);
		// letting every agent-to-agent @ wake its target directly is how two
		// agents end up waking each other forever.
		targets = mentions
		if mode != "parallel" && len(targets) > 1 {
			targets = targets[:1]
		}
		for _, target := range targets {
			var cm models.ChannelMember
			if err := database.Where("channel_id = ? AND agent_name = ?", channel.ID, target).First(&cm).Error; err != nil {
				_ = database.Create(&models.ChannelMember{
					ChannelID: channel.ID,
					AgentName: target,
				}).Error
			}
		}
	} else if mode == "master" && channel.MasterAgent != nil && *channel.MasterAgent != "" {
		targets = masterTargets(req.Source, *channel.MasterAgent, participants, mentions)
	} else if len(participants) >= 2 {
		// Dynamic keeps its own rule: the router picks one next speaker. Waking
		// several at once is what parallel mode is for, and blurring that here
		// is what made the modes indistinguishable in the first place.
		if llmTargets, handled := routeWithLLM(workspaceID, channel, req, participants); handled {
			targets = llmTargets
		} else {
			targets = fallbackTargets(channel.ID, req.Source, channel.MasterAgent, participants, online, mentions)
		}
	} else {
		targets = fallbackTargets(channel.ID, req.Source, channel.MasterAgent, participants, online, mentions)
	}
	if len(targets) == 0 {
		targets = []string{noResponseAgent}
	}
	return targets, true, nil
}

func messageType(payload map[string]interface{}) string {
	if payload == nil {
		return "chat"
	}
	value, ok := payload["message_type"].(string)
	if !ok || strings.TrimSpace(value) == "" {
		return "chat"
	}
	return strings.ToLower(strings.TrimSpace(value))
}

func isHumanSource(source string) bool { return strings.HasPrefix(source, "human:") }
func isAgentSource(source string) bool {
	return strings.HasPrefix(source, "52hz:") || strings.HasPrefix(source, "52hzAgents:") || strings.HasPrefix(source, "agent:") || strings.HasPrefix(source, "openagents:")
}

func agentNameFromSource(source string) string {
	s := strings.TrimPrefix(source, "52hzAgents:")
	s = strings.TrimPrefix(s, "52hz:")
	s = strings.TrimPrefix(s, "agent:")
	return strings.TrimPrefix(s, "openagents:")
}

func validateMessageSession(workspaceID, source string, metadata map[string]interface{}) error {
	claimed, _ := metadata["session_id"].(string)
	if claimed == "" { // legacy connector: retain original compatibility
		return nil
	}
	var member models.WorkspaceMember
	if err := db.DB.Where("workspace_id = ? AND agent_name = ?", workspaceID, agentNameFromSource(source)).First(&member).Error; err != nil {
		return errSessionRevoked
	}
	if member.SessionID != nil && *member.SessionID != "" && *member.SessionID != claimed {
		return errSessionRevoked
	}
	return nil
}

func mentionedAgents(content string, payload map[string]interface{}, participants []string) []string {
	allowed := make(map[string]string, len(participants))
	for _, name := range participants {
		allowed[strings.ToLower(name)] = name
	}
	seen := map[string]bool{}
	mentions := make([]string, 0)
	add := func(name string) {
		canonical, ok := allowed[strings.ToLower(name)]
		if ok && !seen[canonical] {
			mentions = append(mentions, canonical)
			seen[canonical] = true
		}
	}
	if raw, ok := payload["mentions"].([]interface{}); ok {
		for _, value := range raw {
			if name, ok := value.(string); ok {
				add(name)
			}
		}
	}
	for _, match := range mentionPattern.FindAllStringSubmatch(content, -1) {
		add(match[1])
	}
	return mentions
}

func onlineParticipants(database *gorm.DB, workspaceID string, participants []string) map[string]bool {
	if len(participants) == 0 {
		return nil
	}
	if database == nil {
		database = db.DB
	}
	var members []models.WorkspaceMember
	database.Where("workspace_id = ? AND agent_name IN ?", workspaceID, participants).Find(&members)
	now := time.Now()
	// Connector sends heartbeats every 30s; require 90s (3x margin) for online status
	timeout := 90 * time.Second
	if config.GlobalConfig != nil && config.GlobalConfig.AgentTimeoutSeconds > 0 {
		timeout = time.Duration(config.GlobalConfig.AgentTimeoutSeconds) * time.Second
	}
	online := map[string]bool{}
	for _, member := range members {
		if strings.HasPrefix(strings.ToLower(valueOrEmpty(member.AgentType)), "cloud:") {
			online[member.AgentName] = strings.EqualFold(member.Status, "online")
			continue
		}
		if strings.EqualFold(member.Status, "online") && member.LastHeartbeat != nil && now.Sub(*member.LastHeartbeat) <= timeout {
			online[member.AgentName] = true
		}
	}
	return online
}

func valueOrEmpty(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func fallbackTargets(channelID string, source string, master *string, participants []string, online map[string]bool, mentions []string) []string {
	if len(mentions) > 0 {
		return mentions
	}
	sender := agentNameFromSource(source)

	// Rotate among online candidates first
	var onlineCandidates []string
	for _, participant := range participants {
		if online[participant] && participant != sender {
			onlineCandidates = append(onlineCandidates, participant)
		}
	}

	if len(onlineCandidates) > 0 {
		rrMutex.Lock()
		lastIdx := rrIndexMap[channelID]
		nextIdx := (lastIdx + 1) % len(onlineCandidates)
		rrIndexMap[channelID] = nextIdx
		selected := onlineCandidates[nextIdx]
		rrMutex.Unlock()
		return []string{selected}
	}

	// Fallback to master if configured and not sender
	if master != nil && *master != "" && sender != *master {
		return []string{*master}
	}

	var allCandidates []string
	for _, participant := range participants {
		if participant != sender {
			allCandidates = append(allCandidates, participant)
		}
	}

	if len(allCandidates) > 0 {
		rrMutex.Lock()
		lastIdx := rrIndexMap[channelID]
		nextIdx := (lastIdx + 1) % len(allCandidates)
		rrIndexMap[channelID] = nextIdx
		selected := allCandidates[nextIdx]
		rrMutex.Unlock()
		return []string{selected}
	}

	return nil
}

func masterTargets(source, master string, participants, mentions []string) []string {
	if !isAgentSource(source) {
		if len(mentions) > 0 {
			return mentions
		}
		return []string{master}
	}
	sender := agentNameFromSource(source)
	if sender != master {
		return []string{master}
	}
	if len(mentions) > 0 {
		return mentions
	}
	return nil
}

// eventTargetsAgent mirrors the legacy Python poll filter. Untargeted human
// events remain visible for compatibility; agent/system output must be
// explicitly targeted before a local connector can receive it.
func eventTargetsAgent(record models.EventRecord, agentName string) bool {
	var metadata map[string]interface{}
	if err := json.Unmarshal(record.Metadata, &metadata); err != nil {
		return false
	}
	rawTargets, hasTargets := metadata["target_agents"]
	if !hasTargets {
		return isHumanSource(record.Source)
	}
	targets, ok := rawTargets.([]interface{})
	if !ok {
		return false
	}
	for _, value := range targets {
		if name, ok := value.(string); ok && name == agentName {
			return true
		}
	}
	return false
}
