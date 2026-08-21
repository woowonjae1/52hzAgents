package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"gorm.io/gorm"
)

func compactionTestRouter(t *testing.T) (*gin.Engine, models.Workspace, models.Channel, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	database, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:%s?mode=memory&cache=shared", uuid.NewString())), &gorm.Config{})
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}

	if err := database.AutoMigrate(
		&models.Workspace{},
		&models.Channel{},
		&models.EventRecord{},
		&models.ChannelCompactionRecord{},
	); err != nil {
		t.Fatalf("migrate test db: %v", err)
	}
	db.DB = database

	token := "compaction-test-token"
	hash := hashWorkspaceToken(token)
	ws := models.Workspace{
		ID:           uuid.NewString(),
		Slug:         "compact-ws",
		Name:         "Compaction Test WS",
		PasswordHash: &hash,
	}
	database.Create(&ws)

	ch := models.Channel{
		ID:          uuid.NewString(),
		WorkspaceID: ws.ID,
		Name:        "general",
	}
	database.Create(&ch)

	router := gin.New()
	router.POST("/v1/workspaces/:workspace_id/channels/:channel_name/compact", CompactChannelHandler)
	router.GET("/v1/workspaces/:workspace_id/channels/:channel_name/summary", GetChannelSummaryHandler)
	router.GET("/v1/workspaces/:workspace_id/channels/:channel_name/history/compacted", GetCompactedHistoryHandler)
	router.GET("/v1/events", ListEvents)

	return router, ws, ch, token
}

func TestCompactionHandlers_FullLifecycle(t *testing.T) {
	router, ws, _, token := compactionTestRouter(t)

	// 1. Seed 25 chat messages into channel/general
	for i := 1; i <= 25; i++ {
		payloadBytes, _ := json.Marshal(map[string]interface{}{
			"content":      fmt.Sprintf("Chat message #%d regarding system architecture", i),
			"message_type": "chat",
		})
		rec := models.EventRecord{
			ID:        fmt.Sprintf("evt-item-%03d", i),
			NetworkID: ws.ID,
			Type:      "workspace.message.posted",
			Source:    "openagents:agent-1",
			Target:    "channel/general",
			Payload:   payloadBytes,
			Timestamp: int64(1000 + i*10),
			CreatedAt: time.Now(),
		}
		db.DB.Create(&rec)
	}

	// 2. Trigger Compaction via POST API
	body, _ := json.Marshal(map[string]interface{}{
		"message_threshold":    15,
		"keep_recent_verbatim": 5,
		"force":                true,
	})
	req := httptest.NewRequest("POST", "/v1/workspaces/"+ws.ID+"/channels/general/compact", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Workspace-Token", token)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK compacting channel, got %d. Body: %s", w.Code, w.Body.String())
	}

	var compactResp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &compactResp)
	if compactResp["status"] != "ok" {
		t.Errorf("Expected status 'ok', got %v", compactResp["status"])
	}

	// 3. Query Summary via GET API
	reqSummary := httptest.NewRequest("GET", "/v1/workspaces/"+ws.ID+"/channels/general/summary", nil)
	reqSummary.Header.Set("X-Workspace-Token", token)
	wSummary := httptest.NewRecorder()
	router.ServeHTTP(wSummary, reqSummary)

	if wSummary.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK getting summary, got %d", wSummary.Code)
	}
	var summaryResp map[string]interface{}
	_ = json.Unmarshal(wSummary.Body.Bytes(), &summaryResp)
	if summaryResp["has_summary"] != true {
		t.Errorf("Expected has_summary to be true")
	}

	// 4. Query Compacted History via GET API
	reqHistory := httptest.NewRequest("GET", "/v1/workspaces/"+ws.ID+"/channels/general/history/compacted?limit=10", nil)
	reqHistory.Header.Set("X-Workspace-Token", token)
	wHistory := httptest.NewRecorder()
	router.ServeHTTP(wHistory, reqHistory)

	if wHistory.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK getting compacted history, got %d", wHistory.Code)
	}
	var historyResp map[string]interface{}
	_ = json.Unmarshal(wHistory.Body.Bytes(), &historyResp)
	if historyResp["has_summary"] != true {
		t.Errorf("Expected has_summary in history response")
	}
	recentList, ok := historyResp["recent_messages"].([]interface{})
	if !ok || len(recentList) != 5 {
		t.Errorf("Expected 5 recent messages, got %v", len(recentList))
	}

	// 5. Query ListEvents with ?compact=true
	reqEvents := httptest.NewRequest("GET", "/v1/events?network="+ws.ID+"&channel=general&compact=true", nil)
	reqEvents.Header.Set("X-Workspace-Token", token)
	wEvents := httptest.NewRecorder()
	router.ServeHTTP(wEvents, reqEvents)

	if wEvents.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK getting events with compact=true, got %d", wEvents.Code)
	}
	var eventsResp map[string]interface{}
	_ = json.Unmarshal(wEvents.Body.Bytes(), &eventsResp)
	if eventsResp["context_summary"] == nil || eventsResp["context_summary"] == "" {
		t.Errorf("Expected non-empty context_summary in ListEvents response with compact=true")
	}
}
