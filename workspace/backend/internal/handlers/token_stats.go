package handlers

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/compaction"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
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

type ChannelContextHealth struct {
	ChannelName  string `json:"channel_name"`
	MessageCount int    `json:"message_count"`
	// ContextTokens is the largest recent prompt among the participants when
	// `Measured` is true, and a character-heuristic estimate otherwise. The
	// flag travels with the number so the UI can stop presenting a guess and a
	// measurement in the same typeface.
	ContextTokens      int     `json:"context_tokens"`
	Measured           bool    `json:"measured"`
	MinContextWindow   int     `json:"min_context_window"`
	BottleneckAgent    string  `json:"bottleneck_agent,omitempty"`
	HasDisparity       bool    `json:"has_disparity"`
	TokenBudgetPercent float64 `json:"token_budget_percent"`
	// "optimal", "warning", "critical", or "unknown" when no participant has
	// reported a context window -- which is a real state, not 0%.
	HealthStatus    string     `json:"health_status"`
	LastCompactedAt *time.Time `json:"last_compacted_at,omitempty"`
	CompactionCount int        `json:"compaction_count"`
}

type WorkspaceTokenStatsResponse struct {
	WorkspaceID           string `json:"workspace_id"`
	TotalTokens           int64  `json:"total_tokens"`
	TotalPromptTokens     int64  `json:"total_prompt_tokens"`
	TotalCompletionTokens int64  `json:"total_completion_tokens"`
	/*
		`compaction_saved_tokens` WAS REMOVED, not renamed.

		Compaction does not save tokens -- it DISCARDS context. The number was
		a difference between two runs of a character heuristic, i.e. an
		estimate of a difference of estimates, rendered as a precise integer
		next to real measured totals. Nobody can act on it: it does not tell
		you whether to compact, whether compaction worked, or what it cost.
		It is a vanity metric, and this workspace does not ship those.

		`compaction_runs` stays. How often a channel has been compacted is a
		fact, and a channel being compacted every few turns is a real signal
		that its budget is too small.
	*/
	CompactionRuns int                    `json:"compaction_runs"`
	Agents         []AgentTokenStat       `json:"agents"`
	Channels       []ChannelContextHealth `json:"channels"`
}

// GetWorkspaceTokenStatsHandler aggregates multi-agent token usage and channel context health.
func GetWorkspaceTokenStatsHandler(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}

	if db.DB == nil {
		c.JSON(http.StatusOK, WorkspaceTokenStatsResponse{
			WorkspaceID: workspace.ID,
			Agents:      []AgentTokenStat{},
			Channels:    []ChannelContextHealth{},
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
		window := compaction.UnknownWindow
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
				window = compaction.ModelContextWindow(model)
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
				window = compaction.ModelContextWindow(model)
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

	// 3. Aggregate compaction records
	var compactions []models.ChannelCompactionRecord
	_ = db.DB.Where("workspace_id = ?", workspace.ID).Find(&compactions).Error

	compactionRuns := len(compactions)
	compactionByChannel := make(map[string][]models.ChannelCompactionRecord)

	// The `savedTokens` accumulator that used to live here summed
	// `EstimatedTokensBefore - EstimatedTokensAfter` across every compaction --
	// see the note on the response struct for why that number was removed
	// rather than kept.
	for _, cRec := range compactions {
		rawName := strings.TrimPrefix(cRec.ChannelName, "channel/")
		compactionByChannel[rawName] = append(compactionByChannel[rawName], cRec)
	}

	// 4. Inspect channel context health
	var channels []models.Channel
	_ = db.DB.Where("workspace_id = ? AND status = ?", workspace.ID, "active").Find(&channels).Error

	channelHealths := make([]ChannelContextHealth, 0, len(channels))
	for _, ch := range channels {
		rawName := ch.Name
		target := "channel/" + rawName

		var lastCompactedAt *time.Time
		cList := compactionByChannel[rawName]
		cCount := len(cList)
		if cCount > 0 {
			t := cList[cCount-1].CreatedAt
			lastCompactedAt = &t
		}

		// Calculate uncompacted messages & tokens
		var eventRecords []models.EventRecord
		query := db.DB.Where("network_id = ? AND target = ? AND type = ?", workspace.ID, target, "workspace.message.posted")
		_ = query.Order("timestamp desc").Limit(100).Find(&eventRecords).Error

		msgCount := len(eventRecords)

		/*
			MEASURED FIRST, ESTIMATED ONLY AS A FALLBACK.

			The agents report the size of every prompt they send, so the
			largest recent one IS the context load -- no estimation needed.
			The estimate below stays for channels where nothing has reported
			yet, but it is marked as such rather than dressed up as a reading:
			it counts only message `content`, so it misses tool payloads
			(usually the bulk of a prompt), and its query is capped at 100
			messages, so it saturates rather than growing.
		*/
		contextTokens, measured := compaction.ChannelLoad(workspace.ID, target)
		if !measured {
			for _, ev := range eventRecords {
				var payload map[string]interface{}
				if err := json.Unmarshal(ev.Payload, &payload); err == nil {
					if content, ok := payload["content"].(string); ok && content != "" {
						contextTokens += compaction.EstimateTokens(content)
					}
				}
			}
		}

		/*
			THE REAL WINDOW, NOT A RECONSTRUCTION OF IT.

			This used to be `cfg.TokenThreshold * 4`, described as the "inverse
			of 0.25 safety margin" -- while the code producing the threshold
			used 0.20, so the inverse was wrong before anything else changed.
			The threshold is a subtraction now, which no single multiplier
			inverts. And the actual window was available the whole time.
		*/
		cfg := compaction.ResolveChannelAdaptiveCompactorConfig(workspace.ID, target)
		diag := compaction.ChannelContextDiagnostics(workspace.ID, target)
		minWindow := diag.MinWindow

		budgetPct := 0.0
		healthStatus := "unknown"
		if minWindow > 0 {
			budgetPct = (float64(contextTokens) / float64(minWindow)) * 100.0
			// Thresholds are against the SHARE OF THE WINDOW ALREADY SPENT.
			// Compaction reserves roughly a quarter of the window, so a
			// channel past 75% is out of room, not merely busy.
			healthStatus = "optimal"
			if budgetPct >= 75.0 || msgCount >= cfg.MessageThreshold {
				healthStatus = "critical"
			} else if budgetPct >= 50.0 || msgCount >= cfg.MessageThreshold/2 {
				healthStatus = "warning"
			}
		}

		channelHealths = append(channelHealths, ChannelContextHealth{
			ChannelName:        rawName,
			MessageCount:       msgCount,
			ContextTokens:      contextTokens,
			Measured:           measured,
			MinContextWindow:   minWindow,
			BottleneckAgent:    diag.BottleneckAgent,
			HasDisparity:       diag.HasDisparity,
			TokenBudgetPercent: budgetPct,
			HealthStatus:       healthStatus,
			LastCompactedAt:    lastCompactedAt,
			CompactionCount:    cCount,
		})
	}

	c.JSON(http.StatusOK, WorkspaceTokenStatsResponse{
		WorkspaceID:           workspace.ID,
		TotalTokens:           totalTokens,
		TotalPromptTokens:     totalPrompt,
		TotalCompletionTokens: totalCompletion,
		CompactionRuns:        compactionRuns,
		Agents:                agentStatsList,
		Channels:              channelHealths,
	})
}
