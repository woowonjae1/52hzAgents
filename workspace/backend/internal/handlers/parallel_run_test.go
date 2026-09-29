package handlers

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

func parallelTestDB(t *testing.T) string {
	t.Helper()
	database, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:%s?mode=memory&cache=shared", uuid.NewString())), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := database.AutoMigrate(&models.Workspace{}, &models.Channel{}, &models.EventRecord{}, &models.TodoRecord{},
		&models.ParallelBatchRecord{}, &models.ParallelLaneRecord{}); err != nil {
		t.Fatal(err)
	}
	db.DB = database
	ws := uuid.NewString()
	t.Cleanup(func() { _ = os.RemoveAll(GetAgentWorktreeRoot(ws)) })
	return ws
}

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func newRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	dir := t.TempDir()
	git(t, dir, "init", "-q", "-b", "main")
	git(t, dir, "config", "user.email", "t@t")
	git(t, dir, "config", "user.name", "t")
	os.WriteFile(filepath.Join(dir, "shared.txt"), []byte("base\n"), 0644)
	git(t, dir, "add", "-A")
	git(t, dir, "commit", "-q", "-m", "init")
	return dir
}

func startTestBatch(t *testing.T, ws, repo string, agents ...string) (models.ParallelBatchRecord, map[string]models.ParallelLaneRecord) {
	t.Helper()
	ch := models.Channel{ID: uuid.NewString(), WorkspaceID: ws, Name: "ch-" + uuid.NewString()[:6], WorkingDir: &repo}
	db.DB.Create(&ch)
	tasks := map[string]string{}
	for _, a := range agents {
		tasks[a] = "do the " + a + " part"
	}
	meta := startParallelBatch(db.DB, ws, &ch, "mention", agents, tasks, nil)
	if meta == nil {
		t.Fatal("batch not started")
	}
	var batch models.ParallelBatchRecord
	db.DB.Where("id = ?", meta["batch_id"]).First(&batch)
	lanes := map[string]models.ParallelLaneRecord{}
	var rows []models.ParallelLaneRecord
	db.DB.Where("batch_id = ?", batch.ID).Find(&rows)
	for _, l := range rows {
		lanes[l.Agent] = l
	}
	return batch, lanes
}

func finish(t *testing.T, batchID, agent string, failed bool) {
	t.Helper()
	var batch models.ParallelBatchRecord
	db.DB.Where("id = ?", batchID).First(&batch)
	var lane models.ParallelLaneRecord
	db.DB.Where("batch_id = ? AND agent = ?", batchID, agent).First(&lane)
	finishLane(&batch, &lane, failed, "boom", agent+" finished")
}

// approve is the user pressing Merge: the batch must be waiting for review,
// and nothing may have reached the base branch before this.
func approve(t *testing.T, batchID string) {
	t.Helper()
	var batch models.ParallelBatchRecord
	db.DB.Where("id = ?", batchID).First(&batch)
	if batch.Status != batchReview && !(batch.Status == batchDone && hasKeptLanes(batch.ID)) {
		t.Fatalf("batch should wait for review before merging, got %s", batch.Status)
	}
	finalizeBatch(&batch)
}

func lanesOf(batchID string) map[string]models.ParallelLaneRecord {
	var rows []models.ParallelLaneRecord
	db.DB.Where("batch_id = ?", batchID).Find(&rows)
	m := map[string]models.ParallelLaneRecord{}
	for _, l := range rows {
		m[l.Agent] = l
	}
	return m
}

func TestParallelBatchIsolatesLanesAndMergesDisjointWork(t *testing.T) {
	ws := parallelTestDB(t)
	repo := newRepo(t)
	batch, lanes := startTestBatch(t, ws, repo, "alpha", "beta")
	if batch.Isolation != "worktree" || batch.BaseBranch != "main" {
		t.Fatalf("want worktree isolation on main, got %+v", batch)
	}
	for _, a := range []string{"alpha", "beta"} {
		l := lanes[a]
		if l.WorktreePath == "" || !strings.HasPrefix(l.Branch, "parallel/") {
			t.Fatalf("lane %s not isolated: %+v", a, l)
		}
		os.WriteFile(filepath.Join(l.WorktreePath, a+".txt"), []byte(a+"\n"), 0644)
	}
	// The worktrees really are separate: alpha's file is not in beta's tree.
	if _, err := os.Stat(filepath.Join(lanes["beta"].WorktreePath, "alpha.txt")); err == nil {
		t.Fatal("lanes share a directory")
	}

	finish(t, batch.ID, "alpha", false)
	db.DB.Where("id = ?", batch.ID).First(&batch)
	if batch.Status != batchRunning {
		t.Fatal("batch finished before every lane did")
	}
	finish(t, batch.ID, "beta", false)

	// Every lane ended, but nothing lands on main until the user says so.
	for _, f := range []string{"alpha.txt", "beta.txt"} {
		if _, err := os.Stat(filepath.Join(repo, f)); err == nil {
			t.Fatalf("%s reached the base tree before the user approved", f)
		}
	}
	approve(t, batch.ID)

	db.DB.Where("id = ?", batch.ID).First(&batch)
	if batch.Status != batchDone {
		t.Fatalf("batch not done: %s", batch.Status)
	}
	for a, l := range lanesOf(batch.ID) {
		if l.Status != laneMerged {
			t.Fatalf("lane %s = %s (%s)", a, l.Status, l.Error)
		}
		if _, err := os.Stat(l.WorktreePath); err == nil {
			t.Fatalf("merged worktree %s not removed", l.WorktreePath)
		}
	}
	for _, f := range []string{"alpha.txt", "beta.txt"} {
		if _, err := os.Stat(filepath.Join(repo, f)); err != nil {
			t.Fatalf("%s not merged into the base tree", f)
		}
	}
	if strings.Contains(git(t, repo, "branch", "--list", "parallel/*"), "parallel/") {
		t.Fatal("merged lane branches were not deleted")
	}
	var summary models.EventRecord
	if db.DB.Where("source = ? AND target = ?", "system:parallel", "channel/"+batch.ChannelName).Limit(1).Find(&summary).RowsAffected == 0 {
		t.Fatal("no summary posted to the channel")
	}
}

func TestParallelConflictingLaneKeepsItsBranch(t *testing.T) {
	ws := parallelTestDB(t)
	repo := newRepo(t)
	batch, lanes := startTestBatch(t, ws, repo, "alpha", "beta")
	os.WriteFile(filepath.Join(lanes["alpha"].WorktreePath, "shared.txt"), []byte("alpha wins\n"), 0644)
	os.WriteFile(filepath.Join(lanes["beta"].WorktreePath, "shared.txt"), []byte("beta wins\n"), 0644)
	finish(t, batch.ID, "alpha", false)
	finish(t, batch.ID, "beta", false)
	approve(t, batch.ID)

	got := lanesOf(batch.ID)
	// beta conflicted on merge and was sent straight back to resolve it, once.
	if got["alpha"].Status != laneMerged || got["beta"].Status != laneRunning || got["beta"].Attempts != 2 {
		t.Fatalf("want alpha merged, beta back to running on attempt 2; got %s / %s (attempt %d)", got["alpha"].Status, got["beta"].Status, got["beta"].Attempts)
	}
	assertRedispatchedInWorktree(t, batch.ChannelName, got["beta"], "conflicts with")
	if !strings.Contains(git(t, repo, "branch", "--list", got["beta"].Branch), got["beta"].Branch) {
		t.Fatal("conflicting branch was deleted")
	}
	// The base tree is not left mid-merge.
	if st := git(t, repo, "status", "--porcelain"); st != "" {
		t.Fatalf("base tree left dirty after an aborted merge:\n%s", st)
	}
}

func TestParallelDirtyBaseKeepsEverythingAndFailedLaneIsNotMerged(t *testing.T) {
	ws := parallelTestDB(t)
	repo := newRepo(t)
	batch, lanes := startTestBatch(t, ws, repo, "alpha", "beta")
	os.WriteFile(filepath.Join(lanes["alpha"].WorktreePath, "alpha.txt"), []byte("a\n"), 0644)
	os.WriteFile(filepath.Join(repo, "shared.txt"), []byte("user is editing\n"), 0644) // uncommitted work in the base
	finish(t, batch.ID, "alpha", false)
	finish(t, batch.ID, "beta", true)
	// The first failure goes back to beta, in its worktree, with the error.
	if l := lanesOf(batch.ID)["beta"]; l.Status != laneRunning || l.Attempts != 2 {
		t.Fatalf("failed lane should be bounced once: %s attempt %d", l.Status, l.Attempts)
	}
	assertRedispatchedInWorktree(t, batch.ChannelName, lanesOf(batch.ID)["beta"], "failed (boom)")
	finish(t, batch.ID, "beta", true) // fails again: now it is left for the user
	approve(t, batch.ID)

	got := lanesOf(batch.ID)
	if got["alpha"].Status != laneKept || got["beta"].Status != laneFailed {
		t.Fatalf("want kept / failed, got %s / %s", got["alpha"].Status, got["beta"].Status)
	}
	if b, _ := os.ReadFile(filepath.Join(repo, "shared.txt")); string(b) != "user is editing\n" {
		t.Fatal("the user's uncommitted work was touched")
	}
	if _, err := os.Stat(got["beta"].WorktreePath); err != nil {
		t.Fatal("a failed lane's worktree must stay for a retry")
	}
}

func TestParallelNonGitFolderSharesTheDirectory(t *testing.T) {
	ws := parallelTestDB(t)
	dir := t.TempDir()
	batch, lanes := startTestBatch(t, ws, dir, "alpha", "beta")
	if batch.Isolation != "shared" || lanes["alpha"].WorktreePath != "" {
		t.Fatalf("non-git folder should share: %+v", batch)
	}
	// A second batch is never started on top of a running one.
	var ch models.Channel
	db.DB.Where("name = ?", batch.ChannelName).First(&ch)
	if startParallelBatch(db.DB, ws, &ch, "mention", []string{"alpha", "beta"}, nil, nil) != nil {
		t.Fatal("started a second batch while one is running")
	}
}

func TestParallelLanesGetDistinctFreePorts(t *testing.T) {
	ws := parallelTestDB(t)
	// Occupy the port the first lane would get, as if a dev server were up.
	wouldBe := allocateLanePorts(db.DB, 1)
	if len(wouldBe) != 1 || wouldBe[0] <= laneBasePort {
		t.Fatalf("allocateLanePorts gave %v", wouldBe)
	}
	l, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", wouldBe[0]))
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()

	batch, lanes := startTestBatch(t, ws, t.TempDir(), "alpha", "beta", "gamma")
	seen := map[int]string{}
	for a, lane := range lanes {
		if lane.Port <= laneBasePort {
			t.Fatalf("lane %s has no port: %d", a, lane.Port)
		}
		if lane.Port == wouldBe[0] {
			t.Fatalf("lane %s got port %d, which is already listening", a, lane.Port)
		}
		if other, dup := seen[lane.Port]; dup {
			t.Fatalf("lanes %s and %s share port %d", a, other, lane.Port)
		}
		seen[lane.Port] = a
	}

	// The ports are in the lane view and are not handed out again while the
	// batch runs, even though nothing listens on them yet.
	view := latestBatchView(ws, batch.ChannelName)
	if view == nil || len(view.Lanes) != 3 || view.Lanes[0].Port == 0 {
		t.Fatalf("lane view missing ports: %+v", view)
	}
	for _, p := range allocateLanePorts(db.DB, 3) {
		if _, taken := seen[p]; taken {
			t.Fatalf("port %d reserved by a running batch was handed out again", p)
		}
	}
}

func TestInferScope(t *testing.T) {
	cases := map[string]string{
		"rebuild the list in workspace/frontend":                         "workspace/frontend",
		"fix workspace/backend/internal/handlers/todos.go":               "workspace/backend/internal/handlers",
		"touch workspace/frontend/a.tsx and workspace/frontend/lib/b.ts": "workspace/frontend",
		"write up docs/ for both":                                        "docs",
		"no paths here at all":                                           "",
		"see https://example.com/a/b for details":                        "",
	}
	for in, want := range cases {
		if got := inferScope(in); got != want {
			t.Errorf("inferScope(%q) = %q, want %q", in, got, want)
		}
	}
	a := models.TodoRecord{Assignee: "a", Content: "work in workspace/frontend"}
	b := models.TodoRecord{Assignee: "b", Content: "work in workspace/backend"}
	if c := detectScopeConflicts([]models.TodoRecord{a, b}); len(c) != 0 {
		t.Fatalf("inferred disjoint scopes should not conflict: %+v", c)
	}
}

func TestParallelMergesWithoutAHostGitIdentity(t *testing.T) {
	// A fresh machine has no git identity. The lane commits always named one,
	// but the --no-ff merge commit did not, so it failed with "Committer
	// identity unknown" and every lane was reported as a merge conflict.
	ws := parallelTestDB(t)
	repo := newRepo(t)
	empty := filepath.Join(t.TempDir(), "gitconfig")
	os.WriteFile(empty, nil, 0644)
	t.Setenv("GIT_CONFIG_GLOBAL", empty)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	git(t, repo, "config", "--unset", "user.email")
	git(t, repo, "config", "--unset", "user.name")
	// No guessing from the hostname either: identity must come from config.
	git(t, repo, "config", "user.useConfigOnly", "true")

	batch, lanes := startTestBatch(t, ws, repo, "alpha", "beta")
	for _, a := range []string{"alpha", "beta"} {
		os.WriteFile(filepath.Join(lanes[a].WorktreePath, a+".txt"), []byte(a+"\n"), 0644)
	}
	finish(t, batch.ID, "alpha", false)
	finish(t, batch.ID, "beta", false)
	approve(t, batch.ID)

	for a, l := range lanesOf(batch.ID) {
		if l.Status != laneMerged {
			t.Fatalf("lane %s = %s (%s)", a, l.Status, l.Error)
		}
	}
	for _, f := range []string{"alpha.txt", "beta.txt"} {
		if _, err := os.Stat(filepath.Join(repo, f)); err != nil {
			t.Fatalf("%s not merged into the base tree", f)
		}
	}
	if _, err := runGit(repo, "config", "user.email"); err == nil {
		t.Fatal("the merge must not write an identity into the user's repo config")
	}
}

// postedSummary returns the batch-finished message posted to the channel.
func postedSummary(t *testing.T, channelName string) string {
	t.Helper()
	var rows []models.EventRecord
	db.DB.Where("source = ? AND target = ?", "system:parallel", "channel/"+channelName).Find(&rows)
	for _, r := range rows {
		if s := string(r.Payload); strings.Contains(s, "Parallel batch finished") {
			return s
		}
	}
	t.Fatal("no batch summary posted to the channel")
	return ""
}

func TestBatchSummaryOnlyClaimsAMergeThatHappened(t *testing.T) {
	batch := &models.ParallelBatchRecord{Isolation: "worktree", BaseBranch: "main"}
	lane := func(agent, status string) models.ParallelLaneRecord {
		return models.ParallelLaneRecord{Agent: agent, Status: status, Branch: "parallel/x-" + agent}
	}
	cases := []struct {
		name  string
		lanes []models.ParallelLaneRecord
		want  string
	}{
		{"all merged", []models.ParallelLaneRecord{lane("a", laneMerged), lane("b", laneMerged)}, " — merged into `main`"},
		{"some merged", []models.ParallelLaneRecord{lane("a", laneMerged), lane("b", laneConflict)}, " — 1 of 2 lanes merged into `main`"},
		{"all conflicted", []models.ParallelLaneRecord{lane("a", laneConflict), lane("b", laneConflict)}, " — nothing was merged into `main`"},
		{"kept and failed", []models.ParallelLaneRecord{lane("a", laneKept), lane("b", laneFailed)}, " — nothing was merged into `main`"},
	}
	for _, c := range cases {
		got := batchSummary(batch, c.lanes, "")
		head := strings.SplitN(got, "\n", 2)[0]
		if head != "**Parallel batch finished**"+c.want {
			t.Errorf("%s: headline = %q, want suffix %q", c.name, head, c.want)
		}
	}
	// A shared-directory batch never merges, so it never talks about merging.
	shared := &models.ParallelBatchRecord{Isolation: "shared"}
	if got := batchSummary(shared, []models.ParallelLaneRecord{lane("a", laneDone)}, ""); strings.Contains(got, "merged") {
		t.Errorf("shared batch summary mentions a merge: %q", got)
	}
}

func TestParallelSummaryOfAnUnmergedBatchSaysNothingMerged(t *testing.T) {
	// End to end: a dirty base keeps alpha's branch and beta fails, so the
	// posted summary must not claim anything reached main.
	ws := parallelTestDB(t)
	repo := newRepo(t)
	batch, lanes := startTestBatch(t, ws, repo, "alpha", "beta")
	os.WriteFile(filepath.Join(lanes["alpha"].WorktreePath, "alpha.txt"), []byte("a\n"), 0644)
	os.WriteFile(filepath.Join(repo, "shared.txt"), []byte("user is editing\n"), 0644)
	finish(t, batch.ID, "alpha", false)
	finish(t, batch.ID, "beta", true)
	finish(t, batch.ID, "beta", true) // its one automatic retry fails too
	approve(t, batch.ID)

	s := postedSummary(t, batch.ChannelName)
	if strings.Contains(s, "— merged into") || strings.Contains(s, "lanes merged into") {
		t.Fatalf("summary claims a merge that did not happen: %s", s)
	}
	if !strings.Contains(s, "nothing was merged into `main`") {
		t.Fatalf("summary does not say nothing was merged: %s", s)
	}
}

func TestParallelBatchWaitsForReviewAndCanBeDiscarded(t *testing.T) {
	ws := parallelTestDB(t)
	repo := newRepo(t)
	batch, lanes := startTestBatch(t, ws, repo, "alpha", "beta")
	os.WriteFile(filepath.Join(lanes["alpha"].WorktreePath, "alpha.txt"), []byte("a\n"), 0644)
	finish(t, batch.ID, "alpha", false)
	finish(t, batch.ID, "beta", false)

	db.DB.Where("id = ?", batch.ID).First(&batch)
	if batch.Status != batchReview {
		t.Fatalf("want review, got %s", batch.Status)
	}
	got := lanesOf(batch.ID)
	if !strings.Contains(got["alpha"].Diffstat, "1 file changed") || got["alpha"].ChangedFiles != "alpha.txt" {
		t.Fatalf("alpha's diff was not recorded: %q / %q", got["alpha"].Diffstat, got["alpha"].ChangedFiles)
	}
	if got["beta"].Diffstat != "" {
		t.Fatalf("beta changed nothing but has a diffstat %q", got["beta"].Diffstat)
	}
	// A batch under review still holds the channel: a new one would branch
	// from a base this one may be about to merge into.
	var ch models.Channel
	db.DB.Where("name = ?", batch.ChannelName).First(&ch)
	if startParallelBatch(db.DB, ws, &ch, "mention", []string{"alpha", "beta"}, nil, nil) != nil {
		t.Fatal("started a second batch while one waits for review")
	}
	var rows []models.EventRecord
	db.DB.Where("source = ? AND target = ? AND type = ?", "system:parallel", "channel/"+batch.ChannelName, "workspace.message.posted").Find(&rows)
	if len(rows) != 1 || !strings.Contains(string(rows[0].Payload), "ready for review") {
		t.Fatalf("want one review message, got %d", len(rows))
	}

	discardBatch(&batch)
	db.DB.Where("id = ?", batch.ID).First(&batch)
	if batch.Status != batchDone {
		t.Fatalf("discarded batch = %s", batch.Status)
	}
	for a, l := range lanesOf(batch.ID) {
		if l.Status != laneDiscarded {
			t.Fatalf("lane %s = %s", a, l.Status)
		}
		if _, err := os.Stat(l.WorktreePath); err == nil {
			t.Fatalf("discarded worktree %s still exists", l.WorktreePath)
		}
	}
	if _, err := os.Stat(filepath.Join(repo, "alpha.txt")); err == nil {
		t.Fatal("discard merged alpha's work")
	}
	if strings.Contains(git(t, repo, "branch", "--list", "parallel/*"), "parallel/") {
		t.Fatal("discarded lane branches were not deleted")
	}
}

func TestParallelBatchWithNoChangesFinishesWithoutReview(t *testing.T) {
	ws := parallelTestDB(t)
	repo := newRepo(t)
	batch, _ := startTestBatch(t, ws, repo, "alpha", "beta")
	finish(t, batch.ID, "alpha", false)
	finish(t, batch.ID, "beta", false)
	db.DB.Where("id = ?", batch.ID).First(&batch)
	if batch.Status != batchDone {
		t.Fatalf("a batch with nothing to merge should not wait for review, got %s", batch.Status)
	}
}

func TestParallelMergesALaneThatCommittedOnItsOwn(t *testing.T) {
	// An agent that commits in its worktree leaves it clean, so commitLane has
	// nothing to do and lane.Commit stays empty -- the branch still carries work.
	ws := parallelTestDB(t)
	repo := newRepo(t)
	batch, lanes := startTestBatch(t, ws, repo, "alpha", "beta")
	wt := lanes["alpha"].WorktreePath
	os.WriteFile(filepath.Join(wt, "alpha.txt"), []byte("a\n"), 0644)
	git(t, wt, "add", "-A")
	git(t, wt, "-c", "user.name=agent", "-c", "user.email=a@b.c", "commit", "-m", "self")
	finish(t, batch.ID, "alpha", false)
	finish(t, batch.ID, "beta", false)
	approve(t, batch.ID)
	if _, err := os.Stat(filepath.Join(repo, "alpha.txt")); err != nil {
		t.Fatal("the lane's own commit was not merged")
	}
}

func TestParallelResumeMetadataOnlyForARunningLane(t *testing.T) {
	ws := parallelTestDB(t)
	repo := newRepo(t)
	batch, lanes := startTestBatch(t, ws, repo, "alpha", "beta")
	meta := ParallelResumeMetadata(batch.ID, "ALPHA")
	if meta == nil || meta["resume"] != true || meta["batch_id"] != batch.ID {
		t.Fatalf("running lane: %+v", meta)
	}
	d, ok := meta["lanes"].(map[string]laneDispatch)["alpha"]
	if !ok || d.WorkingDir != lanes["alpha"].WorktreePath {
		t.Fatalf("resume must carry the lane's worktree: %+v", meta["lanes"])
	}
	finish(t, batch.ID, "alpha", false)
	if ParallelResumeMetadata(batch.ID, "alpha") != nil {
		t.Fatal("a finished lane must not be resumed")
	}
	if ParallelResumeMetadata("", "alpha") != nil || ParallelResumeMetadata(batch.ID, "nobody") != nil {
		t.Fatal("unknown batch or agent must give nil")
	}
}

// assertRedispatchedInWorktree checks the lane was sent back through the lane
// path: a message targeting it whose parallel_batch metadata carries its own
// worktree -- not a bare @mention, which would run it in the main checkout.
func assertRedispatchedInWorktree(t *testing.T, channelName string, lane models.ParallelLaneRecord, wantText string) {
	t.Helper()
	var rows []models.EventRecord
	db.DB.Where("source = ? AND target = ? AND type = ?", "system:parallel", "channel/"+channelName, "workspace.message.posted").
		Order("timestamp DESC").Find(&rows)
	for _, r := range rows {
		var meta map[string]interface{}
		_ = json.Unmarshal(r.Metadata, &meta)
		pb, _ := meta["parallel_batch"].(map[string]interface{})
		if pb == nil {
			continue
		}
		lanes, _ := pb["lanes"].(map[string]interface{})
		d, _ := lanes[lane.Agent].(map[string]interface{})
		if d == nil {
			continue
		}
		if d["working_dir"] != lane.WorktreePath || lane.WorktreePath == "" {
			t.Fatalf("redispatch runs outside the lane worktree: %v", d["working_dir"])
		}
		targets, _ := meta["target_agents"].([]interface{})
		if len(targets) != 1 || targets[0] != lane.Agent {
			t.Fatalf("redispatch targets %v, want only %s", targets, lane.Agent)
		}
		if !strings.Contains(string(r.Payload), wantText) {
			t.Fatalf("redispatch message lacks %q: %s", wantText, r.Payload)
		}
		return
	}
	t.Fatalf("no lane redispatch message for %s", lane.Agent)
}

func TestParallelRetryMergeAfterCleaningBaseTree(t *testing.T) {
	ws := parallelTestDB(t)
	repo := newRepo(t)
	batch, lanes := startTestBatch(t, ws, repo, "alpha", "beta")
	os.WriteFile(filepath.Join(lanes["alpha"].WorktreePath, "alpha.txt"), []byte("a\n"), 0644)
	finish(t, batch.ID, "alpha", false)
	finish(t, batch.ID, "beta", false)

	// Make base dirty with an uncommitted edit
	os.WriteFile(filepath.Join(repo, "shared.txt"), []byte("uncommitted\n"), 0644)

	// First merge attempt: base is dirty, so lanes are kept and batch is not merged
	approve(t, batch.ID)
	got := lanesOf(batch.ID)
	if got["alpha"].Status != laneKept {
		t.Fatalf("expected laneKept for alpha on dirty base, got %s", got["alpha"].Status)
	}

	// User cleans the base directory
	git(t, repo, "checkout", "--", "shared.txt")

	// Retry merge now that base is clean
	approve(t, batch.ID)
	got = lanesOf(batch.ID)
	if got["alpha"].Status != laneMerged {
		t.Fatalf("expected laneMerged for alpha after cleaning base, got %s", got["alpha"].Status)
	}
	if b, err := os.ReadFile(filepath.Join(repo, "alpha.txt")); err != nil || strings.TrimSpace(string(b)) != "a" {
		t.Fatalf("alpha.txt not merged to base repo: %v", err)
	}
}

func TestParallelDiscardRevertsBoardTodos(t *testing.T) {
	ws := parallelTestDB(t)
	repo := newRepo(t)
	ch := models.Channel{ID: uuid.NewString(), WorkspaceID: ws, Name: "board-ch", WorkingDir: &repo}
	db.DB.Create(&ch)

	todo := models.TodoRecord{
		ID:          uuid.NewString(),
		WorkspaceID: ws,
		ChannelName: ch.Name,
		Assignee:    "alpha",
		Content:     "Implement alpha feature",
		Status:      "in_progress",
	}
	db.DB.Create(&todo)

	todoB := models.TodoRecord{
		ID:          uuid.NewString(),
		WorkspaceID: ws,
		ChannelName: ch.Name,
		Assignee:    "beta",
		Content:     "Implement beta feature",
		Status:      "in_progress",
	}
	db.DB.Create(&todoB)

	tasks := map[string]string{"alpha": "Implement alpha feature", "beta": "Implement beta feature"}
	meta := startParallelBatch(db.DB, ws, &ch, "board", []string{"alpha", "beta"}, tasks, nil)
	if meta == nil {
		t.Fatal("board batch failed to start")
	}
	var batch models.ParallelBatchRecord
	db.DB.Where("id = ?", meta["batch_id"]).First(&batch)

	var laneA, laneB models.ParallelLaneRecord
	db.DB.Where("batch_id = ? AND agent = ?", batch.ID, "alpha").First(&laneA)
	db.DB.Where("batch_id = ? AND agent = ?", batch.ID, "beta").First(&laneB)
	os.WriteFile(filepath.Join(laneA.WorktreePath, "alpha.txt"), []byte("code\n"), 0644)
	finishLane(&batch, &laneA, false, "", "done")
	finishLane(&batch, &laneB, false, "", "done")

	// Verify todo was marked completed on lane completion
	var checkTodo models.TodoRecord
	db.DB.Where("id = ?", todo.ID).First(&checkTodo)
	if checkTodo.Status != "completed" {
		t.Fatalf("expected todo completed while in review, got %s", checkTodo.Status)
	}

	// Discard the batch
	discardBatch(&batch)

	// Verify todo was reverted back to pending and completed_at cleared
	var reverted models.TodoRecord
	db.DB.Where("id = ?", todo.ID).First(&reverted)
	if reverted.Status != "pending" || reverted.CompletedAt != nil {
		t.Fatalf("expected todo reverted to pending with nil completed_at, got status=%s, completed_at=%v", reverted.Status, reverted.CompletedAt)
	}
}
