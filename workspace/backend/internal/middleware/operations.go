package middleware

import (
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

type rateWindow struct {
	startedAt time.Time
	count     int
}

// RateLimit uses a fixed one-minute window per client IP. It is deliberately
// process-local; production replicas should additionally enforce an edge rate
// limit, while this protects a standalone deployment by default.
func RateLimit(requestsPerMinute int) gin.HandlerFunc {
	var (
		mu        sync.Mutex
		clients   = make(map[string]rateWindow)
		lastSweep time.Time
	)
	return func(c *gin.Context) {
		if c.Request.URL.Path == "/v1/health" || c.Request.URL.Path == "/api/health" {
			c.Next()
			return
		}
		now := time.Now()
		key := c.ClientIP()
		mu.Lock()
		// Evict windows too old to affect a decision, so the map does not retain
		// an entry per client IP for the process lifetime. Throttled to once a
		// minute: sweeping on every request walks the whole map while holding the
		// lock, which costs more under load than the leak it prevents.
		if now.Sub(lastSweep) >= time.Minute {
			for ip, w := range clients {
				if now.Sub(w.startedAt) >= 2*time.Minute {
					delete(clients, ip)
				}
			}
			lastSweep = now
		}
		window := clients[key]
		if window.startedAt.IsZero() || now.Sub(window.startedAt) >= time.Minute {
			window = rateWindow{startedAt: now}
		}
		window.count++
		clients[key] = window
		allowed := window.count <= requestsPerMinute
		mu.Unlock()
		if !allowed {
			c.Header("Retry-After", "60")
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "rate_limit_exceeded"})
			return
		}
		c.Next()
	}
}

// AuditMutations writes metadata for state-changing calls after their response
// has been produced. It never logs request bodies, headers, or tokens.
func AuditMutations() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()
		if c.Request.Method == http.MethodGet || c.Request.Method == http.MethodOptions || db.DB == nil {
			return
		}
		workspaceID := c.Param("workspace_id")
		if workspaceID == "" {
			workspaceID = c.Query("network")
		}
		var workspace *string
		if workspaceID != "" {
			workspace = &workspaceID
		}
		_ = db.DB.Create(&models.AuditRecord{
			ID: uuid.NewString(), RequestID: c.GetHeader("X-Request-ID"), WorkspaceID: workspace,
			Method: c.Request.Method, Path: c.FullPath(), StatusCode: c.Writer.Status(), ClientIP: c.ClientIP(),
		}).Error
	}
}
