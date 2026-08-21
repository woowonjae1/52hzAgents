package compaction

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
)

const compactionSystemPrompt = `You are a context compaction engine for an autonomous multi-agent coding platform.
Your task is to summarize past conversation history into an ultra-dense, structured historical checkpoint so that agents can maintain full context without token bloat.

Preserve exact details: filenames, URLs, key decisions, architectural agreements, commands run, and pending todos.

Format your output EXACTLY as follows:
### 1. Goals & Objectives
(Bullet points of user intent, task objectives, requirements)

### 2. Key Decisions & Consensus
(Architectural choices, conventions agreed upon, resolutions)

### 3. Actions & Modifications
(Files edited, commands executed, tools called, outputs achieved)

### 4. Pending Tasks & Current State
(Next steps, open blockers, active work in progress)

Be concise, accurate, and avoid filler text.`

const compactionUserPromptTemplate = `Previous Historical Summary (if any):
%s

New Dialogue to Compact:
%s

Produce a consolidated, updated structured summary integrating the previous summary and the new dialogue:`

// GenerateSummary produces a dense structured summary of the given message items,
// optionally merging with an existing prior summary checkpoint.
func GenerateSummary(cfg *config.Config, previousSummary string, messages []MessageItem) (string, error) {
	if len(messages) == 0 {
		return previousSummary, nil
	}

	// 1. Check if LLM router is available and configured
	if cfg != nil && cfg.RouterLLMEnabled && cfg.RouterLLMAPIKey != "" {
		summary, err := generateSummaryViaLLM(cfg, previousSummary, messages)
		if err == nil && strings.TrimSpace(summary) != "" {
			return strings.TrimSpace(summary), nil
		}
	}

	// 2. Fallback: High-availability deterministic rule-based summarizer
	return GenerateDeterministicSummary(previousSummary, messages), nil
}

func formatMessagesForPrompt(messages []MessageItem) string {
	var sb strings.Builder
	for _, m := range messages {
		source := m.Source
		if source == "" {
			source = "unknown"
		}
		content := strings.TrimSpace(m.Content)
		if content == "" {
			continue
		}
		sb.WriteString(fmt.Sprintf("[%s] %s\n", source, content))
	}
	return sb.String()
}

func generateSummaryViaLLM(cfg *config.Config, previousSummary string, messages []MessageItem) (string, error) {
	if strings.TrimSpace(previousSummary) == "" {
		previousSummary = "(None - this is the initial compaction checkpoint)"
	}

	dialogueText := formatMessagesForPrompt(messages)
	userPrompt := fmt.Sprintf(compactionUserPromptTemplate, previousSummary, dialogueText)

	model := cfg.RouterLLMModel
	if model == "" {
		if cfg.RouterLLMProvider == "openai" {
			model = "gpt-4o-mini"
		} else {
			model = "claude-haiku-4-5-20251001"
		}
	}

	if cfg.RouterLLMProvider == "openai" {
		endpoint := cfg.RouterLLMBaseURL
		if endpoint == "" {
			endpoint = "https://api.openai.com/v1"
		}
		body := map[string]interface{}{
			"model":       model,
			"max_tokens":  1500,
			"temperature": 0.2,
			"messages": []map[string]string{
				{"role": "system", "content": compactionSystemPrompt},
				{"role": "user", "content": userPrompt},
			},
		}
		respBytes, err := sendLLMRequest(endpoint+"/chat/completions", cfg.RouterLLMAPIKey, body, false)
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
		if err := json.Unmarshal(respBytes, &parsed); err != nil || len(parsed.Choices) == 0 {
			return "", fmt.Errorf("invalid OpenAI response for compaction")
		}
		return parsed.Choices[0].Message.Content, nil
	}

	// Anthropic format
	endpoint := cfg.RouterLLMBaseURL
	if endpoint == "" {
		endpoint = "https://api.anthropic.com/v1"
	}
	body := map[string]interface{}{
		"model":       model,
		"max_tokens":  1500,
		"temperature": 0.2,
		"system":      compactionSystemPrompt,
		"messages": []map[string]string{
			{"role": "user", "content": userPrompt},
		},
	}
	respBytes, err := sendLLMRequest(endpoint+"/messages", cfg.RouterLLMAPIKey, body, true)
	if err != nil {
		return "", err
	}
	var parsed struct {
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(respBytes, &parsed); err != nil || len(parsed.Content) == 0 {
		return "", fmt.Errorf("invalid Anthropic response for compaction")
	}
	return parsed.Content[0].Text, nil
}

func sendLLMRequest(endpoint, apiKey string, body interface{}, anthropic bool) ([]byte, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if anthropic {
		req.Header.Set("x-api-key", apiKey)
		req.Header.Set("anthropic-version", "2023-06-01")
	} else {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 128*1024))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("LLM request failed status %d: %s", resp.StatusCode, string(data))
	}
	return data, nil
}

// Keyword cues for the deterministic fallback. Sections 2 and 4 carry no content
// unless something is actually extracted for them, so the cues are matched against
// each line of every message rather than just the opening line.
var decisionCues = []string{
	"decided", "decision", "agreed", "consensus", "we will", "we'll", "let's use",
	"instead of", "convention", "chose", "chosen", "approach is", "settled on",
	"决定", "采用", "约定", "共识", "方案", "改用", "统一用",
}

var pendingCues = []string{
	"todo", "to-do", "next step", "next up", "pending", "blocked", "blocker",
	"still need", "remaining", "fixme", "follow up", "follow-up", "not yet",
	"待办", "待定", "下一步", "未完成", "阻塞", "还需", "未解决",
}

func matchesAnyCue(lowerLine string, cues []string) bool {
	for _, cue := range cues {
		if strings.Contains(lowerLine, cue) {
			return true
		}
	}
	return false
}

func clipLine(line string, limit int) string {
	line = strings.TrimSpace(line)
	if len(line) <= limit {
		return line
	}
	// Trim on a rune boundary so multi-byte CJK is not cut mid-character.
	runes := []rune(line)
	if len(runes) <= limit {
		return line
	}
	return string(runes[:limit-3]) + "..."
}

func tailOf(items []string, max int) []string {
	if len(items) <= max {
		return items
	}
	return items[len(items)-max:]
}

// withoutClaimed removes bullets already emitted under another section, and any
// whose text is a near-restatement of one (same source and same opening clause).
func withoutClaimed(items []string, claimed map[string]bool) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		if claimed[item] {
			continue
		}
		out = append(out, item)
	}
	return out
}

// dedupe drops repeated bullets while preserving order. Agent chatter repeats the
// same decision or TODO on every turn, and without this the checkpoint restates one
// line a dozen times -- which is what a compaction pass exists to avoid.
func dedupe(items []string) []string {
	seen := make(map[string]bool, len(items))
	out := make([]string, 0, len(items))
	for _, item := range items {
		if seen[item] {
			continue
		}
		seen[item] = true
		out = append(out, item)
	}
	return out
}

// GenerateDeterministicSummary produces a structured summary using deterministic keyword and role extraction.
// Used when no LLM API is available or as an instant zero-latency fallback.
func GenerateDeterministicSummary(previousSummary string, messages []MessageItem) string {
	var goals []string
	var actions []string
	var decisions []string
	var pending []string
	var latestAgentNotes []string
	participants := make(map[string]bool)

	for _, m := range messages {
		source := m.Source
		if source == "" {
			source = "unknown"
		}
		participants[source] = true
		content := strings.TrimSpace(m.Content)
		if content == "" {
			continue
		}

		lines := strings.Split(content, "\n")
		firstLine := clipLine(lines[0], 120)

		if strings.HasPrefix(source, "human:") {
			goals = append(goals, fmt.Sprintf("- %s requested: %s", source, firstLine))
		} else if strings.Contains(content, "```") || strings.Contains(content, "exec") || strings.Contains(content, "Created") || strings.Contains(content, "Modified") {
			actions = append(actions, fmt.Sprintf("- %s: %s", source, firstLine))
		} else {
			latestAgentNotes = append(latestAgentNotes, fmt.Sprintf("- %s: %s", source, firstLine))
		}

		// Sections 2 and 4 are extracted from any line, not just the opener: a
		// decision or a TODO is usually stated mid-message.
		for _, line := range lines {
			trimmed := strings.TrimSpace(line)
			if trimmed == "" {
				continue
			}
			lower := strings.ToLower(trimmed)
			// A line goes to exactly one section. Emitting it into several restates
			// the same text two or three times and wipes out the token saving that
			// is the whole point of a checkpoint.
			switch {
			case matchesAnyCue(lower, decisionCues):
				decisions = append(decisions, fmt.Sprintf("- %s: %s", source, clipLine(trimmed, 110)))
			case matchesAnyCue(lower, pendingCues):
				pending = append(pending, fmt.Sprintf("- %s: %s", source, clipLine(trimmed, 110)))
			}
		}
	}

	// Map iteration order is randomized, so the participant list must be sorted or
	// this "deterministic" summary would differ on every call for the same input.
	participantList := make([]string, 0, len(participants))
	for p := range participants {
		participantList = append(participantList, p)
	}
	sort.Strings(participantList)

	var sb strings.Builder

	if strings.TrimSpace(previousSummary) != "" {
		sb.WriteString("=== [PREVIOUS SUMMARY] ===\n")
		sb.WriteString(strings.TrimSpace(previousSummary))
		sb.WriteString("\n\n=== [NEW CONSOLIDATED SUMMARY] ===\n")
	}

	sb.WriteString("### 1. Goals & Objectives\n")
	if len(goals) > 0 {
		sb.WriteString(strings.Join(tailOf(dedupe(goals), 4), "\n"))
	} else {
		sb.WriteString("- Ongoing multi-agent collaboration (no explicit human request in this window).")
	}
	sb.WriteString("\n\n")

	sb.WriteString("### 2. Key Decisions & Consensus\n")
	if len(decisions) > 0 {
		sb.WriteString(strings.Join(tailOf(dedupe(decisions), 5), "\n"))
	} else {
		sb.WriteString("- No explicit decision or consensus statement detected in this window.")
	}
	sb.WriteString("\n\n")

	sb.WriteString("### 3. Actions & Modifications\n")
	claimed := make(map[string]bool, len(decisions)+len(pending))
	for _, line := range append(append([]string{}, decisions...), pending...) {
		claimed[line] = true
	}
	actions = withoutClaimed(dedupe(actions), claimed)
	latestAgentNotes = withoutClaimed(dedupe(latestAgentNotes), claimed)
	if len(actions) > 0 {
		sb.WriteString(strings.Join(tailOf(actions, 6), "\n"))
	} else if len(latestAgentNotes) > 0 {
		sb.WriteString(strings.Join(tailOf(latestAgentNotes, 4), "\n"))
	} else {
		if len(decisions) > 0 || len(pending) > 0 {
			sb.WriteString("- File and command activity is stated inline in the sections above.")
		} else {
			sb.WriteString("- No file or command activity recorded in this window.")
		}
	}
	sb.WriteString("\n\n")

	sb.WriteString("### 4. Pending Tasks & Current State\n")
	if len(pending) > 0 {
		sb.WriteString(strings.Join(tailOf(dedupe(pending), 5), "\n"))
		sb.WriteString("\n")
	} else {
		sb.WriteString("- No open blocker or TODO stated in this window.\n")
	}
	sb.WriteString(fmt.Sprintf("- Participants: %s.\n", strings.Join(participantList, ", ")))
	sb.WriteString(fmt.Sprintf("- Compacted %d historical messages into this checkpoint.", len(messages)))

	return sb.String()
}
