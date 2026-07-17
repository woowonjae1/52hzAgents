package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

const routerPrompt = `You are a conversation router for a multi-agent workspace.
Choose exactly one next speaker for the latest message, or stop.

Participants:
%s
Master: %s
%s
Recent conversation:
%s

Latest message from %s:
%s

Rules:
- A human message must select one appropriate participant; prefer a directly addressed @mention.
- An agent message may select another agent only for an explicit handoff or a report back to the master.
- Never select the agent that just spoke.
- A final answer, status, acknowledgement, error, or uncertain agent message must stop.

Output exactly one line: next:<agent-name> or stop`

func routeWithLLM(workspaceID string, channel *models.Channel, req *SendEventRequest, participants []string) ([]string, bool) {
	settings := config.GlobalConfig
	if settings == nil || !settings.RouterLLMEnabled || settings.RouterLLMAPIKey == "" || len(participants) < 2 {
		return nil, false
	}

	var memberRows []models.WorkspaceMember
	db.DB.Where("workspace_id = ? AND agent_name IN ?", workspaceID, participants).Find(&memberRows)
	byName := map[string]models.WorkspaceMember{}
	for _, member := range memberRows {
		byName[member.AgentName] = member
	}
	participantLines := make([]string, 0, len(participants))
	for _, name := range participants {
		line := "- " + name
		if member, ok := byName[name]; ok && member.Description != nil && strings.TrimSpace(*member.Description) != "" {
			line += ": " + strings.TrimSpace(*member.Description)
		}
		participantLines = append(participantLines, line)
	}

	var recent []models.EventRecord
	db.DB.Where("network_id = ? AND target = ? AND type = ?", workspaceID, "channel/"+channel.Name, "workspace.message.posted").Order("timestamp desc").Limit(5).Find(&recent)
	history := make([]string, 0, len(recent))
	for index := len(recent) - 1; index >= 0; index-- {
		var payload map[string]interface{}
		if json.Unmarshal(recent[index].Payload, &payload) != nil || messageType(payload) != "chat" {
			continue
		}
		content, _ := payload["content"].(string)
		if content != "" {
			history = append(history, fmt.Sprintf("[%s] %s", recent[index].Source, truncateRouterText(content, 500)))
		}
	}
	if len(history) == 0 {
		history = append(history, "(no prior messages)")
	}
	master := "(none)"
	if channel.MasterAgent != nil && *channel.MasterAgent != "" {
		master = *channel.MasterAgent
	}
	plan := ""
	if strings.EqualFold(channel.OrchestrationMode, "workflow") && channel.OrchestrationInstruction != nil && strings.TrimSpace(*channel.OrchestrationInstruction) != "" {
		plan = "Workflow plan (authoritative):\n" + strings.TrimSpace(*channel.OrchestrationInstruction)
	}
	content, _ := req.Payload["content"].(string)
	prompt := fmt.Sprintf(routerPrompt, strings.Join(participantLines, "\n"), master, plan, strings.Join(history, "\n"), req.Source, truncateRouterText(content, 500))

	decision, err := requestRouterDecision(settings, prompt)
	if err != nil {
		return nil, false
	}
	decision = strings.TrimSpace(decision)
	if !strings.HasPrefix(strings.ToLower(decision), "next:") {
		// Preserve the original safety net: an LLM router must never drop a
		// human's request merely because it answered "stop" or malformed output.
		// Returning handled=false lets deterministic fallback pick a receiver.
		if isHumanSource(req.Source) {
			return nil, false
		}
		return []string{noResponseAgent}, true
	}
	chosen := strings.TrimSpace(decision[len("next:"):])
	for _, participant := range participants {
		if strings.EqualFold(participant, chosen) && participant != agentNameFromSource(req.Source) {
			return []string{participant}, true
		}
	}
	if isHumanSource(req.Source) {
		return nil, false
	}
	return []string{noResponseAgent}, true
}

func requestRouterDecision(settings *config.Config, prompt string) (string, error) {
	model := settings.RouterLLMModel
	if model == "" {
		if settings.RouterLLMProvider == "openai" {
			model = "gpt-4o-mini"
		} else {
			model = "claude-haiku-4-5-20251001"
		}
	}
	if settings.RouterLLMProvider == "openai" {
		endpoint := settings.RouterLLMBaseURL
		if endpoint == "" {
			endpoint = "https://api.openai.com/v1"
		}
		body := map[string]interface{}{"model": model, "max_tokens": 30, "messages": []map[string]string{{"role": "user", "content": prompt}}}
		response, err := routerPOST(endpoint+"/chat/completions", settings.RouterLLMAPIKey, body, false)
		if err != nil {
			return "", err
		}
		var parsed struct {
			Choices []struct {
				Message struct {
					Content string `json:"content"`
				} `json:"message"`
			} `json:"choices"`
		}
		if err := json.Unmarshal(response, &parsed); err != nil || len(parsed.Choices) == 0 {
			return "", fmt.Errorf("invalid OpenAI router response")
		}
		return parsed.Choices[0].Message.Content, nil
	}
	endpoint := settings.RouterLLMBaseURL
	if endpoint == "" {
		endpoint = "https://api.anthropic.com/v1"
	}
	body := map[string]interface{}{"model": model, "max_tokens": 30, "messages": []map[string]string{{"role": "user", "content": prompt}}}
	response, err := routerPOST(endpoint+"/messages", settings.RouterLLMAPIKey, body, true)
	if err != nil {
		return "", err
	}
	var parsed struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(response, &parsed); err != nil || len(parsed.Content) == 0 {
		return "", fmt.Errorf("invalid Anthropic router response")
	}
	return parsed.Content[0].Text, nil
}

func routerPOST(endpoint, apiKey string, body interface{}, anthropic bool) ([]byte, error) {
	payload, _ := json.Marshal(body)
	request, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	if anthropic {
		request.Header.Set("x-api-key", apiKey)
		request.Header.Set("anthropic-version", "2023-06-01")
	} else {
		request.Header.Set("Authorization", "Bearer "+apiKey)
	}
	client := &http.Client{Timeout: 15 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("router request failed: %s", response.Status)
	}
	return data, nil
}

func truncateRouterText(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}
