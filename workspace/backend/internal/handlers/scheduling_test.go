package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

// schedulingTestRouter extends the planning router with the endpoints added for
// schedule editing and single-task updates.
func schedulingTestRouter(t *testing.T) (*gin.Engine, models.Workspace, string) {
	t.Helper()
	router, workspace, token := planningTestRouter(t)
	if err := db.DB.AutoMigrate(&models.RoutineRunRecord{}); err != nil {
		t.Fatalf("migrate routine runs: %v", err)
	}
	router.PATCH("/v1/todos/:todo_id", PatchTodo)
	router.DELETE("/v1/todos/:todo_id", DeleteTodo)
	router.PATCH("/v1/routines/:routine_id", UpdateRoutine)
	router.POST("/v1/routines/:routine_id/run", TriggerRoutineNow)
	return router, workspace, token
}

// TestComputeNextFiresAtHonoursTimezone pins the behaviour the UI promises: a
// daily schedule set to 09:00 fires at 09:00 *where the user lives*, not at
// 09:00 UTC. Every daily routine created before this was silently shifted by
// the user's UTC offset.
func TestComputeNextFiresAtHonoursTimezone(t *testing.T) {
	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatalf("load Asia/Shanghai (is time/tzdata linked?): %v", err)
	}

	hour, minute := 9, 30
	next := ComputeNextFiresAt(&hour, &minute, nil, nil, "Asia/Shanghai")
	local := next.In(shanghai)

	if local.Hour() != 9 || local.Minute() != 30 {
		t.Fatalf("next fire in Asia/Shanghai = %s, want local wall-clock 09:30", local.Format(time.RFC3339))
	}
	if !next.After(time.Now()) {
		t.Fatalf("next fire %s is not in the future", next.Format(time.RFC3339))
	}
	// The stored instant must be UTC so the scheduler's `next_fires_at <= now`
	// comparison stays apples-to-apples.
	if next.Location() != time.UTC {
		t.Fatalf("stored instant location = %v, want UTC", next.Location())
	}

	// An unknown zone must degrade to UTC rather than panic or return a zero time.
	fallback := ComputeNextFiresAt(&hour, &minute, nil, nil, "Not/AZone")
	if fallback.UTC().Hour() != 9 || fallback.UTC().Minute() != 30 {
		t.Fatalf("unknown timezone did not fall back to UTC: %s", fallback.Format(time.RFC3339))
	}
}

// TestComputeNextFiresAtPicksSelectedWeekday checks the 0=Monday convention the
// model stores against the Go 0=Sunday convention it has to translate from.
func TestComputeNextFiresAtPicksSelectedWeekday(t *testing.T) {
	hour, minute := 8, 0
	// 2 == Wednesday under the stored convention (0=Monday).
	next := ComputeNextFiresAt(&hour, &minute, []int{2}, nil, "UTC")
	if next.Weekday() != time.Wednesday {
		t.Fatalf("day index 2 resolved to %s, want Wednesday", next.Weekday())
	}
	if next.Hour() != 8 || next.Minute() != 0 {
		t.Fatalf("weekly fire time = %02d:%02d, want 08:00", next.Hour(), next.Minute())
	}
}

// TestComputeNextFiresAtIntervalIgnoresTimezone documents that interval mode is
// wall-clock independent.
func TestComputeNextFiresAtIntervalIgnoresTimezone(t *testing.T) {
	interval := 45
	next := ComputeNextFiresAt(nil, nil, nil, &interval, "Asia/Tokyo")
	delta := time.Until(next)
	if delta < 44*time.Minute || delta > 46*time.Minute {
		t.Fatalf("interval fire is %s away, want ~45m", delta)
	}
}

// TestCreateRoutineAcceptsWorkspaceAddressPrefix covers the failure that made
// "New Schedule" unusable from the UI: the client sends 52hz:<agent>, and the
// membership check only knew how to strip openagents:, so every create 403'd.
func TestCreateRoutineAcceptsWorkspaceAddressPrefix(t *testing.T) {
	router, workspace, token := schedulingTestRouter(t)

	for _, source := range []string{"52hz:planner", "openagents:planner", "agent:planner", "planner"} {
		body := gin.H{
			"network":  workspace.ID,
			"source":   source,
			"name":     "Prefix " + source,
			"message":  "Report status",
			"hour":     9,
			"minute":   0,
			"timezone": "Asia/Shanghai",
		}
		response := planningRequest(t, router, http.MethodPost, "/v1/routines", token, body)
		if response.Code != http.StatusOK {
			t.Fatalf("create routine with source %q = %d, body = %s", source, response.Code, response.Body.String())
		}
		var routine models.RoutineRecord
		if err := json.Unmarshal(response.Body.Bytes(), &routine); err != nil {
			t.Fatalf("decode routine: %v", err)
		}
		if routine.CreatedBy != "planner" {
			t.Fatalf("created_by = %q, want the bare agent name", routine.CreatedBy)
		}
		if routine.Timezone != "Asia/Shanghai" {
			t.Fatalf("timezone = %q, want Asia/Shanghai", routine.Timezone)
		}
	}
}

// TestCreateRoutineRejectsUnknownTimezone keeps a typo'd zone from silently
// relocating a schedule to UTC.
func TestCreateRoutineRejectsUnknownTimezone(t *testing.T) {
	router, workspace, token := schedulingTestRouter(t)
	body := gin.H{
		"network": workspace.ID, "source": "52hz:planner", "name": "Bad zone",
		"message": "x", "hour": 9, "minute": 0, "timezone": "Mars/Olympus",
	}
	if response := planningRequest(t, router, http.MethodPost, "/v1/routines", token, body); response.Code != http.StatusBadRequest {
		t.Fatalf("unknown timezone = %d, want %d", response.Code, http.StatusBadRequest)
	}
}

// TestRoutineShortIDsAreUnique guards the identifier users refer to a schedule
// by. COUNT(*)+1 handed the same RTN-00n to two schedules.
func TestRoutineShortIDsAreUnique(t *testing.T) {
	router, workspace, token := schedulingTestRouter(t)
	seen := map[string]bool{}
	for i := 0; i < 5; i++ {
		body := gin.H{
			"network": workspace.ID, "source": "52hz:planner",
			"name": fmt.Sprintf("Routine %d", i), "message": "work", "interval_minutes": 30,
		}
		response := planningRequest(t, router, http.MethodPost, "/v1/routines", token, body)
		if response.Code != http.StatusOK {
			t.Fatalf("create routine %d = %d, body = %s", i, response.Code, response.Body.String())
		}
		var routine models.RoutineRecord
		if err := json.Unmarshal(response.Body.Bytes(), &routine); err != nil {
			t.Fatalf("decode routine: %v", err)
		}
		if routine.ShortID == "" {
			t.Fatal("routine created without a short id")
		}
		if seen[routine.ShortID] {
			t.Fatalf("duplicate short id %q", routine.ShortID)
		}
		seen[routine.ShortID] = true
	}
}

// TestUpdateRoutineSwitchesScheduleMode verifies an edit fully replaces the
// previous mode. Leaving interval_minutes behind while setting hour/minute
// would make the new time silently ineffective.
func TestUpdateRoutineSwitchesScheduleMode(t *testing.T) {
	router, workspace, token := schedulingTestRouter(t)
	create := gin.H{
		"network": workspace.ID, "source": "52hz:planner", "name": "Hourly sweep",
		"message": "sweep", "interval_minutes": 60,
	}
	response := planningRequest(t, router, http.MethodPost, "/v1/routines", token, create)
	if response.Code != http.StatusOK {
		t.Fatalf("create routine = %d, body = %s", response.Code, response.Body.String())
	}
	var routine models.RoutineRecord
	if err := json.Unmarshal(response.Body.Bytes(), &routine); err != nil {
		t.Fatalf("decode routine: %v", err)
	}
	originalShortID := routine.ShortID

	patch := gin.H{
		"schedule_mode": "daily",
		"hour":          7,
		"minute":        15,
		"days":          []int{0, 1, 2, 3, 4},
		"timezone":      "Asia/Shanghai",
		"name":          "Weekday sweep",
	}
	response = planningRequest(t, router, http.MethodPatch, "/v1/routines/"+routine.ID, token, patch)
	if response.Code != http.StatusOK {
		t.Fatalf("patch routine = %d, body = %s", response.Code, response.Body.String())
	}

	var updated models.RoutineRecord
	if err := db.DB.Where("id = ?", routine.ID).First(&updated).Error; err != nil {
		t.Fatalf("reload routine: %v", err)
	}
	if updated.ScheduleIntervalMinutes != nil {
		t.Fatalf("interval survived the switch to daily: %d", *updated.ScheduleIntervalMinutes)
	}
	if updated.ScheduleHour == nil || *updated.ScheduleHour != 7 || updated.ScheduleMinute == nil || *updated.ScheduleMinute != 15 {
		t.Fatalf("daily time not applied: %+v", updated)
	}
	if updated.Name != "Weekday sweep" || updated.Timezone != "Asia/Shanghai" {
		t.Fatalf("metadata not applied: %+v", updated)
	}
	if updated.ShortID != originalShortID {
		t.Fatalf("short id changed on edit: %q -> %q", originalShortID, updated.ShortID)
	}

	shanghai, _ := time.LoadLocation("Asia/Shanghai")
	local := updated.NextFiresAt.In(shanghai)
	if local.Hour() != 7 || local.Minute() != 15 {
		t.Fatalf("next fire was not rescheduled: %s", local.Format(time.RFC3339))
	}

	// Switching back to interval must clear the daily fields.
	response = planningRequest(t, router, http.MethodPatch, "/v1/routines/"+routine.ID, token,
		gin.H{"schedule_mode": "interval", "interval_minutes": 20})
	if response.Code != http.StatusOK {
		t.Fatalf("patch back to interval = %d, body = %s", response.Code, response.Body.String())
	}
	if err := db.DB.Where("id = ?", routine.ID).First(&updated).Error; err != nil {
		t.Fatalf("reload routine: %v", err)
	}
	if updated.ScheduleHour != nil || updated.ScheduleMinute != nil {
		t.Fatalf("daily fields survived the switch to interval: %+v", updated)
	}
	if updated.ScheduleIntervalMinutes == nil || *updated.ScheduleIntervalMinutes != 20 {
		t.Fatalf("interval not applied: %+v", updated)
	}
}

// TestPutTodosKeepsOtherSourcesAndPersistsPriority covers the two defects that
// made the task board lossy: a replace wiped every other author's tasks in the
// channel (including the tracker rows scheduled runs create), and the priority
// the UI sent was dropped on the floor.
func TestPutTodosKeepsOtherSourcesAndPersistsPriority(t *testing.T) {
	router, workspace, token := schedulingTestRouter(t)

	agentBody := gin.H{
		"network": workspace.ID, "source": "52hz:planner", "channel": "general",
		"todos": []gin.H{{"content": "Agent task", "status": "in_progress", "priority": "high"}},
	}
	if response := planningRequest(t, router, http.MethodPut, "/v1/todos", token, agentBody); response.Code != http.StatusOK {
		t.Fatalf("put agent todos = %d, body = %s", response.Code, response.Body.String())
	}

	// A scheduled run's tracker row lives in the same channel under a different author.
	tracker := models.TodoRecord{
		ID: "TASK-RTN-001-1", WorkspaceID: workspace.ID, ChannelName: "general",
		CreatedBy: "system:routine", Assignee: "planner", Content: "Scheduled run",
		Status: "in_progress", Priority: "high",
	}
	if err := db.DB.Create(&tracker).Error; err != nil {
		t.Fatalf("create tracker todo: %v", err)
	}

	humanBody := gin.H{
		"network": workspace.ID, "source": "human:user", "channel": "general",
		"todos": []gin.H{{"content": "Human task", "status": "pending", "priority": "urgent"}},
	}
	if response := planningRequest(t, router, http.MethodPut, "/v1/todos", token, humanBody); response.Code != http.StatusOK {
		t.Fatalf("put human todos = %d, body = %s", response.Code, response.Body.String())
	}

	response := planningRequest(t, router, http.MethodGet, "/v1/todos?network="+workspace.ID+"&all=true", token, nil)
	var listed struct {
		Todos []models.TodoRecord `json:"todos"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode todos: %v", err)
	}

	byContent := map[string]models.TodoRecord{}
	for _, todo := range listed.Todos {
		byContent[todo.Content] = todo
	}
	for _, want := range []string{"Agent task", "Human task", "Scheduled run"} {
		if _, ok := byContent[want]; !ok {
			t.Fatalf("%q was destroyed by an unrelated replace; got %+v", want, listed.Todos)
		}
	}
	if got := byContent["Human task"].Priority; got != "urgent" {
		t.Fatalf("priority was not persisted: %q, want urgent", got)
	}
	if got := byContent["Agent task"].Priority; got != "high" {
		t.Fatalf("agent priority was not persisted: %q, want high", got)
	}

	// A replace from the same author still replaces that author's own list.
	humanBody["todos"] = []gin.H{{"content": "Human task v2", "status": "pending", "priority": "low"}}
	if response := planningRequest(t, router, http.MethodPut, "/v1/todos", token, humanBody); response.Code != http.StatusOK {
		t.Fatalf("second human put = %d, body = %s", response.Code, response.Body.String())
	}
	response = planningRequest(t, router, http.MethodGet, "/v1/todos?network="+workspace.ID+"&all=true", token, nil)
	if err := json.Unmarshal(response.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode todos: %v", err)
	}
	humanCount := 0
	for _, todo := range listed.Todos {
		if todo.CreatedBy == "human:user" {
			humanCount++
		}
	}
	if humanCount != 1 {
		t.Fatalf("replace did not replace the author's own list: %d rows", humanCount)
	}
}

// TestPatchTodoUpdatesOneRowAndTracksCompletion exercises the endpoint the task
// board now uses for status and priority toggles.
func TestPatchTodoUpdatesOneRowAndTracksCompletion(t *testing.T) {
	router, workspace, token := schedulingTestRouter(t)
	body := gin.H{
		"network": workspace.ID, "source": "human:user", "channel": "general",
		"todos": []gin.H{
			{"content": "First", "status": "pending"},
			{"content": "Second", "status": "pending"},
		},
	}
	if response := planningRequest(t, router, http.MethodPut, "/v1/todos", token, body); response.Code != http.StatusOK {
		t.Fatalf("seed todos = %d, body = %s", response.Code, response.Body.String())
	}

	var seeded []models.TodoRecord
	if err := db.DB.Where("workspace_id = ?", workspace.ID).Order("position").Find(&seeded).Error; err != nil || len(seeded) != 2 {
		t.Fatalf("expected 2 seeded todos, got %d (%v)", len(seeded), err)
	}
	target := seeded[0]

	response := planningRequest(t, router, http.MethodPatch, "/v1/todos/"+target.ID, token,
		gin.H{"status": "completed", "priority": "urgent"})
	if response.Code != http.StatusOK {
		t.Fatalf("patch todo = %d, body = %s", response.Code, response.Body.String())
	}

	var updated models.TodoRecord
	if err := db.DB.Where("id = ?", target.ID).First(&updated).Error; err != nil {
		t.Fatalf("reload todo: %v", err)
	}
	if updated.Status != "completed" || updated.Priority != "urgent" {
		t.Fatalf("patch did not apply: %+v", updated)
	}
	if updated.CompletedAt == nil {
		t.Fatal("completed_at was not stamped; the column is what the routine tracker writes to")
	}
	if updated.ID != target.ID {
		t.Fatalf("patch replaced the row identity: %q -> %q", target.ID, updated.ID)
	}

	// Reopening clears the completion stamp. Scan into a fresh struct: GORM will
	// not overwrite an already-set pointer field when the column comes back NULL,
	// so reusing `updated` here would report a stale timestamp.
	if response := planningRequest(t, router, http.MethodPatch, "/v1/todos/"+target.ID, token,
		gin.H{"status": "in_progress"}); response.Code != http.StatusOK {
		t.Fatalf("reopen todo = %d, body = %s", response.Code, response.Body.String())
	}
	var reopened models.TodoRecord
	if err := db.DB.Where("id = ?", target.ID).First(&reopened).Error; err != nil {
		t.Fatalf("reload todo: %v", err)
	}
	if reopened.CompletedAt != nil {
		t.Fatalf("completed_at survived reopening: %v", reopened.CompletedAt)
	}
	if reopened.Status != "in_progress" {
		t.Fatalf("reopened status = %q, want in_progress", reopened.Status)
	}

	// The sibling row is untouched.
	var sibling models.TodoRecord
	if err := db.DB.Where("id = ?", seeded[1].ID).First(&sibling).Error; err != nil {
		t.Fatalf("sibling todo vanished: %v", err)
	}
	if sibling.Status != "pending" {
		t.Fatalf("sibling status changed: %q", sibling.Status)
	}

	// Invalid enums are rejected rather than written.
	if response := planningRequest(t, router, http.MethodPatch, "/v1/todos/"+target.ID, token,
		gin.H{"priority": "catastrophic"}); response.Code != http.StatusBadRequest {
		t.Fatalf("invalid priority = %d, want %d", response.Code, http.StatusBadRequest)
	}

	if response := planningRequest(t, router, http.MethodDelete, "/v1/todos/"+target.ID, token, nil); response.Code != http.StatusOK {
		t.Fatalf("delete todo = %d, body = %s", response.Code, response.Body.String())
	}
	if err := db.DB.Where("id = ?", target.ID).First(&updated).Error; err == nil {
		t.Fatal("deleted todo is still readable")
	}
}

// TestRoutineRunCompletesOnlyForItsOwnAgent covers the completion rule: the
// trigger message and unrelated speakers used to close a run before its agent
// had produced anything.
func TestRoutineRunCompletesOnlyForItsOwnAgent(t *testing.T) {
	router, workspace, token := schedulingTestRouter(t)
	if err := db.DB.Create(&models.WorkspaceMember{WorkspaceID: workspace.ID, AgentName: "bystander"}).Error; err != nil {
		t.Fatalf("create second member: %v", err)
	}

	create := gin.H{
		"network": workspace.ID, "source": "52hz:planner", "name": "Nightly",
		"message": "run checks", "interval_minutes": 60,
	}
	response := planningRequest(t, router, http.MethodPost, "/v1/routines", token, create)
	if response.Code != http.StatusOK {
		t.Fatalf("create routine = %d, body = %s", response.Code, response.Body.String())
	}
	var routine models.RoutineRecord
	if err := json.Unmarshal(response.Body.Bytes(), &routine); err != nil {
		t.Fatalf("decode routine: %v", err)
	}

	if response := planningRequest(t, router, http.MethodPost, "/v1/routines/"+routine.ID+"/run", token, nil); response.Code != http.StatusOK {
		t.Fatalf("trigger routine = %d, body = %s", response.Code, response.Body.String())
	}

	target := "channel/" + routine.ChannelName
	var run models.RoutineRunRecord
	if err := db.DB.Where("routine_id = ?", routine.ID).First(&run).Error; err != nil {
		t.Fatalf("run record was not created: %v", err)
	}
	if run.Status != "running" {
		t.Fatalf("fresh run status = %q, want running", run.Status)
	}

	// Neither the system trigger nor an unrelated agent closes the run.
	CompleteRoutineRunIfApplicable(workspace.ID, target, "system:routine")
	CompleteRoutineRunIfApplicable(workspace.ID, target, "52hz:bystander")
	if err := db.DB.Where("id = ?", run.ID).First(&run).Error; err != nil {
		t.Fatalf("reload run: %v", err)
	}
	if run.Status != "running" {
		t.Fatalf("run was closed by an unrelated source: %q", run.Status)
	}

	// The routine's own agent does.
	CompleteRoutineRunIfApplicable(workspace.ID, target, "52hz:planner")
	if err := db.DB.Where("id = ?", run.ID).First(&run).Error; err != nil {
		t.Fatalf("reload run: %v", err)
	}
	if run.Status != "completed" || run.CompletedAt == nil {
		t.Fatalf("agent reply did not complete the run: %+v", run)
	}

	// The tracking task must close with it — this is the write that silently
	// failed while todos had no completed_at column.
	var tracker models.TodoRecord
	if err := db.DB.Where("run_id = ?", run.ID).First(&tracker).Error; err != nil {
		t.Fatalf("tracking task missing: %v", err)
	}
	if tracker.Status != "completed" {
		t.Fatalf("tracking task stayed %q; scheduled tasks would pile up forever", tracker.Status)
	}
	if tracker.CompletedAt == nil {
		t.Fatal("tracking task has no completed_at")
	}
}

// TestRunsAreRecordedInEveryWorkspace covers a collision that only appears with
// more than one workspace in the database, which is why the single-workspace
// tests above all passed while the second workspace's runs were vanishing.
//
// Short ids are numbered per workspace, so the first run of the first routine in
// every workspace derived the same "RTN-001.#1" primary key. The first workspace
// won; every later one hit a silently-discarded insert error and its run and its
// tracking task were never created.
func TestRunsAreRecordedInEveryWorkspace(t *testing.T) {
	router, first, token := schedulingTestRouter(t)

	// A second workspace sharing the same database and the same agent name.
	secondHash := hashWorkspaceToken("second-token")
	second := models.Workspace{
		ID: uuid.NewString(), Name: "Second", Slug: uuid.NewString(), PasswordHash: &secondHash,
	}
	if err := db.DB.Create(&second).Error; err != nil {
		t.Fatalf("create second workspace: %v", err)
	}
	if err := db.DB.Create(&models.WorkspaceMember{WorkspaceID: second.ID, AgentName: "planner"}).Error; err != nil {
		t.Fatalf("add member to second workspace: %v", err)
	}

	type created struct {
		id      string
		shortID string
	}
	made := map[string]created{}

	for _, ws := range []struct {
		id    string
		token string
	}{{first.ID, token}, {second.ID, "second-token"}} {
		body := gin.H{
			"network": ws.id, "source": "52hz:planner", "name": "Nightly",
			"message": "run checks", "interval_minutes": 60,
		}
		response := planningRequest(t, router, http.MethodPost, "/v1/routines", ws.token, body)
		if response.Code != http.StatusOK {
			t.Fatalf("create routine in %s = %d, body = %s", ws.id, response.Code, response.Body.String())
		}
		var routine models.RoutineRecord
		if err := json.Unmarshal(response.Body.Bytes(), &routine); err != nil {
			t.Fatalf("decode routine: %v", err)
		}
		made[ws.id] = created{id: routine.ID, shortID: routine.ShortID}

		if response := planningRequest(t, router, http.MethodPost, "/v1/routines/"+routine.ID+"/run", ws.token, nil); response.Code != http.StatusOK {
			t.Fatalf("trigger routine in %s = %d, body = %s", ws.id, response.Code, response.Body.String())
		}
	}

	// Both workspaces genuinely allocate RTN-001 — that is the point.
	if made[first.ID].shortID != made[second.ID].shortID {
		t.Logf("note: short ids differ (%s vs %s); the collision this guards needs them equal",
			made[first.ID].shortID, made[second.ID].shortID)
	}

	for label, ws := range map[string]string{"first": first.ID, "second": second.ID} {
		var runs []models.RoutineRunRecord
		if err := db.DB.Where("routine_id = ?", made[ws].id).Find(&runs).Error; err != nil {
			t.Fatalf("list runs for %s workspace: %v", label, err)
		}
		if len(runs) != 1 {
			t.Fatalf("%s workspace recorded %d runs, want 1", label, len(runs))
		}
		if runs[0].RunNumber != 1 || runs[0].RoutineShortID == "" {
			t.Fatalf("%s workspace run lost its readable identity: %+v", label, runs[0])
		}

		var trackers []models.TodoRecord
		if err := db.DB.Where("routine_id = ?", made[ws].id).Find(&trackers).Error; err != nil {
			t.Fatalf("list tracking tasks for %s workspace: %v", label, err)
		}
		if len(trackers) != 1 {
			t.Fatalf("%s workspace opened %d tracking tasks, want 1", label, len(trackers))
		}
		if trackers[0].WorkspaceID != ws {
			t.Fatalf("%s workspace tracking task belongs to %s", label, trackers[0].WorkspaceID)
		}
	}
}

// TestTriggerCancelledRoutineIsRejected keeps a deleted schedule from being
// resurrected by a stale UI.
func TestTriggerCancelledRoutineIsRejected(t *testing.T) {
	router, workspace, token := schedulingTestRouter(t)
	create := gin.H{
		"network": workspace.ID, "source": "52hz:planner", "name": "Gone",
		"message": "x", "interval_minutes": 30,
	}
	response := planningRequest(t, router, http.MethodPost, "/v1/routines", token, create)
	if response.Code != http.StatusOK {
		t.Fatalf("create routine = %d, body = %s", response.Code, response.Body.String())
	}
	var routine models.RoutineRecord
	if err := json.Unmarshal(response.Body.Bytes(), &routine); err != nil {
		t.Fatalf("decode routine: %v", err)
	}
	if err := db.DB.Model(&models.RoutineRecord{}).Where("id = ?", routine.ID).Update("status", "cancelled").Error; err != nil {
		t.Fatalf("cancel routine: %v", err)
	}
	if response := planningRequest(t, router, http.MethodPost, "/v1/routines/"+routine.ID+"/run", token, nil); response.Code != http.StatusConflict {
		t.Fatalf("running a cancelled routine = %d, want %d", response.Code, http.StatusConflict)
	}
}

// TestRoutineRunNumbersDoNotCollide checks the atomic run counter. runID is the
// primary key of routine_runs, so a repeated number silently drops a run from
// the history.
func TestRoutineRunNumbersDoNotCollide(t *testing.T) {
	router, workspace, token := schedulingTestRouter(t)
	create := gin.H{
		"network": workspace.ID, "source": "52hz:planner", "name": "Repeat",
		"message": "x", "interval_minutes": 30,
	}
	response := planningRequest(t, router, http.MethodPost, "/v1/routines", token, create)
	if response.Code != http.StatusOK {
		t.Fatalf("create routine = %d, body = %s", response.Code, response.Body.String())
	}
	var routine models.RoutineRecord
	if err := json.Unmarshal(response.Body.Bytes(), &routine); err != nil {
		t.Fatalf("decode routine: %v", err)
	}

	// Two triggers from the same in-memory snapshot: the stale RunCount on the
	// struct is exactly the situation that produced duplicate run ids.
	stale := routine
	for i := 0; i < 3; i++ {
		snapshot := stale
		if err := ExecuteRoutineTrigger(&snapshot, true); err != nil {
			t.Fatalf("trigger %d: %v", i, err)
		}
	}

	var runs []models.RoutineRunRecord
	if err := db.DB.Where("routine_id = ?", routine.ID).Find(&runs).Error; err != nil {
		t.Fatalf("list runs: %v", err)
	}
	if len(runs) != 3 {
		t.Fatalf("expected 3 distinct runs, got %d: %+v", len(runs), runs)
	}
	numbers := map[int]bool{}
	for _, run := range runs {
		if numbers[run.RunNumber] {
			t.Fatalf("duplicate run number %d", run.RunNumber)
		}
		numbers[run.RunNumber] = true
	}
	_ = uuid.Nil
}
