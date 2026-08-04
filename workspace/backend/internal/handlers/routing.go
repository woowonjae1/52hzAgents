package handlers

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

var (
	rrMutex    sync.Mutex
	rrIndexMap = make(map[string]int) // channelID -> last routed index
)

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

	var memberships []models.ChannelMember
	db.DB.Where("channel_id = ?", channel.ID).Order("id ASC").Find(&memberships)
	participants := make([]string, 0, len(memberships))
	for _, member := range memberships {
		if member.AgentName != noResponseAgent {
			participants = append(participants, member.AgentName)
		}
	}

	// 若频道尚未关联任何专属成员，自动回退取工作区中的所有 Agent 成员
	if len(participants) == 0 {
		var wsMembers []models.WorkspaceMember
		db.DB.Where("workspace_id = ?", workspaceID).Find(&wsMembers)
		for _, m := range wsMembers {
			if m.AgentName != "" && m.AgentName != noResponseAgent {
				participants = append(participants, m.AgentName)
			}
		}
	}

	if len(participants) == 0 {
		return []string{noResponseAgent}, true, nil
	}

	content, _ := req.Payload["content"].(string)
	mentions := mentionedAgents(content, req.Payload, participants)
	online := onlineParticipants(workspaceID, participants)

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
func isAgentSource(source string) bool { return strings.HasPrefix(source, "openagents:") }

func agentNameFromSource(source string) string {
	return strings.TrimPrefix(source, "openagents:")
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
