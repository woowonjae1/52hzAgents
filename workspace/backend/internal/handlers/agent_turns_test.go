package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"gorm.io/gorm"
)

func agentTurnTestRouter(t *testing.T) (*gin.Engine, models.Workspace, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	database, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:%s?mode=memory&cache=shared", uuid.NewString())), &gorm.Config{})
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	if err := database.AutoMigrate(&models.Workspace{}, &models.EventRecord{}, &models.WorkspaceMember{}, &models.AgentTurnState{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	db.DB = database

	token := "agent-turn-token"
	hash := hashWorkspaceToken(token)
	ws := models.Workspace{ID: uuid.NewString(), Name: "turns", Slug: uuid.NewString(), PasswordHash: &hash}
	if err := database.Create(&ws).Error; err != nil {
		t.Fatalf("create workspace: %v", err)
	}

	r := gin.New()
	r.POST("/v1/workspaces/:workspace_id/agents/:agent_name/turn", ReportAgentTurn)
	r.GET("/v1/workspaces/:workspace_id/agent-turns", ListAgentTurns)
	return r, ws, token
}

func postTurn(t *testing.T, r *gin.Engine, ws models.Workspace, token, agent, body string) (int, models.AgentTurnState) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/workspaces/"+ws.ID+"/agents/"+agent+"/turn", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Workspace-Token", token)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	var rec models.AgentTurnState
	_ = json.Unmarshal(w.Body.Bytes(), &rec)
	return w.Code, rec
}

func listTurns(t *testing.T, r *gin.Engine, ws models.Workspace, token, query string) []models.AgentTurnState {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/v1/workspaces/"+ws.ID+"/agent-turns"+query, nil)
	req.Header.Set("X-Workspace-Token", token)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("GET agent-turns: %d %s", w.Code, w.Body.String())
	}
	var list struct {
		Turns []models.AgentTurnState `json:"turns"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &list)
	return list.Turns
}

func TestReportAgentTurnLifecycle(t *testing.T) {
	r, ws, token := agentTurnTestRouter(t)

	code, rec := postTurn(t, r, ws, token, "claude", `{"channel":"channel/general","state":"running"}`)
	if code != http.StatusOK || rec.State != "running" || rec.ChannelName != "general" || rec.StartedAt == nil || rec.EndedAt != nil {
		t.Fatalf("running: %d %+v", code, rec)
	}
	started := *rec.StartedAt

	// Re-asserting a running turn (after a rejoin) keeps its start time.
	time.Sleep(5 * time.Millisecond)
	_, rec = postTurn(t, r, ws, token, "claude", `{"channel":"general","state":"running"}`)
	if rec.StartedAt == nil || !rec.StartedAt.Equal(started) {
		t.Fatalf("re-assert moved started_at: %v -> %v", started, rec.StartedAt)
	}

	_, rec = postTurn(t, r, ws, token, "claude", `{"channel":"general","state":"idle"}`)
	if rec.State != "idle" || rec.EndedAt == nil || rec.StartedAt == nil || !rec.StartedAt.Equal(started) || rec.Error != "" {
		t.Fatalf("idle: %+v", rec)
	}

	// Error carries its text; the next running clears it.
	postTurn(t, r, ws, token, "claude", `{"channel":"design","state":"running"}`)
	_, rec = postTurn(t, r, ws, token, "claude", `{"channel":"design","state":"error","error":"CLI exited 1"}`)
	if rec.State != "error" || rec.Error != "CLI exited 1" || rec.EndedAt == nil {
		t.Fatalf("error: %+v", rec)
	}
	_, rec = postTurn(t, r, ws, token, "claude", `{"channel":"design","state":"running"}`)
	if rec.Error != "" || rec.EndedAt != nil {
		t.Fatalf("running after error kept stale fields: %+v", rec)
	}

	if code, _ := postTurn(t, r, ws, token, "claude", `{"channel":"general","state":"thinking"}`); code != http.StatusBadRequest {
		t.Fatalf("unknown state accepted: %d", code)
	}
	if code, _ := postTurn(t, r, ws, token, "claude", `{"state":"idle"}`); code != http.StatusBadRequest {
		t.Fatalf("missing channel accepted: %d", code)
	}

	if all := listTurns(t, r, ws, token, ""); len(all) != 2 {
		t.Fatalf("want 2 rows (general, design), got %d", len(all))
	}
	gen := listTurns(t, r, ws, token, "?channel=general")
	if len(gen) != 1 || gen[0].State != "idle" {
		t.Fatalf("channel filter: %+v", gen)
	}

	var events int64
	db.DB.Model(&models.EventRecord{}).Where("type = ?", agentTurnEventType).Count(&events)
	if events != 6 {
		t.Fatalf("want one state event per accepted report (6), got %d", events)
	}
}

func TestExpireOrphanedAgentTurns(t *testing.T) {
	r, ws, token := agentTurnTestRouter(t)
	now := time.Now()
	old := now.Add(-10 * time.Minute)
	for _, m := range []models.WorkspaceMember{
		{WorkspaceID: ws.ID, AgentName: "alive", Status: "online", LastHeartbeat: &now, SessionStartedAt: &old},
		{WorkspaceID: ws.ID, AgentName: "gone", Status: "offline", LastHeartbeat: &old, SessionStartedAt: &old},
		{WorkspaceID: ws.ID, AgentName: "silent", Status: "online", LastHeartbeat: &old, SessionStartedAt: &old},
		{WorkspaceID: ws.ID, AgentName: "crashy", Status: "crashed", LastHeartbeat: &now, SessionStartedAt: &old},
	} {
		if err := db.DB.Create(&m).Error; err != nil {
			t.Fatalf("seed member: %v", err)
		}
	}
	for _, agent := range []string{"alive", "gone", "silent", "crashy", "ghost", "restarted"} {
		postTurn(t, r, ws, token, agent, `{"channel":"general","state":"running"}`)
	}
	// Finished turns are never touched, even for an offline agent.
	postTurn(t, r, ws, token, "gone", `{"channel":"design","state":"running"}`)
	postTurn(t, r, ws, token, "gone", `{"channel":"design","state":"idle"}`)

	// "restarted" joined again 30s after its turn was last reported, and has
	// had more than the grace period to re-assert it: the old process is gone.
	if err := db.DB.Model(&models.AgentTurnState{}).Where("agent_name = ?", "restarted").
		Update("updated_at", now.Add(-time.Minute).UTC()).Error; err != nil {
		t.Fatalf("backdate: %v", err)
	}
	joined := now.Add(-30 * time.Second)
	if err := db.DB.Create(&models.WorkspaceMember{WorkspaceID: ws.ID, AgentName: "restarted", Status: "online", LastHeartbeat: &now, SessionStartedAt: &joined}).Error; err != nil {
		t.Fatalf("seed restarted: %v", err)
	}

	moved := ExpireOrphanedAgentTurns(60 * time.Second)
	if moved != 5 {
		t.Fatalf("want 5 orphaned turns moved to error, got %d", moved)
	}

	want := map[string]string{
		"alive":     "",
		"gone":      "agent went offline mid-turn",
		"silent":    "agent went offline mid-turn",
		"crashy":    "agent crashed mid-turn",
		"ghost":     "agent left the workspace mid-turn",
		"restarted": "agent restarted mid-turn",
	}
	for _, row := range listTurns(t, r, ws, token, "?channel=general") {
		reason, ok := want[row.AgentName]
		if !ok {
			t.Fatalf("unexpected row %+v", row)
		}
		if reason == "" {
			if row.State != "running" {
				t.Fatalf("live agent's turn was expired: %+v", row)
			}
			continue
		}
		if row.State != "error" || row.Error != reason || row.EndedAt == nil {
			t.Fatalf("%s: want error %q, got %+v", row.AgentName, reason, row)
		}
	}
	design := listTurns(t, r, ws, token, "?channel=design&agent=gone")
	if len(design) != 1 || design[0].State != "idle" {
		t.Fatalf("finished turn touched: %+v", design)
	}

	// Idempotent: nothing left to move.
	if again := ExpireOrphanedAgentTurns(60 * time.Second); again != 0 {
		t.Fatalf("second sweep moved %d", again)
	}

	// A rejoin inside the grace period leaves the turn alone so the adapter
	// can re-assert it.
	fresh := time.Now()
	db.DB.Model(&models.WorkspaceMember{}).Where("agent_name = ?", "alive").Update("session_started_at", fresh.Add(time.Second))
	if n := ExpireOrphanedAgentTurns(60 * time.Second); n != 0 {
		t.Fatalf("turn expired inside the rejoin grace period: %d", n)
	}
}
