package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

/*
	Delegation end to end, against a real git repository: an agent hands work
	to profiles, every lane gets a worktree and the profile's mode and model,
	the delegator is told when the batch is ready for review and again when it
	is merged, and the guardrails say no in words an agent can act on.

	Pure-Go SQLite on purpose (see build-verification notes): the CGO driver
	skips on a machine without a C compiler while the package reports "ok".
*/

type delegationFixture struct {
	r       *gin.Engine
	ws      models.Workspace
	channel models.Channel
	token   string
}

const delegationToken = "delegation-token"

func newDelegationFixture(t *testing.T, folder string, agents ...string) *delegationFixture {
	t.Helper()
	gin.SetMode(gin.TestMode)
	database, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:%s?mode=memory&cache=shared", uuid.NewString())), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.AutoMigrate(&models.Workspace{}, &models.WorkspaceMember{}, &models.Channel{}, &models.ChannelMember{},
		&models.EventRecord{}, &models.TodoRecord{}, &models.RouterConfig{}, &models.ChannelPipeline{},
		&models.ParallelBatchRecord{}, &models.ParallelLaneRecord{}, &models.WorkProfile{}, &models.AgentTurnState{}); err != nil {
		t.Fatal(err)
	}
	db.DB = database
	config.GlobalConfig = &config.Config{AgentTimeoutSeconds: 60}

	hash := hashWorkspaceToken(delegationToken)
	ws := models.Workspace{ID: uuid.NewString(), Name: "delegation", Slug: uuid.NewString(), PasswordHash: &hash, Status: "active"}
	if err := db.DB.Create(&ws).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(GetAgentWorktreeRoot(ws.ID)) })
	ch := models.Channel{ID: uuid.NewString(), WorkspaceID: ws.ID, Name: "general", Status: "active"}
	if folder != "" {
		ch.WorkingDir = &folder
	}
	if err := db.DB.Create(&ch).Error; err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for _, name := range agents {
		if err := db.DB.Create(&models.WorkspaceMember{WorkspaceID: ws.ID, AgentName: name, Status: "online", LastHeartbeat: &now}).Error; err != nil {
			t.Fatal(err)
		}
		_ = db.DB.Create(&models.ChannelMember{ChannelID: ch.ID, AgentName: name}).Error
	}

	r := gin.New()
	r.POST("/v1/workspaces/:workspace_id/delegations", DelegateTasks)
	r.GET("/v1/workspaces/:workspace_id/delegations/:batch_id", GetDelegation)
	r.POST("/v1/workspaces/:workspace_id/delegations/:batch_id/cancel", CancelDelegation)
	r.GET("/v1/workspaces/:workspace_id/profiles", ListWorkProfiles)
	r.POST("/v1/workspaces/:workspace_id/profiles", CreateWorkProfile)
	r.PATCH("/v1/workspaces/:workspace_id/profiles/:profile_id", UpdateWorkProfile)
	r.DELETE("/v1/workspaces/:workspace_id/profiles/:profile_id", DeleteWorkProfile)
	return &delegationFixture{r: r, ws: ws, channel: ch, token: delegationToken}
}

func (f *delegationFixture) do(t *testing.T, method, path string, body interface{}) (int, map[string]interface{}) {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		reader = bytes.NewReader(b)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, "/v1/workspaces/"+f.ws.ID+path, reader)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Workspace-Token", f.token)
	w := httptest.NewRecorder()
	f.r.ServeHTTP(w, req)
	out := map[string]interface{}{}
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func (f *delegationFixture) profile(t *testing.T, name, agent, mode, model, when string) {
	t.Helper()
	code, out := f.do(t, http.MethodPost, "/profiles", map[string]string{"name": name, "agent": agent, "mode": mode, "model": model, "when_to_use": when})
	if code != http.StatusOK {
		t.Fatalf("create profile %s: %d %v", name, code, out)
	}
}

func (f *delegationFixture) delegate(t *testing.T, from string, tasks ...map[string]string) (int, map[string]interface{}) {
	t.Helper()
	return f.do(t, http.MethodPost, "/delegations", map[string]interface{}{"channel": f.channel.Name, "source": "52hz:" + from, "tasks": tasks})
}

func errText(out map[string]interface{}) string {
	s, _ := out["error"].(string)
	return s
}

// lastMessage is the newest chat message posted into the fixture's channel.
func lastMessage(t *testing.T, f *delegationFixture) (string, map[string]interface{}) {
	t.Helper()
	var ev models.EventRecord
	if db.DB.Where("network_id = ? AND type = ? AND target = ?", f.ws.ID, "workspace.message.posted", "channel/"+f.channel.Name).
		Order("timestamp DESC, rowid DESC").Limit(1).Find(&ev).RowsAffected == 0 {
		t.Fatal("no message in the channel")
	}
	var payload, meta map[string]interface{}
	_ = json.Unmarshal(ev.Payload, &payload)
	_ = json.Unmarshal(ev.Metadata, &meta)
	content, _ := payload["content"].(string)
	return content, meta
}

func targetsOf(meta map[string]interface{}) []string {
	raw, _ := meta["target_agents"].([]interface{})
	out := []string{}
	for _, v := range raw {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

func batchOf(t *testing.T, id string) (models.ParallelBatchRecord, map[string]models.ParallelLaneRecord) {
	t.Helper()
	var b models.ParallelBatchRecord
	if err := db.DB.Where("id = ?", id).First(&b).Error; err != nil {
		t.Fatal(err)
	}
	return b, lanesOf(id)
}

func batchIDOf(out map[string]interface{}) string {
	batch, _ := out["batch"].(map[string]interface{})
	id, _ := batch["id"].(string)
	return id
}

func TestDelegateGivesEachProfileItsOwnWorktreeModeAndModel(t *testing.T) {
	repo := newRepo(t)
	f := newDelegationFixture(t, repo, "alice", "bob", "carol")
	f.profile(t, "reviewer", "carol", "plan", "strong-model", "careful read-only review")

	code, out := f.delegate(t, "alice",
		map[string]string{"profile": "reviewer", "task": "review the parser"},
		map[string]string{"agent": "bob", "task": "fix the parser"})
	if code != http.StatusOK {
		t.Fatalf("delegate: %d %v", code, out)
	}
	batch, lanes := batchOf(t, batchIDOf(out))
	if batch.Origin != "agent" || batch.DelegatedBy != "alice" || batch.Isolation != "worktree" || batch.Status != batchRunning {
		t.Fatalf("batch = %+v", batch)
	}
	carol, bob := lanes["carol"], lanes["bob"]
	if carol.Profile != "reviewer" || carol.Mode != "plan" || carol.Model != "strong-model" {
		t.Fatalf("the profile's mode/model must be on the lane: %+v", carol)
	}
	if bob.Profile != "" || bob.Mode != "execute" || bob.Model != "" {
		t.Fatalf("an agent named directly runs in Fix with its own model: %+v", bob)
	}
	for _, l := range []models.ParallelLaneRecord{carol, bob} {
		if _, err := os.Stat(l.WorktreePath); err != nil || l.Branch == "" {
			t.Fatalf("lane %s has no worktree: %+v", l.Agent, l)
		}
	}

	// The dispatch wakes exactly the lanes and carries each lane's mode/model.
	content, meta := lastMessage(t, f)
	if got := targetsOf(meta); len(got) != 2 {
		t.Fatalf("dispatch targets = %v", got)
	}
	if !strings.Contains(content, "@alice delegated 2 tasks") || !strings.Contains(content, "profile `reviewer`") {
		t.Fatalf("dispatch text = %q", content)
	}
	pb, _ := meta["parallel_batch"].(map[string]interface{})
	if pb["delegated_by"] != "alice" {
		t.Fatalf("lanes must learn who delegated: %v", pb)
	}
	laneMeta, _ := pb["lanes"].(map[string]interface{})
	carolMeta, _ := laneMeta["carol"].(map[string]interface{})
	if carolMeta["mode"] != "plan" || carolMeta["model"] != "strong-model" || carolMeta["working_dir"] != carol.WorktreePath {
		t.Fatalf("carol's dispatch = %v", carolMeta)
	}
}

func TestDelegateAllowsASingleLane(t *testing.T) {
	repo := newRepo(t)
	f := newDelegationFixture(t, repo, "alice", "bob")
	code, out := f.delegate(t, "alice", map[string]string{"agent": "bob", "task": "review it", "mode": "plan"})
	if code != http.StatusOK {
		t.Fatalf("one isolated lane is the common case: %d %v", code, out)
	}
	_, lanes := batchOf(t, batchIDOf(out))
	if len(lanes) != 1 || lanes["bob"].Mode != "plan" {
		t.Fatalf("lanes = %+v", lanes)
	}
}

func TestDelegateRefusesWithReasonsAnAgentCanActOn(t *testing.T) {
	repo := newRepo(t)
	f := newDelegationFixture(t, repo, "alice", "bob", "carol", "dave", "erin", "frank")
	f.profile(t, "reviewer", "carol", "plan", "", "")
	old := time.Now().Add(-time.Hour)
	db.DB.Model(&models.WorkspaceMember{}).Where("agent_name = ?", "frank").Update("last_heartbeat", old)

	t5 := []map[string]string{}
	for _, a := range []string{"bob", "carol", "dave", "erin", "alice"} {
		t5 = append(t5, map[string]string{"agent": a, "task": "x"})
	}
	cases := []struct {
		name  string
		tasks []map[string]string
		code  int
		want  string
	}{
		{"too many lanes", t5, 400, "at most 4"},
		{"same agent twice", []map[string]string{{"agent": "bob", "task": "a"}, {"agent": "bob", "task": "b"}}, 400, "both go to @bob"},
		{"unknown profile", []map[string]string{{"profile": "nope", "task": "a"}}, 400, "saved profiles: reviewer"},
		{"unknown agent", []map[string]string{{"agent": "zed", "task": "a"}}, 400, "no agent @zed"},
		{"profile and agent", []map[string]string{{"profile": "reviewer", "agent": "bob", "task": "a"}}, 400, "not both"},
		{"mode against a profile", []map[string]string{{"profile": "reviewer", "mode": "execute", "task": "a"}}, 400, "mode comes from profile"},
		{"empty task", []map[string]string{{"agent": "bob", "task": "  "}}, 400, "empty"},
		{"offline agent", []map[string]string{{"agent": "frank", "task": "a"}}, 409, "@frank is offline"},
	}
	for _, tc := range cases {
		code, out := f.delegate(t, "alice", tc.tasks...)
		if code != tc.code || !strings.Contains(errText(out), tc.want) {
			t.Errorf("%s: got %d %q, want %d containing %q", tc.name, code, errText(out), tc.code, tc.want)
		}
	}
	var batches int64
	db.DB.Model(&models.ParallelBatchRecord{}).Count(&batches)
	if batches != 0 {
		t.Fatalf("a refused delegation must start nothing, found %d batches", batches)
	}
}

func TestOneBatchPerThreadAndLanesCannotDelegate(t *testing.T) {
	repo := newRepo(t)
	f := newDelegationFixture(t, repo, "alice", "bob", "carol")
	if code, out := f.delegate(t, "alice", map[string]string{"agent": "bob", "task": "a"}); code != 200 {
		t.Fatalf("first delegation: %d %v", code, out)
	}
	code, out := f.delegate(t, "carol", map[string]string{"agent": "alice", "task": "b"})
	if code != http.StatusConflict || !strings.Contains(errText(out), "still running") {
		t.Fatalf("second batch in the thread: %d %q", code, errText(out))
	}
	code, out = f.delegate(t, "bob", map[string]string{"agent": "carol", "task": "c"})
	if code != http.StatusConflict || !strings.Contains(errText(out), "lane cannot delegate") {
		t.Fatalf("a lane delegating: %d %q", code, errText(out))
	}
}

func TestSharedFolderNeedsDisjointScopesForEditingLanes(t *testing.T) {
	folder := t.TempDir() // not a git repository: the lanes would share it
	f := newDelegationFixture(t, folder, "alice", "bob", "carol")

	code, out := f.delegate(t, "alice",
		map[string]string{"agent": "bob", "task": "fix things"},
		map[string]string{"agent": "carol", "task": "fix other things"})
	if code != http.StatusBadRequest || !strings.Contains(errText(out), "not a git repository") {
		t.Fatalf("two unscoped editing lanes in a shared folder: %d %q", code, errText(out))
	}
	code, out = f.delegate(t, "alice",
		map[string]string{"agent": "bob", "task": "fix things"},
		map[string]string{"agent": "carol", "task": "look at things", "mode": "plan"})
	if code != http.StatusOK {
		t.Fatalf("a review lane cannot collide: %d %v", code, out)
	}
	stopBatch(&models.ParallelBatchRecord{}, "user", "") // no-op on an empty batch must not panic
	var b models.ParallelBatchRecord
	db.DB.Where("id = ?", batchIDOf(out)).First(&b)
	stopBatch(&b, "user", "")

	code, out = f.delegate(t, "alice",
		map[string]string{"agent": "bob", "task": "fix things", "scope": "api"},
		map[string]string{"agent": "carol", "task": "fix things", "scope": "web"})
	if code != http.StatusOK {
		t.Fatalf("disjoint scopes may share the folder: %d %v", code, out)
	}
}

func TestDelegatorIsToldAtReviewAndAfterMergeNotTheMaster(t *testing.T) {
	repo := newRepo(t)
	f := newDelegationFixture(t, repo, "alice", "bob", "carol", "mona")
	master := "mona"
	db.DB.Model(&models.Channel{}).Where("id = ?", f.channel.ID).Updates(map[string]interface{}{"master_agent": master, "orchestration_mode": "master"})

	_, out := f.delegate(t, "alice",
		map[string]string{"agent": "bob", "task": "write b.txt"},
		map[string]string{"agent": "carol", "task": "read only", "mode": "plan"})
	id := batchIDOf(out)
	_, lanes := batchOf(t, id)
	os.WriteFile(filepath.Join(lanes["bob"].WorktreePath, "b.txt"), []byte("b\n"), 0644)
	finish(t, id, "carol", false)
	finish(t, id, "bob", false)

	batch, _ := batchOf(t, id)
	if batch.Status != batchReview {
		t.Fatalf("a lane with changes waits for review, got %s", batch.Status)
	}
	content, meta := lastMessage(t, f)
	if got := targetsOf(meta); len(got) != 1 || got[0] != "alice" {
		t.Fatalf("the review summary must wake the delegator only, got %v", got)
	}
	if !strings.Contains(content, "@alice — this is the work you delegated") || !strings.Contains(content, "Nothing is merged") {
		t.Fatalf("review note = %q", content)
	}
	if strings.Contains(git(t, repo, "log", "--oneline", "main"), "parallel(bob)") {
		t.Fatal("nothing may reach main before the user merges")
	}

	approve(t, id)
	content, meta = lastMessage(t, f)
	if got := targetsOf(meta); len(got) != 1 || got[0] != "alice" {
		t.Fatalf("after the merge the delegator reviews, not the master: %v", got)
	}
	if !strings.Contains(content, "has finished") {
		t.Fatalf("done note = %q", content)
	}
	if _, err := os.Stat(filepath.Join(repo, "b.txt")); err != nil {
		t.Fatal("bob's change should be merged after the click")
	}
}

func TestCancelIsTheDelegatorsAndReallyStopsTheLanes(t *testing.T) {
	repo := newRepo(t)
	f := newDelegationFixture(t, repo, "alice", "bob", "carol")
	_, out := f.delegate(t, "alice",
		map[string]string{"agent": "bob", "task": "a"},
		map[string]string{"agent": "carol", "task": "b"})
	id := batchIDOf(out)

	code, res := f.do(t, http.MethodPost, "/delegations/"+id[:8]+"/cancel", map[string]string{"source": "52hz:carol"})
	if code != http.StatusForbidden || !strings.Contains(errText(res), "@alice") {
		t.Fatalf("someone else cancelling: %d %v", code, res)
	}
	before, _ := lastMessage(t, f)
	code, res = f.do(t, http.MethodPost, "/delegations/"+id[:8]+"/cancel", map[string]string{"source": "52hz:alice"})
	if code != http.StatusOK {
		t.Fatalf("delegator cancelling: %d %v", code, res)
	}
	batch, lanes := batchOf(t, id)
	if batch.Status != batchDone || lanes["bob"].Status != laneFailed || lanes["bob"].Error != "Stopped by @alice" {
		t.Fatalf("batch %s lanes %+v", batch.Status, lanes)
	}
	var controls []models.EventRecord
	db.DB.Where("type = ?", "workspace.agent.control").Find(&controls)
	stopped := map[string]bool{}
	for _, c := range controls {
		if strings.Contains(string(c.Payload), `"stop"`) {
			stopped[strings.TrimPrefix(c.Target, "openagents:")] = true
		}
	}
	if !stopped["bob"] || !stopped["carol"] || stopped["alice"] {
		t.Fatalf("every running lane gets the stop control, the caller does not: %v", stopped)
	}
	content, meta := lastMessage(t, f)
	if content == before || len(targetsOf(meta)) != 0 {
		t.Fatalf("cancelling must not wake anyone; last message %q targets %v", content, targetsOf(meta))
	}
	if code, _ := f.do(t, http.MethodPost, "/delegations/"+id+"/cancel", map[string]string{"source": "52hz:alice"}); code != http.StatusConflict {
		t.Fatalf("cancelling twice: %d", code)
	}
}

func TestStoppingKeepsFinishedWorkReviewable(t *testing.T) {
	// The Stop button used to decide review-or-done by a diffstat that only
	// review computes, so a stopped batch with finished work went straight to
	// done -- branches orphaned, nothing to merge or discard.
	repo := newRepo(t)
	f := newDelegationFixture(t, repo, "alice", "bob", "carol")
	_, out := f.delegate(t, "alice",
		map[string]string{"agent": "bob", "task": "write b.txt"},
		map[string]string{"agent": "carol", "task": "slow"})
	id := batchIDOf(out)
	_, lanes := batchOf(t, id)
	os.WriteFile(filepath.Join(lanes["bob"].WorktreePath, "b.txt"), []byte("b\n"), 0644)
	finish(t, id, "bob", false)

	batch, _ := batchOf(t, id)
	stopBatch(&batch, "user", "")
	batch, lanes = batchOf(t, id)
	if batch.Status != batchReview || lanes["bob"].Diffstat == "" || lanes["carol"].Status != laneFailed {
		t.Fatalf("stopped batch: %s, lanes %+v", batch.Status, lanes)
	}
}

func TestStatusReadsByShortID(t *testing.T) {
	repo := newRepo(t)
	f := newDelegationFixture(t, repo, "alice", "bob")
	_, out := f.delegate(t, "alice", map[string]string{"agent": "bob", "task": "a"})
	id := batchIDOf(out)
	code, res := f.do(t, http.MethodGet, "/delegations/"+id[:8], nil)
	if code != http.StatusOK || batchIDOf(res) != id {
		t.Fatalf("status by prefix: %d %v", code, res)
	}
	if code, _ := f.do(t, http.MethodGet, "/delegations/abc", nil); code != http.StatusNotFound {
		t.Fatalf("too short an id must not match everything: %d", code)
	}
}

func TestRedispatchKeepsTheLanesMode(t *testing.T) {
	repo := newRepo(t)
	f := newDelegationFixture(t, repo, "alice", "carol")
	f.profile(t, "reviewer", "carol", "plan", "strong-model", "")
	_, out := f.delegate(t, "alice", map[string]string{"profile": "reviewer", "task": "review"})
	id := batchIDOf(out)
	batch, lanes := batchOf(t, id)
	lane := lanes["carol"]
	redispatchLane(&batch, &lane, "again")
	_, meta := lastMessage(t, f)
	pb, _ := meta["parallel_batch"].(map[string]interface{})
	l, _ := pb["lanes"].(map[string]interface{})["carol"].(map[string]interface{})
	if l["mode"] != "plan" || l["model"] != "strong-model" || pb["delegated_by"] != "alice" {
		t.Fatalf("a retry must keep the profile: %v", pb)
	}
}

func TestWorkProfileCRUDValidates(t *testing.T) {
	f := newDelegationFixture(t, "", "alice", "bob")
	bad := []struct {
		body map[string]string
		want string
	}{
		{map[string]string{"name": "Has Space", "agent": "bob"}, "name must be"},
		{map[string]string{"name": "x", "agent": "zed"}, "no agent @zed"},
		{map[string]string{"name": "x", "agent": "bob", "mode": "yolo"}, "mode must be"},
		{map[string]string{"agent": "bob"}, "required"},
	}
	for _, b := range bad {
		if code, out := f.do(t, http.MethodPost, "/profiles", b.body); code != 400 || !strings.Contains(errText(out), b.want) {
			t.Errorf("%v: %d %q", b.body, code, errText(out))
		}
	}
	code, created := f.do(t, http.MethodPost, "/profiles", map[string]string{"name": "Fixer", "agent": "BOB", "when_to_use": "small edits"})
	if code != 200 || created["name"] != "fixer" || created["agent"] != "bob" || created["mode"] != "execute" {
		t.Fatalf("create: %d %v", code, created)
	}
	if code, out := f.do(t, http.MethodPost, "/profiles", map[string]string{"name": "fixer", "agent": "alice"}); code != 400 || !strings.Contains(errText(out), "already exists") {
		t.Fatalf("duplicate: %d %v", code, out)
	}
	id, _ := created["id"].(string)
	code, patched := f.do(t, http.MethodPatch, "/profiles/"+id, map[string]string{"mode": "plan"})
	if code != 200 || patched["mode"] != "plan" || patched["when_to_use"] != "small edits" {
		t.Fatalf("patch keeps what it does not name: %d %v", code, patched)
	}
	code, list := f.do(t, http.MethodGet, "/profiles", nil)
	profiles, _ := list["profiles"].([]interface{})
	status, _ := list["agent_status"].(map[string]interface{})
	if code != 200 || len(profiles) != 1 || status["bob"] != "online" {
		t.Fatalf("list: %d %v", code, list)
	}
	if code, _ := f.do(t, http.MethodDelete, "/profiles/"+id, nil); code != 200 {
		t.Fatalf("delete: %d", code)
	}
}

// agentMessage routes a chat message from an agent through the real event path.
func agentMessage(t *testing.T, f *delegationFixture, from, content string) *SendEventRequest {
	t.Helper()
	req := &SendEventRequest{
		Type: "workspace.message.posted", Source: "52hz:" + from, Target: "channel/" + f.channel.Name,
		Payload:  map[string]interface{}{"content": content, "message_type": "chat"},
		Metadata: map[string]interface{}{},
	}
	if err := materializeEvent(f.ws.ID, req, time.Now().UnixMilli()); err != nil {
		t.Fatal(err)
	}
	return req
}

func TestAgentFanOutInParallelModeStartsADelegatedBatch(t *testing.T) {
	// The live bug: an agent writing "@bob ... @carol ..." in a parallel thread
	// woke both in the shared folder, one after the other, with nothing
	// committed or reviewed.
	repo := newRepo(t)
	f := newDelegationFixture(t, repo, "alice", "bob", "carol")
	db.DB.Model(&models.Channel{}).Where("id = ?", f.channel.ID).Update("orchestration_mode", "parallel")

	req := agentMessage(t, f, "alice", "Splitting this up. @bob write api/a.txt @carol write web/b.txt")
	targets, _ := req.Metadata["target_agents"].([]string)
	if len(targets) != 2 {
		t.Fatalf("both named agents run, got %v", targets)
	}
	pb, _ := req.Metadata["parallel_batch"].(map[string]interface{})
	if pb == nil || pb["delegated_by"] != "alice" || pb["isolation"] != "worktree" {
		t.Fatalf("the hand-off must be an isolated, delegated batch: %v", pb)
	}
	batch, lanes := batchOf(t, pb["batch_id"].(string))
	if batch.Origin != "agent" || batch.DelegatedBy != "alice" {
		t.Fatalf("batch = %+v", batch)
	}
	if lanes["bob"].Task != "write api/a.txt" || lanes["carol"].Task != "write web/b.txt" {
		t.Fatalf("each lane takes its own part: bob=%q carol=%q", lanes["bob"].Task, lanes["carol"].Task)
	}

	// While it runs, another fan-out is refused visibly and wakes nobody --
	// and naming the busy lanes in passing does not wake them again.
	db.DB.Create(&models.WorkspaceMember{WorkspaceID: f.ws.ID, AgentName: "dave", Status: "online", LastHeartbeat: ptrTime(time.Now())})
	db.DB.Create(&models.WorkspaceMember{WorkspaceID: f.ws.ID, AgentName: "erin", Status: "online", LastHeartbeat: ptrTime(time.Now())})
	req = agentMessage(t, f, "alice", "@dave do x @erin do y")
	if targets, _ := req.Metadata["target_agents"].([]string); len(targets) != 0 {
		t.Fatalf("a second batch must not start: %v", targets)
	}
	content, meta := lastMessage(t, f)
	if meta["delegation_refused"] != true || !strings.Contains(content, "nothing was dispatched") {
		t.Fatalf("refusal notice = %q %v", content, meta)
	}
	req = agentMessage(t, f, "alice", "Waiting on @bob and @carol.")
	if targets, _ := req.Metadata["target_agents"].([]string); len(targets) != 0 {
		t.Fatalf("running lanes must not be woken outside their worktree: %v", targets)
	}
}

func TestAgentNamingABusyLaneInDynamicModeDoesNotWakeIt(t *testing.T) {
	repo := newRepo(t)
	f := newDelegationFixture(t, repo, "alice", "bob")
	f.delegate(t, "alice", map[string]string{"agent": "bob", "task": "a"})
	req := agentMessage(t, f, "alice", "I've asked @bob to handle it.")
	if targets, _ := req.Metadata["target_agents"].([]string); len(targets) != 0 {
		t.Fatalf("bob is in his lane; got %v", targets)
	}
}

func ptrTime(t time.Time) *time.Time { return &t }
