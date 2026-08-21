package evaluator

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

// EvalStatus represents the outcome of step execution evaluation.
type EvalStatus string

const (
	EvalPass          EvalStatus = "pass"
	EvalFail          EvalStatus = "fail"
	EvalIndeterminate EvalStatus = "indeterminate"
)

// EvaluationResult contains the detailed evaluation verdict and feedback for self-correction.
type EvaluationResult struct {
	Status          EvalStatus `json:"status"`
	Reason          string     `json:"reason"`
	ErrorDetails    []string   `json:"error_details,omitempty"`
	FeedbackMessage string     `json:"feedback_message,omitempty"`
}

// Error patterns across Go, Node/TS, Python, Shell, and Git
var errorPatterns = []*regexp.Regexp{
	// Go compilation, runtime and test errors
	regexp.MustCompile(`(?i)\b(syntax error:|undefined:|cannot use .* as|cannot convert|type .* has no field or method)`),
	regexp.MustCompile(`(?i)(^|\n)---\s*FAIL:\s*\w+`),
	regexp.MustCompile(`(?i)(^|\n)FAIL\t`),
	regexp.MustCompile(`(?i)\bpanic:\s*`),
	regexp.MustCompile(`(?i)\[build failed\]`),

	// Node.js / TypeScript / JavaScript errors
	regexp.MustCompile(`(?i)\b(TypeError:|ReferenceError:|SyntaxError:|RangeError:|URIError:)\s+.*`),
	regexp.MustCompile(`(?i)\bTS\d{4,5}:\s+.*`),
	regexp.MustCompile(`(?i)\bnpm\s+ERR!\s+.*`),
	regexp.MustCompile(`(?i)\bFAIL\s+.*\.test\.[jt]sx?`),
	regexp.MustCompile(`(?i)\bTests:\s+.*failed`),

	// Python errors & tracebacks
	regexp.MustCompile(`(?i)Traceback \(most recent call last\):`),
	regexp.MustCompile(`(?i)\b(IndentationError:|NameError:|AttributeError:|ImportError:|ModuleNotFoundError:|ZeroDivisionError:)\s+.*`),
	regexp.MustCompile(`(?i)\bFAILED \(failures=\d+`),
	regexp.MustCompile(`(?i)\b\d+\s+failed,\s+\d+\s+passed\b`),

	// Shell / General execution failures
	regexp.MustCompile(`(?i)\[SYSTEM ERROR\]`),
	regexp.MustCompile(`(?i)\bexit status [1-9]\d*\b`),
	regexp.MustCompile(`(?i)\b(command not found|Permission denied|No such file or directory|Segmentation fault)\b`),

	// Git error states
	regexp.MustCompile(`(?i)\bfatal:\s+.*`),
	regexp.MustCompile(`(?i)\berror:\s+(failed to push|cannot spawn|unable to read)\b`),
}

// Explicit success signals
var successPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(^|\n)PASS(\s|$)`),
	regexp.MustCompile(`(?i)(^|\n)ok\t`),
	regexp.MustCompile(`(?i)\bAll tests passed\b`),
	regexp.MustCompile(`(?i)\b(0 errors,\s*0 warnings|Build succeeded|Compiled successfully)\b`),
}

// ExtractErrorLines scans text lines for matching error patterns and returns up to maxLines informative snippets.
func ExtractErrorLines(text string, maxLines int) []string {
	if maxLines <= 0 {
		maxLines = 4
	}
	var extracted []string
	lines := strings.Split(text, "\n")

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}

		for _, pat := range errorPatterns {
			if pat.MatchString(trimmed) {
				extracted = append(extracted, trimmed)
				if len(extracted) >= maxLines {
					return extracted
				}
				break
			}
		}
	}
	return extracted
}

// EvaluateTurn assesses the messages and tool outputs emitted by an agent during its current step turn.
func EvaluateTurn(agentName string, step models.PipelineStep, turnMessages []string) EvaluationResult {
	if len(turnMessages) == 0 {
		return EvaluationResult{
			Status: EvalPass,
			Reason: "No output messages in turn; passing by default",
		}
	}

	combinedText := strings.Join(turnMessages, "\n")

	// 1. Scan for hard failure signals
	var allErrors []string
	for _, msg := range turnMessages {
		errs := ExtractErrorLines(msg, 3)
		allErrors = append(allErrors, errs...)
	}

	if len(allErrors) > 0 {
		// Limit to top 4 error lines for clean feedback
		if len(allErrors) > 4 {
			allErrors = allErrors[:4]
		}

		retryNum := step.RetryCount + 1
		maxRetries := step.MaxRetries
		if maxRetries <= 0 {
			maxRetries = 3
		}

		var feedbackSb strings.Builder
		feedbackSb.WriteString(fmt.Sprintf("⚠️ [Pipeline Quality Gate - Retry %d/%d]\n", retryNum, maxRetries))
		feedbackSb.WriteString(fmt.Sprintf("Errors detected during @%s's execution:\n", agentName))
		for _, errLine := range allErrors {
			feedbackSb.WriteString(fmt.Sprintf("> %s\n", errLine))
		}
		feedbackSb.WriteString("\nPlease analyze the error details above, correct the issue, and ensure the build/tests succeed.")

		return EvaluationResult{
			Status:          EvalFail,
			Reason:          fmt.Sprintf("Found %d execution or compilation error signals", len(allErrors)),
			ErrorDetails:    allErrors,
			FeedbackMessage: feedbackSb.String(),
		}
	}

	// 2. Scan for positive pass signals
	hasExplicitPass := false
	for _, pat := range successPatterns {
		if pat.MatchString(combinedText) {
			hasExplicitPass = true
			break
		}
	}

	if hasExplicitPass {
		return EvaluationResult{
			Status: EvalPass,
			Reason: "Explicit success / pass signals verified",
		}
	}

	// 3. Default: clean completion without errors is accepted as Pass
	return EvaluationResult{
		Status: EvalPass,
		Reason: "Turn completed with no fatal error signals detected",
	}
}
