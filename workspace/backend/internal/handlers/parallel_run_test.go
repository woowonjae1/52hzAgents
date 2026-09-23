package handlers

import (
	"fmt"
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

	got := lanesOf(batch.ID)
	if got["alpha"].Status != laneMerged || got["beta"].Status != laneConflict {
		t.Fatalf("want alpha merged, beta conflict; got %s / %s", got["alpha"].Status, got["beta"].Status)
	}
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
