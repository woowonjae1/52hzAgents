package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/compaction"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"gorm.io/gorm"
)

func tokenStatsTestRouter(t *testing.T) (*gin.Engine, models.Workspace, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	database, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:%s?mode=memory&cache=shared", uuid.NewString())), &gorm.Config{})
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}

	if err := database.AutoMigrate(
		&models.Workspace{},
		&models.WorkspaceMember{},
		&models.Channel{},
		&models.ChannelMember{},
		&models.EventRecord{},
		&models.ChannelCompactionRecord{},
		&models.AgentUsageRecord{},
	); err != nil {
		t.Fatalf("migrate test db: %v", err)
	}
	db.DB = database

	token := "token-stats-secret"
	hash := hashWorkspaceToken(token)
	ws := models.Workspace{
		ID:           uuid.NewString(),
		Slug:         "token-stats-ws",
		Name:         "Token Stats Workspace",
		PasswordHash: &hash,
	}
	database.Create(&ws)

	router := gin.New()
	router.GET("/v1/workspaces/:workspace_id/tokens/stats", GetWorkspaceTokenStatsHandler)
	router.POST("/v1/events", SendEvent)

	return router, ws, token
}

func TestGetWorkspaceTokenStatsHandler(t *testing.T) {
	router, ws, token := tokenStatsTestRouter(t)

	// Create channel
	ch := models.Channel{
		ID:          uuid.NewString(),
		WorkspaceID: ws.ID,
		Name:        "general",
		Status:      "active",
	}
	db.DB.Create(&ch)

	// Create agent member
	db.DB.Create(&models.WorkspaceMember{
		WorkspaceID: ws.ID,
		AgentName:   "codex-agent",
		Status:      "online",
	})

	// Preload an agent usage record
	model := "gpt-4o"
	db.DB.Create(&models.AgentUsageRecord{
		WorkspaceID:           ws.ID,
		AgentName:             "codex-agent",
		CurrentModel:          &model,
		TotalPromptTokens:     1200,
		TotalCompletionTokens: 300,
		TotalTokens:           1500,
		LastPromptTokens:      850,
		ContextWindowSize:     128000,
	})

	req, _ := http.NewRequest(http.MethodGet, "/v1/workspaces/"+ws.ID+"/tokens/stats", nil)
	req.Header.Set("X-Workspace-Token", token)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp WorkspaceTokenStatsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if resp.TotalTokens != 1500 {
		t.Errorf("expected total tokens 1500, got %d", resp.TotalTokens)
	}
	if len(resp.Agents) != 1 {
		t.Fatalf("expected 1 agent, got %d", len(resp.Agents))
	}
	if resp.Agents[0].AgentName != "codex-agent" || resp.Agents[0].TotalTokens != 1500 || resp.Agents[0].LastPromptTokens != 850 {
		t.Errorf("unexpected agent token stat: %+v", resp.Agents[0])
	}
	if len(resp.Channels) != 1 {
		t.Fatalf("expected 1 channel, got %d", len(resp.Channels))
	}
	if resp.Channels[0].ChannelName != "general" {
		t.Errorf("expected channel general, got %s", resp.Channels[0].ChannelName)
	}
}

func TestRecordAgentMessageTokenUsage(t *testing.T) {
	router, ws, token := tokenStatsTestRouter(t)

	// Create channel
	ch := models.Channel{
		ID:          uuid.NewString(),
		WorkspaceID: ws.ID,
		Name:        "general",
		Status:      "active",
	}
	db.DB.Create(&ch)

	// Agent emits a chat message with content
	eventBody := map[string]interface{}{
		"network": ws.ID,
		"type":    "workspace.message.posted",
		"source":  "openagents:antigravity",
		"target":  "channel/general",
		"payload": map[string]interface{}{
			"content":      "Here is a solution for token governance and compaction.",
			"message_type": "chat",
		},
	}
	payloadBytes, _ := json.Marshal(eventBody)

	req, _ := http.NewRequest(http.MethodPost, "/v1/events", bytes.NewReader(payloadBytes))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Workspace-Token", token)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", w.Code, w.Body.String())
	}

	// Verify usage record was automatically created with tokens
	var usage models.AgentUsageRecord
	if err := db.DB.Where("workspace_id = ? AND agent_name = ?", ws.ID, "antigravity").First(&usage).Error; err != nil {
		t.Fatalf("expected usage record to exist for antigravity: %v", err)
	}

	if usage.TotalCompletionTokens <= 0 || usage.TotalTokens <= 0 {
		t.Errorf("expected completion tokens > 0, got %d", usage.TotalCompletionTokens)
	}
	// The agent posted a message but never reported a model or a window, so
	// the window must stay UNKNOWN. This assertion used to demand 1000000,
	// which the code produced by passing the AGENT NAME "antigravity" to the
	// model table -- a guess the dashboard then rendered as a measured
	// capacity. A test pinning that value made correcting it look like a
	// regression, which is why it survived.
	if usage.ContextWindowSize != compaction.UnknownWindow {
		t.Errorf("unreported agent should have an unknown window, got %d", usage.ContextWindowSize)
	}
}
