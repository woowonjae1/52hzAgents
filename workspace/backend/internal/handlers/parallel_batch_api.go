package handlers

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

// GetParallelBatch serves what a channel's parallel batch is doing: one lane per
// assignee, with progress, and the scope conflicts that are blocking it.
//
// The UI needs this as its own read rather than inferring from chat, because
// the whole point of parallel mode is that the transcript stops being a
// sequence - several agents write into it at once, and "who is doing what, how
// far along" is no longer legible by reading top to bottom.
func GetParallelBatch(c *gin.Context) {
	network := c.Query("network")
	channelName := strings.TrimSpace(c.Query("channel"))
	if network == "" || channelName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "network and channel parameters are required"})
		return
	}

	workspace, err := resolveWorkspace(network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}

	token := c.GetHeader("X-Workspace-Token")
	if token == "" {
		token = c.Query("token")
	}
	if !verifyWorkspaceAccess(workspace, token) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid workspace credentials"})
		return
	}

	var channel models.Channel
	if err := db.DB.Where("workspace_id = ? AND name = ?", workspace.ID, channelName).First(&channel).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Channel not found"})
		return
	}

	var todos []models.TodoRecord
	db.DB.Where("workspace_id = ? AND channel_name = ?", workspace.ID, channelName).
		Order("position asc, created_at asc").Find(&todos)

	c.JSON(http.StatusOK, buildParallelBatch(strings.ToLower(strings.TrimSpace(channel.OrchestrationMode)), todos))
}
