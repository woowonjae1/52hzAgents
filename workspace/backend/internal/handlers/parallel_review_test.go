package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

// reviewTestDB is parallelTestDB plus what reviews read: the workspace row
// (for the HTTP handlers), its members (who is online) and channel members.
func reviewTestDB(t *testing.T) string {
	t.Helper()
	ws := parallelTestDB(t)
	if err := db.DB.AutoMigrate(&models.WorkspaceMember{}, &models.ChannelMember{}); err != nil {
		t.Fatal(err)
	}
	db.DB.Create(&models.Workspace{ID: ws, Name: "review", Slug: uuid.NewString()})
	return ws
}

// addAgent registers a workspace agent; online means a fresh heartbeat.
func addAgent(ws, name, agentType string, online bool) {
	m := models.WorkspaceMember{WorkspaceID: ws, AgentName: name, AgentType: &agentType, Status: "offline"}
	if online {
		now := time.Now()
		m.Status, m.LastHeartbeat = "online", &now
	}
	db.DB.Create(&m)
}

func setReviewer(t *testing.T, batch models.ParallelBatchRecord, reviewer string) {
	t.Helper()
	if err := db.DB.Model(&models.Channel{}).Where("workspace_id = ? AND name = ?", batch.WorkspaceID, batch.ChannelName).
		Update("review_agent", reviewer).Error; err != nil {
		t.Fatal(err)
	}
}

// changeLane writes a file in the lane's worktree, as the lane's agent would.
func changeLane(t *testing.T, lane models.ParallelLaneRecord, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(lane.WorktreePath, name), []byte(body), 0644); err != nil {
		t.Fatal(err)
	}
}

func batchByID(id string) models.ParallelBatchRecord {
	var b models.ParallelBatchRecord
	db.DB.Where("id = ?", id).First(&b)
	return b
}

// messagesIn is every message posted to a channel, oldest first.
func messagesIn(channel string) []models.EventRecord {
	var rows []models.EventRecord
	db.DB.Where("target = ? AND type = ?", "channel/"+channel, "workspace.message.posted").Order("timestamp asc, id asc").Find(&rows)
	return rows
}

func contentOf(t *testing.T, ev models.EventRecord) string {
	t.Helper()
	var p map[string]interface{}
	_ = json.Unmarshal(ev.Payload, &p)
	s, _ := p["content"].(string)
	return s
}

func metaOf(t *testing.T, ev models.EventRecord) map[string]interface{} {
	t.Helper()
	m := map[string]interface{}{}
	_ = json.Unmarshal(ev.Metadata, &m)
	return m
}

func countContaining(t *testing.T, channel, needle string) int {
	n := 0
	for _, ev := range messagesIn(channel) {
		if strings.Contains(contentOf(t, ev), needle) {
			n++
		}
	}
	return n
}

// reviewedBatch runs alpha and beta to completion with changes, with gamma
// (online, another provider) as the channel's reviewer.
func reviewedBatch(t *testing.T) (string, string, models.ParallelBatchRecord) {
	t.Helper()
	ws := reviewTestDB(t)
	repo := newRepo(t)
	addAgent(ws, "alpha", "claude", true)
	addAgent(ws, "beta", "claude", true)
	addAgent(ws, "gamma", "codex", true)
	batch, lanes := startTestBatch(t, ws, repo, "alpha", "beta")
	setReviewer(t, batch, "gamma")
	changeLane(t, lanes["alpha"], "a.txt", "alpha\n")
	changeLane(t, lanes["beta"], "b.txt", "beta\n")
	finish(t, batch.ID, "alpha", false)
	finish(t, batch.ID, "beta", false)
	return ws, repo, batchByID(batch.ID)
}

func TestLaneReviewRunsInAReadOnlyCopyInItsOwnThread(t *testing.T) {
	_, _, batch := reviewedBatch(t)
	if batch.Status != batchReview {
		t.Fatalf("batch should wait in review, got %s", batch.Status)
	}
	for _, agent := range []string{"alpha", "beta"} {
		lane := lanesOf(batch.ID)[agent]
		if lane.ReviewStatus != reviewRunning || lane.Reviewer != "gamma" {
			t.Fatalf("%s: want a running review by gamma, got %q by %q (%s)", agent, lane.ReviewStatus, lane.Reviewer, lane.ReviewInfo)
		}
		if lane.ReviewedCommit == "" || lane.ReviewStartedAt == nil {
			t.Fatalf("%s: review must record the commit it reads and when it started", agent)
		}
		// The copy is a checkout of the lane's branch, not the lane's worktree.
		path := reviewCopyPath(&batch, &lane)
		if path == lane.WorktreePath {
			t.Fatal("the reviewer must not work in the lane's own worktree")
		}
		file := map[string]string{"alpha": "a.txt", "beta": "b.txt"}[agent]
		if _, err := os.Stat(filepath.Join(path, file)); err != nil {
			t.Fatalf("%s: review copy lacks the lane's change: %v", agent, err)
		}
		if head := git(t, path, "rev-parse", "HEAD"); head != lane.ReviewedCommit {
			t.Fatalf("%s: copy is at %s, want the reviewed commit %s", agent, head, lane.ReviewedCommit)
		}

		// The brief goes to the reviewer alone, in the lane's review thread,
		// read-only, carrying where to work.
		if lane.ReviewChannel != reviewThreadName(&batch, &lane) {
			t.Fatalf("%s: review thread %q", agent, lane.ReviewChannel)
		}
		var thread models.Channel
		if db.DB.Where("workspace_id = ? AND name = ?", batch.WorkspaceID, lane.ReviewChannel).First(&thread).Error != nil {
			t.Fatalf("%s: review thread was not created", agent)
		}
		msgs := messagesIn(lane.ReviewChannel)
		if len(msgs) != 1 {
			t.Fatalf("%s: want one brief in the review thread, got %d", agent, len(msgs))
		}
		meta := metaOf(t, msgs[0])
		if meta["agent_mode"] != "plan" {
			t.Fatalf("%s: review turn must be read-only, metadata %v", agent, meta)
		}
		if targets, _ := meta["target_agents"].([]interface{}); len(targets) != 1 || targets[0] != "gamma" {
			t.Fatalf("%s: brief must target only the reviewer, got %v", agent, meta["target_agents"])
		}
		pr, _ := meta["parallel_review"].(map[string]interface{})
		if pr["batch_id"] != batch.ID || pr["lane"] != agent || pr["working_dir"] != path {
			t.Fatalf("%s: parallel_review metadata %v", agent, pr)
		}
		brief := contentOf(t, msgs[0])
		for _, want := range []string{"do the " + agent + " part", file, lane.Branch, "```verdict", "Do not modify"} {
			if !strings.Contains(brief, want) {
				t.Fatalf("%s: brief lacks %q:\n%s", agent, want, brief)
			}
		}
	}
	// The main channel learns who reads what, and nothing of the review itself.
	if countContaining(t, batch.ChannelName, "@gamma** is reviewing") != 1 {
		t.Fatal("the ready-for-review message should say gamma is reviewing")
	}
}

func TestLaneReviewOffLeavesTheBatchAsBefore(t *testing.T) {
	ws := reviewTestDB(t)
	repo := newRepo(t)
	addAgent(ws, "gamma", "codex", true)
	batch, lanes := startTestBatch(t, ws, repo, "alpha", "beta")
	changeLane(t, lanes["alpha"], "a.txt", "alpha\n")
	finish(t, batch.ID, "alpha", false)
	finish(t, batch.ID, "beta", false)
	if batchByID(batch.ID).Status != batchReview {
		t.Fatal("batch should still wait for the user")
	}
	for _, l := range lanesOf(batch.ID) {
		if l.ReviewStatus != "" || l.Reviewer != "" {
			t.Fatalf("review is off, but lane %s has %q by %q", l.Agent, l.ReviewStatus, l.Reviewer)
		}
	}
}

func TestLaneReviewVerdictsAreStoredAndAnnouncedOnce(t *testing.T) {
	_, _, batch := reviewedBatch(t)
	alpha, beta := lanesOf(batch.ID)["alpha"], lanesOf(batch.ID)["beta"]

	finishLaneReview(&batch, &alpha, false, "", "Looks right.\n\n```verdict\n{\"verdict\": \"approve\"}\n```")
	if countContaining(t, batch.ChannelName, "Reviews are in") != 0 {
		t.Fatal("must not announce while beta's review is still running")
	}
	finishLaneReview(&batch, &beta, false, "", "b.txt has no test.\nAdd one.\n\n```verdict\nchanges_requested\n```")

	alpha, beta = lanesOf(batch.ID)["alpha"], lanesOf(batch.ID)["beta"]
	if alpha.ReviewStatus != reviewApproved || alpha.ReviewNotes != "Looks right." {
		t.Fatalf("alpha: %q %q", alpha.ReviewStatus, alpha.ReviewNotes)
	}
	if beta.ReviewStatus != reviewChangesRequested || beta.ReviewNotes != "b.txt has no test.\nAdd one." {
		t.Fatalf("beta: %q %q", beta.ReviewStatus, beta.ReviewNotes)
	}
	for _, l := range []models.ParallelLaneRecord{alpha, beta} {
		if _, err := os.Stat(reviewCopyPath(&batch, &l)); err == nil {
			t.Fatalf("%s: review copy should be removed once the review is in", l.Agent)
		}
		var thread models.Channel
		db.DB.Where("workspace_id = ? AND name = ?", batch.WorkspaceID, l.ReviewChannel).First(&thread)
		if thread.WorkingDir != nil {
			t.Fatalf("%s: thread still bound to the removed copy %s", l.Agent, *thread.WorkingDir)
		}
	}
	if n := countContaining(t, batch.ChannelName, "Reviews are in"); n != 1 {
		t.Fatalf("want one reviews-are-in message, got %d", n)
	}
	if countContaining(t, batch.ChannelName, "changes requested by @gamma: b.txt has no test.") != 1 {
		t.Fatal("summary should carry beta's first note")
	}
	// Merge stays the user's call: a verdict does not move the batch.
	if batchByID(batch.ID).Status != batchReview {
		t.Fatal("verdicts must not merge or finish the batch")
	}
}

func TestLaneReviewWithoutAVerdictBlockFailsAndKeepsTheReply(t *testing.T) {
	_, _, batch := reviewedBatch(t)
	alpha := lanesOf(batch.ID)["alpha"]
	finishLaneReview(&batch, &alpha, false, "", "I think it is fine.")
	alpha = lanesOf(batch.ID)["alpha"]
	if alpha.ReviewStatus != reviewFailed || alpha.ReviewNotes != "I think it is fine." || !strings.Contains(alpha.ReviewInfo, "verdict block") {
		t.Fatalf("got %q / %q / %q", alpha.ReviewStatus, alpha.ReviewNotes, alpha.ReviewInfo)
	}
	beta := lanesOf(batch.ID)["beta"]
	finishLaneReview(&batch, &beta, true, "agent crashed", "")
	if b := lanesOf(batch.ID)["beta"]; b.ReviewStatus != reviewFailed || b.ReviewInfo != "agent crashed" {
		t.Fatalf("failed turn: %q / %q", b.ReviewStatus, b.ReviewInfo)
	}
}

func TestLaneReviewerIsNeverTheAuthor(t *testing.T) {
	ws := reviewTestDB(t)
	repo := newRepo(t)
	addAgent(ws, "alpha", "claude", true)
	addAgent(ws, "beta", "codex", true)
	batch, lanes := startTestBatch(t, ws, repo, "alpha", "beta")
	setReviewer(t, batch, "alpha")
	changeLane(t, lanes["alpha"], "a.txt", "alpha\n")
	changeLane(t, lanes["beta"], "b.txt", "beta\n")
	finish(t, batch.ID, "alpha", false)
	finish(t, batch.ID, "beta", false)

	got := lanesOf(batch.ID)
	if got["beta"].Reviewer != "alpha" || got["beta"].ReviewInfo != "" {
		t.Fatalf("beta should be reviewed by the configured alpha, got %q (%s)", got["beta"].Reviewer, got["beta"].ReviewInfo)
	}
	if got["alpha"].Reviewer != "beta" || got["alpha"].ReviewInfo != "@alpha wrote this part" {
		t.Fatalf("alpha's own part should go to beta, got %q (%s)", got["alpha"].Reviewer, got["alpha"].ReviewInfo)
	}
}

func TestOfflineReviewerFallsBackToAnotherProviderOrSkips(t *testing.T) {
	ws := reviewTestDB(t)
	addAgent(ws, "claude", "claude", true)
	addAgent(ws, "claude2", "claude", true)
	addAgent(ws, "pi", "pi", true)
	addAgent(ws, "codex", "codex", false)

	choice, ok := resolveReviewer(ws, "codex", "claude")
	if !ok || choice.Agent != "pi" || choice.Info != "@codex is offline" {
		t.Fatalf("want pi (another provider than the author), got %+v ok=%v", choice, ok)
	}
	choice, ok = resolveReviewer(ws, "nobody", "claude")
	if !ok || choice.Info != "@nobody is not in this workspace" {
		t.Fatalf("unknown reviewer: %+v ok=%v", choice, ok)
	}

	lonely := reviewTestDB(t)
	addAgent(lonely, "claude", "claude", true)
	addAgent(lonely, "codex", "codex", false)
	choice, ok = resolveReviewer(lonely, "codex", "claude")
	if ok || !strings.Contains(choice.Info, "no other agent is online") {
		t.Fatalf("nobody can review: want skip, got %+v ok=%v", choice, ok)
	}
}

func TestLaneReviewSkippedWhenNobodyCanReview(t *testing.T) {
	ws := reviewTestDB(t)
	repo := newRepo(t)
	addAgent(ws, "alpha", "claude", true)
	batch, lanes := startTestBatch(t, ws, repo, "alpha", "beta")
	setReviewer(t, batch, "beta") // beta is not online (not even a member)
	changeLane(t, lanes["beta"], "b.txt", "beta\n")
	finish(t, batch.ID, "alpha", false)
	finish(t, batch.ID, "beta", false)

	beta := lanesOf(batch.ID)["beta"]
	// beta wrote it; alpha is the only one online and may review it.
	if beta.Reviewer != "alpha" {
		t.Fatalf("beta's part should fall back to alpha, got %q (%s)", beta.Reviewer, beta.ReviewInfo)
	}
	if a := lanesOf(batch.ID)["alpha"]; a.ReviewStatus != "" {
		t.Fatalf("alpha changed nothing and must not be reviewed, got %q", a.ReviewStatus)
	}

	// Now alpha goes offline too: a retry finds nobody and says why.
	db.DB.Model(&models.WorkspaceMember{}).Where("workspace_id = ?", ws).Update("status", "offline")
	b := batchByID(batch.ID)
	cancelLaneReviews(&b, "test")
	beta = lanesOf(batch.ID)["beta"]
	line := startLaneReview(&b, &beta, "beta")
	beta = lanesOf(batch.ID)["beta"]
	if beta.ReviewStatus != reviewSkipped || !strings.Contains(beta.ReviewInfo, "no other agent is online") || !strings.Contains(line, "review skipped") {
		t.Fatalf("want a skip with its reason, got %q (%s) / %s", beta.ReviewStatus, beta.ReviewInfo, line)
	}
}

func TestSendBackReReviewsOnlyThatLaneAgainstTheOldNotes(t *testing.T) {
	_, _, batch := reviewedBatch(t)
	alpha, beta := lanesOf(batch.ID)["alpha"], lanesOf(batch.ID)["beta"]
	finishLaneReview(&batch, &alpha, false, "", "```verdict\napprove\n```")
	finishLaneReview(&batch, &beta, false, "", "Rename b.txt to c.txt.\n```verdict\nchanges_requested\n```")
	approvedAt := lanesOf(batch.ID)["alpha"].ReviewedCommit

	r := reviewRouter()
	w := postJSON(r, "/v1/workspaces/"+batch.WorkspaceID+"/parallel-batches/"+batch.ID+"/lanes/beta/send-back", "")
	if w.Code != 200 {
		t.Fatalf("send-back: %d %s", w.Code, w.Body.String())
	}
	beta = lanesOf(batch.ID)["beta"]
	if beta.Status != laneRunning || batchByID(batch.ID).Status != batchRunning {
		t.Fatalf("lane should run again: lane %s batch %s", beta.Status, batchByID(batch.ID).Status)
	}
	assertRedispatchedInWorktree(t, batch.ChannelName, beta, "Rename b.txt to c.txt.")

	// beta does the work and finishes: only beta is reviewed again, against
	// what was asked; alpha keeps its verdict.
	changeLane(t, beta, "c.txt", "beta\n")
	finish(t, batch.ID, "beta", false)
	got := lanesOf(batch.ID)
	if got["beta"].ReviewStatus != reviewRunning || got["beta"].ReviewedCommit == beta.ReviewedCommit {
		t.Fatalf("beta should be re-reviewed at its new head, got %q at %s", got["beta"].ReviewStatus, got["beta"].ReviewedCommit)
	}
	if got["alpha"].ReviewStatus != reviewApproved || got["alpha"].ReviewedCommit != approvedAt {
		t.Fatalf("alpha's verdict must stand, got %q", got["alpha"].ReviewStatus)
	}
	msgs := messagesIn(got["beta"].ReviewChannel)
	if len(msgs) != 2 || !strings.Contains(contentOf(t, msgs[1]), "re-review") || !strings.Contains(contentOf(t, msgs[1]), "Rename b.txt to c.txt.") {
		t.Fatalf("re-review brief should quote the previous notes; thread has %d messages", len(msgs))
	}
}

func TestSendBackNeedsReviewNotes(t *testing.T) {
	_, _, batch := reviewedBatch(t)
	r := reviewRouter()
	// Review still running: no notes yet.
	if w := postJSON(r, "/v1/workspaces/"+batch.WorkspaceID+"/parallel-batches/"+batch.ID+"/lanes/alpha/send-back", ""); w.Code != 409 {
		t.Fatalf("want 409 while the review runs, got %d", w.Code)
	}
}

func TestLaneReviewTimesOutAndALateReportIsIgnored(t *testing.T) {
	_, _, batch := reviewedBatch(t)
	past := time.Now().UTC().Add(-ParallelReviewTimeout() - time.Minute)
	db.DB.Model(&models.ParallelLaneRecord{}).Where("batch_id = ?", batch.ID).Update("review_started_at", past)

	ExpireStaleParallelLanes()

	for _, l := range lanesOf(batch.ID) {
		if l.ReviewStatus != reviewTimedOut {
			t.Fatalf("%s: want timed_out, got %q", l.Agent, l.ReviewStatus)
		}
		if _, err := os.Stat(reviewCopyPath(&batch, &l)); err == nil {
			t.Fatalf("%s: copy should be removed on time-out", l.Agent)
		}
	}
	var stops int64
	db.DB.Model(&models.EventRecord{}).Where("type = ? AND target = ?", "workspace.agent.control", "openagents:gamma").Count(&stops)
	if stops != 2 {
		t.Fatalf("the reviewer should be told to stop each review, got %d stop events", stops)
	}
	// One summary once both are over, naming each lane.
	if countContaining(t, batch.ChannelName, "gave no verdict in time") != 1 ||
		countContaining(t, batch.ChannelName, "**@alpha**'s part — @gamma gave no verdict in time") != 1 ||
		countContaining(t, batch.ChannelName, "**@beta**'s part — @gamma gave no verdict in time") != 1 {
		t.Fatal("the time-outs should be announced in one summary")
	}

	// The reviewer's turn ends later and reports: nothing changes.
	w := postJSON(reviewRouter(), "/v1/workspaces/"+batch.WorkspaceID+"/parallel-batches/"+batch.ID+"/lanes/alpha/review/complete",
		`{"reviewer":"gamma","status":"done","reply":"`+"```verdict\\napprove\\n```"+`"}`)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "ignored") {
		t.Fatalf("late report: %d %s", w.Code, w.Body.String())
	}
	if lanesOf(batch.ID)["alpha"].ReviewStatus != reviewTimedOut {
		t.Fatal("a late report must not overwrite the time-out")
	}

	// Retry runs it again.
	w = postJSON(reviewRouter(), "/v1/workspaces/"+batch.WorkspaceID+"/parallel-batches/"+batch.ID+"/lanes/alpha/review", "")
	if w.Code != 200 || lanesOf(batch.ID)["alpha"].ReviewStatus != reviewRunning {
		t.Fatalf("retry: %d %s", w.Code, w.Body.String())
	}
}

func TestCompleteLaneReviewOverHTTP(t *testing.T) {
	_, _, batch := reviewedBatch(t)
	r := reviewRouter()
	url := "/v1/workspaces/" + batch.WorkspaceID + "/parallel-batches/" + batch.ID + "/lanes/alpha/review/complete"
	if w := postJSON(r, url, `{"reviewer":"someone-else","status":"done","reply":"x"}`); !strings.Contains(w.Body.String(), "ignored") {
		t.Fatalf("a report from another agent must be ignored: %s", w.Body.String())
	}
	w := postJSON(r, url, `{"reviewer":"52hz:gamma","status":"done","reply":"ok\n`+"```verdict\\n{\\\"verdict\\\":\\\"approve\\\"}\\n```"+`"}`)
	if w.Code != 200 || lanesOf(batch.ID)["alpha"].ReviewStatus != reviewApproved {
		t.Fatalf("complete: %d %s / %q", w.Code, w.Body.String(), lanesOf(batch.ID)["alpha"].ReviewStatus)
	}
}

func TestMergeWithoutWaitingCancelsRunningReviews(t *testing.T) {
	_, repo, batch := reviewedBatch(t)
	paths := []string{}
	for _, l := range lanesOf(batch.ID) {
		paths = append(paths, reviewCopyPath(&batch, &l))
	}
	w := postJSON(reviewRouter(), "/v1/workspaces/"+batch.WorkspaceID+"/parallel-batches/"+batch.ID+"/merge", "")
	if w.Code != 200 {
		t.Fatalf("merge: %d %s", w.Code, w.Body.String())
	}
	for _, l := range lanesOf(batch.ID) {
		if l.Status != laneMerged || l.ReviewStatus != reviewCancelled {
			t.Fatalf("%s: want merged with its review cancelled, got %s / %q", l.Agent, l.Status, l.ReviewStatus)
		}
	}
	for _, p := range paths {
		if _, err := os.Stat(p); err == nil {
			t.Fatalf("review copy %s left behind", p)
		}
	}
	if !strings.Contains(git(t, repo, "log", "--oneline"), "parallel(alpha)") {
		t.Fatal("alpha's work should be merged")
	}
	if countContaining(t, batch.ChannelName, "Reviews are in") != 0 {
		t.Fatal("cancelled reviews must not be announced")
	}
}

func TestReviewThreadAgentMessagesAreNotRouted(t *testing.T) {
	thread := &models.Channel{Name: "review:abcd1234:alpha"}
	agentMsg := &SendEventRequest{Source: "agent:gamma", Metadata: map[string]interface{}{}}
	silenceReviewThreadAgent(thread, agentMsg)
	if targets, ok := agentMsg.Metadata["target_agents"].([]string); !ok || len(targets) != 0 {
		t.Fatalf("agent message in a review thread should get an empty target list, got %v", agentMsg.Metadata["target_agents"])
	}
	human := &SendEventRequest{Source: "human:me", Metadata: map[string]interface{}{}}
	silenceReviewThreadAgent(thread, human)
	if _, set := human.Metadata["target_agents"]; set {
		t.Fatal("the user's own questions in the thread are routed normally")
	}
	elsewhere := &SendEventRequest{Source: "agent:gamma", Metadata: map[string]interface{}{}}
	silenceReviewThreadAgent(&models.Channel{Name: "general"}, elsewhere)
	if _, set := elsewhere.Metadata["target_agents"]; set {
		t.Fatal("only review threads are silenced")
	}
}

func TestParseReviewVerdict(t *testing.T) {
	cases := []struct {
		name, reply, status, notes string
		ok                         bool
	}{
		{"json approve", "All good.\n\n```verdict\n{\"verdict\": \"approve\"}\n```", reviewApproved, "All good.", true},
		{"bare word", "Missing test.\n```verdict\nchanges_requested\n```", reviewChangesRequested, "Missing test.", true},
		{"spaced word", "```verdict\nChanges Requested\n```", reviewChangesRequested, "", true},
		{"json notes", "```verdict\n{\"verdict\":\"changes_requested\",\"notes\":\"add a test\"}\n```", reviewChangesRequested, "add a test", true},
		{"last block wins", "Format:\n```verdict\napprove\n```\nActually no.\n```verdict\nchanges_requested\n```", reviewChangesRequested, "Format:\n```verdict\napprove\n```\nActually no.", true},
		{"crlf", "Fine.\r\n```verdict\r\napprove\r\n```", reviewApproved, "Fine.", true},
		{"no block", "Looks fine to me.", "", "Looks fine to me.", false},
		{"unknown word", "```verdict\nmaybe\n```", "", "```verdict\nmaybe\n```", false},
		{"bad json", "```verdict\n{\"verdict\": \n```", "", "```verdict\n{\"verdict\": \n```", false},
		{"unterminated", "```verdict\napprove", "", "```verdict\napprove", false},
	}
	for _, c := range cases {
		status, notes, ok := parseReviewVerdict(c.reply)
		if status != c.status || ok != c.ok || strings.ReplaceAll(notes, "\r", "") != c.notes {
			t.Errorf("%s: got (%q, %q, %v), want (%q, %q, %v)", c.name, status, notes, ok, c.status, c.notes, c.ok)
		}
	}
}

func reviewRouter() *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/v1/workspaces/:workspace_id/parallel-batches/:batch_id/merge", MergeParallelBatch)
	r.POST("/v1/workspaces/:workspace_id/parallel-batches/:batch_id/lanes/:agent/review", RetryLaneReview)
	r.POST("/v1/workspaces/:workspace_id/parallel-batches/:batch_id/lanes/:agent/review/complete", CompleteLaneReview)
	r.POST("/v1/workspaces/:workspace_id/parallel-batches/:batch_id/lanes/:agent/send-back", SendBackParallelLane)
	return r
}

func postJSON(r *gin.Engine, url, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}
