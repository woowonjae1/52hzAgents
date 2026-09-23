package handlers

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/tokens"
)

type AgentTokenStat struct {
	AgentName             string  `json:"agent_name"`
	CurrentModel          string  `json:"current_model"`
	ContextWindowSize     int     `json:"context_window_size"`
	TotalPromptTokens     int64   `json:"total_prompt_tokens"`
	TotalCompletionTokens int64   `json:"total_completion_tokens"`
	TotalTokens           int64   `json:"total_tokens"`
	LastPromptTokens      int64   `json:"last_prompt_tokens"`
	SessionUsedPercent    int     `json:"session_used_percent"`
	WeekUsedPercent       int     `json:"week_used_percent"`
	SessionResetsAt       *string `json:"session_resets_at,omitempty"`
	WeekResetsAt          *string `json:"week_resets_at,omitempty"`
	Status                string  `json:"status"`
}

type WorkspaceTokenStatsResponse struct {
	WorkspaceID           string `json:"workspace_id"`
	TotalTokens           int64  `json:"total_tokens"`
	TotalPromptTokens     int64  `json:"total_prompt_tokens"`
	TotalCompletionTokens int64  `json:"total_completion_tokens"`
	/*
		Per-channel "context health" and `compaction_runs` were removed with
		the channel compactor. A channel has no single context -- each agent
		has its own, reported per channel at /agent-contexts.
	*/
	Agents []AgentTokenStat `json:"agents"`
}

// GetWorkspaceTokenStatsHandler aggregates per-agent token usage.
func GetWorkspaceTokenStatsHandler(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}

	if db.DB == nil {
		c.JSON(http.StatusOK, WorkspaceTokenStatsResponse{
			WorkspaceID: workspace.ID,
			Agents:      []AgentTokenStat{},
		})
		return
	}

	// 1. Fetch agent usage records
	var usages []models.AgentUsageRecord
	_ = db.DB.Where("workspace_id = ?", workspace.ID).Find(&usages).Error

	usageMap := make(map[string]models.AgentUsageRecord)
	for _, u := range usages {
		usageMap[u.AgentName] = u
	}

	// 2. Fetch workspace members to include all active or registered agents
	var members []models.WorkspaceMember
	_ = db.DB.Where("workspace_id = ?", workspace.ID).Find(&members).Error

	agentStatsMap := make(map[string]AgentTokenStat)
	var totalPrompt, totalCompletion, totalTokens int64

	// Populate from members
	for _, m := range members {
		u, hasUsage := usageMap[m.AgentName]
		// `model` starts EMPTY, not as the agent's name. Seeding it with the
		// name meant ModelContextWindow was asked to size "rfc-bot", which it
		// answered with its default -- a window the agent never claimed, then
		// reported to the dashboard as though it had been measured.
		model := ""
		window := tokens.UnknownWindow
		var pTokens, cTokens, tTokens, lastPrompt int64
		var sPct, wPct int
		var sResets, wResets *string

		if hasUsage {
			if u.CurrentModel != nil && *u.CurrentModel != "" {
				model = *u.CurrentModel
			}
			if u.ContextWindowSize > 0 {
				window = u.ContextWindowSize
			} else {
				window = tokens.ModelContextWindow(model)
				if window <= 0 && u.AvailableModels != nil && (strings.Contains(*u.AvailableModels, "[1m]") || strings.Contains(*u.AvailableModels, "opus-5") || strings.Contains(*u.AvailableModels, "sonnet-5")) {
					window = 1000000
				}
			}
			pTokens = u.TotalPromptTokens
			cTokens = u.TotalCompletionTokens
			tTokens = u.TotalTokens
			if tTokens == 0 && (pTokens > 0 || cTokens > 0) {
				tTokens = pTokens + cTokens
			}
			lastPrompt = u.LastPromptTokens
			sPct = u.SessionUsedPercent
			wPct = u.WeekUsedPercent
			sResets = u.SessionResetsAt
			wResets = u.WeekResetsAt
		}

		if model == "" {
			if m.AgentType != nil && *m.AgentType != "" {
				model = *m.AgentType
			} else {
				model = m.AgentName
			}
		}
		if window <= 0 {
			window = tokens.ModelContextWindow(model)
		}

		totalPrompt += pTokens
		totalCompletion += cTokens
		totalTokens += tTokens

		agentStatsMap[m.AgentName] = AgentTokenStat{
			AgentName:             m.AgentName,
			CurrentModel:          model,
			ContextWindowSize:     window,
			TotalPromptTokens:     pTokens,
			TotalCompletionTokens: cTokens,
			TotalTokens:           tTokens,
			LastPromptTokens:      lastPrompt,
			SessionUsedPercent:    sPct,
			WeekUsedPercent:       wPct,
			SessionResetsAt:       sResets,
			WeekResetsAt:          wResets,
			Status:                m.Status,
		}
	}

	// Add any usage record not present in members
	for _, u := range usages {
		if _, exists := agentStatsMap[u.AgentName]; !exists {
			model := u.AgentName
			if u.CurrentModel != nil && *u.CurrentModel != "" {
				model = *u.CurrentModel
			}
			window := u.ContextWindowSize
			if window == 0 {
				window = tokens.ModelContextWindow(model)
				if window == 0 && u.AvailableModels != nil && (strings.Contains(*u.AvailableModels, "[1m]") || strings.Contains(*u.AvailableModels, "opus-5") || strings.Contains(*u.AvailableModels, "sonnet-5")) {
					window = 1000000
				}
			}
			tTokens := u.TotalTokens
			if tTokens == 0 && (u.TotalPromptTokens > 0 || u.TotalCompletionTokens > 0) {
				tTokens = u.TotalPromptTokens + u.TotalCompletionTokens
			}

			totalPrompt += u.TotalPromptTokens
			totalCompletion += u.TotalCompletionTokens
			totalTokens += tTokens

			agentStatsMap[u.AgentName] = AgentTokenStat{
				AgentName:             u.AgentName,
				CurrentModel:          model,
				ContextWindowSize:     window,
				TotalPromptTokens:     u.TotalPromptTokens,
				TotalCompletionTokens: u.TotalCompletionTokens,
				TotalTokens:           tTokens,
				LastPromptTokens:      u.LastPromptTokens,
				SessionUsedPercent:    u.SessionUsedPercent,
				WeekUsedPercent:       u.WeekUsedPercent,
				SessionResetsAt:       u.SessionResetsAt,
				WeekResetsAt:          u.WeekResetsAt,
				Status:                "registered",
			}
		}
	}

	agentStatsList := make([]AgentTokenStat, 0, len(agentStatsMap))
	for _, stat := range agentStatsMap {
		agentStatsList = append(agentStatsList, stat)
	}

	c.JSON(http.StatusOK, WorkspaceTokenStatsResponse{
		WorkspaceID:           workspace.ID,
		TotalTokens:           totalTokens,
		TotalPromptTokens:     totalPrompt,
		TotalCompletionTokens: totalCompletion,
		Agents:                agentStatsList,
	})
}
