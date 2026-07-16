package handlers

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

type CreateNotificationRequest struct {
	Network     string  `json:"network" binding:"required"`
	Source      string  `json:"source" binding:"required"`
	Title       string  `json:"title" binding:"required"`
	Message     string  `json:"message" binding:"required"`
	Priority    string  `json:"priority"`
	ChannelName *string `json:"channel_name"`
	ThreadID    *string `json:"thread_id"`
	LinkURL     *string `json:"link_url"`
}

func validNotificationPriority(priority string) bool {
	return priority == "low" || priority == "normal" || priority == "high"
}

// CreateNotification persists a workspace notification and broadcasts its
// creation to active event-stream clients.
func CreateNotification(c *gin.Context) {
	var req CreateNotificationRequest
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
	priority := req.Priority
	if priority == "" {
		priority = "normal"
	}
	if !validNotificationPriority(priority) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "priority must be low, normal, or high"})
		return
	}
	if strings.TrimSpace(req.Title) == "" || strings.TrimSpace(req.Message) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "title and message are required"})
		return
	}

	record := models.NotificationRecord{
		ID:          uuid.NewString(),
		WorkspaceID: workspace.ID,
		CreatedBy:   req.Source,
		Title:       strings.TrimSpace(req.Title),
		Message:     strings.TrimSpace(req.Message),
		Priority:    priority,
		ChannelName: req.ChannelName,
		ThreadID:    req.ThreadID,
		LinkURL:     req.LinkURL,
		Status:      "active",
	}
	if err := db.DB.Create(&record).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create notification"})
		return
	}
	if err := PublishWorkspaceStateEvent(workspace.ID, "workspace.notification.created", req.Source, dereference(record.ChannelName), gin.H{"notification": record}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to publish notification"})
		return
	}
	c.JSON(http.StatusCreated, record)
}

func ListNotifications(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	limit, err := strconv.Atoi(c.DefaultQuery("limit", "50"))
	if err != nil || limit < 1 || limit > 200 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "limit must be between 1 and 200"})
		return
	}
	query := db.DB.Where("workspace_id = ?", workspace.ID)
	if status := c.Query("status"); status != "" {
		query = query.Where("status = ?", status)
	} else {
		query = query.Where("status = ?", "active")
	}
	if isRead := c.Query("is_read"); isRead != "" {
		value, err := strconv.ParseBool(isRead)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "is_read must be true or false"})
			return
		}
		query = query.Where("is_read = ?", value)
	}
	var notifications []models.NotificationRecord
	if err := query.Order("created_at desc").Limit(limit).Find(&notifications).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to list notifications"})
		return
	}
	var unreadCount int64
	if err := db.DB.Model(&models.NotificationRecord{}).Where("workspace_id = ? AND status = ? AND is_read = ?", workspace.ID, "active", false).Count(&unreadCount).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to count unread notifications"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"notifications": notifications, "unread_count": unreadCount})
}

func notificationForRequest(c *gin.Context) (*models.NotificationRecord, *models.Workspace, bool) {
	var record models.NotificationRecord
	if err := db.DB.Where("id = ?", c.Param("notification_id")).First(&record).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Notification not found"})
		return nil, nil, false
	}
	workspace, err := resolveWorkspace(record.WorkspaceID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Workspace not found"})
		return nil, nil, false
	}
	if !authorizeWorkspace(c, workspace) {
		return nil, nil, false
	}
	return &record, workspace, true
}

func MarkNotificationRead(c *gin.Context) {
	record, workspace, ok := notificationForRequest(c)
	if !ok {
		return
	}
	if !record.IsRead {
		now := time.Now()
		if err := db.DB.Model(record).Updates(map[string]interface{}{"is_read": true, "read_at": now}).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to mark notification read"})
			return
		}
		record.IsRead, record.ReadAt = true, &now
		if err := PublishWorkspaceStateEvent(workspace.ID, "workspace.notification.read", "human:user", dereference(record.ChannelName), gin.H{"notification": record}); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to publish notification update"})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "notification": record})
}

func MarkAllNotificationsRead(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	now := time.Now()
	if err := db.DB.Model(&models.NotificationRecord{}).Where("workspace_id = ? AND status = ? AND is_read = ?", workspace.ID, "active", false).Updates(map[string]interface{}{"is_read": true, "read_at": now}).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to mark notifications read"})
		return
	}
	if err := PublishWorkspaceStateEvent(workspace.ID, "workspace.notification.read_all", "human:user", "", gin.H{"read_at": now}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to publish notification update"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

func DismissNotification(c *gin.Context) {
	record, workspace, ok := notificationForRequest(c)
	if !ok {
		return
	}
	if record.Status != "dismissed" {
		now := time.Now()
		updates := map[string]interface{}{"status": "dismissed"}
		if !record.IsRead {
			updates["is_read"], updates["read_at"] = true, now
			record.IsRead, record.ReadAt = true, &now
		}
		if err := db.DB.Model(record).Updates(updates).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to dismiss notification"})
			return
		}
		record.Status = "dismissed"
		if err := PublishWorkspaceStateEvent(workspace.ID, "workspace.notification.dismissed", "human:user", dereference(record.ChannelName), gin.H{"notification": record}); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to publish notification update"})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"success": true})
}

func dereference(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
