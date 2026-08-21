package handlers

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/compaction"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

type compactChannelRequest struct {
	MessageThreshold   *int `json:"message_threshold"`
	TokenThreshold     *int `json:"token_threshold"`
	KeepRecentVerbatim *int `json:"keep_recent_verbatim"`
	Force              bool `json:"force"`
}

// CompactChannelHandler handles POST /v1/workspaces/:workspace_id/channels/:channel_name/compact
func CompactChannelHandler(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	channelName := strings.TrimSpace(c.Param("channel_name"))
	if channelName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "channel_name parameter is required"})
		return
	}

	var req compactChannelRequest
	_ = c.ShouldBindJSON(&req)

	cfg := compaction.DefaultCompactorConfig()
	if req.MessageThreshold != nil && *req.MessageThreshold > 0 {
		cfg.MessageThreshold = *req.MessageThreshold
	}
	if req.TokenThreshold != nil && *req.TokenThreshold > 0 {
		cfg.TokenThreshold = *req.TokenThreshold
	}
	if req.KeepRecentVerbatim != nil && *req.KeepRecentVerbatim > 0 {
		cfg.KeepRecentVerbatim = *req.KeepRecentVerbatim
	}
	cfg.Force = req.Force

	result, err := compaction.CompactChannel(workspace.ID, channelName, cfg)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to compact channel: " + err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"status": "ok",
		"result": result,
	})
}

// GetChannelSummaryHandler handles GET /v1/workspaces/:workspace_id/channels/:channel_name/summary
func GetChannelSummaryHandler(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	channelName := strings.TrimPrefix(strings.TrimSpace(c.Param("channel_name")), "channel/")

	var channel models.Channel
	if err := db.DB.Where("workspace_id = ? AND name = ?", workspace.ID, channelName).First(&channel).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Channel not found"})
		return
	}

	var latestCompaction models.ChannelCompactionRecord
	err := db.DB.Where("workspace_id = ? AND channel_id = ?", workspace.ID, channel.ID).
		Order("created_at desc").
		First(&latestCompaction).Error
	if err != nil {
		c.JSON(http.StatusOK, gin.H{
			"channel":     channelName,
			"has_summary": false,
			"summary":     nil,
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"channel":     channelName,
		"has_summary": true,
		"summary":     latestCompaction,
	})
}

// GetCompactedHistoryHandler handles GET /v1/workspaces/:workspace_id/channels/:channel_name/history/compacted
func GetCompactedHistoryHandler(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	channelName := strings.TrimPrefix(strings.TrimSpace(c.Param("channel_name")), "channel/")
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "15"))
	if limit < 1 || limit > 100 {
		limit = 15
	}

	summary, recentMessages, err := compaction.GetCompactedChannelHistory(workspace.ID, channelName, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"channel":         channelName,
		"summary":         summary,
		"has_summary":     strings.TrimSpace(summary) != "",
		"recent_messages": recentMessages,
		"count":           len(recentMessages),
	})
}
