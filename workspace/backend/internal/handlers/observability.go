package handlers

import (
	"github.com/gin-gonic/gin"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/hub"
	"net/http"
)

// HubStats exposes lightweight connection/backpressure diagnostics.
// It intentionally contains no message contents or workspace tokens.
func HubStats(c *gin.Context) {
	if hub.GlobalHub == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "event hub unavailable"})
		return
	}
	c.JSON(http.StatusOK, hub.GlobalHub.Stats())
}
