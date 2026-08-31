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
	allowed := make(map[string]string, len(participants))
	for _, p := range participants {
		allowed[strings.ToLower(p)] = p
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
	allowed := make(map[string]string, len(participants))
	for _, p := range participants {
		allowed[strings.ToLower(p)] = p
	}

	matches := pipelineRegex.FindAllStringSubmatchIndex(content, -1)
	if len(matches) < 2 {
		return nil
	}

	var segments []models.PipelineStep
	for i := 0; i < len(matches); i++ {
		nameStart, nameEnd := matches[i][2], matches[i][3]
		rawName := strings.ToLower(content[nameStart:nameEnd])
		if rawName == "knowledge" {
			continue
		}
		agentName, ok := allowed[rawName]
		if !ok {
			continue
		}

		instructionStart := matches[i][1]
		var instructionEnd int
		if i+1 < len(matches) {
			instructionEnd = matches[i+1][0]
		} else {
			instructionEnd = len(content)
		}

		instruction := strings.TrimSpace(content[instructionStart:instructionEnd])
		segments = append(segments, models.PipelineStep{
			Agent:       agentName,
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
func startPipeline(workspaceID, channelID, startedBy string, steps []models.PipelineStep) string {
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

	clearPipeline(channelID)
	record := models.ChannelPipeline{
		ID:           uuid.NewString(),
		WorkspaceID:  workspaceID,
		ChannelID:    channelID,
		Steps:        encoded,
		CurrentIndex: 0,
		Status:       "running",
		StartedBy:    startedBy,
	}
	if err := db.DB.Create(&record).Error; err != nil {
		log.Printf("pipeline: failed to persist chain for channel %s: %v", channelID, err)
		return ""
	}
	return record.ID
}

// clearPipeline drops the channel's chain completely.
func clearPipeline(channelID string) {
	if err := db.DB.Where("channel_id = ?", channelID).Delete(&models.ChannelPipeline{}).Error; err != nil {
		log.Printf("pipeline: failed to clear chain for channel %s: %v", channelID, err)
	}
}

// pausePipeline suspends the pipeline without deleting its progress, allowing safe human-in-the-loop takeover.
func pausePipeline(channelID string) {
	if err := db.DB.Model(&models.ChannelPipeline{}).
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
	}

	c.JSON(http.StatusOK, gin.H{"status": "halted", "finished_at": nowMs})
}

// CheckAndTriggerNextPipelineStep evaluates the current step's execution quality
// and either advances the chain to the next agent or triggers a self-correction retry.
func CheckAndTriggerNextPipelineStep(workspaceID string, target string, source string) {
	if !strings.HasPrefix(target, "channel/") {
		return
	}
	actor := agentNameFromSource(source)
	if actor == "" {
		return
	}
	channelName := strings.TrimPrefix(target, "channel/")

	var channel models.Channel
	if err := db.DB.Where("workspace_id = ? AND name = ?", workspaceID, channelName).First(&channel).Error; err != nil {
		return
	}

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

	// 1. Gather recent turn messages produced during this step for quality evaluation
	var turnEvents []models.EventRecord
	turnQuery := db.DB.Where("network_id = ? AND target = ? AND type LIKE ?", workspaceID, target, "workspace.message%")
	if steps[idx].StartedAt != nil {
		turnQuery = turnQuery.Where("timestamp >= ?", *steps[idx].StartedAt)
	}
	turnQuery.Order("timestamp asc, id asc").Limit(20).Find(&turnEvents)

	var turnMessages []string
	for _, te := range turnEvents {
		var p map[string]interface{}
		if json.Unmarshal(te.Payload, &p) == nil {
			if c, ok := p["content"].(string); ok && strings.TrimSpace(c) != "" {
				turnMessages = append(turnMessages, c)
			}
		}
	}

	// 2. Evaluate step execution quality using real verification command and delta regression check
	dir := resolveTurnDir(workspaceID, &channel, actor)
	var verificationCmd string
	if channel.VerificationCmd != nil {
		verificationCmd = *channel.VerificationCmd
	}
	baselineVerify := GetLatestTurnBaselineVerify(workspaceID, channel.ID, actor)
	evalRes := evaluator.EvaluateTurnWithVerification(actor, steps[idx], turnMessages, dir, verificationCmd, baselineVerify)
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

		if record.TotalRetries >= maxPipelineRetries {
			// Pipeline-level retry budget exhausted to prevent run-away token burn
			steps[idx].Status = "failed"
			errDetailStr := strings.Join(evalRes.ErrorDetails, "\n")
			steps[idx].LastError = &errDetailStr
			steps[idx].FinishedAt = &nowMs

			encoded, _ := json.Marshal(steps)
			db.DB.Model(&models.ChannelPipeline{}).
				Where("id = ? AND current_index = ? AND status = ?", record.ID, idx, "running").
				Updates(map[string]interface{}{
					"steps":  encoded,
					"status": "halted_budget",
				})

			haltMsg := fmt.Sprintf("⚠️ [Pipeline Halted: Budget Exceeded] Total retries across pipeline reached limit (%d/%d). Halting to prevent infinite loop or token drain.\nLast error:\n> %s\nHuman intervention required.",
				record.TotalRetries, maxPipelineRetries, strings.Join(evalRes.ErrorDetails, "\n> "))
			RelayPipelineAlert(workspaceID, target, haltMsg)
			return
		}

		if steps[idx].RetryCount < maxRetries {
			// Trigger self-correction retry
			steps[idx].RetryCount++
			steps[idx].Status = "retrying"
			errDetailStr := strings.Join(evalRes.ErrorDetails, "\n")
			steps[idx].LastError = &errDetailStr

			encoded, _ := json.Marshal(steps)
			db.DB.Model(&models.ChannelPipeline{}).
				Where("id = ? AND current_index = ? AND status = ?", record.ID, idx, "running").
				Updates(map[string]interface{}{
					"steps":         encoded,
					"total_retries": record.TotalRetries + 1,
				})

			relaySelfCorrection(workspaceID, target, actor, evalRes.FeedbackMessage, pipelineTaskID(record.ID, idx))
			return
		}

		// Retries exhausted: fail the pipeline and halt
		steps[idx].Status = "failed"
		errDetailStr := strings.Join(evalRes.ErrorDetails, "\n")
		steps[idx].LastError = &errDetailStr
		steps[idx].FinishedAt = &nowMs

		encoded, _ := json.Marshal(steps)
		db.DB.Model(&models.ChannelPipeline{}).
			Where("id = ? AND current_index = ? AND status = ?", record.ID, idx, "running").
			Updates(map[string]interface{}{
				"steps":  encoded,
				"status": "failed",
			})

		haltMsg := fmt.Sprintf("⚠️ [Pipeline Halted] Step %d (@%s) failed after %d attempts.\nErrors:\n> %s\nHuman intervention required.",
			idx+1, actor, steps[idx].RetryCount, strings.Join(evalRes.ErrorDetails, "\n> "))
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
	}

	encoded, err := json.Marshal(steps)
	if err != nil {
		log.Printf("pipeline: failed to encode chain %s: %v", record.ID, err)
		return
	}

	// Compare-and-swap on (current_index, status) so two replies racing through
	// this path cannot advance the chain twice.
	result := db.DB.Model(&models.ChannelPipeline{}).
		Where("id = ? AND current_index = ? AND status = ?", record.ID, idx, "running").
		Updates(map[string]interface{}{
			"steps":         encoded,
			"current_index": nextIdx,
			"status":        nextStatus,
		})
	if result.Error != nil {
		log.Printf("pipeline: failed to advance chain %s: %v", record.ID, result.Error)
		return
	}
	if result.RowsAffected == 0 || nextStatus == "completed" {
		return
	}

	relayPipelineStep(workspaceID, target, steps[nextIdx], actor, deliverable, pipelineTaskID(record.ID, nextIdx))
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
var mentionPattern = regexp.MustCompile(`@([A-Za-z0-9_-]+)`)

// routeMessage applies the original WorkspaceMod routing rules to one chat
// event. It returns routed=false for operational/status events, which must be
// persisted and shown in the UI but must never wake another agent.
func routeMessage(workspaceID string, channel *models.Channel, req *SendEventRequest) (targets []string, routed bool, err error) {
	if req.Type != "workspace.message.posted" || channel == nil {
		return nil, false, nil
	}
	if _, explicit := req.Metadata["target_agents"]; explicit {
		return nil, false, nil
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
	db.DB.Where("workspace_id = ?", workspaceID).Find(&wsMembers)
	allWorkspaceAgents := make([]string, 0, len(wsMembers))
	for _, m := range wsMembers {
		if m.AgentName != "" && m.AgentName != noResponseAgent {
			allWorkspaceAgents = append(allWorkspaceAgents, m.AgentName)
		}
	}

	var memberships []models.ChannelMember
	if err := db.DB.Where("channel_id = ?", channel.ID).Order("agent_name ASC").Find(&memberships).Error; err != nil {
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
	online := onlineParticipants(workspaceID, availableCandidates)

	// If human message contains multi-agent pipeline (@agent1 ... @agent2 ... @agent3 ...)
	if isHumanSource(req.Source) {
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

		if len(segments) >= 2 {
			if pipelineID := startPipeline(workspaceID, channel.ID, req.Source, segments); pipelineID != "" && req.Metadata != nil {
				// Turn attribution groups every retry of a step under that
				// step's key. Step 0 is dispatched through the event handler
				// rather than a relay, so its key travels in metadata to keep
				// it grouped with the retries relaySelfCorrection will send.
				req.Metadata["task_id"] = pipelineTaskID(pipelineID, 0)
			}
			return []string{segments[0].Agent}, true, nil
		}
		// Suspend running pipeline instead of destroying it when human intervenes
		pausePipeline(channel.ID)
	}

	// Agent-sourced messages: only route if the agent explicitly @mentions
	// another agent. Without a mention, the reply is stored but must NOT wake
	// another agent — otherwise every agent reply triggers the next agent's
	// turn, creating an infinite echo storm.
	if isAgentSource(req.Source) {
		if len(mentions) > 0 {
			sender := agentNameFromSource(req.Source)
			var nextTargets []string
			for _, m := range mentions {
				if !strings.EqualFold(m, sender) {
					nextTargets = append(nextTargets, m)
				}
			}
			if len(nextTargets) > 0 {
				return nextTargets, true, nil
			}
		}
		return nil, false, nil
	}

	if len(participants) == 0 {
		return []string{noResponseAgent}, true, nil
	}

	mode := strings.ToLower(strings.TrimSpace(channel.OrchestrationMode))
	if mode == "master" && channel.MasterAgent != nil && *channel.MasterAgent != "" {
		targets = masterTargets(req.Source, *channel.MasterAgent, participants, mentions)
	} else if len(participants) >= 2 {
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
	return strings.HasPrefix(source, "52hz:") || strings.HasPrefix(source, "agent:") || strings.HasPrefix(source, "openagents:")
}

func agentNameFromSource(source string) string {
	s := strings.TrimPrefix(source, "52hz:")
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
	allowed := make(map[string]bool, len(participants))
	for _, name := range participants {
		allowed[name] = true
	}
	seen := map[string]bool{}
	mentions := make([]string, 0)
	add := func(name string) {
		if allowed[name] && !seen[name] {
			mentions = append(mentions, name)
			seen[name] = true
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

func onlineParticipants(workspaceID string, participants []string) map[string]bool {
	if len(participants) == 0 {
		return nil
	}
	var members []models.WorkspaceMember
	db.DB.Where("workspace_id = ? AND agent_name IN ?", workspaceID, participants).Find(&members)
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
