package scheduler

import (
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"gorm.io/gorm"
)

func setupTimerDB(t *testing.T) {
	t.Helper()
	database, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	db.DB = database
	if err := db.DB.AutoMigrate(&models.TimerRecord{}, &models.TodoRecord{}, &models.EventRecord{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
}

func newTimer(t *testing.T, firesAt time.Time) models.TimerRecord {
	t.Helper()
	rec := models.TimerRecord{
		ID:           uuid.NewString(),
		WorkspaceID:  uuid.NewString(),
		ChannelName:  "general",
		CreatedBy:    "52hz:antigravity",
		Message:      "report the weather",
		DelaySeconds: 300,
		FiresAt:      firesAt,
		Status:       "active",
	}
	if err := db.DB.Create(&rec).Error; err != nil {
		t.Fatalf("create timer: %v", err)
	}
	return rec
}

func statusOf(t *testing.T, id string) string {
	t.Helper()
	var rec models.TimerRecord
	if err := db.DB.Where("id = ?", id).First(&rec).Error; err != nil {
		t.Fatalf("reload timer: %v", err)
	}
	return rec.Status
}

// TestFireDueTimersRespectsUTC is the regression test for two opposite defects,
// both of which shipped.
//
// First, fires_at was written as local time while the sweep compared against
// time.Now().UTC(), so in a +08:00 zone no timer ever came due and none ever
// fired. The fix was to store UTC.
//
// Then the sweep briefly also compared against the local clock, meaning to
// rescue those legacy rows. That is far worse: the local clock reads eight hours
// ahead of the UTC values now being stored, so every timer scheduled within the
// next eight hours fired on the tick right after it was created.
func TestFireDueTimersRespectsUTC(t *testing.T) {
	setupTimerDB(t)

	past := newTimer(t, time.Now().UTC().Add(-time.Minute))
	soon := newTimer(t, time.Now().UTC().Add(30*time.Minute))
	later := newTimer(t, time.Now().UTC().Add(5*time.Hour))

	fireDueTimers()

	if got := statusOf(t, past.ID); got != "fired" {
		t.Fatalf("a timer already past its time did not fire: status = %q", got)
	}
	if got := statusOf(t, soon.ID); got != "active" {
		t.Fatalf("a timer 30 minutes out fired early: status = %q", got)
	}
	if got := statusOf(t, later.ID); got != "active" {
		t.Fatalf("a timer 5 hours out fired early: status = %q — the local-clock comparison is back", got)
	}
}

// TestFireDueTimersAdvancesItsTask covers the board link: a fired timer moves
// its task from pending to in_progress, and leaves other timers' tasks alone.
func TestFireDueTimersAdvancesItsTask(t *testing.T) {
	setupTimerDB(t)

	due := newTimer(t, time.Now().UTC().Add(-time.Minute))
	pending := newTimer(t, time.Now().UTC().Add(time.Hour))

	for _, timer := range []models.TimerRecord{due, pending} {
		id := timer.ID
		if err := db.DB.Create(&models.TodoRecord{
			ID:          uuid.NewString(),
			WorkspaceID: timer.WorkspaceID,
			ChannelName: timer.ChannelName,
			CreatedBy:   "system:timer",
			Assignee:    "antigravity",
			Content:     "report the weather",
			Status:      "pending",
			TimerID:     &id,
		}).Error; err != nil {
			t.Fatalf("create task: %v", err)
		}
	}

	fireDueTimers()

	read := func(timerID string) string {
		var rec models.TodoRecord
		if err := db.DB.Where("timer_id = ?", timerID).First(&rec).Error; err != nil {
			t.Fatalf("reload task: %v", err)
		}
		return rec.Status
	}

	if got := read(due.ID); got != "in_progress" {
		t.Fatalf("fired timer's task = %q, want in_progress", got)
	}
	if got := read(pending.ID); got != "pending" {
		t.Fatalf("an unrelated timer's task was advanced: %q", got)
	}
}
