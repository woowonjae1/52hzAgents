package handlers

import (
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/hub"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"github.com/glebarez/sqlite"
	"gorm.io/gorm"
)

// setupHandoffDB mirrors a real workspace rather than the tidy pipeline fixture:
// every agent is a WORKSPACE member, but only the first one has ever posted in
// the channel, so it is the only CHANNEL member. That is the state a fresh
// thread is in the moment a user writes "@a do X, hand to @b, then Y" — and the
// existing pipeline tests never cover it because they pre-join every agent to
// the channel.
func setupHandoffDB(t *testing.T, channelMembers []string) (models.Workspace, models.Channel) {
	t.Helper()
	database, err := gorm.Open(sqlite.Open("file:"+uuid.NewString()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	db.DB = database
	if err := db.DB.AutoMigrate(
		&models.Workspace{},
		&models.WorkspaceMember{},
		&models.Channel{},
		&models.ChannelMember{},
		&models.ChannelPipeline{},
		&models.EventRecord{},
	); err != nil {
		t.Fatal(err)
	}
	if hub.GlobalHub == nil {
		hub.InitHub()
	}
	config.GlobalConfig = &config.Config{AgentTimeoutSeconds: 60}

	token := "token"
	workspace := models.Workspace{ID: uuid.NewString(), Name: "handoff", PasswordHash: &token, Status: "active"}
	if err := db.DB.Create(&workspace).Error; err != nil {
		t.Fatal(err)
	}
	channel := models.Channel{ID: uuid.NewString(), WorkspaceID: workspace.ID, Name: "thread-x", OrchestrationMode: "dynamic", Status: "active"}
	if err := db.DB.Create(&channel).Error; err != nil {
		t.Fatal(err)
	}

	now := time.Now()
	// The real roster from a live workspace.
	for _, name := range []string{"amp", "antigravity", "claude", "cline", "kilo", "openclaw", "opencode"} {
		session := name + "-session"
		member := models.WorkspaceMember{WorkspaceID: workspace.ID, AgentName: name, Status: "online", LastHeartbeat: &now, SessionID: &session}
		if err := db.DB.Create(&member).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range channelMembers {
		if err := db.DB.Create(&models.ChannelMember{ChannelID: channel.ID, AgentName: name}).Error; err != nil {
			t.Fatal(err)
		}
	}
	return workspace, channel
}

// The exact prompt that failed to hand off in production, verbatim.
const handoffPrompt = "@antigravity 给一个今天的美国时间 交给 @claude 然后分析出美国纽约往后 7 天的 天气"

func TestHandoffStartsPipelineWhenOnlyFirstAgentIsInChannel(t *testing.T) {
	workspace, channel := setupHandoffDB(t, []string{"antigravity"})

	req := &SendEventRequest{
		Type:   "workspace.message.posted",
		Source: "human:user",
		Target: "channel/" + channel.Name,
		Payload: map[string]interface{}{
			"content":      handoffPrompt,
			"message_type": "chat",
		},
		// The frontend always sends a metadata object; an earlier version of this
		// path bailed out whenever metadata was present at all.
		Metadata: map[string]interface{}{},
	}

	targets, routed, err := routeMessage(workspace.ID, &channel, req)
	if err != nil {
		t.Fatal(err)
	}
	if !routed || len(targets) != 1 || targets[0] != "antigravity" {
		t.Fatalf("expected the chain to open on antigravity, got routed=%v targets=%v", routed, targets)
	}

	var record models.ChannelPipeline
	if err := db.DB.Where("channel_id = ?", channel.ID).First(&record).Error; err != nil {
		t.Fatalf("no pipeline was persisted, so nothing will ever relay to @claude: %v", err)
	}
	steps := decodeSteps(t, record)
	if len(steps) != 2 {
		t.Fatalf("expected 2 steps, got %d", len(steps))
	}
	if steps[0].Agent != "antigravity" || steps[1].Agent != "claude" {
		t.Fatalf("expected antigravity -> claude, got %s -> %s", steps[0].Agent, steps[1].Agent)
	}
	if steps[1].Instruction == "" {
		t.Fatal("step 2 lost its instruction, so @claude would be woken with nothing to do")
	}
}

func decodeSteps(t *testing.T, record models.ChannelPipeline) []models.PipelineStep {
	t.Helper()
	_, steps := loadChain(t, record.ChannelID)
	return steps
}
