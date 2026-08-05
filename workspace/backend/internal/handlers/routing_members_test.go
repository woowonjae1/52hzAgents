package handlers

import (
	"fmt"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"gorm.io/gorm"
)

// setupEmptyChannel builds a workspace holding `agentCount` online agents and a
// channel with NO members of its own, then returns the workspace.
//
// Uses the pure-Go sqlite driver (github.com/glebarez/sqlite) rather than
// gorm.io/driver/sqlite so the test actually executes without cgo/gcc — the
// cgo-based tests in routing_test.go silently t.Skip on such machines.
func setupEmptyChannel(t *testing.T, agentCount int) models.Workspace {
	t.Helper()
	database, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:%s?mode=memory&cache=shared", uuid.NewString())), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	db.DB = database
	if err := db.DB.AutoMigrate(&models.Workspace{}, &models.WorkspaceMember{}, &models.Channel{}, &models.ChannelMember{}, &models.EventRecord{}); err != nil {
		t.Fatal(err)
	}
	config.GlobalConfig = &config.Config{AgentTimeoutSeconds: 60}

	token := "token"
	workspace := models.Workspace{ID: uuid.NewString(), Name: "members", PasswordHash: &token, Status: "active"}
	if err := db.DB.Create(&workspace).Error; err != nil {
		t.Fatal(err)
	}
	// Channel deliberately has no ChannelMember rows.
	channel := models.Channel{ID: uuid.NewString(), WorkspaceID: workspace.ID, Name: "general", OrchestrationMode: "dynamic", Status: "active"}
	if err := db.DB.Create(&channel).Error; err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for i := 0; i < agentCount; i++ {
		name := fmt.Sprintf("agent-%d", i)
		session := name + "-session"
		member := models.WorkspaceMember{WorkspaceID: workspace.ID, AgentName: name, Status: "online", LastHeartbeat: &now, SessionID: &session}
		if err := db.DB.Create(&member).Error; err != nil {
			t.Fatal(err)
		}
	}
	return workspace
}

func humanChatTargets(t *testing.T, workspaceID string) []string {
	t.Helper()
	req := &SendEventRequest{
		Type:    "workspace.message.posted",
		Source:  "human:user",
		Target:  "channel/general",
		Payload: map[string]interface{}{"content": "anyone there?", "message_type": "chat"},
	}
	if err := materializeEvent(workspaceID, req, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	targets, ok := req.Metadata["target_agents"].([]string)
	if !ok {
		t.Fatalf("target_agents missing or wrong type: %#v", req.Metadata["target_agents"])
	}
	return targets
}

// Regression guard for the real bug: channel_members was queried with
// Order("id ASC") on a table that has no id column, so the query always errored,
// memberships came back empty, and every channel fell through to the
// workspace-wide fallback. A message therefore reached agents that were never
// added to the thread. Membership must be honoured.
func TestChannelMembersAreHonoured(t *testing.T) {
	workspace := setupEmptyChannel(t, 3)

	var channel models.Channel
	if err := db.DB.Where("workspace_id = ?", workspace.ID).First(&channel).Error; err != nil {
		t.Fatal(err)
	}
	// Only agent-1 joins the channel; agent-0 and agent-2 stay outside it.
	if err := db.DB.Create(&models.ChannelMember{ChannelID: channel.ID, AgentName: "agent-1"}).Error; err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 4; i++ {
		targets := humanChatTargets(t, workspace.ID)
		if len(targets) != 1 || targets[0] != "agent-1" {
			t.Fatalf("attempt %d: targets = %v, want [agent-1] — only channel members may be routed to", i, targets)
		}
	}
}

// A memberless channel must not pull in an arbitrary workspace agent when more
// than one could be chosen — that used to route the message to an agent the user
// never added to the channel.
func TestEmptyChannelDoesNotBorrowAgentWhenAmbiguous(t *testing.T) {
	workspace := setupEmptyChannel(t, 3)
	targets := humanChatTargets(t, workspace.ID)
	if len(targets) != 1 || targets[0] != noResponseAgent {
		t.Fatalf("targets = %v, want [%s]", targets, noResponseAgent)
	}
}

// The single-agent workspace keeps working: there is only one possible receiver,
// so falling back to it is unambiguous and preserves legacy channels.
func TestEmptyChannelFallsBackWhenOnlyOneAgent(t *testing.T) {
	workspace := setupEmptyChannel(t, 1)
	targets := humanChatTargets(t, workspace.ID)
	if len(targets) != 1 || targets[0] != "agent-0" {
		t.Fatalf("targets = %v, want [agent-0]", targets)
	}
}
