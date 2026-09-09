package scheduler

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"gorm.io/gorm"
)

func setupTestDB(t *testing.T) {
	database, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("failed to open sqlite in-memory db: %v", err)
	}
	db.DB = database
	err = db.DB.AutoMigrate(
		&models.ChannelPipeline{},
		&models.Channel{},
		&models.AgentApprovalRecord{},
		&models.WorkspaceMember{},
		&models.EventRecord{},
		&models.CouncilSession{},
		&models.SpeechActRecord{},
		&models.RoutineRecord{},
		&models.RoutineRunRecord{},
		&models.TodoRecord{},
	)
	if err != nil {
		t.Fatalf("failed to auto migrate: %v", err)
	}
	config.GlobalConfig = &config.Config{
		AgentTimeoutSeconds: 5,
		// A step's deadline is deliberately a separate knob from agent liveness;
		// the sweeper must never read AgentTimeoutSeconds.
		PipelineStepTimeoutSeconds: 5,
	}
}

func TestExpireStalePipelineSteps(t *testing.T) {
	setupTestDB(t)

	wsID := uuid.NewString()
	chID := uuid.NewString()

	channel := models.Channel{
		ID:          chID,
		WorkspaceID: wsID,
		Name:        "general",
		Status:      "active",
	}
	db.DB.Create(&channel)

	// Step started 10 seconds ago (exceeds 5s timeout)
	startedAt := time.Now().Add(-10 * time.Second).UnixMilli()
	steps := []models.PipelineStep{
		{
			Agent:       "coder",
			Instruction: "Refactor backend",
			Status:      "running",
			StartedAt:   &startedAt,
			MaxRetries:  3,
			RetryCount:  0,
		},
	}
	stepsJSON, _ := json.Marshal(steps)

	pipeline := models.ChannelPipeline{
		ID:           uuid.NewString(),
		WorkspaceID:  wsID,
		ChannelID:    chID,
		Steps:        stepsJSON,
		CurrentIndex: 0,
		Status:       "running",
	}
	db.DB.Create(&pipeline)

	// Run sweeper
	expireStalePipelineSteps()

	var updated models.ChannelPipeline
	db.DB.Where("id = ?", pipeline.ID).First(&updated)
	if updated.Status != "failed" {
		t.Fatalf("Expected pipeline status to be 'failed', got '%s'", updated.Status)
	}

	var updatedSteps []models.PipelineStep
	_ = json.Unmarshal(updated.Steps, &updatedSteps)
	if len(updatedSteps) == 0 || updatedSteps[0].Status != "failed" {
		t.Fatalf("Expected step status to be 'failed', got '%s'", updatedSteps[0].Status)
	}
}

func TestExpirePendingApprovals(t *testing.T) {
	setupTestDB(t)

	wsID := uuid.NewString()
	now := time.Now().UTC()

	// 1. Expired approval with explicit ExpiresAt in the past
	past := now.Add(-10 * time.Minute)
	app1 := models.AgentApprovalRecord{
		ID:          uuid.NewString(),
		WorkspaceID: wsID,
		AgentName:   "coder",
		RequestedBy: "coder",
		Action:      "terminal.execute",
		Status:      "pending",
		ExpiresAt:   &past,
	}
	db.DB.Create(&app1)

	// 2. Fresh approval with ExpiresAt in the future
	future := now.Add(10 * time.Minute)
	app2 := models.AgentApprovalRecord{
		ID:          uuid.NewString(),
		WorkspaceID: wsID,
		AgentName:   "coder",
		RequestedBy: "coder",
		Action:      "terminal.execute",
		Status:      "pending",
		ExpiresAt:   &future,
	}
	db.DB.Create(&app2)

	// Run sweeper
	expirePendingApprovals()

	var res1, res2 models.AgentApprovalRecord
	db.DB.Where("id = ?", app1.ID).First(&res1)
	db.DB.Where("id = ?", app2.ID).First(&res2)

	if res1.Status != "expired" {
		t.Errorf("Expected app1 status to be 'expired', got '%s'", res1.Status)
	}
	if res2.Status != "pending" {
		t.Errorf("Expected app2 status to remain 'pending', got '%s'", res2.Status)
	}
}

// A long-running coding step is not a stalled one. The agent streams status and
// thinking events the whole time it works, so the sweeper must reap on silence
// rather than on how long the step has been open -- otherwise the deadline kills
// work that is visibly in progress, which is exactly what a one-minute default
// did to every real task.
func TestExpireStalePipelineStepsSparesAnActiveAgent(t *testing.T) {
	setupTestDB(t)

	wsID := uuid.NewString()
	chID := uuid.NewString()
	db.DB.Create(&models.Channel{ID: chID, WorkspaceID: wsID, Name: "general", Status: "active"})

	// The step opened well past the deadline...
	startedAt := time.Now().Add(-60 * time.Second).UnixMilli()
	stepsJSON, _ := json.Marshal([]models.PipelineStep{{
		Agent:      "coder",
		Status:     "running",
		StartedAt:  &startedAt,
		MaxRetries: 3,
	}})
	pipeline := models.ChannelPipeline{
		ID: uuid.NewString(), WorkspaceID: wsID, ChannelID: chID,
		Steps: stepsJSON, CurrentIndex: 0, Status: "running",
	}
	db.DB.Create(&pipeline)

	// ...but the agent reported in one second ago.
	db.DB.Create(&models.EventRecord{
		ID:        uuid.NewString(),
		NetworkID: wsID,
		Type:      "workspace.message.posted",
		Source:    "openagents:coder",
		Target:    "channel/general",
		Timestamp: time.Now().Add(-1 * time.Second).UnixMilli(),
	})

	expireStalePipelineSteps()

	var updated models.ChannelPipeline
	db.DB.Where("id = ?", pipeline.ID).First(&updated)
	if updated.Status != "running" {
		t.Fatalf("an agent active 1s ago must not be halted, got status %q", updated.Status)
	}
}

func TestExpireStaleCouncilSessions(t *testing.T) {
	setupTestDB(t)

	wsID := uuid.New().String()
	ch := models.Channel{
		ID:          uuid.New().String(),
		WorkspaceID: wsID,
		Name:        "general",
	}
	db.DB.Create(&ch)

	// Past deadline by 10 seconds
	pastDeadline := time.Now().Add(-10 * time.Second).UnixMilli()
	session := models.CouncilSession{
		ID:                  uuid.New().String(),
		WorkspaceID:         wsID,
		ChannelID:           ch.ID,
		Topic:               "Authentication RFC",
		Status:              models.CouncilStatusDebating,
		InitiatedBy:         "human:user",
		ProposerAgent:       "claude",
		MandatoryChallenger: "codex",
		CurrentRound:        1,
		MaxRounds:           3,
		ChallengeDeadlineAt: &pastDeadline,
		CreatedAt:           time.Now().Add(-15 * time.Second),
	}
	db.DB.Create(&session)

	// Run scheduler sweep
	expireStaleCouncilSessions()

	var updated models.CouncilSession
	db.DB.Where("id = ?", session.ID).First(&updated)
	if updated.Status != models.CouncilStatusBudgetExhausted {
		t.Fatalf("expected council session to transition to budget_exhausted, got %s", updated.Status)
	}

	// Verify alert event was posted to channel
	var alert models.EventRecord
	if err := db.DB.Where("network_id = ? AND source = ?", wsID, "system:council").First(&alert).Error; err != nil {
		t.Fatalf("expected alert event from system:council, got error: %v", err)
	}
}

func TestExpireStaleRoutineRuns(t *testing.T) {
	setupTestDB(t)

	wsID := uuid.NewString()
	rtnID := uuid.NewString()
	runID := uuid.NewString()
	todoID := uuid.NewString()

	// Routine created and running
	rtn := models.RoutineRecord{
		ID:            rtnID,
		ShortID:       "RTN-001",
		WorkspaceID:   wsID,
		ChannelName:   "routines:coder",
		CreatedBy:     "coder",
		Name:          "Nightly Check",
		Message:       "Run test",
		NextFiresAt:   time.Now().Add(1 * time.Hour),
		LastRunID:     &runID,
		LastRunStatus: "running",
		Status:        "active",
	}
	db.DB.Create(&rtn)

	// Run started 20 minutes ago (exceeds 15m timeout)
	run := models.RoutineRunRecord{
		ID:             runID,
		RoutineID:      rtnID,
		RoutineShortID: "RTN-001",
		WorkspaceID:    wsID,
		RunNumber:      1,
		ChannelName:    "routines:coder",
		AgentName:      "coder",
		RoutineName:    "Nightly Check",
		TriggerMessage: "Run test",
		Status:         "running",
		StartedAt:      time.Now().Add(-20 * time.Minute),
	}
	db.DB.Create(&run)

	// Linked in_progress todo
	todo := models.TodoRecord{
		ID:          todoID,
		WorkspaceID: wsID,
		ChannelName: "routines:coder",
		CreatedBy:   "system:routine",
		Assignee:    "coder",
		Content:     "⏰ [Nightly Check] Run test (Run #1)",
		Status:      "in_progress",
		RoutineID:   &rtnID,
		RunID:       &runID,
		CreatedAt:   time.Now().Add(-20 * time.Minute),
		UpdatedAt:   time.Now().Add(-20 * time.Minute),
	}
	db.DB.Create(&todo)

	// Run sweeper
	expireStaleRoutineRuns()

	// 1. Verify RoutineRunRecord marked failed with error
	var freshRun models.RoutineRunRecord
	if err := db.DB.Where("id = ?", runID).First(&freshRun).Error; err != nil {
		t.Fatalf("run not found: %v", err)
	}
	if freshRun.Status != "failed" {
		t.Fatalf("expected run status to be failed, got %s", freshRun.Status)
	}
	if freshRun.Error == nil || *freshRun.Error == "" {
		t.Fatalf("expected run error to be populated")
	}

	// 2. Verify RoutineRecord last_run_status is failed
	var freshRtn models.RoutineRecord
	if err := db.DB.Where("id = ?", rtnID).First(&freshRtn).Error; err != nil {
		t.Fatalf("routine not found: %v", err)
	}
	if freshRtn.LastRunStatus != "failed" {
		t.Fatalf("expected routine last_run_status to be failed, got %s", freshRtn.LastRunStatus)
	}
	if freshRtn.LastRunError == nil || *freshRtn.LastRunError == "" {
		t.Fatalf("expected routine last_run_error to be populated")
	}

	// 3. Verify TodoRecord status is cancelled and error is set
	var freshTodo models.TodoRecord
	if err := db.DB.Where("id = ?", todoID).First(&freshTodo).Error; err != nil {
		t.Fatalf("todo not found: %v", err)
	}
	if freshTodo.Status != "cancelled" {
		t.Fatalf("expected todo status to be cancelled, got %s", freshTodo.Status)
	}
	if freshTodo.Error == nil || *freshTodo.Error == "" {
		t.Fatalf("expected todo error to be populated")
	}
}


