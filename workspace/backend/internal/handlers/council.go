package handlers

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/hub"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

// Default challenge timeout in seconds (1800s = 30 minutes, aligned with scheduler timeout)
const defaultChallengeTimeoutSec = 1800

type CreateCouncilSessionRequest struct {
	Channel   string `json:"channel" binding:"required"`
	Topic     string `json:"topic" binding:"required"`
	MaxRounds int    `json:"max_rounds"`
}

type PostSpeechActRequest struct {
	ActType     string                 `json:"act_type" binding:"required"` // PROPOSAL | CHALLENGE | DEFENSE | SUPPORT | RESOLUTION
	Summary     string                 `json:"summary" binding:"required"`
	TargetActID *string                `json:"target_act_id"`
	Payload     map[string]interface{} `json:"payload"`
	Metadata    map[string]interface{} `json:"metadata"`
}

// CreateCouncilSession handles POST /v1/council/sessions
func CreateCouncilSession(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}

	var req CreateCouncilSessionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	channelName := strings.TrimPrefix(strings.TrimSpace(req.Channel), "channel/")
	var channel models.Channel
	if err := db.DB.Where("workspace_id = ? AND (id = ? OR name = ?)", workspace.ID, channelName, channelName).First(&channel).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Channel not found"})
		return
	}

	initiator := currentActor(c)
	if initiator == "" {
		initiator = "human:user"
	}

	session, err := startCouncilSession(workspace.ID, &channel, initiator, strings.TrimSpace(req.Topic), req.MaxRounds)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, session)
}

// GetCouncilSession handles GET /v1/council/sessions/:session_id
func GetCouncilSession(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}

	sessionID := c.Param("session_id")
	var session models.CouncilSession
	if err := db.DB.Where("id = ? AND workspace_id = ?", sessionID, workspace.ID).First(&session).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Council session not found"})
		return
	}

	var acts []models.SpeechActRecord
	db.DB.Where("session_id = ?", sessionID).Order("round asc, created_at asc").Find(&acts)

	c.JSON(http.StatusOK, gin.H{
		"session": session,
		"acts":    acts,
	})
}

// PostSpeechAct handles POST /v1/council/sessions/:session_id/acts
func PostSpeechAct(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}

	sessionID := c.Param("session_id")
	var session models.CouncilSession
	if err := db.DB.Where("id = ? AND workspace_id = ?", sessionID, workspace.ID).First(&session).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Council session not found"})
		return
	}

	if session.Status != models.CouncilStatusDebating {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": fmt.Sprintf("Council session is not in debating status (current: %s)", session.Status),
		})
		return
	}

	var req PostSpeechActRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	actor := currentActor(c)
	if actor == "" {
		actor = "unknown"
	}
	agentSource := "52hz:" + actor
	if strings.HasPrefix(actor, "human:") || strings.HasPrefix(actor, "agent:") || strings.HasPrefix(actor, "52hz:") {
		agentSource = actor
	}

	// Reject acts from a revoked session, but deliberately stay lenient: a caller
	// that supplies no session_id at all is still accepted. Only the MCP adapters
	// (4 of 11) send one; the rest reach this endpoint by curl from a prompt
	// template that carries no metadata, and failing closed here would lock Codex
	// and Gemini out of deliberation entirely — which would defeat the point,
	// since the adversarial design depends on a *heterogeneous* challenger.
	//
	// So this is not an identity guarantee. X-Actor-Id is an unauthenticated
	// header and the workspace token is shared by every agent, so a caller can
	// claim to be the mandatory challenger and cast the SUPPORT that unlocks
	// sealing. The accepted threat model is a confused agent, not an attacker.
	// Closing this properly means per-agent credentials, not a stricter check
	// here; do not convert this to fail-closed without that in place first.
	if err := validateMessageSession(workspace.ID, agentSource, req.Metadata); err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "session_revoked: client is not the active session for this agent"})
		return
	}

	actType := strings.ToUpper(strings.TrimSpace(req.ActType))
	switch actType {
	case models.ActProposal, models.ActChallenge, models.ActDefense, models.ActSupport, models.ActResolution:
	default:
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("Invalid act_type: %s", actType)})
		return
	}

	// Fetch previous acts to enforce discourse rules
	var existingActs []models.SpeechActRecord
	db.DB.Where("session_id = ?", session.ID).Order("round asc, created_at asc").Find(&existingActs)

	// Sealing authority is deliberately narrow. `existingActs` is ordered, so the
	// decisive question is not "did anyone ever agree" but "is the version that is
	// on the table right now endorsed by the agent appointed to attack it".
	hasProposal := false
	hasChallenge := false
	// latestVersionIdx tracks the newest substantive design on the table: the
	// original PROPOSAL, or the revision a later DEFENSE replaced it with.
	latestVersionIdx := -1
	challengerSupportIdx := -1
	for i, a := range existingActs {
		switch a.ActType {
		case models.ActProposal:
			hasProposal = true
			latestVersionIdx = i
		case models.ActDefense:
			latestVersionIdx = i
		case models.ActChallenge:
			hasChallenge = true
		case models.ActSupport:
			// Only the appointed adversary can endorse. A bystander agent's "lgtm"
			// is still recorded as discourse but carries no sealing authority —
			// otherwise the proposer only needs one friendly agent to rubber-stamp
			// its own work and appointing a challenger would mean nothing.
			if session.MandatoryChallenger != "" && strings.EqualFold(a.Author, session.MandatoryChallenger) {
				challengerSupportIdx = i
			}
		}
	}
	// A SUPPORT endorses the design that was on the table when it was given. A
	// later DEFENSE puts a new, unreviewed design there and invalidates it.
	hasCurrentSupport := challengerSupportIdx > latestVersionIdx

	// Rule 3 Enforcement: Self-certification of victory is physically forbidden!
	// RESOLUTION is ONLY permitted after at least one CHALLENGE and subsequent SUPPORT from challenger.
	if actType == models.ActResolution {
		if !hasProposal || !hasChallenge || !hasCurrentSupport {
			c.JSON(http.StatusBadRequest, gin.H{
				"error": fmt.Sprintf("Resolution forbidden: the version currently on the table must be challenged and then explicitly supported by the appointed adversary (@%s) before it can be sealed. A revision submitted after a SUPPORT must be supported again, and a bystander's endorsement does not count. If consensus cannot be reached within budget, request human arbitration.", session.MandatoryChallenger),
			})
			return
		}
	}

	// Challenger cannot challenge own proposal
	if actType == models.ActChallenge {
		if session.ProposerAgent != "" && strings.EqualFold(actor, session.ProposerAgent) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "The proposer cannot challenge their own proposal. Challenge must come from an adversary."})
			return
		}
	}

	// Proposer cannot submit SUPPORT for own proposal
	if actType == models.ActSupport {
		if session.ProposerAgent != "" && strings.EqualFold(actor, session.ProposerAgent) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Proposer cannot submit SUPPORT for their own proposal."})
			return
		}
	}

	payloadBytes, _ := json.Marshal(req.Payload)
	actID := uuid.New().String()
	speechAct := models.SpeechActRecord{
		ID:          actID,
		SessionID:   session.ID,
		Round:       session.CurrentRound,
		Author:      actor,
		ActType:     actType,
		TargetActID: req.TargetActID,
		Summary:     strings.TrimSpace(req.Summary),
		Payload:     payloadBytes,
	}

	if err := db.DB.Create(&speechAct).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to record speech act"})
		return
	}

	timeoutSec := getChallengeTimeoutSec()
	nowMs := time.Now().UnixMilli()
	deadline := nowMs + int64(timeoutSec)*1000

	// State machine transition
	sessionUpdates := map[string]interface{}{}
	if actType == models.ActProposal {
		session.ProposerAgent = actor
		sessionUpdates["proposer_agent"] = actor
		sessionUpdates["challenge_deadline_at"] = deadline
		session.ChallengeDeadlineAt = &deadline
	} else if actType == models.ActChallenge {
		// Challenge received; extend deadline for defense
		sessionUpdates["challenge_deadline_at"] = deadline
		session.ChallengeDeadlineAt = &deadline
	} else if actType == models.ActDefense {
		// Round progresses after defense
		if session.CurrentRound < session.MaxRounds {
			session.CurrentRound++
			sessionUpdates["current_round"] = session.CurrentRound
			sessionUpdates["challenge_deadline_at"] = deadline
			session.ChallengeDeadlineAt = &deadline
		} else {
			// A DEFENSE puts a revised, unreviewed design on the table and no round
			// remains in which to review it. Escalate unconditionally: leaving the
			// session in `debating` here strands it — nothing can advance it, and the
			// scheduler would later reap it as a challenger timeout that never happened.
			session.Status = models.CouncilStatusBudgetExhausted
			sessionUpdates["status"] = models.CouncilStatusBudgetExhausted
		}
	} else if actType == models.ActResolution {
		session.Status = models.CouncilStatusConverged
		sessionUpdates["status"] = models.CouncilStatusConverged
		sessionUpdates["resolution"] = payloadBytes
	}

	if len(sessionUpdates) > 0 {
		_ = db.DB.Model(&session).Updates(sessionUpdates)
	}

	// Project speech act to channel event stream and wake target agent
	var channel models.Channel
	if err := db.DB.Where("id = ?", session.ChannelID).First(&channel).Error; err == nil {
		projectSpeechActToEvents(workspace.ID, &channel, &session, &speechAct, timeoutSec)
	}

	c.JSON(http.StatusCreated, gin.H{
		"act":     speechAct,
		"session": session,
	})
}

func startCouncilSession(workspaceID string, channel *models.Channel, initiatedBy, topic string, maxRounds int) (*models.CouncilSession, error) {
	if maxRounds <= 0 {
		maxRounds = 3
	}
	timeoutSec := getChallengeTimeoutSec()
	nowMs := time.Now().UnixMilli()
	deadline := nowMs + int64(timeoutSec)*1000

	challenger := selectMandatoryChallenger(workspaceID, channel.ID, initiatedBy)

	session := models.CouncilSession{
		ID:                  uuid.New().String(),
		WorkspaceID:         workspaceID,
		ChannelID:           channel.ID,
		Topic:               topic,
		Status:              models.CouncilStatusDebating,
		InitiatedBy:         initiatedBy,
		MandatoryChallenger: challenger,
		CurrentRound:        1,
		MaxRounds:           maxRounds,
		ChallengeDeadlineAt: &deadline,
	}

	if err := db.DB.Create(&session).Error; err != nil {
		return nil, err
	}

	// Project announcement to channel
	projectSessionAnnouncement(workspaceID, channel, &session)
	return &session, nil
}

func getChallengeTimeoutSec() int {
	timeoutSec := defaultChallengeTimeoutSec
	if config.GlobalConfig != nil && config.GlobalConfig.PipelineStepTimeoutSeconds > 0 {
		timeoutSec = config.GlobalConfig.PipelineStepTimeoutSeconds
	}
	return timeoutSec
}

// selectMandatoryChallenger picks a capable, non-author adversary prioritizing heterogeneous agent types.
func selectMandatoryChallenger(workspaceID, channelID, excludeAuthor string) string {
	cleanAuthor := strings.TrimPrefix(excludeAuthor, "52hz:")
	cleanAuthor = strings.TrimPrefix(cleanAuthor, "human:")
	cleanAuthor = strings.TrimPrefix(cleanAuthor, "agent:")

	var members []models.WorkspaceMember
	db.DB.Where("workspace_id = ?", workspaceID).Find(&members)

	var candidates []models.WorkspaceMember
	for _, m := range members {
		if m.AgentName == "" || m.AgentName == noResponseAgent || strings.EqualFold(m.AgentName, cleanAuthor) {
			continue
		}
		candidates = append(candidates, m)
	}

	if len(candidates) == 0 {
		return "reviewer"
	}

	// Priority 1: explicitly designated reviewer / auditor
	for _, m := range candidates {
		roleLower := strings.ToLower(m.Role)
		nameLower := strings.ToLower(m.AgentName)
		if strings.Contains(roleLower, "review") || strings.Contains(roleLower, "audit") ||
			strings.Contains(nameLower, "review") || strings.Contains(nameLower, "audit") {
			return m.AgentName
		}
	}

	// Priority 2: different agent_type
	var authorType string
	for _, m := range members {
		if strings.EqualFold(m.AgentName, cleanAuthor) && m.AgentType != nil {
			authorType = *m.AgentType
			break
		}
	}

	for _, m := range candidates {
		if m.AgentType != nil && *m.AgentType != authorType && *m.AgentType != "" {
			return m.AgentName
		}
	}

	return candidates[0].AgentName
}

func projectSessionAnnouncement(workspaceID string, channel *models.Channel, session *models.CouncilSession) {
	nowUnixMs := time.Now().UnixNano() / int64(time.Millisecond)
	eventID := uuid.New().String()
	targetChan := "channel/" + channel.Name

	content := fmt.Sprintf("🏛️ **Council Session Initiated**\n\n" +
		"**Topic**: %s\n" +
		"**Session ID**: `%s`\n" +
		"**Mandatory Challenger**: @%s\n" +
		"**Max Rounds**: %d\n\n" +
		"_Agents may submit a PROPOSAL using `workspace_council_post` or the Council REST API._",
		session.Topic, session.ID, session.MandatoryChallenger, session.MaxRounds)

	payload := map[string]interface{}{
		"content":      content,
		"sender_name":  "Council Supervisor",
		"sender_type":  "system",
		"message_type": "chat",
	}

	metadata := map[string]interface{}{
		"speech_act":    true,
		"act_type":      "SESSION_START",
		"session_id":    session.ID,
		"target_agents": []string{session.MandatoryChallenger},
	}

	emitCouncilEvent(workspaceID, targetChan, eventID, nowUnixMs, payload, metadata)
}

func projectSpeechActToEvents(workspaceID string, channel *models.Channel, session *models.CouncilSession, act *models.SpeechActRecord, timeoutSec int) {
	nowUnixMs := time.Now().UnixNano() / int64(time.Millisecond)
	eventID := uuid.New().String()
	targetChan := "channel/" + channel.Name

	var targetAgents []string
	var promptContent string

	switch act.ActType {
	case models.ActProposal:
		targetAgents = []string{session.MandatoryChallenger}
		promptContent = fmt.Sprintf("@%s\n🏛️ [Council Debate - Round %d] Proposal submitted by @%s.\n\n" +
			"**Topic**: %s\n" +
			"**Session ID**: `%s`\n" +
			"**Proposal ID**: `%s`\n" +
			"**Summary**: %s\n\n" +
			"👉 **MANDATORY ACTION REQUIRED**:\n" +
			"You are designated as the **Mandatory Challenger**. You must critically inspect this proposal for architectural flaws, security risks, or missing edge cases.\n" +
			"Submit your structured CHALLENGE using `workspace_council_post` (or via Council API) within %d seconds.",
			session.MandatoryChallenger, act.Round, act.Author, session.Topic, session.ID, act.ID, act.Summary, timeoutSec)

	case models.ActChallenge:
		targetAgents = []string{session.ProposerAgent}
		promptContent = fmt.Sprintf("@%s\n🏛️ [Council Debate - Round %d] Your proposal was CHALLENGED by @%s.\n\n" +
			"**Target Act ID**: `%s`\n" +
			"**Challenge Summary**: %s\n\n" +
			"👉 **DEFENSE REQUIRED**:\n" +
			"Please evaluate the criticisms above, revise your proposal, and submit your DEFENSE using `workspace_council_post`.",
			session.ProposerAgent, act.Round, act.Author, safeStr(act.TargetActID), act.Summary)

	case models.ActDefense:
		targetAgents = []string{session.MandatoryChallenger}
		promptContent = fmt.Sprintf("@%s\n🏛️ [Council Debate - Round %d] Proposer @%s submitted a DEFENSE.\n\n" +
			"**Defense Summary**: %s\n\n" +
			"👉 **REVIEW REQUIRED**:\n" +
			"If all concerns are resolved, submit SUPPORT. Otherwise, submit an additional CHALLENGE.",
			session.MandatoryChallenger, act.Round, act.Author, act.Summary)

	case models.ActSupport:
		targetAgents = []string{session.ProposerAgent}
		promptContent = fmt.Sprintf("@%s\n🏛️ [Council Debate - Round %d] Challenger @%s submitted SUPPORT for the proposal.\n\n" +
			"**Summary**: %s\n\n" +
			"👉 **SEAL RESOLUTION**:\n" +
			"The proposal has satisfied adversarial review. Proposer @%s may now submit the final RESOLUTION to conclude the council.",
			session.ProposerAgent, act.Round, act.Author, act.Summary, session.ProposerAgent)

	case models.ActResolution:
		promptContent = fmt.Sprintf("✅ **Council Resolution Sealed (Consensus Reached)**\n\n" +
			"**Topic**: %s\n" +
			"**Session ID**: `%s`\n" +
			"**Sealed by**: @%s\n" +
			"**Summary**: %s\n\n" +
			"Awaiting Human Chairman Approval (Approve to execute, Veto to reject).",
			session.Topic, session.ID, act.Author, act.Summary)
	}

	payload := map[string]interface{}{
		"content":      promptContent,
		"sender_name":  act.Author,
		"sender_type":  "agent",
		"message_type": "chat",
	}

	metadata := map[string]interface{}{
		"speech_act":    true,
		"act_type":      act.ActType,
		"act_id":        act.ID,
		"session_id":    session.ID,
		"round":         act.Round,
		"summary":       act.Summary,
		"target_agents": targetAgents,
	}

	emitCouncilEvent(workspaceID, targetChan, eventID, nowUnixMs, payload, metadata)
}

func emitCouncilEvent(workspaceID, targetChan, eventID string, nowUnixMs int64, payload, metadata map[string]interface{}) {
	payloadBytes, _ := json.Marshal(payload)
	metaBytes, _ := json.Marshal(metadata)

	eventRec := models.EventRecord{
		ID:         eventID,
		NetworkID:  workspaceID,
		Type:       "workspace.message.posted",
		Source:     "system:council",
		Target:     targetChan,
		Payload:    payloadBytes,
		Metadata:   metaBytes,
		Timestamp:  nowUnixMs,
		Visibility: "channel",
	}

	if err := db.DB.Create(&eventRec).Error; err != nil {
		log.Printf("council: failed to save projection event %s: %v", eventID, err)
		return
	}

	fullEvent, _ := json.Marshal(gin.H{
		"id":        eventID,
		"event_id":  eventID,
		"network":   workspaceID,
		"type":      "workspace.message.posted",
		"source":    "system:council",
		"target":    targetChan,
		"payload":   payload,
		"metadata":  metadata,
		"timestamp": nowUnixMs,
		"status":    "confirmed",
	})

	if hub.GlobalHub != nil {
		hub.GlobalHub.Broadcast(hub.BroadcastMsg{
			WorkspaceID: workspaceID,
			ChannelName: targetChan,
			Payload:     string(fullEvent),
		})
	}
}

func safeStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// InterceptRFCCommand handles `/rfc <topic>` in human chat messages to initiate a council session
func InterceptRFCCommand(workspaceID, target, source, content string) bool {
	contentTrimmed := strings.TrimSpace(content)
	if !strings.HasPrefix(contentTrimmed, "/rfc ") && contentTrimmed != "/rfc" {
		return false
	}
	topic := strings.TrimSpace(strings.TrimPrefix(contentTrimmed, "/rfc"))
	if topic == "" {
		topic = "Architecture & Engineering Deliberation"
	}

	channelName := strings.TrimPrefix(target, "channel/")
	var channel models.Channel
	if err := db.DB.Where("workspace_id = ? AND name = ?", workspaceID, channelName).First(&channel).Error; err != nil {
		return false
	}

	_, err := startCouncilSession(workspaceID, &channel, source, topic, 3)
	return err == nil
}
