package handlers

// Conversation sharing endpoints — public snapshot links.
//
//	POST   /v1/shares                   Create a share snapshot
//	GET    /v1/shares                   List shares for a workspace
//	GET    /v1/shares/public/:token     View a shared snapshot (no auth)
//	DELETE /v1/shares/:share_id         Soft-delete a share
//
// A snapshot freezes the chat messages of a channel at creation time into the
// share_snapshots table, so a public viewer never touches live workspace state.

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

type createShareRequest struct {
	Network   string `json:"network" binding:"required"`
	Channel   string `json:"channel" binding:"required"`
	CreatedBy string `json:"created_by"`
}

// shareToken mirrors Python's secrets.token_urlsafe(9): 9 random bytes, URL-safe
// base64 without padding (12 characters).
func shareToken() string {
	buf := make([]byte, 9)
	if _, err := rand.Read(buf); err != nil {
		return strings.ReplaceAll(uuid.NewString(), "-", "")[:12]
	}
	return base64.RawURLEncoding.EncodeToString(buf)
}

func serializeShare(s *models.ShareSnapshot) gin.H {
	return gin.H{
		"id":            s.ID,
		"workspace_id":  s.WorkspaceID,
		"channel_name":  s.ChannelName,
		"title":         s.Title,
		"share_token":   s.ShareToken,
		"message_count": s.MessageCount,
		"status":        s.Status,
		"created_at":    s.CreatedAt,
	}
}

// CreateShare handles POST /v1/shares.
func CreateShare(c *gin.Context) {
	var req createShareRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	workspace, err := resolveWorkspace(req.Network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Workspace not found"})
		return
	}
	if !authorizeWorkspace(c, workspace) {
		return
	}
	createdBy := req.CreatedBy
	if createdBy == "" {
		createdBy = "human:user"
	}

	channelTarget := "channel/" + req.Channel
	var events []models.EventRecord
	db.DB.Where("network_id = ? AND target = ? AND type = ?", workspace.ID, channelTarget, "workspace.message.posted").
		Order("timestamp asc").Find(&events)

	messages := make([]map[string]interface{}, 0, len(events))
	for i := range events {
		var payload map[string]interface{}
		_ = json.Unmarshal(events[i].Payload, &payload)
		if payload == nil {
			payload = map[string]interface{}{}
		}
		msgType, _ := payload["message_type"].(string)
		if msgType == "" {
			msgType = "chat"
		}
		if msgType != "chat" {
			continue
		}
		senderName, _ := payload["sender_name"].(string)
		if senderName == "" {
			senderName = events[i].Source
		}
		senderType := "agent"
		if strings.HasPrefix(events[i].Source, "human:") {
			senderType = "human"
		}
		content, _ := payload["content"].(string)
		messages = append(messages, map[string]interface{}{
			"sender_name": senderName,
			"sender_type": senderType,
			"content":     content,
			"created_at":  events[i].CreatedAt,
		})
	}

	if len(messages) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No chat messages found in this channel"})
		return
	}

	title := req.Channel
	var channel models.Channel
	if db.DB.Where("workspace_id = ? AND name = ?", workspace.ID, req.Channel).First(&channel).Error == nil {
		if channel.Title != nil && *channel.Title != "" {
			title = *channel.Title
		}
	}

	snapshotData, _ := json.Marshal(messages)
	snapshot := models.ShareSnapshot{
		ID:           uuid.NewString(),
		WorkspaceID:  workspace.ID,
		ChannelName:  req.Channel,
		Title:        &title,
		CreatedBy:    createdBy,
		SnapshotData: snapshotData,
		ShareToken:   shareToken(),
		MessageCount: len(messages),
		Status:       "active",
	}
	if err := db.DB.Create(&snapshot).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create share"})
		return
	}
	c.JSON(http.StatusOK, serializeShare(&snapshot))
}

// GetPublicShare handles GET /v1/shares/public/:share_token (no auth).
func GetPublicShare(c *gin.Context) {
	var snapshot models.ShareSnapshot
	if err := db.DB.Where("share_token = ? AND status = ?", c.Param("share_token"), "active").
		First(&snapshot).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Share not found"})
		return
	}
	var messages interface{}
	_ = json.Unmarshal(snapshot.SnapshotData, &messages)
	if messages == nil {
		messages = []interface{}{}
	}
	c.JSON(http.StatusOK, gin.H{
		"id":            snapshot.ID,
		"title":         snapshot.Title,
		"messages":      messages,
		"message_count": snapshot.MessageCount,
		"created_at":    snapshot.CreatedAt,
	})
}

// ListShares handles GET /v1/shares.
func ListShares(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	var snapshots []models.ShareSnapshot
	db.DB.Where("workspace_id = ? AND status = ?", workspace.ID, "active").
		Order("created_at desc").Find(&snapshots)
	items := make([]gin.H, 0, len(snapshots))
	for i := range snapshots {
		items = append(items, serializeShare(&snapshots[i]))
	}
	c.JSON(http.StatusOK, items)
}

// DeleteShare handles DELETE /v1/shares/:share_id (soft delete).
func DeleteShare(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	var snapshot models.ShareSnapshot
	if err := db.DB.Where("id = ? AND workspace_id = ?", c.Param("share_id"), workspace.ID).
		First(&snapshot).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Share not found"})
		return
	}
	if err := db.DB.Model(&snapshot).Update("status", "deleted").Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete share"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"id": snapshot.ID, "status": "deleted"})
}
