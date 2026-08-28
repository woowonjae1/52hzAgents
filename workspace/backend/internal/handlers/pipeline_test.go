package handlers

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/hub"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"gorm.io/gorm"
)

// setupPipelineDB uses the pure-Go SQLite driver (the one the server itself
// runs on) rather than the cgo driver, so these tests actually execute instead
// of skipping under CGO_ENABLED=0.
func setupPipelineDB(t *testing.T) (models.Workspace, models.Channel) {
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
	workspace := models.Workspace{ID: uuid.NewString(), Name: "pipeline", PasswordHash: &token, Status: "active"}
	if err := db.DB.Create(&workspace).Error; err != nil {
		t.Fatal(err)
	}
	channel := models.Channel{ID: uuid.NewString(), WorkspaceID: workspace.ID, Name: "general", OrchestrationMode: "dynamic", Status: "active"}
	if err := db.DB.Create(&channel).Error; err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for _, name := range []string{"codex-agent", "claude-agent", "hermes-agent"} {
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

func startTestPipeline(t *testing.T, workspace models.Workspace, channel models.Channel) {
	t.Helper()
	req := &SendEventRequest{
		Type:   "workspace.message.posted",
		Source: "human:user",
		Target: "channel/general",
		Payload: map[string]interface{}{
			"content":      "@codex-agent analyse this @claude-agent refactor it @hermes-agent review it",
			"message_type": "chat",
		},
	}
	targets, routed, err := routeMessage(workspace.ID, &channel, req)
	if err != nil {
		t.Fatal(err)
	}
	if !routed || len(targets) != 1 || targets[0] != "codex-agent" {
		t.Fatalf("expected the chain to open on codex-agent, got routed=%v targets=%v", routed, targets)
	}
}

// loadChain returns the persisted chain plus its decoded steps.
func loadChain(t *testing.T, channelID string) (models.ChannelPipeline, []models.PipelineStep) {
	t.Helper()
	var record models.ChannelPipeline
	if err := db.DB.Where("channel_id = ?", channelID).First(&record).Error; err != nil {
		t.Fatalf("expected a persisted chain: %v", err)
	}
	var steps []models.PipelineStep
	if err := json.Unmarshal(record.Steps, &steps); err != nil {
		t.Fatalf("chain steps are unreadable: %v", err)
	}
	return record, steps
}

func TestPipelineIsPersistedOnStart(t *testing.T) {
	workspace, channel := setupPipelineDB(t)
	startTestPipeline(t, workspace, channel)

	record, steps := loadChain(t, channel.ID)
	if len(steps) != 3 {
		t.Fatalf("expected 3 steps, got %d", len(steps))
	}
	if record.CurrentIndex != 0 || record.Status != "running" {
		t.Fatalf("expected a running chain at index 0, got index=%d status=%s", record.CurrentIndex, record.Status)
	}
	if steps[0].Agent != "codex-agent" || steps[0].Status != "running" {
		t.Fatalf("expected step 0 to be codex-agent/running, got %s/%s", steps[0].Agent, steps[0].Status)
	}
	if steps[1].Status != "pending" || steps[2].Status != "pending" {
		t.Fatalf("expected later steps to stay pending, got %s/%s", steps[1].Status, steps[2].Status)
	}
	if steps[1].Instruction != "refactor it" {
		t.Fatalf("expected step 1 instruction to be preserved, got %q", steps[1].Instruction)
	}
}

// A plain message must end whatever chain was in flight.
func TestPipelineClearedByPlainMessage(t *testing.T) {
	workspace, channel := setupPipelineDB(t)
	startTestPipeline(t, workspace, channel)

	req := &SendEventRequest{
		Type:    "workspace.message.posted",
		Source:  "human:user",
		Target:  "channel/general",
		Payload: map[string]interface{}{"content": "never mind", "message_type": "chat"},
	}
	if _, _, err := routeMessage(workspace.ID, &channel, req); err != nil {
		t.Fatal(err)
	}

	var count int64
	db.DB.Model(&models.ChannelPipeline{}).Where("channel_id = ?", channel.ID).Count(&count)
	if count != 0 {
		t.Fatalf("expected the chain to be cleared, still found %d", count)
	}
}

// The regression this change exists for: an agent that is not the one the
// current step waits on must not advance the chain.
func TestPipelineIgnoresUnrelatedAgent(t *testing.T) {
	workspace, channel := setupPipelineDB(t)
	startTestPipeline(t, workspace, channel)

	CheckAndTriggerNextPipelineStep(workspace.ID, "channel/general", "openagents:hermes-agent")

	record, steps := loadChain(t, channel.ID)
	if record.CurrentIndex != 0 {
		t.Fatalf("an unrelated agent advanced the chain to index %d", record.CurrentIndex)
	}
	if steps[0].Status != "running" {
		t.Fatalf("expected step 0 to still be running, got %s", steps[0].Status)
	}
}

// The second regression: a single turn that posts two chat messages must not
// advance the chain twice and skip an agent.
func TestPipelineAdvancesOncePerStep(t *testing.T) {
	workspace, channel := setupPipelineDB(t)
	startTestPipeline(t, workspace, channel)

	CheckAndTriggerNextPipelineStep(workspace.ID, "channel/general", "openagents:codex-agent")
	CheckAndTriggerNextPipelineStep(workspace.ID, "channel/general", "openagents:codex-agent")

	record, steps := loadChain(t, channel.ID)
	if record.CurrentIndex != 1 {
		t.Fatalf("expected the chain to sit at index 1, got %d", record.CurrentIndex)
	}
	if steps[0].Status != "done" || steps[1].Status != "running" || steps[2].Status != "pending" {
		t.Fatalf("unexpected step states: %s/%s/%s", steps[0].Status, steps[1].Status, steps[2].Status)
	}
}

func TestPipelineRunsToCompletion(t *testing.T) {
	workspace, channel := setupPipelineDB(t)
	startTestPipeline(t, workspace, channel)

	for _, agent := range []string{"codex-agent", "claude-agent", "hermes-agent"} {
		CheckAndTriggerNextPipelineStep(workspace.ID, "channel/general", "openagents:"+agent)
	}

	record, steps := loadChain(t, channel.ID)
	if record.Status != "completed" {
		t.Fatalf("expected the chain to complete, got %s", record.Status)
	}
	if record.CurrentIndex != 2 {
		t.Fatalf("expected current_index to stay on the last step, got %d", record.CurrentIndex)
	}
	for i, step := range steps {
		if step.Status != "done" {
			t.Fatalf("expected step %d (%s) to be done, got %s", i, step.Agent, step.Status)
		}
	}

	// A further reply must not revive a finished chain.
	CheckAndTriggerNextPipelineStep(workspace.ID, "channel/general", "openagents:hermes-agent")
	if record, _ = loadChain(t, channel.ID); record.Status != "completed" {
		t.Fatalf("a finished chain was revived: %s", record.Status)
	}
}

// Advancing must actually wake the next agent, not just move the index.
func TestPipelineRelaysToNextAgent(t *testing.T) {
	workspace, channel := setupPipelineDB(t)
	startTestPipeline(t, workspace, channel)

	CheckAndTriggerNextPipelineStep(workspace.ID, "channel/general", "openagents:codex-agent")

	// relayPipelineStep posts after a 500ms delay.
	deadline := time.Now().Add(3 * time.Second)
	var relayed []models.EventRecord
	for time.Now().Before(deadline) {
		db.DB.Where("network_id = ? AND source = ?", workspace.ID, "human:pipeline").Find(&relayed)
		if len(relayed) > 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if len(relayed) != 1 {
		t.Fatalf("expected exactly one relay event, got %d", len(relayed))
	}

	var metadata map[string]interface{}
	if err := json.Unmarshal(relayed[0].Metadata, &metadata); err != nil {
		t.Fatal(err)
	}
	targets, _ := metadata["target_agents"].([]interface{})
	if len(targets) != 1 || targets[0] != "claude-agent" {
		t.Fatalf("expected the relay to target claude-agent, got %v", metadata["target_agents"])
	}

	var payload map[string]interface{}
	if err := json.Unmarshal(relayed[0].Payload, &payload); err != nil {
		t.Fatal(err)
	}
	content, _ := payload["content"].(string)
	if !strings.Contains(content, "@claude-agent") || !strings.Contains(content, "refactor it") || !strings.Contains(content, "Prior Stage Deliverables") {
		t.Fatalf("unexpected relay content: %q", content)
	}
}

func TestPipelineSelfCorrectionOnFailure(t *testing.T) {
	workspace, channel := setupPipelineDB(t)
	startTestPipeline(t, workspace, channel)

	// Simulate codex-agent emitting an error in its turn
	errPayload, _ := json.Marshal(map[string]interface{}{
		"content":      "Trying to analyze...\nmain.go:12: syntax error: unexpected semicolon\n[build failed]",
		"message_type": "chat",
	})
	db.DB.Create(&models.EventRecord{
		ID:        uuid.NewString(),
		NetworkID: workspace.ID,
		Type:      "workspace.message.posted",
		Source:    "openagents:codex-agent",
		Target:    "channel/general",
		Payload:   errPayload,
		Timestamp: time.Now().UnixMilli(),
	})

	CheckAndTriggerNextPipelineStep(workspace.ID, "channel/general", "openagents:codex-agent")

	// Verify step 0 did NOT advance and entered retrying state
	record, steps := loadChain(t, channel.ID)
	if record.CurrentIndex != 0 {
		t.Fatalf("Expected pipeline to stay at step 0 on error, got %d", record.CurrentIndex)
	}
	if steps[0].Status != "retrying" {
		t.Fatalf("Expected step 0 status 'retrying', got %s", steps[0].Status)
	}
	if steps[0].RetryCount != 1 {
		t.Fatalf("Expected retry_count = 1, got %d", steps[0].RetryCount)
	}

	// Verify self-correction message was relayed back to codex-agent
	deadline := time.Now().Add(2 * time.Second)
	var retried []models.EventRecord
	for time.Now().Before(deadline) {
		db.DB.Where("network_id = ? AND source = ?", workspace.ID, "system:evaluator").Find(&retried)
		if len(retried) > 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if len(retried) == 0 {
		t.Fatalf("Expected self-correction relay event from system:evaluator")
	}
}

func TestPipelineHaltOnExhaustedRetries(t *testing.T) {
	workspace, channel := setupPipelineDB(t)
	startTestPipeline(t, workspace, channel)

	// Set step 0 retry_count to 3 (exhausted)
	record, steps := loadChain(t, channel.ID)
	steps[0].RetryCount = 3
	encoded, _ := json.Marshal(steps)
	db.DB.Model(&record).Update("steps", encoded)

	// Emit failure message again
	errPayload, _ := json.Marshal(map[string]interface{}{
		"content":      "Fatal error: [SYSTEM ERROR] Process crashed with exit status 1",
		"message_type": "chat",
	})
	db.DB.Create(&models.EventRecord{
		ID:        uuid.NewString(),
		NetworkID: workspace.ID,
		Type:      "workspace.message.posted",
		Source:    "openagents:codex-agent",
		Target:    "channel/general",
		Payload:   errPayload,
		Timestamp: time.Now().UnixMilli(),
	})

	CheckAndTriggerNextPipelineStep(workspace.ID, "channel/general", "openagents:codex-agent")

	// Verify pipeline failed and halted
	updatedRecord, updatedSteps := loadChain(t, channel.ID)
	if updatedRecord.Status != "failed" {
		t.Fatalf("Expected pipeline status 'failed', got %s", updatedRecord.Status)
	}
	if updatedSteps[0].Status != "failed" {
		t.Fatalf("Expected step 0 status 'failed', got %s", updatedSteps[0].Status)
	}
	if updatedRecord.CurrentIndex != 0 {
		t.Fatalf("Expected current_index to stay on failed step 0, got %d", updatedRecord.CurrentIndex)
	}
}

func TestPipelineAdvancesOnAnalyticalReviewWithReportedBugs(t *testing.T) {
	workspace, channel := setupPipelineDB(t)

	// Start pipeline: @codex-agent 你只看前端 看看有什么能优化的 @claude-agent 你看后端看看有什么能优化的
	req := &SendEventRequest{
		Type:   "workspace.message.posted",
		Source: "human:user",
		Target: "channel/general",
		Payload: map[string]interface{}{
			"content":      "@codex-agent 你只看前端 看看有什么能优化的 @claude-agent 你看后端看看有什么能优化的",
			"message_type": "chat",
		},
	}
	_, _, err := routeMessage(workspace.ID, &channel, req)
	if err != nil {
		t.Fatal(err)
	}

	// Codex-agent emits a long code review listing bugs, undefined keys, build errors
	reviewPayload, _ := json.Marshal(map[string]interface{}{
		"content":      "审查分析前端代码发现以下缺陷：\n1. React 列表 key 为 undefined\n2. JSX 语法标签开闭不匹配导致 Build 报错\n3. SyntaxError: unexpected token",
		"message_type": "chat",
	})
	db.DB.Create(&models.EventRecord{
		ID:        uuid.NewString(),
		NetworkID: workspace.ID,
		Type:      "workspace.message.posted",
		Source:    "openagents:codex-agent",
		Target:    "channel/general",
		Payload:   reviewPayload,
		Timestamp: time.Now().UnixMilli(),
	})

	CheckAndTriggerNextPipelineStep(workspace.ID, "channel/general", "openagents:codex-agent")

	// Verify step 0 (codex-agent) is marked done and pipeline advances to step 1 (claude-agent)
	record, steps := loadChain(t, channel.ID)
	if record.CurrentIndex != 1 {
		t.Fatalf("Expected pipeline to advance to step 1 (claude-agent), got index %d", record.CurrentIndex)
	}
	if steps[0].Status != "done" {
		t.Fatalf("Expected step 0 to be done, got %s", steps[0].Status)
	}
	if steps[1].Status != "running" {
		t.Fatalf("Expected step 1 (claude-agent) to be running, got %s", steps[1].Status)
	}
}

func TestPipelineStructuredMentionSegmentsDirect(t *testing.T) {
	workspace, channel := setupPipelineDB(t)

	// User sends structured mention_segments containing complex Chinese conjunctions
	req := &SendEventRequest{
		Type:   "workspace.message.posted",
		Source: "human:user",
		Target: "channel/general",
		Payload: map[string]interface{}{
			"content":      "@codex-agent 检查项目的微服务组件有哪些交给 @claude-agent 给出微服务组件的优化建议",
			"message_type": "chat",
		},
		Metadata: map[string]interface{}{
			"mention_segments": []interface{}{
				map[string]interface{}{
					"agent":       "codex-agent",
					"instruction": "检查项目的微服务组件有哪些交给",
				},
				map[string]interface{}{
					"agent":       "claude-agent",
					"instruction": "给出微服务组件的优化建议",
				},
			},
		},
	}

	targets, routed, err := routeMessage(workspace.ID, &channel, req)
	if err != nil {
		t.Fatal(err)
	}
	if !routed || len(targets) != 1 || targets[0] != "codex-agent" {
		t.Fatalf("expected structured chain to route directly to codex-agent, got routed=%v targets=%v", routed, targets)
	}

	record, steps := loadChain(t, channel.ID)
	if record.Status != "running" || record.CurrentIndex != 0 {
		t.Fatalf("expected running chain at index 0, got status=%s index=%d", record.Status, record.CurrentIndex)
	}
	if len(steps) != 2 {
		t.Fatalf("expected 2 steps in chain, got %d", len(steps))
	}
	if steps[0].Agent != "codex-agent" || steps[0].Instruction != "检查项目的微服务组件有哪些交给" {
		t.Fatalf("unexpected step 0: %+v", steps[0])
	}
	if steps[1].Agent != "claude-agent" || steps[1].Instruction != "给出微服务组件的优化建议" {
		t.Fatalf("unexpected step 1: %+v", steps[1])
	}
}
