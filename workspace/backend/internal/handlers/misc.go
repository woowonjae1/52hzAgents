package handlers

// Supplementary endpoints that round out parity with the original service.
//
//	POST /v1/composing                          Typing indicator (ephemeral broadcast)
//	GET  /v1/events/conversations               Agent-to-agent DM conversation list
//	POST /v1/heartbeat                          Legacy agent presence ping
//	POST /v1/remove                             Remove an agent from a network
//	POST /v1/workspaces/:workspace_id/claim         Claim workspace ownership
//	POST /v1/workspaces/:workspace_id/rotate-token  Rotate the workspace token

import (
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/hub"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

type composingRequest struct {
	Network string `json:"network" binding:"required"`
	Channel string `json:"channel" binding:"required"`
	Source  string `json:"source"`
}

// ComposingSignal handles POST /v1/composing. The typing signal is ephemeral:
// it is broadcast to live clients but never written to the event store.
func ComposingSignal(c *gin.Context) {
	var req composingRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	workspace, err := resolveWorkspace(req.Network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}
	if !authorizeWorkspace(c, workspace) {
		return
	}
	source := req.Source
	if source == "" {
		source = "human:user"
	}
	if hub.GlobalHub != nil {
		event := gin.H{
			"id": uuid.NewString(), "type": "workspace.composing", "source": source,
			"target": "channel/" + req.Channel, "payload": gin.H{"channel": req.Channel},
			"metadata": gin.H{}, "timestamp": time.Now().UnixMilli(), "visibility": "channel",
		}
		if payload, err := json.Marshal(event); err == nil {
			hub.GlobalHub.Broadcast(hub.BroadcastMsg{WorkspaceID: workspace.ID, ChannelName: req.Channel, Payload: string(payload)})
		}
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

// ListConversations handles GET /v1/events/conversations. It groups direct
// (agent-to-agent) events into normalized conversation pairs with their latest
// message, newest first.
func ListConversations(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	limit, err := strconv.Atoi(c.DefaultQuery("limit", "20"))
	if err != nil || limit < 1 || limit > 100 {
		limit = 20
	}
	agent := strings.TrimSpace(c.Query("agent"))

	query := db.DB.Where("network_id = ? AND visibility = ? AND target NOT LIKE ?", workspace.ID, "direct", "channel/%")
	if agent != "" {
		query = query.Where("source = ? OR target = ?", agent, agent)
	}
	var events []models.EventRecord
	query.Order("timestamp desc").Limit(2000).Find(&events)

	type pair struct {
		agentA, agentB string
		latest         models.EventRecord
		count          int
	}
	pairs := map[string]*pair{}
	order := []string{}
	for i := range events {
		a, b := events[i].Source, events[i].Target
		if a > b {
			a, b = b, a
		}
		pkey := a + "\x00" + b
		if existing, found := pairs[pkey]; found {
			existing.count++
			if events[i].Timestamp > existing.latest.Timestamp {
				existing.latest = events[i]
			}
		} else {
			pairs[pkey] = &pair{agentA: a, agentB: b, latest: events[i], count: 1}
			order = append(order, pkey)
		}
	}

	conversations := make([]gin.H, 0, len(order))
	for _, pkey := range order {
		p := pairs[pkey]
		var payload map[string]interface{}
		_ = json.Unmarshal(p.latest.Payload, &payload)
		content := ""
		if payload != nil {
			content, _ = payload["content"].(string)
		}
		conversations = append(conversations, gin.H{
			"agents": []string{p.agentA, p.agentB},
			"last_message": gin.H{
				"content": content, "sender": p.latest.Source, "timestamp": p.latest.Timestamp,
			},
			"message_count": p.count,
		})
	}
	// Newest-first, then cap.
	for i := 0; i < len(conversations); i++ {
		for j := i + 1; j < len(conversations); j++ {
			ti := conversations[i]["last_message"].(gin.H)["timestamp"].(int64)
			tj := conversations[j]["last_message"].(gin.H)["timestamp"].(int64)
			if tj > ti {
				conversations[i], conversations[j] = conversations[j], conversations[i]
			}
		}
	}
	if len(conversations) > limit {
		conversations = conversations[:limit]
	}
	c.JSON(http.StatusOK, gin.H{"conversations": conversations})
}

type heartbeatRequest struct {
	Network   string `json:"network" binding:"required"`
	AgentName string `json:"agent_name" binding:"required"`
	SessionID string `json:"session_id"`
}

// HeartbeatAgent handles POST /v1/heartbeat (legacy presence ping).
func HeartbeatAgent(c *gin.Context) {
	var req heartbeatRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	workspace, err := resolveWorkspace(req.Network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}
	var member models.WorkspaceMember
	if err := db.DB.Where("workspace_id = ? AND agent_name = ?", workspace.ID, req.AgentName).First(&member).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Agent not in network"})
		return
	}
	// A newer join revokes older sessions: reject a stale session's ping.
	if req.SessionID != "" && member.SessionID != nil && *member.SessionID != "" && *member.SessionID != req.SessionID {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "session_revoked: another client is now running as this agent"})
		return
	}
	now := time.Now()
	db.DB.Model(&member).Updates(map[string]interface{}{"status": "online", "last_heartbeat": now})
	c.JSON(http.StatusOK, gin.H{"agent_name": req.AgentName, "status": "online"})
}

type removeAgentRequest struct {
	Network   string `json:"network" binding:"required"`
	AgentName string `json:"agent_name" binding:"required"`
}

// RemoveAgentFromNetwork handles POST /v1/remove.
func RemoveAgentFromNetwork(c *gin.Context) {
	var req removeAgentRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	workspace, err := resolveWorkspace(req.Network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}
	if !authorizeWorkspace(c, workspace) {
		return
	}
	var member models.WorkspaceMember
	if err := db.DB.Where("workspace_id = ? AND agent_name = ?", workspace.ID, req.AgentName).First(&member).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Agent not in network"})
		return
	}
	db.DB.Delete(&member)
	// Reassign master on any channel this agent led.
	resp := gin.H{"agent_name": req.AgentName, "status": "removed"}
	var channels []models.Channel
	db.DB.Where("workspace_id = ? AND master_agent = ?", workspace.ID, req.AgentName).Find(&channels)
	for i := range channels {
		var replacement models.ChannelMember
		if db.DB.Where("channel_id = ? AND agent_name != ?", channels[i].ID, req.AgentName).First(&replacement).Error == nil {
			db.DB.Model(&channels[i]).Update("master_agent", replacement.AgentName)
			resp["new_master"] = replacement.AgentName
		} else {
			db.DB.Model(&channels[i]).Update("master_agent", nil)
		}
	}
	_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.member.removed", "human:user", "", gin.H{"agent_name": req.AgentName})
	c.JSON(http.StatusOK, resp)
}

// ClaimWorkspace handles POST /v1/workspaces/:workspace_id/claim. In the
// self-hosted, token-authenticated deployment there is no Firebase identity to
// bind, so a valid workspace credential is sufficient and the call returns the
// current workspace. If a caller-supplied email is present it is recorded as the
// creator when the workspace is not yet claimed.
func ClaimWorkspace(c *gin.Context) {
	workspace, ok := workspaceForParam(c)
	if !ok {
		return
	}
	var body struct {
		Email string `json:"email"`
	}
	_ = c.ShouldBindJSON(&body)
	email := strings.ToLower(strings.TrimSpace(body.Email))
	if email != "" {
		if workspace.CreatorEmail != nil && *workspace.CreatorEmail != "" && !strings.EqualFold(*workspace.CreatorEmail, email) {
			c.JSON(http.StatusForbidden, gin.H{"error": "Workspace already claimed by another user"})
			return
		}
		db.DB.Model(workspace).Update("creator_email", email)
		workspace.CreatorEmail = &email
	}
	// The :workspace_id path param is already bound; GetWorkspace re-reads it.
	GetWorkspace(c)
}

// RotateWorkspaceToken handles POST /v1/workspaces/:workspace_id/rotate-token.
func RotateWorkspaceToken(c *gin.Context) {
	workspace, ok := workspaceForParam(c)
	if !ok {
		return
	}
	newToken := "ws_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	newHash := hashWorkspaceToken(newToken)
	settings := decodeJSONMap(workspace.Settings)
	settings["token"] = newToken
	settingsBytes, _ := json.Marshal(settings)
	if err := db.DB.Model(workspace).Updates(map[string]interface{}{
		"password_hash": newHash, "settings": settingsBytes,
	}).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to rotate token"})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"workspace_id": workspace.ID,
		"token":        newToken,
		"url":          "/" + workspace.Slug + "?token=" + newToken,
	})
}

type openPathReq struct {
	Path string `json:"path" binding:"required"`
}

// OpenLocalPath handles POST /v1/system/open-path to open a local folder or file directly in the host OS.
func OpenLocalPath(c *gin.Context) {
	var req openPathReq
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	clean := strings.TrimSpace(req.Path)
	clean = strings.TrimPrefix(clean, "file:///")
	clean = strings.TrimPrefix(clean, "file://")
	clean = strings.TrimPrefix(clean, "file:")

	if runtime.GOOS == "windows" {
		if strings.HasPrefix(clean, "/") && len(clean) >= 3 && clean[2] == ':' {
			clean = clean[1:]
		}
		clean = filepath.FromSlash(clean)
		stat, err := os.Stat(clean)
		if err == nil && stat.IsDir() {
			exec.Command("explorer.exe", clean).Start()
			c.JSON(http.StatusOK, gin.H{"status": "ok", "opened": true, "type": "directory"})
			return
		}
		exec.Command("rundll32", "url.dll,FileProtocolHandler", clean).Start()
		c.JSON(http.StatusOK, gin.H{"status": "ok", "opened": true, "type": "file"})
		return
	} else if runtime.GOOS == "darwin" {
		exec.Command("open", clean).Start()
	} else {
		exec.Command("xdg-open", clean).Start()
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok", "opened": true})
}
