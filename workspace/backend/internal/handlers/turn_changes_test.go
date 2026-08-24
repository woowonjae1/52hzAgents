package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/hub"

	"github.com/glebarez/sqlite"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"gorm.io/gorm"
)

// These tests run against a real throwaway git repository rather than a stubbed
// snapshot. Attribution is entirely a question of what git reports for a
// directory that two writers are editing, so a fake snapshot would only prove
// the diff arithmetic and none of the behaviour that actually breaks.

func writeRepoFile(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
}

func initTestRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		if out, err := runGit(dir, args...); err != nil {
			t.Skipf("git %v unavailable in this environment: %v (%s)", args, err, out)
		}
	}
	run("init")
	run("config", "user.email", "turn-changes@example.test")
	run("config", "user.name", "Turn Changes Test")
	run("config", "commit.gpgsign", "false")

	writeRepoFile(t, dir, "app.go", "package main\n\nfunc main() {}\n")
	writeRepoFile(t, dir, "util.go", "package main\n\nfunc helper() {}\n")
	run("add", "-A")
	run("commit", "-m", "initial")
	return dir
}

func mustCapture(t *testing.T, dir string) *turnSnapshot {
	t.Helper()
	snap, err := captureTurnSnapshot(dir)
	if err != nil {
		t.Fatalf("captureTurnSnapshot(%s): %v", dir, err)
	}
	return snap
}

func changeFor(changes []turnFileChange, path string) *turnFileChange {
	for i := range changes {
		if changes[i].Path == path {
			return &changes[i]
		}
	}
	return nil
}

func paths(changes []turnFileChange) []string {
	out := make([]string, 0, len(changes))
	for _, change := range changes {
		out = append(out, change.Path)
	}
	return out
}

// The whole point of a baseline: a file the human had already dirtied before the
// turn must not be blamed on the agent.
func TestDiffTurnSnapshotsIgnoresPreExistingEdit(t *testing.T) {
	dir := initTestRepo(t)
	writeRepoFile(t, dir, "util.go", "package main\n\nfunc helper() { println(1) }\n")

	base := mustCapture(t, dir)
	writeRepoFile(t, dir, "app.go", "package main\n\nfunc main() { println(2) }\n")
	final := mustCapture(t, dir)

	changes := diffTurnSnapshots(dir, base, final)
	if len(changes) != 1 || changes[0].Path != "app.go" {
		t.Fatalf("expected only app.go attributed, got %v", paths(changes))
	}
	if changes[0].PreExisting {
		t.Errorf("app.go was clean at dispatch, must not be marked pre-existing")
	}
}

// A file that was already dirty and then edited *further* is attributed, with
// the share that predates the turn reported separately instead of subtracted.
func TestDiffTurnSnapshotsFlagsFurtherEditToDirtyFile(t *testing.T) {
	dir := initTestRepo(t)
	writeRepoFile(t, dir, "util.go", "package main\n\nfunc helper() { println(1) }\n")

	base := mustCapture(t, dir)
	baseStats := base.Files["util.go"]
	if baseStats.Additions == 0 {
		t.Fatalf("baseline should already show additions for util.go, got %+v", baseStats)
	}

	writeRepoFile(t, dir, "util.go", "package main\n\nfunc helper() { println(1) }\n\nfunc extra() {}\n")
	final := mustCapture(t, dir)

	changes := diffTurnSnapshots(dir, base, final)
	change := changeFor(changes, "util.go")
	if change == nil {
		t.Fatalf("util.go must be attributed after a further edit, got %v", paths(changes))
	}
	if !change.PreExisting {
		t.Errorf("util.go was dirty at dispatch, expected PreExisting")
	}
	if change.BaseAdditions != baseStats.Additions {
		t.Errorf("BaseAdditions = %d, want the baseline's %d", change.BaseAdditions, baseStats.Additions)
	}
	if change.Additions <= change.BaseAdditions {
		t.Errorf("total additions %d should exceed the pre-existing %d", change.Additions, change.BaseAdditions)
	}
}

// The case that defeats every cheaper fingerprint: an already-dirty file edited
// to the same byte length with the same +/- counts. Only content hashing sees it.
func TestDiffTurnSnapshotsDetectsSameLengthRewrite(t *testing.T) {
	dir := initTestRepo(t)
	writeRepoFile(t, dir, "util.go", "package main\n\nfunc helpe1() {}\n")

	base := mustCapture(t, dir)
	writeRepoFile(t, dir, "util.go", "package main\n\nfunc helpe2() {}\n")
	final := mustCapture(t, dir)

	baseFP, finalFP := base.Files["util.go"], final.Files["util.go"]
	if baseFP.Size != finalFP.Size || baseFP.Additions != finalFP.Additions || baseFP.Deletions != finalFP.Deletions {
		t.Fatalf("test premise broken: size/numstat should be identical, got %+v vs %+v", baseFP, finalFP)
	}

	if changeFor(diffTurnSnapshots(dir, base, final), "util.go") == nil {
		t.Fatalf("a same-length, same-numstat rewrite must still be attributed")
	}
}

// An agent that commits its own work leaves a clean status. Without following
// HEAD the turn would look empty, which is the worst possible answer.
func TestDiffTurnSnapshotsFollowsCommittedWork(t *testing.T) {
	dir := initTestRepo(t)

	base := mustCapture(t, dir)
	writeRepoFile(t, dir, "app.go", "package main\n\nfunc main() { println(3) }\n")
	if out, err := runGit(dir, "commit", "-am", "agent work"); err != nil {
		t.Fatalf("commit failed: %v (%s)", err, out)
	}
	final := mustCapture(t, dir)

	if len(final.Files) != 0 {
		t.Fatalf("status should be clean after the agent committed, got %v", final.Files)
	}
	change := changeFor(diffTurnSnapshots(dir, base, final), "app.go")
	if change == nil {
		t.Fatalf("committed work must still be attributed to the turn")
	}
	if !change.Committed {
		t.Errorf("expected Committed to be set")
	}
	if change.Additions == 0 {
		t.Errorf("expected line counts from the commit diff, got %+v", change)
	}
}

// Dirty before, clean after, nothing committed: the agent threw away an
// uncommitted human edit. Reporting this is the reason the revert pass exists.
func TestDiffTurnSnapshotsRecordsRevert(t *testing.T) {
	dir := initTestRepo(t)
	writeRepoFile(t, dir, "util.go", "package main\n\nfunc helper() { println(9) }\n")

	base := mustCapture(t, dir)
	writeRepoFile(t, dir, "util.go", "package main\n\nfunc helper() {}\n")
	final := mustCapture(t, dir)

	change := changeFor(diffTurnSnapshots(dir, base, final), "util.go")
	if change == nil {
		t.Fatalf("a reverted human edit must be reported, got %v", paths(diffTurnSnapshots(dir, base, final)))
	}
	if !change.Reverted {
		t.Errorf("expected Reverted to be set, got %+v", change)
	}
	if change.BaseAdditions == 0 {
		t.Errorf("expected the discarded edit's size to be preserved, got %+v", change)
	}
}

func TestCaptureTurnSnapshotCountsUntrackedFile(t *testing.T) {
	dir := initTestRepo(t)
	writeRepoFile(t, dir, "new.go", "one\ntwo\nthree\n")

	snap := mustCapture(t, dir)
	fp, ok := snap.Files["new.go"]
	if !ok {
		t.Fatalf("untracked file missing from snapshot: %v", snap.Files)
	}
	if fp.Status != "?" {
		t.Errorf("Status = %q, want %q", fp.Status, "?")
	}
	if fp.Additions != 3 {
		t.Errorf("Additions = %d, want 3", fp.Additions)
	}
}

// A directory that is not a repository must report why, so the record says
// "unavailable" instead of persisting an empty change set that reads as "the
// agent changed nothing".
func TestCaptureTurnSnapshotOutsideRepoFails(t *testing.T) {
	if _, err := captureTurnSnapshot(t.TempDir()); err == nil {
		t.Fatalf("expected an error for a non-repository directory")
	}
}

func setupTurnDB(t *testing.T) (models.Workspace, models.Channel, string) {
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
		&models.AgentTurnChange{},
		// The rollback handler publishes a workspace state event on success.
		&models.EventRecord{},
	); err != nil {
		t.Fatal(err)
	}

	dir := initTestRepo(t)
	token := "token"
	workspace := models.Workspace{ID: uuid.NewString(), Name: "turns", PasswordHash: &token, Status: "active"}
	if err := db.DB.Create(&workspace).Error; err != nil {
		t.Fatal(err)
	}
	channel := models.Channel{
		ID: uuid.NewString(), WorkspaceID: workspace.ID, Name: "general",
		OrchestrationMode: "dynamic", Status: "active", WorkingDir: &dir,
	}
	if err := db.DB.Create(&channel).Error; err != nil {
		t.Fatal(err)
	}
	return workspace, channel, dir
}

func latestTurn(t *testing.T, workspaceID, agentName string) models.AgentTurnChange {
	t.Helper()
	var row models.AgentTurnChange
	if err := db.DB.Where("workspace_id = ? AND agent_name = ?", workspaceID, agentName).
		Order("started_at desc").First(&row).Error; err != nil {
		t.Fatalf("no turn recorded for @%s: %v", agentName, err)
	}
	return row
}

func TestOpenAndCloseAgentTurnAttributesFiles(t *testing.T) {
	workspace, channel, dir := setupTurnDB(t)

	// A human edit that is in flight when the task is dispatched.
	writeRepoFile(t, dir, "util.go", "package main\n\nfunc helper() { println(7) }\n")

	openAgentTurn(workspace.ID, &channel, "claude-agent", "task-1", "event-1")
	opened := latestTurn(t, workspace.ID, "claude-agent")
	if opened.Status != "open" {
		t.Fatalf("Status = %q, want open (reason: %s)", opened.Status, opened.Reason)
	}
	if opened.TaskID != "task-1" || opened.WorkingDir != dir {
		t.Fatalf("turn bound to the wrong task/dir: %+v", opened)
	}

	writeRepoFile(t, dir, "app.go", "package main\n\nfunc main() { println(8) }\n")
	closeAgentTurn(workspace.ID, &channel, "claude-agent")

	closed := latestTurn(t, workspace.ID, "claude-agent")
	if closed.Status != "closed" {
		t.Fatalf("Status = %q, want closed (reason: %s)", closed.Status, closed.Reason)
	}
	if closed.FinishedAt == nil {
		t.Errorf("FinishedAt should be set on a closed turn")
	}

	var files []turnFileChange
	if err := json.Unmarshal(closed.Changes, &files); err != nil {
		t.Fatalf("stored change set is unreadable: %v", err)
	}
	if len(files) != 1 || files[0].Path != "app.go" {
		t.Fatalf("expected only the agent's app.go edit, got %v", paths(files))
	}
	if closed.FileCount != 1 || closed.Additions != files[0].Additions {
		t.Errorf("totals disagree with the change set: %+v vs %+v", closed, files[0])
	}
}

// Attribution is only meaningful while one agent owns the directory. When two
// own it at once the record has to say so rather than credit one of them.
func TestOpenAgentTurnFlagsContention(t *testing.T) {
	workspace, channel, _ := setupTurnDB(t)

	openAgentTurn(workspace.ID, &channel, "claude-agent", "task-1", "event-1")
	openAgentTurn(workspace.ID, &channel, "antigravity-agent", "task-2", "event-2")

	second := latestTurn(t, workspace.ID, "antigravity-agent")
	if !second.Contended {
		t.Fatalf("second agent's turn should be flagged contended")
	}
	var contendedBy []string
	if err := json.Unmarshal(second.ContendedBy, &contendedBy); err != nil {
		t.Fatalf("ContendedBy unreadable: %v", err)
	}
	if len(contendedBy) != 1 || contendedBy[0] != "claude-agent" {
		t.Errorf("ContendedBy = %v, want [claude-agent]", contendedBy)
	}

	first := latestTurn(t, workspace.ID, "claude-agent")
	if !first.Contended {
		t.Errorf("the already-open turn should be flagged contended too")
	}
}

// A channel bound to a directory that is not a repository still gets a record,
// carrying the reason attribution was impossible.
func TestOpenAgentTurnRecordsUnavailableOutsideRepo(t *testing.T) {
	workspace, channel, _ := setupTurnDB(t)
	plain := t.TempDir()
	channel.WorkingDir = &plain
	if err := db.DB.Model(&models.Channel{}).Where("id = ?", channel.ID).
		Update("working_dir", plain).Error; err != nil {
		t.Fatal(err)
	}

	openAgentTurn(workspace.ID, &channel, "claude-agent", "task-1", "event-1")

	row := latestTurn(t, workspace.ID, "claude-agent")
	if row.Status != "unavailable" {
		t.Fatalf("Status = %q, want unavailable", row.Status)
	}
	if row.Reason == "" {
		t.Errorf("an unavailable turn must carry a reason")
	}
}

// Nothing bound to a project means nothing to attribute, and no row to keep.
func TestOpenAgentTurnWithoutWorkingDirIsNoop(t *testing.T) {
	workspace, channel, _ := setupTurnDB(t)
	channel.WorkingDir = nil

	openAgentTurn(workspace.ID, &channel, "claude-agent", "task-1", "event-1")

	var count int64
	if err := db.DB.Model(&models.AgentTurnChange{}).
		Where("workspace_id = ?", workspace.ID).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("expected no turn row, got %d", count)
	}
}

// A second dispatch to the same agent settles the previous turn rather than
// leaving it open to poison later contention checks.
func TestOpenAgentTurnSupersedesItsOwnOpenTurn(t *testing.T) {
	workspace, channel, dir := setupTurnDB(t)

	openAgentTurn(workspace.ID, &channel, "claude-agent", "task-1", "event-1")
	writeRepoFile(t, dir, "app.go", "package main\n\nfunc main() { println(4) }\n")
	openAgentTurn(workspace.ID, &channel, "claude-agent", "task-2", "event-2")

	var rows []models.AgentTurnChange
	if err := db.DB.Where("workspace_id = ?", workspace.ID).Order("started_at asc").Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("expected two turns, got %d", len(rows))
	}

	var first, second models.AgentTurnChange
	for _, row := range rows {
		switch row.TaskID {
		case "task-1":
			first = row
		case "task-2":
			second = row
		}
	}
	if first.Status != "closed" {
		t.Errorf("the superseded turn should be closed, got %q", first.Status)
	}
	if second.Status != "open" {
		t.Errorf("the new turn should be open, got %q (%s)", second.Status, second.Reason)
	}
	if second.Contended {
		t.Errorf("an agent superseding its own turn is not contention")
	}
}

func TestMetadataStringsAcceptsBothShapes(t *testing.T) {
	// routing sets []string in-process; anything that survived a JSON round
	// trip arrives as []interface{}.
	if got := metadataStrings(map[string]interface{}{"target_agents": []string{"a"}}, "target_agents"); len(got) != 1 || got[0] != "a" {
		t.Errorf("[]string form = %v", got)
	}
	if got := metadataStrings(map[string]interface{}{"target_agents": []interface{}{"a", 1, "b"}}, "target_agents"); len(got) != 2 || got[0] != "a" || got[1] != "b" {
		t.Errorf("[]interface{} form = %v", got)
	}
	if got := metadataStrings(nil, "target_agents"); got != nil {
		t.Errorf("nil metadata = %v, want nil", got)
	}
}

func TestRollbackTurnChanges_SelectiveRollback(t *testing.T) {
	ws, ch, dir := setupTurnDB(t)

	// 1. Prepare base commit with base.txt
	writeRepoFile(t, dir, "base.txt", "original base content\n")
	runGit(dir, "add", "base.txt")
	runGit(dir, "commit", "-m", "add base.txt")
	headCommit, _ := runGit(dir, "rev-parse", "HEAD")

	// 2. Human creates uncommitted file
	writeRepoFile(t, dir, "human_uncommitted.txt", "human notes\n")

	// 3. Agent modifies base.txt and creates agent_new.txt
	writeRepoFile(t, dir, "base.txt", "broken agent code\n")
	writeRepoFile(t, dir, "agent_new.txt", "unwanted new agent file\n")

	// 4. Create turn record with attribution changes
	turnFiles := []turnFileChange{
		{Path: "base.txt", Status: "M"},
		{Path: "agent_new.txt", Status: "?"},
	}
	changesJSON, _ := json.Marshal(turnFiles)

	turn := models.AgentTurnChange{
		ID:          uuid.NewString(),
		WorkspaceID: ws.ID,
		ChannelID:   ch.ID,
		AgentName:   "coder",
		TaskID:      "task-rollback-1",
		WorkingDir:  dir,
		BaseCommit:  headCommit,
		Changes:     changesJSON,
		Status:      "closed",
	}
	db.DB.Create(&turn)

	// 5. Test selective rollback
	files := turnFiles
	for _, file := range files {
		cleanRel, _ := sanitizeGitFilePath(dir, file.Path)
		fullPath := filepath.Join(dir, cleanRel)
		if file.Status == "?" || file.Status == "A" {
			_ = os.Remove(fullPath)
		} else if headCommit != "" {
			_, _ = runGit(dir, "checkout", headCommit, "--", cleanRel)
		}
	}

	// Verify base.txt is restored
	baseContent, _ := os.ReadFile(filepath.Join(dir, "base.txt"))
	if strings.TrimSpace(string(baseContent)) != "original base content" {
		t.Fatalf("base.txt not restored, got: %q", string(baseContent))
	}

	// Verify agent_new.txt is removed
	if _, err := os.Stat(filepath.Join(dir, "agent_new.txt")); !os.IsNotExist(err) {
		t.Fatalf("agent_new.txt was not removed by rollback")
	}

	// Verify human_uncommitted.txt is PRESERVED
	humanContent, err := os.ReadFile(filepath.Join(dir, "human_uncommitted.txt"))
	if err != nil || strings.TrimSpace(string(humanContent)) != "human notes" {
		t.Fatalf("human uncommitted file was lost or corrupted during rollback: %v", err)
	}
}

func TestDirectoryQueueAndDrain(t *testing.T) {
	ws, ch, _ := setupTurnDB(t)

	// 1. Agent 1 opens turn -> should be 'open'
	openAgentTurn(ws.ID, &ch, "agent1", "task-1", "event-1")
	var turn1 models.AgentTurnChange
	if err := db.DB.Where("workspace_id = ? AND agent_name = ? AND task_id = ?", ws.ID, "agent1", "task-1").First(&turn1).Error; err != nil {
		t.Fatalf("failed to find agent1 turn: %v", err)
	}
	if turn1.Status != "open" {
		t.Fatalf("expected agent1 turn to be 'open', got %s", turn1.Status)
	}

	// 2. Agent 2 tries to open turn on same dir -> should be 'queued'
	openAgentTurn(ws.ID, &ch, "agent2", "task-2", "event-2")
	var turn2 models.AgentTurnChange
	if err := db.DB.Where("workspace_id = ? AND agent_name = ? AND task_id = ?", ws.ID, "agent2", "task-2").First(&turn2).Error; err != nil {
		t.Fatalf("failed to find agent2 turn: %v", err)
	}
	if turn2.Status != "queued" {
		t.Fatalf("expected agent2 turn to be 'queued', got %s", turn2.Status)
	}

	// 3. Agent 1 closes turn -> should drain queue and activate Agent 2's turn to 'open'
	closeAgentTurn(ws.ID, &ch, "agent1")

	var turn2Updated models.AgentTurnChange
	if err := db.DB.Where("id = ?", turn2.ID).First(&turn2Updated).Error; err != nil {
		t.Fatalf("failed to query agent2 turn: %v", err)
	}
	if turn2Updated.Status != "open" {
		t.Fatalf("expected agent2 turn to be drained and marked 'open', got %s", turn2Updated.Status)
	}
}

func TestRollbackPreservesPreExistingHumanEditsViaStashSnapshot(t *testing.T) {
	ws, ch, dir := setupTurnDB(t)

	// 1. Committed file in repo
	writeRepoFile(t, dir, "feature.go", "package main\n\n// V1\n")
	runGit(dir, "add", "feature.go")
	runGit(dir, "commit", "-m", "init feature.go")

	// 2. Human makes UNCOMMITTED edit before agent starts
	writeRepoFile(t, dir, "feature.go", "package main\n\n// V1 + Human uncommitted edit\n")

	// 3. Agent turn starts -> openAgentTurn runs git stash create to snapshot human edit
	openAgentTurn(ws.ID, &ch, "coder", "task-human-1", "event-h1")

	var turn models.AgentTurnChange
	if err := db.DB.Where("workspace_id = ? AND agent_name = ?", ws.ID, "coder").First(&turn).Error; err != nil {
		t.Fatalf("failed to find turn: %v", err)
	}
	if turn.BaseCommit == "" {
		t.Fatalf("expected BaseCommit to contain stash commit SHA, got empty")
	}

	// 4. Agent further modifies feature.go with buggy code
	writeRepoFile(t, dir, "feature.go", "package main\n\n// V1 + Agent broke everything\n")
	closeAgentTurn(ws.ID, &ch, "coder")

	// 5. Perform rollback on this turn using its BaseCommit
	cleanRel, _ := sanitizeGitFilePath(dir, "feature.go")
	_, err := runGit(dir, "checkout", turn.BaseCommit, "--", cleanRel)
	if err != nil {
		t.Fatalf("checkout from stash commit failed: %v", err)
	}

	// 6. Verify feature.go contains the HUMAN's uncommitted edit, NOT the committed V1!
	content, _ := os.ReadFile(filepath.Join(dir, "feature.go"))
	normalized := strings.ReplaceAll(strings.TrimSpace(string(content)), "\r\n", "\n")
	if normalized != "package main\n\n// V1 + Human uncommitted edit" {
		t.Fatalf("Rollback did not restore human pre-existing edit! Got:\n%s", string(content))
	}
}

// ---------------------------------------------------------------------------
// Rollback: the one promise
// ---------------------------------------------------------------------------

// normalizeEOL lets an assertion be about content rather than about git's
// end-of-line policy.
func normalizeEOL(s string) string {
	return strings.ReplaceAll(s, "\r\n", "\n")
}

func readRepoFile(t *testing.T, dir, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, name))
	if err != nil {
		t.Fatalf("read %s: %v", name, err)
	}
	return string(data)
}

func postRollback(t *testing.T, workspaceID, turnID string, force bool) *httptest.ResponseRecorder {
	t.Helper()
	if hub.GlobalHub == nil {
		hub.InitHub()
	}
	gin.SetMode(gin.TestMode)
	body, err := json.Marshal(map[string]interface{}{"turn_id": turnID, "force": force})
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	req := httptest.NewRequest(http.MethodPost, "/v1/git/turn-rollback?network="+workspaceID, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Workspace-Token", "token")
	c.Request = req
	RollbackTurnChanges(c)
	return rec
}

// This is the assertion the whole rollback feature exists to satisfy: a file the
// human had edited but not committed comes back as the *human's* version -- not
// HEAD, and not the agent's. Restoring HEAD here would silently destroy work
// that was never committed anywhere, which is the one outcome the feature
// promises can never happen.
func TestRollbackRestoresHumanVersionNotHead(t *testing.T) {
	workspace, channel, dir := setupTurnDB(t)

	const committed = "package main\n\nfunc helper() {}\n"
	const humanEdit = "package main\n\nfunc helper() { println(\"human\") }\n"
	const agentEdit = "package main\n\nfunc helper() { println(\"agent\") }\n"

	// The human edits util.go and does not commit it.
	writeRepoFile(t, dir, "util.go", humanEdit)

	openAgentTurn(workspace.ID, &channel, "claude-agent", "task-1", "event-1")
	opened := latestTurn(t, workspace.ID, "claude-agent")
	if opened.Status != "open" {
		t.Fatalf("Status = %q, want open (%s)", opened.Status, opened.Reason)
	}
	if opened.BaseCommit == "" {
		t.Fatal("a dirty tree must produce a snapshot commit at dispatch")
	}

	// The agent overwrites the human's in-flight edit.
	writeRepoFile(t, dir, "util.go", agentEdit)
	closeAgentTurn(workspace.ID, &channel, "claude-agent")

	closed := latestTurn(t, workspace.ID, "claude-agent")
	var files []turnFileChange
	if err := json.Unmarshal(closed.Changes, &files); err != nil {
		t.Fatalf("stored change set unreadable: %v", err)
	}
	change := changeFor(files, "util.go")
	if change == nil {
		t.Fatalf("util.go must be attributed, got %v", paths(files))
	}
	if !change.PreExisting {
		t.Fatalf("util.go was dirty at dispatch, expected PreExisting: %+v", change)
	}

	rec := postRollback(t, workspace.ID, closed.ID, false)
	if rec.Code != http.StatusOK {
		t.Fatalf("rollback returned %d: %s", rec.Code, rec.Body.String())
	}

	// Compare with line endings normalised. `git checkout` applies the repo's
	// eol policy (core.autocrlf is on by default in git-for-windows), so the
	// restored bytes can legitimately differ from what os.WriteFile put there
	// while carrying exactly the same content. What must not differ is *whose*
	// version came back.
	switch got := normalizeEOL(readRepoFile(t, dir, "util.go")); got {
	case normalizeEOL(humanEdit):
		// Correct: the human's uncommitted edit survived the rollback.
	case normalizeEOL(agentEdit):
		t.Fatalf("rollback left the agent's version in place: %s", rec.Body.String())
	case normalizeEOL(committed):
		t.Fatalf("rollback fell back to HEAD and destroyed the human's uncommitted edit")
	default:
		t.Fatalf("util.go is in an unexpected state:\n%q", got)
	}
}

// The snapshot has to survive a garbage collection, or the rollback quietly
// stops working for anyone who runs one.
func TestDispatchPinsCheckpointRefAgainstGC(t *testing.T) {
	workspace, channel, dir := setupTurnDB(t)
	writeRepoFile(t, dir, "util.go", "package main\n\nfunc helper() { println(1) }\n")

	openAgentTurn(workspace.ID, &channel, "claude-agent", "task-1", "event-1")
	turn := latestTurn(t, workspace.ID, "claude-agent")

	ref := checkpointRefPrefix + turn.ID
	resolved, err := runGit(dir, "rev-parse", "--verify", ref)
	if err != nil {
		t.Fatalf("checkpoint ref %s does not resolve: %v", ref, err)
	}
	if strings.TrimSpace(resolved) != turn.BaseCommit {
		t.Fatalf("ref points at %s, want the recorded base commit %s", strings.TrimSpace(resolved), turn.BaseCommit)
	}

	// The pin must be what keeps the object alive: an aggressive prune is the
	// exact operation that deletes an unreferenced stash commit.
	if out, err := runGit(dir, "gc", "--prune=now"); err != nil {
		t.Skipf("git gc unavailable here: %v (%s)", err, out)
	}
	if _, err := runGit(dir, "cat-file", "-e", turn.BaseCommit+"^{commit}"); err != nil {
		t.Fatalf("snapshot commit was garbage-collected despite the ref: %v", err)
	}
}

// A clean tree has nothing to stash, and needs nothing: HEAD already describes
// it. The dispatch must record that rather than an empty base commit, which the
// rollback path reads as "no snapshot available".
func TestDispatchFallsBackToHeadOnCleanTree(t *testing.T) {
	workspace, channel, dir := setupTurnDB(t)

	head, err := runGit(dir, "rev-parse", "HEAD")
	if err != nil {
		t.Fatal(err)
	}

	openAgentTurn(workspace.ID, &channel, "claude-agent", "task-1", "event-1")
	turn := latestTurn(t, workspace.ID, "claude-agent")

	if turn.BaseCommit != strings.TrimSpace(head) {
		t.Fatalf("BaseCommit = %q, want HEAD %q", turn.BaseCommit, strings.TrimSpace(head))
	}
}

// An aged-out snapshot is released so gc can reclaim its tree, and BaseCommit is
// cleared so the rollback path refuses instead of dereferencing a dead object.
func TestPruneCheckpointRefsReleasesAgedSnapshots(t *testing.T) {
	workspace, channel, dir := setupTurnDB(t)
	writeRepoFile(t, dir, "util.go", "package main\n\nfunc helper() { println(2) }\n")

	openAgentTurn(workspace.ID, &channel, "claude-agent", "task-1", "event-1")
	turn := latestTurn(t, workspace.ID, "claude-agent")
	if turn.BaseCommit == "" {
		t.Fatal("expected a snapshot for a dirty tree")
	}

	// Age the turn past the retention window.
	aged := time.Now().Add(-checkpointRetention - time.Hour).UnixMilli()
	if err := db.DB.Model(&models.AgentTurnChange{}).Where("id = ?", turn.ID).
		Update("started_at", aged).Error; err != nil {
		t.Fatal(err)
	}

	pruneCheckpointRefs(workspace.ID, dir)

	if _, err := runGit(dir, "rev-parse", "--verify", checkpointRefPrefix+turn.ID); err == nil {
		t.Errorf("aged checkpoint ref should have been deleted")
	}
	var after models.AgentTurnChange
	if err := db.DB.Where("id = ?", turn.ID).First(&after).Error; err != nil {
		t.Fatal(err)
	}
	if after.BaseCommit != "" {
		t.Errorf("BaseCommit = %q, want cleared", after.BaseCommit)
	}
}
