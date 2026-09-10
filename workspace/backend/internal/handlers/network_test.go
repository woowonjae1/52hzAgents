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
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/hub"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"gorm.io/gorm"
)

func setupNetworkTestEnv(t *testing.T) (models.Workspace, *gin.Engine) {
	t.Helper()
	hub.InitHub()
	gin.SetMode(gin.TestMode)

	database, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:%s?mode=memory&cache=shared", uuid.NewString())), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	db.DB = database
	if err := db.DB.AutoMigrate(&models.Workspace{}, &models.WorkspaceMember{}, &models.Channel{}, &models.ChannelMember{}, &models.EventRecord{}); err != nil {
		t.Fatal(err)
	}
	config.GlobalConfig = &config.Config{AgentTimeoutSeconds: 60}

	token := "valid-token"
	ws := models.Workspace{
		ID:           uuid.NewString(),
		Name:         "test-ws",
		PasswordHash: &token,
		Status:       "active",
	}
	if err := db.DB.Create(&ws).Error; err != nil {
		t.Fatal(err)
	}

	r := gin.New()
	r.POST("/v1/join", JoinNetwork)
	r.POST("/v1/leave", LeaveNetwork)
	r.POST("/v1/workspaces/:workspace_id/presence", UpdatePresence)

	return ws, r
}

func TestUpdatePresence_StatusTransitionAndCrash(t *testing.T) {
	ws, r := setupNetworkTestEnv(t)

	// Create an initial member
	sess := "sess-123"
	now := time.Now().Add(-10 * time.Minute)
	member := models.WorkspaceMember{
		WorkspaceID:   ws.ID,
		AgentName:     "agent-alpha",
		Role:          "member",
		Status:        "offline",
		LastHeartbeat: &now,
		SessionID:     &sess,
	}
	db.DB.Create(&member)

	// 1. Transition offline -> online via presence heartbeat
	reqBody, _ := json.Marshal(PresenceRequest{
		AgentName: "agent-alpha",
		SessionID: sess,
		Status:    "online",
	})
	req := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/v1/workspaces/%s/presence", ws.ID), bytes.NewReader(reqBody))
	req.Header.Set("X-Workspace-Token", "valid-token")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// Verify database status updated
	var updated models.WorkspaceMember
	db.DB.Where("workspace_id = ? AND agent_name = ?", ws.ID, "agent-alpha").First(&updated)
	if updated.Status != "online" {
		t.Errorf("expected status 'online', got '%s'", updated.Status)
	}

	// Verify workspace.member.status event was published
	var events []models.EventRecord
	db.DB.Where("network_id = ? AND type = ?", ws.ID, "workspace.member.status").Order("timestamp desc").Find(&events)
	if len(events) == 0 {
		t.Fatalf("expected workspace.member.status event to be published")
	}

	var payload map[string]interface{}
	json.Unmarshal(events[0].Payload, &payload)
	if payload["agent_name"] != "agent-alpha" || payload["status"] != "online" {
		t.Errorf("unexpected event payload: %+v", payload)
	}

	// 2. Fast crash reporting via presence heartbeat with reason
	crashBody, _ := json.Marshal(PresenceRequest{
		AgentName: "agent-alpha",
		SessionID: sess,
		Status:    "crashed",
		Reason:    "Child process terminated with SIGSEGV",
	})
	req2 := httptest.NewRequest(http.MethodPost, fmt.Sprintf("/v1/workspaces/%s/presence", ws.ID), bytes.NewReader(crashBody))
	req2.Header.Set("X-Workspace-Token", "valid-token")
	req2.Header.Set("Content-Type", "application/json")
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, req2)

	if w2.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w2.Code, w2.Body.String())
	}

	// Verify member is now marked as crashed
	db.DB.Where("workspace_id = ? AND agent_name = ?", ws.ID, "agent-alpha").First(&updated)
	if updated.Status != "crashed" {
		t.Errorf("expected status 'crashed', got '%s'", updated.Status)
	}

	// Verify the latest event carries the crash reason
	var crashEvents []models.EventRecord
	db.DB.Where("network_id = ? AND type = ?", ws.ID, "workspace.member.status").Order("timestamp desc").Find(&crashEvents)
	if len(crashEvents) < 2 {
		t.Fatalf("expected at least 2 member status events")
	}
	var crashPayload map[string]interface{}
	json.Unmarshal(crashEvents[0].Payload, &crashPayload)
	if crashPayload["status"] != "crashed" {
		t.Errorf("expected status crashed, got: %+v", crashPayload)
	}
	if crashPayload["reason"] != "Child process terminated with SIGSEGV" {
		t.Errorf("expected crash reason in payload, got: %+v", crashPayload)
	}
}

func TestJoinAndLeaveNetwork_EventEmission(t *testing.T) {
	ws, r := setupNetworkTestEnv(t)

	// 1. Join network
	joinBody, _ := json.Marshal(JoinRequest{
		Network:   ws.ID,
		Token:     "valid-token",
		AgentName: "agent-beta",
		AgentType: "claude",
	})
	reqJoin := httptest.NewRequest(http.MethodPost, "/v1/join", bytes.NewReader(joinBody))
	reqJoin.Header.Set("Content-Type", "application/json")
	wJoin := httptest.NewRecorder()
	r.ServeHTTP(wJoin, reqJoin)

	if wJoin.Code != http.StatusOK {
		t.Fatalf("join failed: %d %s", wJoin.Code, wJoin.Body.String())
	}

	var joinResp JoinResponse
	json.Unmarshal(wJoin.Body.Bytes(), &joinResp)
	if joinResp.Status != "online" || joinResp.SessionID == "" {
		t.Fatalf("invalid join response: %+v", joinResp)
	}

	// Verify workspace.member.status event for join
	var joinEvents []models.EventRecord
	db.DB.Where("network_id = ? AND type = ?", ws.ID, "workspace.member.status").Find(&joinEvents)
	if len(joinEvents) == 0 {
		t.Fatalf("expected workspace.member.status on join")
	}

	// 2. Leave network
	leaveBody, _ := json.Marshal(LeaveRequest{
		Network:   ws.ID,
		AgentName: "agent-beta",
		SessionID: joinResp.SessionID,
	})
	reqLeave := httptest.NewRequest(http.MethodPost, "/v1/leave", bytes.NewReader(leaveBody))
	reqLeave.Header.Set("X-Workspace-Token", "valid-token")
	reqLeave.Header.Set("Content-Type", "application/json")
	wLeave := httptest.NewRecorder()
	r.ServeHTTP(wLeave, reqLeave)

	if wLeave.Code != http.StatusOK {
		t.Fatalf("leave failed: %d %s", wLeave.Code, wLeave.Body.String())
	}

	// Verify member is offline
	var member models.WorkspaceMember
	db.DB.Where("workspace_id = ? AND agent_name = ?", ws.ID, "agent-beta").First(&member)
	if member.Status != "offline" {
		t.Errorf("expected status 'offline', got '%s'", member.Status)
	}

	// Verify workspace.member.status event for leave
	var allEvents []models.EventRecord
	db.DB.Where("network_id = ? AND type = ?", ws.ID, "workspace.member.status").Order("timestamp desc").Find(&allEvents)
	var latestPayload map[string]interface{}
	json.Unmarshal(allEvents[0].Payload, &latestPayload)
	if latestPayload["status"] != "offline" {
		t.Errorf("expected offline status in latest event, got: %+v", latestPayload)
	}
}
