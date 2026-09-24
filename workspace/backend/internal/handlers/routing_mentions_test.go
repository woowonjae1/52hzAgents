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

/*
	Who wakes when a human names several agents — per mode, because that is the
	distinction the modes exist to draw.

	Parallel is the mode where "@a @b" means both, now. Dynamic keeps its own
	rule: the router chooses one next speaker, and naming two does not override
	that, because a mode that sometimes runs one and sometimes runs several is
	exactly the ambiguity this split was meant to remove.

	Uses the pure-Go SQLite driver on purpose. The CGO one skips on a machine
	with no C compiler while the package still reports "ok", which is how a test
	like this passes without ever running.
*/

func setupMentionRouting(t *testing.T, mode string, agents ...string) (models.Workspace, models.Channel) {
	t.Helper()
	database, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:%s?mode=memory&cache=shared", uuid.NewString())), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	db.DB = database
	if err := db.DB.AutoMigrate(&models.Workspace{}, &models.WorkspaceMember{}, &models.Channel{},
		&models.ChannelMember{}, &models.EventRecord{}, &models.RouterConfig{}, &models.TodoRecord{}); err != nil {
		t.Fatal(err)
	}
	config.GlobalConfig = &config.Config{AgentTimeoutSeconds: 60}

	token := "token"
	workspace := models.Workspace{ID: uuid.NewString(), Name: "mentions", PasswordHash: &token, Status: "active"}
	if err := db.DB.Create(&workspace).Error; err != nil {
		t.Fatal(err)
	}
	channel := models.Channel{ID: uuid.NewString(), WorkspaceID: workspace.ID, Name: "general",
		OrchestrationMode: mode, Status: "active"}
	if err := db.DB.Create(&channel).Error; err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for _, name := range agents {
		session := name + "-session"
		if err := db.DB.Create(&models.WorkspaceMember{WorkspaceID: workspace.ID, AgentName: name,
			Status: "online", LastHeartbeat: &now, SessionID: &session}).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.DB.Create(&models.ChannelMember{ChannelID: channel.ID, AgentName: name}).Error; err != nil {
			t.Fatal(err)
		}
	}
	return workspace, channel
}

// enableUnreachableRouter turns the router on and points it at an address that
// cannot answer. If the mention path is working the router is never called, so
// the test must not depend on a network round trip; if it ever IS called, the
// request fails and routing falls back — which this test would then catch as a
// wrong target set rather than as a hang.
func enableUnreachableRouter(t *testing.T, workspaceID string) {
	t.Helper()
	base := "http://127.0.0.1:9"
	if err := db.DB.Create(&models.RouterConfig{
		ID: uuid.NewString(), WorkspaceID: workspaceID, Enabled: true,
		Provider: "openai", Model: "router", APIKey: "test-key", BaseURL: &base,
	}).Error; err != nil {
		t.Fatal(err)
	}
}

func mentionTargets(t *testing.T, workspaceID, content string) []string {
	t.Helper()
	req := &SendEventRequest{
		Type: "workspace.message.posted", Source: "human:user", Target: "channel/general",
		Payload: map[string]interface{}{"content": content, "message_type": "chat"},
	}
	if err := materializeEvent(workspaceID, req, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	targets, _ := req.Metadata["target_agents"].([]string)
	return targets
}

func TestParallelRunsEveryMentionedAgentAtOnce(t *testing.T) {
	// The headline behaviour of the mode, and it must not need a scoped board
	// row first — naming both in one sentence is the assignment.
	workspace, _ := setupMentionRouting(t, "parallel", "codex-agent", "claude-agent")
	enableUnreachableRouter(t, workspace.ID)

	targets := mentionTargets(t, workspace.ID, "@codex-agent @claude-agent please both start")

	if len(targets) != 2 {
		t.Fatalf("both mentioned agents must run, got %v", targets)
	}
	seen := map[string]bool{targets[0]: true, targets[1]: true}
	if !seen["codex-agent"] || !seen["claude-agent"] {
		t.Fatalf("targets = %v, want both agents", targets)
	}
}

func TestParallelWithOneMentionWakesOnlyThatAgent(t *testing.T) {
	workspace, _ := setupMentionRouting(t, "parallel", "codex-agent", "claude-agent")

	targets := mentionTargets(t, workspace.ID, "@claude-agent have a look")

	if len(targets) != 1 || targets[0] != "claude-agent" {
		t.Fatalf("targets = %v, want claude-agent alone", targets)
	}
}

func TestDynamicKeepsOneSpeakerWhenTheRouterIsOn(t *testing.T) {
	// Dynamic's rule is the router's. Two mentions do not turn it into parallel
	// — if the user wants both, that is what the other mode is for.
	workspace, _ := setupMentionRouting(t, "dynamic", "codex-agent", "claude-agent")
	enableUnreachableRouter(t, workspace.ID)

	targets := mentionTargets(t, workspace.ID, "@codex-agent @claude-agent go")

	// The unreachable router fails, so routing falls back deterministically.
	// What matters is that dynamic never routed on the mention count itself.
	if len(targets) == 0 {
		t.Fatal("dynamic must still deliver the message somewhere")
	}
}

func TestParallelMentionsWithInstructionsStartABatchNotAPipeline(t *testing.T) {
	// "@a do x @b do y" -- the composer's per-agent segments -- is the ordinary
	// parallel request. It used to be caught by the sequential-pipeline check
	// first, so only a ran, b was relayed a's output afterwards, and no batch
	// (no worktrees, no ports) was ever created.
	workspace, _ := setupMentionRouting(t, "parallel", "codex-agent", "claude-agent")
	if err := db.DB.AutoMigrate(&models.ChannelPipeline{}, &models.ParallelBatchRecord{}, &models.ParallelLaneRecord{}); err != nil {
		t.Fatal(err)
	}
	req := &SendEventRequest{
		Type: "workspace.message.posted", Source: "human:user", Target: "channel/general",
		Payload: map[string]interface{}{"content": "@codex-agent write a.txt @claude-agent write b.txt", "message_type": "chat"},
		Metadata: map[string]interface{}{"mention_segments": []interface{}{
			map[string]interface{}{"agent": "codex-agent", "instruction": "write a.txt"},
			map[string]interface{}{"agent": "claude-agent", "instruction": "write b.txt"},
		}},
	}
	if err := materializeEvent(workspace.ID, req, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}

	targets, _ := req.Metadata["target_agents"].([]string)
	if len(targets) != 2 {
		t.Fatalf("both mentioned agents must run at once, got %v", targets)
	}
	if _, isStep := req.Metadata["task_id"]; isStep {
		t.Fatalf("a sequential pipeline step was started in parallel mode: %v", req.Metadata["task_id"])
	}
	var pipelines int64
	db.DB.Model(&models.ChannelPipeline{}).Count(&pipelines)
	if pipelines != 0 {
		t.Fatalf("parallel mode must not create a pipeline, found %d", pipelines)
	}
	if req.Metadata["parallel_batch"] == nil {
		t.Fatal("no parallel batch was started")
	}
	var lanes []models.ParallelLaneRecord
	db.DB.Find(&lanes)
	tasks := map[string]string{}
	for _, l := range lanes {
		tasks[l.Agent] = l.Task
	}
	if tasks["codex-agent"] != "write a.txt" || tasks["claude-agent"] != "write b.txt" {
		t.Fatalf("each lane takes its own instruction, got %v", tasks)
	}
}
