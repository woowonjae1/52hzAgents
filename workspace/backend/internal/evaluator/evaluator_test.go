package evaluator

import (
	"strings"
	"testing"

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
