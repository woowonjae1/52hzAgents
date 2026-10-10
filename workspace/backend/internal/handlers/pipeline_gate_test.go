package handlers

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/evaluator"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

const gateCheckCmd = "go run check.go"

// gateDir is a project folder whose verification passes only when out.txt
// says "good".
func gateDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	src := `package main

import (
	"fmt"
	"os"
	"strings"
)

func main() {
	b, err := os.ReadFile("out.txt")
	if err != nil {
		fmt.Fprintln(os.Stderr, "error: out.txt is missing")
		os.Exit(1)
	}
	if s := strings.TrimSpace(string(b)); s != "good" {
		fmt.Fprintf(os.Stderr, "error: out.txt has wrong content %q\n", s)
		os.Exit(1)
	}
	fmt.Println("ok")
}
`
	if err := os.WriteFile(filepath.Join(dir, "check.go"), []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func gateWrite(t *testing.T, dir, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "out.txt"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// gateTurn records a dispatched turn with the baseline verification taken at
// that moment, as openAgentTurn does in the background.
func gateTurn(t *testing.T, workspace models.Workspace, channel models.Channel, agent, dir string, startedAt int64) {
	t.Helper()
	baseline, _ := evaluator.RunVerificationCommand(dir, gateCheckCmd, 60*time.Second)
	if baseline == nil {
		t.Fatal("baseline run returned nothing")
	}
	encoded, _ := json.Marshal(baseline)
	rec := models.AgentTurnChange{
		ID: uuid.NewString(), WorkspaceID: workspace.ID, ChannelID: channel.ID, ChannelName: channel.Name,
		AgentName: agent, TaskID: uuid.NewString(), WorkingDir: dir, Status: "open",
		StartedAt: startedAt, BaselineVerify: encoded,
	}
	if err := db.DB.Create(&rec).Error; err != nil {
		t.Fatal(err)
	}
}

func gateChannel(t *testing.T, channel *models.Channel, dir string) {
	t.Helper()
	cmd := gateCheckCmd
	channel.WorkingDir = &dir
	channel.VerificationCmd = &cmd
	if err := db.DB.Save(channel).Error; err != nil {
		t.Fatal(err)
	}
}

// The live-verified bug: the first attempt fails the gate, the retry changes
// nothing, and it used to pass -- the retry turn's baseline already contained
// the first attempt's failure, so nothing counted as "new".
func TestPipelineRetryThatChangesNothingStillFails(t *testing.T) {
	workspace, channel := setupPipelineDB(t)
	dir := gateDir(t)
	gateChannel(t, &channel, dir)
	startTestPipeline(t, workspace, channel)

	// Attempt 1: baseline taken before the step (out.txt missing), then the
	// agent writes the wrong content.
	gateTurn(t, workspace, channel, "codex-agent", dir, time.Now().UnixMilli())
	gateWrite(t, dir, "bad")
	EvaluatePipelineStep(workspace.ID, "general", "codex-agent", "", 0)

	record, steps := loadChain(t, channel.ID)
	if steps[0].Status != "retrying" || steps[0].RetryCount != 1 {
		t.Fatalf("attempt 1 must fail the gate, got %s retry=%d", steps[0].Status, steps[0].RetryCount)
	}
	if steps[0].Baseline == nil || !strings.Contains(strings.Join(steps[0].Baseline.Errors, "\n"), "missing") {
		t.Fatalf("the pre-step baseline must be kept on the step, got %+v", steps[0].Baseline)
	}

	// Attempt 2: a new turn is dispatched (its own baseline now sees "bad")
	// and the agent changes nothing.
	gateTurn(t, workspace, channel, "codex-agent", dir, time.Now().UnixMilli()+1)
	EvaluatePipelineStep(workspace.ID, "general", "codex-agent", "", 0)

	record, steps = loadChain(t, channel.ID)
	if record.CurrentIndex != 0 || steps[0].Status != "retrying" || steps[0].RetryCount != 2 {
		t.Fatalf("a retry that changed nothing must still fail, got index=%d status=%s retry=%d",
			record.CurrentIndex, steps[0].Status, steps[0].RetryCount)
	}

	// Attempt 3 fixes it: the step passes and the passing run becomes the
	// next step's baseline.
	gateWrite(t, dir, "good")
	EvaluatePipelineStep(workspace.ID, "general", "codex-agent", "", 0)

	record, steps = loadChain(t, channel.ID)
	if record.CurrentIndex != 1 || steps[0].Status != "done" || steps[0].VerifiedBy != "command" {
		t.Fatalf("the fixed attempt must pass, got index=%d status=%s by=%s", record.CurrentIndex, steps[0].Status, steps[0].VerifiedBy)
	}
	if steps[1].Baseline == nil || steps[1].Baseline.ExitCode != 0 {
		t.Fatalf("step 2 must start from the passing run, got %+v", steps[1].Baseline)
	}
}

// Failures that were already there before the step started are not the
// step's fault and must not block it.
func TestPipelinePreExistingFailureDoesNotBlockStep(t *testing.T) {
	workspace, channel := setupPipelineDB(t)
	dir := gateDir(t)
	gateWrite(t, dir, "legacy")
	gateChannel(t, &channel, dir)
	startTestPipeline(t, workspace, channel)

	gateTurn(t, workspace, channel, "codex-agent", dir, time.Now().UnixMilli())
	EvaluatePipelineStep(workspace.ID, "general", "codex-agent", "", 0)

	record, steps := loadChain(t, channel.ID)
	if record.CurrentIndex != 1 || steps[0].Status != "done" {
		t.Fatalf("an unchanged pre-existing failure must not block the step, got index=%d status=%s err=%v",
			record.CurrentIndex, steps[0].Status, steps[0].LastError)
	}
}

// The handoff summary was once the "thinking..." status line.
func TestPipelineHandoffUsesTheReplyNotStatusLines(t *testing.T) {
	workspace, channel := setupPipelineDB(t)
	startTestPipeline(t, workspace, channel)

	now := time.Now().UnixMilli()
	for i, p := range []map[string]interface{}{
		{"content": "thinking...", "message_type": "status"},
		{"content": "Let me look at the parser first and draft a plan.", "message_type": "thinking"},
		{"content": "Implemented the parser rewrite and added unit tests for the edge cases.", "message_type": "chat"},
	} {
		payload, _ := json.Marshal(p)
		db.DB.Create(&models.EventRecord{
			ID: uuid.NewString(), NetworkID: workspace.ID, Type: "workspace.message.posted",
			Source: "52hz:codex-agent", Target: "channel/general", Payload: payload, Timestamp: now + int64(i) + 1,
		})
	}
	EvaluatePipelineStep(workspace.ID, "general", "codex-agent", "", 0)

	_, steps := loadChain(t, channel.ID)
	if steps[0].Status != "done" || steps[0].VerifiedBy != "unverified" {
		t.Fatalf("expected an unverified pass, got %s/%s", steps[0].Status, steps[0].VerifiedBy)
	}
	if steps[0].Deliverable == nil || !strings.Contains(steps[0].Deliverable.Summary, "Implemented the parser") {
		t.Fatalf("the handoff summary must come from the reply, got %+v", steps[0].Deliverable)
	}
}

// An older turn ending (one that started before this attempt was dispatched)
// must not be judged as the attempt.
func TestPipelineIgnoresTurnThatStartedBeforeTheAttempt(t *testing.T) {
	workspace, channel := setupPipelineDB(t)
	startTestPipeline(t, workspace, channel)
	_, steps := loadChain(t, channel.ID)

	EvaluatePipelineStep(workspace.ID, "general", "codex-agent", "", *steps[0].StartedAt-60_000)

	record, steps := loadChain(t, channel.ID)
	if record.CurrentIndex != 0 || steps[0].Status != "running" {
		t.Fatalf("an older turn advanced the step: index=%d status=%s", record.CurrentIndex, steps[0].Status)
	}
}
