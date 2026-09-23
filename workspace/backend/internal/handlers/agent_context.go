package handlers

import (
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"gorm.io/gorm/clause"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/tokens"
)

type ReportAgentContextRequest struct {
	Channel       string `json:"channel" binding:"required"`
	PromptTokens  int64  `json:"prompt_tokens"`
	ContextWindow int    `json:"context_window"`
	Model         string `json:"model"`
	// The agent's CLI compacted its own session during this turn.
	Compacted bool `json:"compacted"`
}

/*
ReportAgentContext records what an agent's own CLI measured about its context
on the turn that just ended, in the channel it ran in.

This is a separate endpoint from /usage on purpose. /usage REPLACES the quota
fields wholesale on every call, so piggybacking a per-turn number on it would
wipe the session/week percentages every time an agent finished a reply.
*/
func ReportAgentContext(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	var req ReportAgentContextRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	agentName := agentNameFromSource(c.Param("agent_name"))
	channel := strings.TrimPrefix(strings.TrimSpace(req.Channel), "channel/")
	if agentName == "" || channel == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "agent and channel are required"})
		return
	}

	var existing models.AgentContextRecord
	// Find, not First: a miss is the normal first turn in a channel, and First
	// logs every miss as an error.
	found := db.DB.Where("workspace_id = ? AND agent_name = ? AND channel_name = ?",
		workspace.ID, agentName, channel).Limit(1).Find(&existing).RowsAffected > 0

	record := models.AgentContextRecord{
		WorkspaceID:   workspace.ID,
		AgentName:     agentName,
		ChannelName:   channel,
		PromptTokens:  existing.PromptTokens,
		ContextWindow: existing.ContextWindow,
		WindowSource:  existing.WindowSource,
		Model:         existing.Model,
		CompactedAt:   existing.CompactedAt,
	}
	if !found {
		record = models.AgentContextRecord{WorkspaceID: workspace.ID, AgentName: agentName, ChannelName: channel}
	}
	if req.PromptTokens > 0 {
		record.PromptTokens = req.PromptTokens
	}
	if m := strings.TrimSpace(req.Model); m != "" {
		record.Model = m
	}
	// A reported window always wins; a model-table window only fills a gap and
	// is labelled as such, so the UI never presents a lookup as a measurement.
	if req.ContextWindow > 0 {
		record.ContextWindow = req.ContextWindow
		record.WindowSource = "reported"
	} else if record.WindowSource != "reported" && record.Model != "" {
		if w := tokens.ModelContextWindow(record.Model); w > 0 {
			record.ContextWindow = w
			record.WindowSource = "model"
		}
	}
	if req.Compacted {
		now := time.Now().UTC()
		record.CompactedAt = &now
	}
	record.UpdatedAt = time.Now().UTC()

	if err := db.DB.Clauses(clause.OnConflict{
		Columns:   []clause.Column{{Name: "workspace_id"}, {Name: "agent_name"}, {Name: "channel_name"}},
		DoUpdates: clause.AssignmentColumns([]string{"prompt_tokens", "context_window", "window_source", "model", "compacted_at", "updated_at"}),
	}).Create(&record).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save agent context"})
		return
	}

	/*
		Keep the per-agent usage row in step, so the compaction budget -- which
		reads LastPromptTokens and ContextWindowSize -- works from the same
		measurement instead of its text-length estimate. Only the fields this
		report owns are touched.
	*/
	usageUpdates := map[string]interface{}{}
	if req.PromptTokens > 0 {
		usageUpdates["last_prompt_tokens"] = req.PromptTokens
	}
	if req.ContextWindow > 0 {
		usageUpdates["context_window_size"] = req.ContextWindow
	}
	if len(usageUpdates) > 0 {
		res := db.DB.Model(&models.AgentUsageRecord{}).
			Where("workspace_id = ? AND agent_name = ?", workspace.ID, agentName).
			Updates(usageUpdates)
		if res.Error == nil && res.RowsAffected == 0 {
			_ = db.DB.Create(&models.AgentUsageRecord{
				WorkspaceID:       workspace.ID,
				AgentName:         agentName,
				LastPromptTokens:  req.PromptTokens,
				ContextWindowSize: req.ContextWindow,
			}).Error
		}
	}

	_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.agent.context.updated", "52hz:"+agentName, channel, gin.H{"context": record})
	c.JSON(http.StatusOK, record)
}

// ListAgentContexts returns every (agent, channel) context row in the
// workspace, newest first; `?channel=` narrows it to one channel.
func ListAgentContexts(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	q := db.DB.Where("workspace_id = ?", workspace.ID)
	if ch := strings.TrimPrefix(strings.TrimSpace(c.Query("channel")), "channel/"); ch != "" {
		q = q.Where("channel_name = ?", ch)
	}
	var records []models.AgentContextRecord
	if err := q.Order("updated_at DESC").Find(&records).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load agent contexts"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"contexts": records})
}
