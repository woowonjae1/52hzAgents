package handlers

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func setupRoutingDB(t *testing.T, mode, master string) (models.Workspace, models.Channel) {
	t.Helper()
	database, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:%s?mode=memory&cache=shared", uuid.NewString())), &gorm.Config{})
	if err != nil {
		if strings.Contains(err.Error(), "requires cgo") {
			t.Skip("SQLite integration test requires CGO_ENABLED=1")
		}
		t.Fatal(err)
	}
	db.DB = database
	if err := db.DB.AutoMigrate(&models.Workspace{}, &models.WorkspaceMember{}, &models.Channel{}, &models.ChannelMember{}, &models.EventRecord{}); err != nil {
		t.Fatal(err)
	}
	config.GlobalConfig = &config.Config{AgentTimeoutSeconds: 60}
	token := "token"
	workspace := models.Workspace{ID: uuid.NewString(), Name: "routing", PasswordHash: &token, Status: "active"}
	if err := db.DB.Create(&workspace).Error; err != nil {
		t.Fatal(err)
	}
	channel := models.Channel{ID: uuid.NewString(), WorkspaceID: workspace.ID, Name: "general", OrchestrationMode: mode, Status: "active"}
	if master != "" {
		channel.MasterAgent = &master
	}
	if err := db.DB.Create(&channel).Error; err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for _, name := range []string{"codex-agent", "claude-agent"} {
		session := name + "-session"
		member := models.WorkspaceMember{WorkspaceID: workspace.ID, AgentName: name, Status: "online", LastHeartbeat: &now, SessionID: &session}
		if err := db.DB.Create(&member).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.DB.Create(&models.ChannelMember{ChannelID: channel.ID, AgentName: name}).Error; err != nil {
			t.Fatal(err)
		}
	}
	return workspace, channel
}

func TestRoutingMasterMode(t *testing.T) {
	workspace, _ := setupRoutingDB(t, "master", "codex-agent")
	req := &SendEventRequest{Type: "workspace.message.posted", Source: "human:user", Target: "channel/general", Payload: map[string]interface{}{"content": "Please investigate this", "message_type": "chat"}}
	if err := materializeEvent(workspace.ID, req, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	targets := req.Metadata["target_agents"].([]string)
	if len(targets) != 1 || targets[0] != "codex-agent" {
		t.Fatalf("human target = %v, want codex-agent", targets)
	}

	req = &SendEventRequest{Type: "workspace.message.posted", Source: "openagents:codex-agent", Target: "channel/general", Payload: map[string]interface{}{"content": "Done", "message_type": "chat"}, Metadata: map[string]interface{}{"session_id": "codex-agent-session"}}
	if err := materializeEvent(workspace.ID, req, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	targets = req.Metadata["target_agents"].([]string)
	if len(targets) != 1 || targets[0] != noResponseAgent {
		t.Fatalf("master final target = %v, want sentinel", targets)
	}
}

func TestRoutingFiltersOperationalEventsAndRejectsStaleSession(t *testing.T) {
	workspace, _ := setupRoutingDB(t, "dynamic", "codex-agent")
	status := &SendEventRequest{Type: "workspace.message.posted", Source: "openagents:claude-agent", Target: "channel/general", Payload: map[string]interface{}{"content": "401", "message_type": "error"}, Metadata: map[string]interface{}{"session_id": "claude-agent-session"}}
	if err := materializeEvent(workspace.ID, status, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	if _, exists := status.Metadata["target_agents"]; exists {
		t.Fatal("error event must not trigger conversational routing")
	}

	stale := &SendEventRequest{Type: "workspace.message.posted", Source: "openagents:claude-agent", Target: "channel/general", Payload: map[string]interface{}{"content": "hello", "message_type": "chat"}, Metadata: map[string]interface{}{"session_id": "stale"}}
	if err := materializeEvent(workspace.ID, stale, time.Now().UnixMilli()); err != errSessionRevoked {
		t.Fatalf("stale session error = %v, want %v", err, errSessionRevoked)
	}
}

func TestEventTargetsAgent(t *testing.T) {
	record := models.EventRecord{Source: "openagents:codex-agent", Metadata: []byte(`{"target_agents":["claude-agent"]}`)}
	if !eventTargetsAgent(record, "claude-agent") || eventTargetsAgent(record, "codex-agent") {
		t.Fatal("target filter did not honor target_agents")
	}
	record = models.EventRecord{Source: "human:user", Metadata: []byte(`{}`)}
	if !eventTargetsAgent(record, "codex-agent") {
		t.Fatal("untargeted human event must remain compatible")
	}
}
