package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

func TestAttributeCommit(t *testing.T) {
	windows := []activityWindow{
		{agent: "claude", start: 1_000_000, end: 2_000_000},
		{agent: "codex", start: 1_800_000, end: 3_000_000},
		{agent: "claude", start: 2_500_000, end: 2_600_000},
	}
	cases := []struct {
		name   string
		at     int64
		agent  string
		shared bool
	}{
		{"inside one turn", 1_500_000, "claude", false},
		{"inside two agents' turns", 1_900_000, "", true},
		{"another agent overlapping", 2_550_000, "", true},
		{"outside every turn", 4_000_000, "", false},
		{"within slack after the end", 3_000_000 + 4_000, "codex", false},
		{"past the slack", 3_000_000 + 6_000, "", false},
	}
	for _, tc := range cases {
		agent, shared := attributeCommit(windows, tc.at)
		if agent != tc.agent || shared != tc.shared {
			t.Errorf("%s: got (%q, %v), want (%q, %v)", tc.name, agent, shared, tc.agent, tc.shared)
		}
	}
}

func commitAt(t *testing.T, dir, file, email string, at time.Time) string {
	t.Helper()
	writeRepoFile(t, dir, file, file+" "+at.String()+"\n")
	if out, err := runGit(dir, "add", "-A"); err != nil {
		t.Fatalf("git add: %v (%s)", err, out)
	}
	author := "Someone <" + email + ">"
	if out, err := runGit(dir, "commit", "-m", "change "+file, "--author="+author, "--date="+at.Format(time.RFC3339)); err != nil {
		t.Fatalf("git commit: %v (%s)", err, out)
	}
	sha, err := runGit(dir, "rev-parse", "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	return sha
}

func getActivity(t *testing.T, handler gin.HandlerFunc, workspaceID, query string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodGet, "/x?"+query, nil)
	c.Request.Header.Set("X-Workspace-Token", "token")
	c.Params = gin.Params{{Key: "workspace_id", Value: workspaceID}}
	handler(c)
	return rec
}

func TestActivityCommitsAttributesAndFilters(t *testing.T) {
	workspace, channel, dir := setupTurnDB(t)
	const me = "turn-changes@example.test"
	now := time.Now()
	ms := func(t time.Time) int64 { return t.UnixMilli() }

	// @claude had a closed turn from -3h to -2h, @codex one from -2h30 to -1h30
	// (overlapping claude's last half hour), and @gemini one that was expired
	// for never reporting back.
	insert := func(agent, workDir, status, reason string, start time.Time, end *time.Time) {
		row := models.AgentTurnChange{
			ID: uuid.NewString(), WorkspaceID: workspace.ID, ChannelID: channel.ID, ChannelName: channel.Name,
			AgentName: agent, TaskID: uuid.NewString(), WorkingDir: workDir, Status: status, Reason: reason,
			StartedAt: ms(start),
		}
		if end != nil {
			e := ms(*end)
			row.FinishedAt = &e
		}
		if err := db.DB.Create(&row).Error; err != nil {
			t.Fatal(err)
		}
	}
	end := func(d time.Duration) *time.Time { v := now.Add(d); return &v }
	insert("claude", dir, "closed", "", now.Add(-3*time.Hour), end(-2*time.Hour))
	insert("codex", dir, "closed", "", now.Add(-150*time.Minute), end(-90*time.Minute))
	insert("gemini", dir, "unavailable", staleTurnReason, now.Add(-60*time.Minute), end(-10*time.Minute))

	byClaude := commitAt(t, dir, "a.txt", me, now.Add(-170*time.Minute))
	shared := commitAt(t, dir, "b.txt", me, now.Add(-140*time.Minute))
	// A collaborator's commit inside an agent turn is the agent's work.
	collabInTurn := commitAt(t, dir, "c.txt", "other@example.test", now.Add(-100*time.Minute))
	// Inside only the expired turn: must not be pinned on @gemini.
	mine := commitAt(t, dir, "d.txt", me, now.Add(-30*time.Minute))
	// A collaborator's commit outside every turn is not on this calendar.
	collabOutside := commitAt(t, dir, "e.txt", "other@example.test", now.Add(-5*time.Minute))

	// A pinned pre-turn snapshot is a single-parent commit on a private ref;
	// it must not be counted as a commit.
	tree, _ := runGit(dir, "rev-parse", "HEAD^{tree}")
	checkpoint, err := runGit(dir, "commit-tree", tree, "-p", "HEAD", "-m", "checkpoint")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := runGit(dir, "update-ref", checkpointRefPrefix+"t1", checkpoint); err != nil {
		t.Fatal(err)
	}

	// A parallel lane: a worktree of the same repository, bound as an agent's
	// launch directory, with a commit on its own branch during a claude turn.
	lane := filepath.Join(t.TempDir(), "lane")
	if out, err := runGit(dir, "worktree", "add", "-b", "lane-claude", lane); err != nil {
		t.Skipf("git worktree unavailable: %v (%s)", err, out)
	}
	laneDir := lane
	if err := db.DB.Create(&models.WorkspaceMember{
		WorkspaceID: workspace.ID, AgentName: "claude", WorkingDir: &laneDir, Status: "online",
	}).Error; err != nil {
		t.Fatal(err)
	}
	insert("claude", lane, "closed", "", now.Add(-20*time.Minute), end(-15*time.Minute))
	laneCommit := commitAt(t, lane, "f.txt", me, now.Add(-18*time.Minute))

	rec := getActivity(t, GetActivityCommits, workspace.ID, "weeks=4&refresh=1")
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var resp ActivityCommitsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}

	if len(resp.Repos) != 1 {
		t.Fatalf("worktree and checkout are one repository, got %d repos: %+v", len(resp.Repos), resp.Repos)
	}
	if resp.Repos[0].Email != me {
		t.Errorf("repo email = %q, want %q", resp.Repos[0].Email, me)
	}

	got := map[string]ActivityCommit{}
	for _, c := range resp.Commits {
		if _, dup := got[c.Hash]; dup {
			t.Errorf("commit %s listed twice", c.Hash)
		}
		got[c.Hash] = c
	}
	expect := func(sha, agent string, isShared bool) {
		t.Helper()
		c, ok := got[sha]
		if !ok {
			t.Errorf("commit %s missing", sha[:7])
			return
		}
		if c.Agent != agent || c.Shared != isShared {
			t.Errorf("commit %s: agent=%q shared=%v, want agent=%q shared=%v", sha[:7], c.Agent, c.Shared, agent, isShared)
		}
	}
	expect(byClaude, "claude", false)
	expect(shared, "", true)
	expect(collabInTurn, "codex", false)
	expect(mine, "", false)
	expect(laneCommit, "claude", false)
	if _, ok := got[collabOutside]; ok {
		t.Error("a collaborator's commit outside every agent turn was counted")
	}
	if _, ok := got[checkpoint]; ok {
		t.Error("a checkpoint snapshot was counted as a commit")
	}
}

func TestActivityTurnsWindowAndExpiredEnd(t *testing.T) {
	workspace, channel, dir := setupTurnDB(t)
	day := time.Date(2026, 9, 28, 0, 0, 0, 0, time.Local)
	from, to := day.UnixMilli(), day.Add(24*time.Hour).UnixMilli()
	hour := int64(time.Hour / time.Millisecond)

	insert := func(agent, status, reason string, start int64, end *int64) {
		if err := db.DB.Create(&models.AgentTurnChange{
			ID: uuid.NewString(), WorkspaceID: workspace.ID, ChannelID: channel.ID, ChannelName: channel.Name,
			AgentName: agent, TaskID: uuid.NewString(), WorkingDir: dir, Status: status, Reason: reason,
			StartedAt: start, FinishedAt: end, Additions: 3,
		}).Error; err != nil {
			t.Fatal(err)
		}
	}
	p := func(v int64) *int64 { return &v }
	insert("claude", "closed", "", from+9*hour, p(from+10*hour)) // inside
	insert("codex", "closed", "", from-hour, p(from+hour))       // straddles midnight
	insert("gemini", "unavailable", staleTurnReason, from+11*hour, p(from+15*hour))
	insert("pi", "queued", "", from+12*hour, nil)               // never started
	insert("claude", "closed", "", from-3*hour, p(from-2*hour)) // previous day
	insert("claude", "open", "", from+20*hour, nil)             // still running
	insert("antigravity", "unavailable", "not a git repository", from+21*hour, nil)

	rec := getActivity(t, GetActivityTurns, workspace.ID,
		"from="+strconv.FormatInt(from, 10)+"&to="+strconv.FormatInt(to, 10))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var resp ActivityTurnsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	var agents []string
	for _, turn := range resp.Turns {
		agents = append(agents, turn.AgentName)
		if turn.AgentName == "gemini" || turn.AgentName == "antigravity" {
			if !turn.EndUnknown || turn.FinishedAt != nil {
				t.Errorf("expired turn: end_unknown=%v finished_at=%v, want true/nil", turn.EndUnknown, turn.FinishedAt)
			}
		}
	}
	want := []string{"codex", "claude", "gemini", "claude", "antigravity"}
	if len(agents) != len(want) {
		t.Fatalf("turns = %v, want %v", agents, want)
	}
	for i := range want {
		if agents[i] != want[i] {
			t.Fatalf("turns = %v, want %v", agents, want)
		}
	}

	if rec := getActivity(t, GetActivityTurns, workspace.ID, "from=0&to="+strconv.FormatInt(30*24*hour, 10)); rec.Code != http.StatusBadRequest {
		t.Errorf("a 30-day range should be refused, got %d", rec.Code)
	}
}
