package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

// lifecycleTestRouter is the scheduling router plus the approval, toggle and
// turn-report endpoints, over a pure-Go SQLite database (these tests RUN; they
// do not skip for lack of cgo).
func lifecycleTestRouter(t *testing.T) (*gin.Engine, models.Workspace, string) {
	t.Helper()
	router, workspace, token := schedulingTestRouter(t)
	if err := db.DB.AutoMigrate(&models.AgentTurnState{}, &models.FileRecord{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	router.PATCH("/v1/routines/:routine_id/toggle", ToggleRoutine)
	router.POST("/v1/routines/:routine_id/approve", ApproveRoutine)
	router.POST("/v1/routines/:routine_id/reject", RejectRoutine)
	router.POST("/v1/workspaces/:workspace_id/agents/:agent_name/turn", ReportAgentTurn)
	return router, workspace, token
}

func createRoutineFor(t *testing.T, router *gin.Engine, workspace models.Workspace, token string, body gin.H) models.RoutineRecord {
	t.Helper()
	body["network"] = workspace.ID
	if _, ok := body["source"]; !ok {
		body["source"] = "52hz:planner"
	}
	if _, ok := body["message"]; !ok {
		body["message"] = "summarise commits"
	}
	response := planningRequest(t, router, http.MethodPost, "/v1/routines", token, body)
	if response.Code != http.StatusOK {
		t.Fatalf("create routine = %d, body = %s", response.Code, response.Body.String())
	}
	var routine models.RoutineRecord
	if err := json.Unmarshal(response.Body.Bytes(), &routine); err != nil {
		t.Fatalf("decode routine: %v", err)
	}
	return routine
}

func reloadRoutine(t *testing.T, id string) models.RoutineRecord {
	t.Helper()
	var r models.RoutineRecord
	if err := db.DB.Where("id = ?", id).First(&r).Error; err != nil {
		t.Fatalf("reload routine: %v", err)
	}
	return r
}

func reloadRun(t *testing.T, id string) models.RoutineRunRecord {
	t.Helper()
	var r models.RoutineRunRecord
	if err := db.DB.Where("id = ?", id).First(&r).Error; err != nil {
		t.Fatalf("reload run: %v", err)
	}
	return r
}

// fireOnce triggers the routine and returns the run it opened.
func fireOnce(t *testing.T, routineID string) models.RoutineRunRecord {
	t.Helper()
	r := reloadRoutine(t, routineID)
	if err := ExecuteRoutineTrigger(&r, true); err != nil {
		t.Fatalf("trigger: %v", err)
	}
	fresh := reloadRoutine(t, routineID)
	if fresh.LastRunID == nil {
		t.Fatal("trigger recorded no run id")
	}
	return reloadRun(t, *fresh.LastRunID)
}

// postAgentEvent stores a message event from the agent into a channel.
func postAgentEvent(t *testing.T, workspaceID, channel, source, messageType, content string) string {
	t.Helper()
	payload, _ := json.Marshal(map[string]interface{}{"content": content, "message_type": messageType})
	id := uuid.NewString()
	if err := db.DB.Create(&models.EventRecord{
		ID: id, NetworkID: workspaceID, Type: "workspace.message.posted", Source: source,
		Target: "channel/" + channel, Payload: payload, Metadata: []byte("{}"),
		Timestamp: time.Now().UnixMilli(), Visibility: "channel",
	}).Error; err != nil {
		t.Fatalf("store event: %v", err)
	}
	return id
}

func reportTurn(t *testing.T, router *gin.Engine, workspace models.Workspace, token, agent, channel, state, errText string) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"channel": channel, "state": state, "error": errText})
	req := httptest.NewRequest(http.MethodPost, "/v1/workspaces/"+workspace.ID+"/agents/"+agent+"/turn", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Workspace-Token", token)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("report turn %s = %d %s", state, w.Code, w.Body.String())
	}
}

// TestAgentCreatedRoutineIsAProposal: a routine an agent creates waits for a
// person, is announced in the agent's channel with no one targeted, and cannot
// be run, paused or resumed until it is decided.
func TestAgentCreatedRoutineIsAProposal(t *testing.T) {
	router, workspace, token := lifecycleTestRouter(t)
	if err := db.DB.Create(&models.Channel{ID: uuid.NewString(), WorkspaceID: workspace.ID, Name: "general", Status: "active"}).Error; err != nil {
		t.Fatalf("create channel: %v", err)
	}

	routine := createRoutineFor(t, router, workspace, token, gin.H{
		"name": "Daily Git Commit Summary", "interval_minutes": 30, "channel": "channel/general",
	})
	if routine.Status != RoutineStatusPendingApproval {
		t.Fatalf("agent-created status = %q, want pending_approval", routine.Status)
	}

	var events []models.EventRecord
	db.DB.Where("network_id = ? AND source = ? AND target = ?", workspace.ID, "system:routine", "channel/general").Find(&events)
	if len(events) != 1 {
		t.Fatalf("proposal messages in the agent's channel = %d, want 1", len(events))
	}
	var payload map[string]interface{}
	var meta map[string]interface{}
	_ = json.Unmarshal(events[0].Payload, &payload)
	_ = json.Unmarshal(events[0].Metadata, &meta)
	proposal, ok := meta["routine_proposal"].(map[string]interface{})
	if !ok {
		t.Fatalf("proposal metadata missing: %s", string(events[0].Metadata))
	}
	if proposal["routine_id"] != routine.ID || proposal["short_id"] != routine.ShortID ||
		proposal["name"] != "Daily Git Commit Summary" || proposal["schedule_text"] != "every 30 min" || proposal["created_by"] != "planner" {
		t.Fatalf("proposal metadata = %+v", proposal)
	}
	if _, targeted := meta["target_agents"]; targeted {
		t.Fatalf("proposal must not target agents: %+v", meta)
	}
	if content, _ := payload["content"].(string); strings.Contains(content, "@") {
		t.Fatalf("proposal text would wake an agent through an @mention: %q", content)
	}

	if response := planningRequest(t, router, http.MethodPost, "/v1/routines/"+routine.ID+"/run", token, nil); response.Code != http.StatusConflict {
		t.Fatalf("run pending routine = %d, want 409", response.Code)
	}
	if response := planningRequest(t, router, http.MethodPatch, "/v1/routines/"+routine.ID+"/toggle", token, nil); response.Code != http.StatusConflict {
		t.Fatalf("toggle pending routine = %d, want 409", response.Code)
	}
	var runs int64
	db.DB.Model(&models.RoutineRunRecord{}).Where("routine_id = ?", routine.ID).Count(&runs)
	if runs != 0 {
		t.Fatalf("pending routine produced %d runs", runs)
	}

	// Without a known channel the proposal lands in the routine's own channel.
	other := createRoutineFor(t, router, workspace, token, gin.H{"name": "Weekly", "hour": 9, "minute": 0, "days": []int{0}})
	var inOwn int64
	db.DB.Model(&models.EventRecord{}).Where("source = ? AND target = ?", "system:routine", "channel/"+other.ChannelName).Count(&inOwn)
	if inOwn != 1 {
		t.Fatalf("fallback proposal messages = %d, want 1", inOwn)
	}

	// A person creating a routine is not asked.
	human := createRoutineFor(t, router, workspace, token, gin.H{"name": "Mine", "interval_minutes": 60, "requested_by": "human:user"})
	if human.Status != RoutineStatusActive {
		t.Fatalf("human-created status = %q, want active", human.Status)
	}
}

// TestApproveAndRejectTransitions pins the only legal moves out of
// pending_approval and the 409 for everything else.
func TestApproveAndRejectTransitions(t *testing.T) {
	router, workspace, token := lifecycleTestRouter(t)
	routine := createRoutineFor(t, router, workspace, token, gin.H{"name": "Proposal", "interval_minutes": 30})

	response := planningRequest(t, router, http.MethodPost, "/v1/routines/"+routine.ID+"/approve", token, nil)
	if response.Code != http.StatusOK {
		t.Fatalf("approve = %d %s", response.Code, response.Body.String())
	}
	approved := reloadRoutine(t, routine.ID)
	if approved.Status != RoutineStatusActive || !approved.NextFiresAt.After(time.Now()) {
		t.Fatalf("approved routine = %+v", approved)
	}
	for _, action := range []string{"approve", "reject"} {
		if response := planningRequest(t, router, http.MethodPost, "/v1/routines/"+routine.ID+"/"+action, token, nil); response.Code != http.StatusConflict {
			t.Fatalf("%s an active routine = %d, want 409", action, response.Code)
		}
	}
	// Once approved it runs like any other.
	if response := planningRequest(t, router, http.MethodPost, "/v1/routines/"+routine.ID+"/run", token, nil); response.Code != http.StatusOK {
		t.Fatalf("run approved routine = %d %s", response.Code, response.Body.String())
	}

	second := createRoutineFor(t, router, workspace, token, gin.H{"name": "Rejected", "interval_minutes": 30})
	if response := planningRequest(t, router, http.MethodPost, "/v1/routines/"+second.ID+"/reject", token, nil); response.Code != http.StatusOK {
		t.Fatalf("reject = %d %s", response.Code, response.Body.String())
	}
	if got := reloadRoutine(t, second.ID).Status; got != RoutineStatusCancelled {
		t.Fatalf("rejected status = %q, want cancelled", got)
	}
	if response := planningRequest(t, router, http.MethodPost, "/v1/routines/"+second.ID+"/approve", token, nil); response.Code != http.StatusConflict {
		t.Fatalf("approve a rejected routine = %d, want 409", response.Code)
	}
	if response := planningRequest(t, router, http.MethodPost, "/v1/routines/"+uuid.NewString()+"/approve", token, nil); response.Code != http.StatusNotFound {
		t.Fatalf("approve unknown routine = %d, want 404", response.Code)
	}
}

// TestAgentRoutineMinimumInterval: agents may not schedule tighter than every
// 15 minutes; people keep the old floor.
func TestAgentRoutineMinimumInterval(t *testing.T) {
	router, workspace, token := lifecycleTestRouter(t)
	response := planningRequest(t, router, http.MethodPost, "/v1/routines", token, gin.H{
		"network": workspace.ID, "source": "52hz:planner", "name": "Too often", "message": "x", "interval_minutes": 5,
	})
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "at least 15") {
		t.Fatalf("agent 5-minute routine = %d %s, want 400 naming the 15-minute floor", response.Code, response.Body.String())
	}
	createRoutineFor(t, router, workspace, token, gin.H{"name": "Quarter hour", "interval_minutes": 15})
	human := createRoutineFor(t, router, workspace, token, gin.H{"name": "Mine", "interval_minutes": 5, "requested_by": "human:user"})
	if human.Status != RoutineStatusActive {
		t.Fatalf("human 5-minute routine status = %q", human.Status)
	}
}

// TestRoutineAutoPausesAfterThreeFailures: three failures in a row pause the
// routine with a reason and a channel note; a success resets the streak; a
// user stop does not count; resuming clears the reason.
func TestRoutineAutoPausesAfterThreeFailures(t *testing.T) {
	router, workspace, token := lifecycleTestRouter(t)
	routine := createRoutineFor(t, router, workspace, token, gin.H{"name": "Flaky", "interval_minutes": 30, "requested_by": "human:user"})

	// fail, fail, success, fail, fail -> still active (streak reset by the success)
	for i, ok := range []bool{false, false, true, false, false} {
		run := fireOnce(t, routine.ID)
		if ok {
			if !CompleteRoutineRun(run, "52hz:planner", "test") {
				t.Fatalf("step %d: complete returned false", i)
			}
			if got := reloadRoutine(t, routine.ID).ConsecutiveFailures; got != 0 {
				t.Fatalf("success did not reset the streak: %d", got)
			}
			continue
		}
		if !FailRoutineRun(run, "Agent planner was offline or exited", "system:routine", true) {
			t.Fatalf("step %d: fail returned false", i)
		}
	}
	if r := reloadRoutine(t, routine.ID); r.Status != RoutineStatusActive || r.ConsecutiveFailures != 2 {
		t.Fatalf("after reset + 2 failures: status %q streak %d, want active/2", r.Status, r.ConsecutiveFailures)
	}

	// A user stop in between is not a failure of the routine.
	fireOnce(t, routine.ID)
	StopActiveRoutineRunsAndTasks(workspace.ID, "planner", routine.ChannelName)
	if r := reloadRoutine(t, routine.ID); r.Status != RoutineStatusActive || r.ConsecutiveFailures != 2 {
		t.Fatalf("user stop counted as a failure: status %q streak %d", r.Status, r.ConsecutiveFailures)
	}

	// The third real failure in a row pauses it.
	FailRoutineRun(fireOnce(t, routine.ID), "Agent planner crashed", "system:routine", true)
	paused := reloadRoutine(t, routine.ID)
	if paused.Status != RoutineStatusPaused || paused.PausedReason == nil || *paused.PausedReason != "Paused after 3 failed runs in a row" {
		t.Fatalf("after 3 failures: %+v", paused)
	}
	var notes []models.EventRecord
	db.DB.Where("source = ? AND target = ?", "system:routine", "channel/"+routine.ChannelName).Find(&notes)
	found := false
	for _, e := range notes {
		var meta map[string]interface{}
		_ = json.Unmarshal(e.Metadata, &meta)
		if _, ok := meta["routine_paused"]; ok {
			found = true
			if _, targeted := meta["target_agents"]; targeted {
				t.Fatalf("pause note targets agents: %+v", meta)
			}
		}
	}
	if !found {
		t.Fatal("no routine_paused channel message was posted")
	}

	// Resuming clears the reason and the streak.
	if response := planningRequest(t, router, http.MethodPatch, "/v1/routines/"+routine.ID+"/toggle", token, nil); response.Code != http.StatusOK {
		t.Fatalf("resume = %d %s", response.Code, response.Body.String())
	}
	resumed := reloadRoutine(t, routine.ID)
	if resumed.Status != RoutineStatusActive || resumed.PausedReason != nil || resumed.ConsecutiveFailures != 0 {
		t.Fatalf("resumed routine = %+v", resumed)
	}
}

// TestFireOpensNoBoardTask: a fire records a run and nothing on the board.
func TestFireOpensNoBoardTask(t *testing.T) {
	router, workspace, token := lifecycleTestRouter(t)
	routine := createRoutineFor(t, router, workspace, token, gin.H{"name": "Quiet", "interval_minutes": 30, "requested_by": "human:user"})
	for i := 0; i < 3; i++ {
		fireOnce(t, routine.ID)
	}
	var todos int64
	db.DB.Model(&models.TodoRecord{}).Where("workspace_id = ?", workspace.ID).Count(&todos)
	if todos != 0 {
		t.Fatalf("3 fires opened %d board tasks, want 0", todos)
	}
}

// TestRunCompletesAtTurnEndWithResult: for an agent that reports turns, the
// first reply does not close the run; the idle report does, and the run keeps
// the LAST reply, its message id and the files registered during it --
// including one registered just after the idle report.
func TestRunCompletesAtTurnEndWithResult(t *testing.T) {
	router, workspace, token := lifecycleTestRouter(t)
	routine := createRoutineFor(t, router, workspace, token, gin.H{"name": "Commits", "interval_minutes": 60, "requested_by": "human:user"})
	run := fireOnce(t, routine.ID)
	target := "channel/" + routine.ChannelName

	reportTurn(t, router, workspace, token, "planner", routine.ChannelName, "running", "")
	postAgentEvent(t, workspace.ID, routine.ChannelName, "52hz:planner", "chat", "On it.")
	CompleteRoutineRunIfApplicable(workspace.ID, target, "52hz:planner")
	if got := reloadRun(t, run.ID).Status; got != "running" {
		t.Fatalf("first reply closed a turn-reporting agent's run: %q", got)
	}
	postAgentEvent(t, workspace.ID, routine.ChannelName, "52hz:planner", "thinking", "reading git log")
	finalID := postAgentEvent(t, workspace.ID, routine.ChannelName, "52hz:planner", "chat", "3 commits today: a, b, c.")
	CompleteRoutineRunIfApplicable(workspace.ID, target, "52hz:planner")
	// A reply from someone else in the channel is not the result.
	postAgentEvent(t, workspace.ID, routine.ChannelName, "52hz:bystander", "chat", "not mine")
	channel := routine.ChannelName
	if err := db.DB.Create(&models.FileRecord{
		ID: uuid.NewString(), WorkspaceID: workspace.ID, Filename: "summary.md", StorageKey: "k1",
		UploadedBy: "52hz:planner", ChannelName: &channel, Status: "active", CreatedAt: time.Now(),
	}).Error; err != nil {
		t.Fatalf("store file: %v", err)
	}

	reportTurn(t, router, workspace, token, "planner", routine.ChannelName, "idle", "")
	done := reloadRun(t, run.ID)
	if done.Status != "completed" || done.CompletedAt == nil {
		t.Fatalf("idle did not complete the run: %+v", done)
	}
	if done.Result == nil || *done.Result != "3 commits today: a, b, c." {
		t.Fatalf("result = %v, want the last reply", done.Result)
	}
	if done.ResultMessageID == nil || *done.ResultMessageID != finalID {
		t.Fatalf("result_message_id = %v, want %s", done.ResultMessageID, finalID)
	}
	if done.FilesChanged == nil || *done.FilesChanged != "summary.md" {
		t.Fatalf("files_changed = %v", done.FilesChanged)
	}

	// The adapter registers touched files after reporting idle.
	late := models.FileRecord{
		ID: uuid.NewString(), WorkspaceID: workspace.ID, Filename: "notes.txt", StorageKey: "k2",
		UploadedBy: "52hz:planner", ChannelName: &channel, Status: "active", CreatedAt: time.Now(),
	}
	db.DB.Create(&late)
	NoteRoutineRunFile(workspace.ID, late.UploadedBy, late.ChannelName)
	if got := reloadRun(t, run.ID).FilesChanged; got == nil || *got != "summary.md\nnotes.txt" {
		t.Fatalf("late file not attributed: %v", got)
	}
	if r := reloadRoutine(t, routine.ID); r.LastRunStatus != "completed" {
		t.Fatalf("routine last_run_status = %q", r.LastRunStatus)
	}
}

// TestTurnEndOnlySettlesTurnsStartedAfterTheRun: the idle ending a turn that
// was already running when the routine fired belongs to that earlier turn.
func TestTurnEndOnlySettlesTurnsStartedAfterTheRun(t *testing.T) {
	router, workspace, token := lifecycleTestRouter(t)
	routine := createRoutineFor(t, router, workspace, token, gin.H{"name": "Busy", "interval_minutes": 60, "requested_by": "human:user"})

	reportTurn(t, router, workspace, token, "planner", routine.ChannelName, "running", "")
	earlier := time.Now().UTC().Add(-10 * time.Second)
	db.DB.Model(&models.AgentTurnState{}).Where("workspace_id = ? AND agent_name = ?", workspace.ID, "planner").
		Updates(map[string]interface{}{"started_at": earlier, "updated_at": earlier})
	run := fireOnce(t, routine.ID)

	reportTurn(t, router, workspace, token, "planner", routine.ChannelName, "idle", "")
	if got := reloadRun(t, run.ID).Status; got != "running" {
		t.Fatalf("the earlier turn's idle settled the run: %q", got)
	}

	// The routine's own turn failing fails the run and counts toward pausing.
	reportTurn(t, router, workspace, token, "planner", routine.ChannelName, "running", "")
	reportTurn(t, router, workspace, token, "planner", routine.ChannelName, "error", "model overloaded")
	failed := reloadRun(t, run.ID)
	if failed.Status != "failed" || failed.Error == nil || !strings.Contains(*failed.Error, "model overloaded") {
		t.Fatalf("error turn did not fail the run: %+v", failed)
	}
	if got := reloadRoutine(t, routine.ID).ConsecutiveFailures; got != 1 {
		t.Fatalf("failure streak = %d, want 1", got)
	}
}

// TestLegacyAgentCompletesOnFirstReply: an adapter that never reports turns
// keeps the old rule, and still gets its result captured.
func TestLegacyAgentCompletesOnFirstReply(t *testing.T) {
	router, workspace, token := lifecycleTestRouter(t)
	routine := createRoutineFor(t, router, workspace, token, gin.H{"name": "Legacy", "interval_minutes": 60, "requested_by": "human:user"})
	run := fireOnce(t, routine.ID)

	id := postAgentEvent(t, workspace.ID, routine.ChannelName, "openagents:planner", "chat", "done")
	CompleteRoutineRunIfApplicable(workspace.ID, "channel/"+routine.ChannelName, "openagents:planner")
	done := reloadRun(t, run.ID)
	if done.Status != "completed" || done.Result == nil || *done.Result != "done" || done.ResultMessageID == nil || *done.ResultMessageID != id {
		t.Fatalf("legacy completion = %+v", done)
	}
}

// TestRoutineScheduleText covers the phrasing the proposal card shows.
func TestRoutineScheduleText(t *testing.T) {
	i30, i60, i1440 := 30, 60, 1440
	h, m := 10, 0
	cases := []struct {
		r    models.RoutineRecord
		want string
	}{
		{models.RoutineRecord{ScheduleIntervalMinutes: &i30}, "every 30 min"},
		{models.RoutineRecord{ScheduleIntervalMinutes: &i60}, "every hour"},
		{models.RoutineRecord{ScheduleIntervalMinutes: &i1440}, "every 24 hours"},
		{models.RoutineRecord{ScheduleHour: &h, ScheduleMinute: &m, Timezone: "UTC"}, "daily at 10:00 UTC"},
		{models.RoutineRecord{ScheduleHour: &h, ScheduleMinute: &m, Timezone: "Asia/Shanghai", ScheduleDays: []byte("[0,1,2,3,4]")}, "weekdays at 10:00 (Asia/Shanghai)"},
		{models.RoutineRecord{ScheduleHour: &h, ScheduleMinute: &m, Timezone: "UTC", ScheduleDays: []byte("[2,0]")}, "Mon, Wed at 10:00 UTC"},
	}
	for _, c := range cases {
		if got := RoutineScheduleText(&c.r); got != c.want {
			t.Errorf("RoutineScheduleText = %q, want %q", got, c.want)
		}
	}
}

// The agent floor holds on edit too: created at 15 minutes, an agent must not
// PATCH itself down to 1. A person (requested_by human:) still can.
func TestAgentCannotPatchUnderTheIntervalFloor(t *testing.T) {
	router, workspace, token := lifecycleTestRouter(t)
	r := createRoutineFor(t, router, workspace, token, gin.H{"name": "Quarter hour", "interval_minutes": 15})
	agent := planningRequest(t, router, http.MethodPatch, "/v1/routines/"+r.ID, token, gin.H{"interval_minutes": 1})
	if agent.Code != http.StatusBadRequest || !strings.Contains(agent.Body.String(), "at least 15") {
		t.Fatalf("agent PATCH to 1 min = %d %s, want 400", agent.Code, agent.Body.String())
	}
	human := planningRequest(t, router, http.MethodPatch, "/v1/routines/"+r.ID, token, gin.H{"interval_minutes": 1, "requested_by": "human:user"})
	if human.Code != http.StatusOK {
		t.Fatalf("human PATCH to 1 min = %d %s, want 200", human.Code, human.Body.String())
	}
}
