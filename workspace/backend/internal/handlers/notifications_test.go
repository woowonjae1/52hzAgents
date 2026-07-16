package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func notificationTestRouter(t *testing.T) (*gin.Engine, models.Workspace, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	database, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:%s?mode=memory&cache=shared", uuid.NewString())), &gorm.Config{})
	if err != nil {
		if strings.Contains(err.Error(), "requires cgo") {
			t.Skip("SQLite integration test requires CGO_ENABLED=1")
		}
		t.Fatalf("open test database: %v", err)
	}
	if err := database.AutoMigrate(&models.Workspace{}, &models.EventRecord{}, &models.NotificationRecord{}); err != nil {
		t.Fatalf("migrate test database: %v", err)
	}
	db.DB = database
	token := "notification-token"
	hash := hashWorkspaceToken(token)
	workspace := models.Workspace{ID: uuid.NewString(), Name: "Notification test", PasswordHash: &hash}
	if err := database.Create(&workspace).Error; err != nil {
		t.Fatalf("create workspace: %v", err)
	}

	router := gin.New()
	router.POST("/v1/notifications", CreateNotification)
	router.GET("/v1/notifications", ListNotifications)
	router.PATCH("/v1/notifications/read-all", MarkAllNotificationsRead)
	router.PATCH("/v1/notifications/:notification_id/read", MarkNotificationRead)
	router.DELETE("/v1/notifications/:notification_id", DismissNotification)
	return router, workspace, token
}

func notificationRequest(t *testing.T, router http.Handler, method, target, token string, body interface{}) *httptest.ResponseRecorder {
	t.Helper()
	var content []byte
	if body != nil {
		var err error
		content, err = json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal request body: %v", err)
		}
	}
	request := httptest.NewRequest(method, target, bytes.NewReader(content))
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("X-Workspace-Token", token)
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func TestNotificationLifecycleAndWorkspaceAuthorization(t *testing.T) {
	router, workspace, token := notificationTestRouter(t)
	createBody := gin.H{
		"network": workspace.ID, "source": "openagents:planner", "title": "Plan ready",
		"message": "The plan has been updated.", "priority": "high", "channel_name": "general",
	}
	if response := notificationRequest(t, router, http.MethodPost, "/v1/notifications", "", createBody); response.Code != http.StatusUnauthorized {
		t.Fatalf("create without token = %d, want %d", response.Code, http.StatusUnauthorized)
	}

	response := notificationRequest(t, router, http.MethodPost, "/v1/notifications", token, createBody)
	if response.Code != http.StatusCreated {
		t.Fatalf("create = %d, body = %s", response.Code, response.Body.String())
	}
	var notification models.NotificationRecord
	if err := json.Unmarshal(response.Body.Bytes(), &notification); err != nil {
		t.Fatalf("decode create response: %v", err)
	}
	if notification.ID == "" || notification.IsRead || notification.Priority != "high" {
		t.Fatalf("unexpected created notification: %+v", notification)
	}

	response = notificationRequest(t, router, http.MethodGet, "/v1/notifications?network="+workspace.ID, token, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("list = %d, body = %s", response.Code, response.Body.String())
	}
	var listed struct {
		Notifications []models.NotificationRecord `json:"notifications"`
		UnreadCount   int64                       `json:"unread_count"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode list response: %v", err)
	}
	if len(listed.Notifications) != 1 || listed.UnreadCount != 1 {
		t.Fatalf("list = %+v, want one unread notification", listed)
	}

	response = notificationRequest(t, router, http.MethodPatch, "/v1/notifications/"+notification.ID+"/read", token, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("mark read = %d, body = %s", response.Code, response.Body.String())
	}
	response = notificationRequest(t, router, http.MethodDelete, "/v1/notifications/"+notification.ID, token, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("dismiss = %d, body = %s", response.Code, response.Body.String())
	}

	response = notificationRequest(t, router, http.MethodGet, "/v1/notifications?network="+workspace.ID, token, nil)
	if response.Code != http.StatusOK || bytes.Contains(response.Body.Bytes(), []byte(notification.ID)) {
		t.Fatalf("dismissed notification leaked from active list: %d %s", response.Code, response.Body.String())
	}
	var eventCount int64
	if err := db.DB.Model(&models.EventRecord{}).Where("network_id = ?", workspace.ID).Count(&eventCount).Error; err != nil {
		t.Fatalf("count notification state events: %v", err)
	}
	if eventCount != 3 {
		t.Fatalf("state event count = %d, want 3", eventCount)
	}
}

func TestNotificationMutationRejectsOtherWorkspaceToken(t *testing.T) {
	router, workspace, token := notificationTestRouter(t)
	response := notificationRequest(t, router, http.MethodPost, "/v1/notifications", token, gin.H{
		"network": workspace.ID, "source": "openagents:planner", "title": "Plan ready", "message": "Updated.",
	})
	if response.Code != http.StatusCreated {
		t.Fatalf("create = %d, body = %s", response.Code, response.Body.String())
	}
	var notification models.NotificationRecord
	if err := json.Unmarshal(response.Body.Bytes(), &notification); err != nil {
		t.Fatalf("decode create response: %v", err)
	}

	otherToken := "other-token"
	otherHash := hashWorkspaceToken(otherToken)
	otherWorkspace := models.Workspace{ID: uuid.NewString(), Name: "Other workspace", PasswordHash: &otherHash}
	if err := db.DB.Create(&otherWorkspace).Error; err != nil {
		t.Fatalf("create other workspace: %v", err)
	}
	response = notificationRequest(t, router, http.MethodPatch, "/v1/notifications/"+notification.ID+"/read", otherToken, nil)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("other workspace mutation = %d, want %d", response.Code, http.StatusUnauthorized)
	}
}
