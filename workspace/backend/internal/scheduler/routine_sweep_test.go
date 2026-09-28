package scheduler

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

func setupRoutineSweepDB(t *testing.T) string {
	t.Helper()
	setupTestDB(t)
	if err := db.DB.AutoMigrate(&models.AgentTurnState{}, &models.FileRecord{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	wsID := uuid.NewString()
	now := time.Now().UTC()
	if err := db.DB.Create(&models.WorkspaceMember{WorkspaceID: wsID, AgentName: "coder", Role: "member", Status: "online", LastHeartbeat: &now}).Error; err != nil {
		t.Fatalf("create member: %v", err)
	}
	return wsID
}

func sweepRoutine(t *testing.T, wsID, status string) models.RoutineRecord {
	t.Helper()
	interval := 30
	r := models.RoutineRecord{
		ID: uuid.NewString(), ShortID: "RTN-001", WorkspaceID: wsID, ChannelName: "routines:coder",
		CreatedBy: "coder", Name: "Daily summary", Message: "summarise", ScheduleIntervalMinutes: &interval,
		ScheduleDays: []byte("[]"), Timezone: "UTC", NextFiresAt: time.Now().UTC().Add(-time.Minute),
		LastRunStatus: "scheduled", Status: status,
	}
	if err := db.DB.Create(&r).Error; err != nil {
		t.Fatalf("create routine: %v", err)
	}
	return r
}

func sweepRun(t *testing.T, r models.RoutineRecord, startedAt time.Time) models.RoutineRunRecord {
	t.Helper()
	run := models.RoutineRunRecord{
		ID: uuid.NewString(), RoutineID: r.ID, RoutineShortID: r.ShortID, WorkspaceID: r.WorkspaceID, RunNumber: 1,
		ChannelName: r.ChannelName, AgentName: r.CreatedBy, RoutineName: r.Name, TriggerMessage: r.Message,
		Status: "running", StartedAt: startedAt,
	}
	if err := db.DB.Create(&run).Error; err != nil {
		t.Fatalf("create run: %v", err)
	}
	return run
}

// TestFireDueRoutinesSkipsPendingApproval: a proposal never fires, however
// overdue; the same routine fires once it is active.
func TestFireDueRoutinesSkipsPendingApproval(t *testing.T) {
	wsID := setupRoutineSweepDB(t)
	r := sweepRoutine(t, wsID, "pending_approval")

	fireDueRoutines()
	var runs int64
	db.DB.Model(&models.RoutineRunRecord{}).Where("routine_id = ?", r.ID).Count(&runs)
	if runs != 0 {
		t.Fatalf("pending_approval routine fired %d times", runs)
	}

	db.DB.Model(&models.RoutineRecord{}).Where("id = ?", r.ID).Update("status", "active")
	fireDueRoutines()
	db.DB.Model(&models.RoutineRunRecord{}).Where("routine_id = ?", r.ID).Count(&runs)
	if runs != 1 {
		t.Fatalf("active routine fired %d times, want 1", runs)
	}
	var todos int64
	db.DB.Model(&models.TodoRecord{}).Where("workspace_id = ?", wsID).Count(&todos)
	if todos != 0 {
		t.Fatalf("scheduled fire opened %d board tasks, want 0", todos)
	}
}

// TestSweepSparesARunWhoseTurnIsStillRunning: past 15 minutes, a run whose
// agent is still in the turn it started for the routine stays open.
func TestSweepSparesARunWhoseTurnIsStillRunning(t *testing.T) {
	wsID := setupRoutineSweepDB(t)
	r := sweepRoutine(t, wsID, "active")
	started := time.Now().UTC().Add(-20 * time.Minute)
	run := sweepRun(t, r, started)
	turnStart := started.Add(2 * time.Second)
	db.DB.Create(&models.AgentTurnState{WorkspaceID: wsID, AgentName: "coder", ChannelName: r.ChannelName, State: "running", StartedAt: &turnStart, UpdatedAt: time.Now().UTC()})

	expireStaleRoutineRuns()
	var fresh models.RoutineRunRecord
	db.DB.Where("id = ?", run.ID).First(&fresh)
	if fresh.Status != "running" {
		t.Fatalf("a run mid-turn was reaped: %q %v", fresh.Status, fresh.Error)
	}
}

// TestSweepCompletesARunThatWasAnswered: the turn-end report was lost, but the
// agent did reply -- the sweep completes the run with that reply instead of
// failing it.
func TestSweepCompletesARunThatWasAnswered(t *testing.T) {
	wsID := setupRoutineSweepDB(t)
	r := sweepRoutine(t, wsID, "active")
	started := time.Now().UTC().Add(-20 * time.Minute)
	run := sweepRun(t, r, started)
	payload, _ := json.Marshal(map[string]string{"content": "summary posted", "message_type": "chat"})
	db.DB.Create(&models.EventRecord{
		ID: uuid.NewString(), NetworkID: wsID, Type: "workspace.message.posted", Source: "52hz:coder",
		Target: "channel/" + r.ChannelName, Payload: payload, Metadata: []byte("{}"),
		Timestamp: started.Add(time.Minute).UnixMilli(), Visibility: "channel",
	})

	expireStaleRoutineRuns()
	var fresh models.RoutineRunRecord
	db.DB.Where("id = ?", run.ID).First(&fresh)
	if fresh.Status != "completed" || fresh.Result == nil || *fresh.Result != "summary posted" {
		t.Fatalf("answered run = %+v", fresh)
	}
}

// TestSweepFailuresAutoPauseTheRoutine: the offline-agent case from the real
// database -- every fire failing -- stops after three.
func TestSweepFailuresAutoPauseTheRoutine(t *testing.T) {
	wsID := setupRoutineSweepDB(t)
	db.DB.Model(&models.WorkspaceMember{}).Where("workspace_id = ?", wsID).Update("status", "offline")
	r := sweepRoutine(t, wsID, "active")

	for i := 0; i < 3; i++ {
		sweepRun(t, r, time.Now().UTC().Add(-5*time.Minute))
		expireStaleRoutineRuns()
	}
	var fresh models.RoutineRecord
	db.DB.Where("id = ?", r.ID).First(&fresh)
	if fresh.Status != "paused" || fresh.PausedReason == nil || fresh.ConsecutiveFailures != 3 {
		t.Fatalf("after 3 offline failures: status %q reason %v streak %d", fresh.Status, fresh.PausedReason, fresh.ConsecutiveFailures)
	}
	// Paused routines do not fire.
	db.DB.Model(&models.RoutineRecord{}).Where("id = ?", r.ID).Update("next_fires_at", time.Now().UTC().Add(-time.Minute))
	var before, after int64
	db.DB.Model(&models.RoutineRunRecord{}).Where("routine_id = ?", r.ID).Count(&before)
	fireDueRoutines()
	db.DB.Model(&models.RoutineRunRecord{}).Where("routine_id = ?", r.ID).Count(&after)
	if after != before {
		t.Fatalf("paused routine fired")
	}
}
