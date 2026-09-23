package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"gorm.io/gorm"
)

func agentContextTestRouter(t *testing.T) (*gin.Engine, models.Workspace, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	database, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:%s?mode=memory&cache=shared", uuid.NewString())), &gorm.Config{})
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	if err := database.AutoMigrate(&models.Workspace{}, &models.EventRecord{}, &models.AgentUsageRecord{}, &models.AgentContextRecord{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	db.DB = database

	token := "agent-context-token"
	hash := hashWorkspaceToken(token)
	ws := models.Workspace{ID: uuid.NewString(), Name: "ctx", Slug: uuid.NewString(), PasswordHash: &hash}
	if err := database.Create(&ws).Error; err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	// Existing quota row: the context report must not wipe it.
	if err := database.Create(&models.AgentUsageRecord{WorkspaceID: ws.ID, AgentName: "claude", SessionUsedPercent: 42}).Error; err != nil {
		t.Fatalf("seed usage: %v", err)
	}

	r := gin.New()
	r.POST("/v1/workspaces/:workspace_id/agents/:agent_name/context", ReportAgentContext)
	r.GET("/v1/workspaces/:workspace_id/agent-contexts", ListAgentContexts)
	return r, ws, token
}

func postContext(t *testing.T, r *gin.Engine, ws models.Workspace, token, agent, body string) models.AgentContextRecord {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/workspaces/"+ws.ID+"/agents/"+agent+"/context", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Workspace-Token", token)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("POST context: %d %s", w.Code, w.Body.String())
	}
	var rec models.AgentContextRecord
	_ = json.Unmarshal(w.Body.Bytes(), &rec)
	return rec
}

func TestReportAgentContextIsPerAgentPerChannel(t *testing.T) {
	r, ws, token := agentContextTestRouter(t)

	// Reported window is labelled as reported.
	rec := postContext(t, r, ws, token, "claude", `{"channel":"channel/general","prompt_tokens":48000,"context_window":200000,"model":"claude-sonnet-4-5"}`)
	if rec.ChannelName != "general" || rec.PromptTokens != 48000 || rec.ContextWindow != 200000 || rec.WindowSource != "reported" {
		t.Fatalf("unexpected first record: %+v", rec)
	}

	// Same agent, other channel: a separate row, not an overwrite.
	postContext(t, r, ws, token, "claude", `{"channel":"design","prompt_tokens":9000,"context_window":200000}`)

	// A later turn with no window keeps the reported one instead of
	// downgrading it to a model-table lookup.
	rec = postContext(t, r, ws, token, "claude", `{"channel":"general","prompt_tokens":61000,"model":"claude-opus-5"}`)
	if rec.PromptTokens != 61000 || rec.ContextWindow != 200000 || rec.WindowSource != "reported" {
		t.Fatalf("reported window lost: %+v", rec)
	}

	// No window reported at all: filled from the model and labelled so.
	rec = postContext(t, r, ws, token, "gemini", `{"channel":"general","prompt_tokens":120000,"model":"gemini-2.5-pro","compacted":true}`)
	if rec.ContextWindow != 1000000 || rec.WindowSource != "model" || rec.CompactedAt == nil {
		t.Fatalf("model window not labelled: %+v", rec)
	}

	var count int64
	db.DB.Model(&models.AgentContextRecord{}).Count(&count)
	if count != 3 {
		t.Fatalf("want 3 rows (claude×2 channels, gemini×1), got %d", count)
	}

	// Quota fields on the usage row survive; the context fields follow.
	var usage models.AgentUsageRecord
	db.DB.Where("workspace_id = ? AND agent_name = ?", ws.ID, "claude").First(&usage)
	if usage.SessionUsedPercent != 42 || usage.LastPromptTokens != 61000 || usage.ContextWindowSize != 200000 {
		t.Fatalf("usage row wrong: session=%d last=%d window=%d", usage.SessionUsedPercent, usage.LastPromptTokens, usage.ContextWindowSize)
	}

	// Channel filter.
	req := httptest.NewRequest(http.MethodGet, "/v1/workspaces/"+ws.ID+"/agent-contexts?channel=general", nil)
	req.Header.Set("X-Workspace-Token", token)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	var list struct {
		Contexts []models.AgentContextRecord `json:"contexts"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &list)
	if w.Code != http.StatusOK || len(list.Contexts) != 2 {
		t.Fatalf("GET general: %d, %d rows, body=%s", w.Code, len(list.Contexts), w.Body.String())
	}
}
