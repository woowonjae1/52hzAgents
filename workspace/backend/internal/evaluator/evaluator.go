package evaluator

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

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
	ExitCode        *int       `json:"exit_code,omitempty"`
	DurationMs      int64      `json:"duration_ms,omitempty"`
	VerifiedBy      string     `json:"verified_by,omitempty"` // "command" | "fallback_regex"
}

// VerificationRunResult captures the raw execution output and parsed errors of a verification run.
type VerificationRunResult struct {
	Command    string   `json:"command"`
	ExitCode   int      `json:"exit_code"`
	Output     string   `json:"output"`
	Errors     []string `json:"errors"`
	DurationMs int64    `json:"duration_ms"`
}

// Error patterns across Go, Node/TS, Python, Rust, Shell, and Git
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

	// Rust errors
	regexp.MustCompile(`(?i)\berror\[E\d{4}\]:\s+.*`),
	regexp.MustCompile(`(?i)\bFAILED\s+test\s+.*`),

	// Shell / General execution failures
	regexp.MustCompile(`(?i)\[SYSTEM ERROR\]`),
	regexp.MustCompile(`(?i)\bexit status [1-9]\d*\b`),
	regexp.MustCompile(`(?i)\b(command not found|Permission denied|No such file or directory|Segmentation fault)\b`),

	// Git error states
	regexp.MustCompile(`(?i)\bfatal:\s+.*`),
	regexp.MustCompile(`(?i)\berror:\s+(failed to push|cannot spawn|unable to read)\b`),
}

// Explicit success signals for heuristic fallback
var successPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?i)(^|\n)PASS(\s|$)`),
	regexp.MustCompile(`(?i)(^|\n)ok\t`),
	regexp.MustCompile(`(?i)\bAll tests passed\b`),
	regexp.MustCompile(`(?i)\b(0 errors,\s*0 warnings|Build succeeded|Compiled successfully)\b`),
}

// ExtractErrorLines scans text lines for matching error patterns and returns up to maxLines informative snippets.
func ExtractErrorLines(text string, maxLines int) []string {
	if maxLines <= 0 {
		maxLines = 6
	}
	var extracted []string
	seen := make(map[string]bool)
	lines := strings.Split(text, "\n")

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || seen[trimmed] {
			continue
		}

		for _, pat := range errorPatterns {
			if pat.MatchString(trimmed) {
				extracted = append(extracted, trimmed)
				seen[trimmed] = true
				if len(extracted) >= maxLines {
					return extracted
				}
				break
			}
		}
	}

	return extracted
}

var allowedRunners = map[string]bool{
	"go": true, "npm": true, "pnpm": true, "yarn": true, "bun": true, "npx": true,
	"pytest": true, "python": true, "python3": true, "node": true, "make": true,
	"cargo": true, "mvn": true, "gradle": true, "gradlew": true, "dotnet": true,
	"tsc": true, "eslint": true, "vitest": true, "jest": true, "ruff": true,
	"flake8": true, "mypy": true, "rustc": true, "ctest": true, "ninja": true,
}

var forbiddenShellOperators = []*regexp.Regexp{
	regexp.MustCompile(`(&&|\|\||[;&` + "`" + `]|\$\(|\n|\r)`),
	regexp.MustCompile(`(?i)\b(curl|wget|nc|netcat|bash|sh|cmd|powershell|pwsh)\b`),
}

var allowedEnvPrefixes = []string{
	"PATH=", "Path=", "PATHEXT=",
	"SYSTEMROOT=", "SystemRoot=", "WINDIR=", "windir=", "COMSPEC=", "ComSpec=",
	"TEMP=", "TMP=", "USERPROFILE=", "HOME=", "HOMEPATH=", "HOMEDRIVE=",
	"LANG=", "LC_ALL=", "TERM=",
	"GOPATH=", "GOROOT=", "GOCACHE=", "GOPROXY=", "GONOPROXY=", "GOPRIVATE=",
	"NODE_PATH=", "NODE_ENV=", "PNPM_HOME=", "NVM_DIR=", "NVM_BIN=",
	"CARGO_HOME=", "RUSTUP_HOME=",
	"PYTHONPATH=", "PYTHONHOME=", "VIRTUAL_ENV=",
	"JAVA_HOME=", "DOTNET_ROOT=", "DOTNET_CLI_TELEMETRY_OPTOUT=",
}

// RunVerificationCommand executes the given verification command in the project directory
// with a strict timeout and captures the exit code, raw output, and extracted errors.
func RunVerificationCommand(dir, command string, timeout time.Duration) (*VerificationRunResult, error) {
	command = strings.TrimSpace(command)
	if command == "" {
		return nil, fmt.Errorf("empty verification command")
	}
	if strings.TrimSpace(dir) == "" {
		return nil, fmt.Errorf("empty directory")
	}

	// 1. Prohibit command chaining operators and egress utilities
	for _, pat := range forbiddenShellOperators {
		if pat.MatchString(command) {
			return &VerificationRunResult{
				Command:    command,
				ExitCode:   126,
				Output:     "[Quality Gate Security] Command contains forbidden shell chaining operators (&&, ;, ||, |) or restricted utilities",
				Errors:     []string{"Command blocked: chained execution and egress utilities are forbidden in quality gates"},
				DurationMs: 0,
			}, nil
		}
	}

	// 2. Validate first token against allowed runner whitelist
	fields := strings.Fields(command)
	if len(fields) == 0 {
		return nil, fmt.Errorf("invalid command")
	}
	rawBinary := fields[0]
	cleanBinary := filepath.Base(rawBinary)
	cleanBinary = strings.ToLower(cleanBinary)
	cleanBinary = strings.TrimSuffix(cleanBinary, ".exe")
	cleanBinary = strings.TrimSuffix(cleanBinary, ".bat")
	cleanBinary = strings.TrimSuffix(cleanBinary, ".cmd")

	if !allowedRunners[cleanBinary] {
		return &VerificationRunResult{
			Command:    command,
			ExitCode:   126,
			Output:     fmt.Sprintf("[Quality Gate Security] '%s' is not an allowed verification runner", rawBinary),
			Errors:     []string{fmt.Sprintf("Runner '%s' blocked. Allowed runners: go, npm, pnpm, yarn, bun, pytest, python, cargo, make, dotnet, etc.", cleanBinary)},
			DurationMs: 0,
		}, nil
	}

	if timeout <= 0 {
		timeout = 60 * time.Second
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "cmd.exe", "/C", command)
	} else {
		cmd = exec.CommandContext(ctx, "sh", "-c", command)
	}
	cmd.Dir = dir

	// 3. Strict Environment Whitelist: never inherit secrets/keys
	var safeEnv []string
	for _, env := range os.Environ() {
		for _, prefix := range allowedEnvPrefixes {
			if strings.HasPrefix(strings.ToUpper(env), strings.ToUpper(prefix)) {
				safeEnv = append(safeEnv, env)
				break
			}
		}
	}
	cmd.Env = safeEnv

	startTime := time.Now()
	outputBytes, execErr := cmd.CombinedOutput()
	durationMs := time.Since(startTime).Milliseconds()

	outputStr := string(outputBytes)
	exitCode := 0
	if execErr != nil {
		if exitErr, ok := execErr.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else if ctx.Err() == context.DeadlineExceeded {
			exitCode = 124 // Standard timeout exit code
			outputStr += fmt.Sprintf("\n[Quality Gate] Command timed out after %v", timeout)
		} else {
			exitCode = 1
			outputStr += fmt.Sprintf("\n[Quality Gate] Execution error: %v", execErr)
		}
	}

	extractedErrors := ExtractErrorLines(outputStr, 8)
	if exitCode != 0 && len(extractedErrors) == 0 {
		// Fallback for failed commands whose output didn't match standard regexes: capture tail lines
		rawLines := strings.Split(outputStr, "\n")
		for i := len(rawLines) - 1; i >= 0 && len(extractedErrors) < 4; i-- {
			trimmed := strings.TrimSpace(rawLines[i])
			if trimmed != "" {
				extractedErrors = append([]string{trimmed}, extractedErrors...)
			}
		}
	}

	return &VerificationRunResult{
		Command:    command,
		ExitCode:   exitCode,
		Output:     outputStr,
		Errors:     extractedErrors,
		DurationMs: durationMs,
	}, nil
}

// normalizeErrorLine cleans an error string for fuzzy delta comparison.
func normalizeErrorLine(line string) string {
	line = strings.TrimSpace(strings.ToLower(line))
	// Strip leading line numbers, timestamp cues, or formatting characters
	line = strings.TrimLeft(line, "> -*#0123456789.:\t")
	return strings.TrimSpace(line)
}

// CalculateNewErrors calculates the delta between baseline errors and final errors,
// returning only the newly introduced regression errors.
func CalculateNewErrors(baselineErrors, finalErrors []string) []string {
	if len(baselineErrors) == 0 {
		return finalErrors
	}

	baselineSet := make(map[string]bool, len(baselineErrors))
	for _, errLine := range baselineErrors {
		norm := normalizeErrorLine(errLine)
		if norm != "" {
			baselineSet[norm] = true
		}
	}

	var newErrors []string
	for _, errLine := range finalErrors {
		norm := normalizeErrorLine(errLine)
		if norm == "" {
			continue
		}
		if !baselineSet[norm] {
			newErrors = append(newErrors, errLine)
		}
	}
	return newErrors
}

// isAnalyticalInstruction checks if a step instruction is an analytical/review task
// where reporting bugs/errors is the expected deliverable, not an execution failure.
func isAnalyticalInstruction(instruction string) bool {
	lower := strings.ToLower(instruction)
	cues := []string{
		"review", "audit", "analyze", "analysis", "inspect", "check", "diagnose", "optimize", "find",
		"审查", "分析", "看看", "找找", "评估", "诊断", "优化", "检查", "建议", "排查", "评审",
	}
	for _, cue := range cues {
		if strings.Contains(lower, cue) {
			return true
		}
	}
	return false
}

// EvaluateTurnWithVerification assesses step execution using real verification command execution
// and delta regression comparison when configured, falling back to prose regex scanning when no command is set.
func EvaluateTurnWithVerification(
	agentName string,
	step models.PipelineStep,
	turnMessages []string,
	dir string,
	verificationCmd string,
	baselineResult *VerificationRunResult,
) EvaluationResult {
	// If this step is an analytical / review task (e.g. "代码审查", "分析架构"),
	// reporting bugs or errors is an expected deliverable, not a pipeline failure.
	if isAnalyticalInstruction(step.Instruction) {
		return EvaluationResult{
			Status:     EvalPass,
			Reason:     "Analytical / review step completed successfully with reported findings",
			VerifiedBy: "analytical_exemption",
		}
	}

	verificationCmd = strings.TrimSpace(verificationCmd)
	dir = strings.TrimSpace(dir)

	// =========================================================================
	// Path A: Real Verification Engine (Primary Ground Truth)
	// =========================================================================
	if verificationCmd != "" && dir != "" {
		finalResult, runErr := RunVerificationCommand(dir, verificationCmd, 60*time.Second)
		if runErr != nil && finalResult == nil {
			return EvaluationResult{
				Status:     EvalFail,
				Reason:     fmt.Sprintf("Failed to run verification command '%s': %v", verificationCmd, runErr),
				VerifiedBy: "command",
			}
		}

		retryNum := step.RetryCount + 1
		maxRetries := step.MaxRetries
		if maxRetries <= 0 {
			maxRetries = 3
		}

		// Case 1: Verification command exited 0 -> Clean Pass!
		if finalResult.ExitCode == 0 {
			return EvaluationResult{
				Status:     EvalPass,
				Reason:     fmt.Sprintf("Verification command succeeded (`%s` exited with code 0)", verificationCmd),
				ExitCode:   &finalResult.ExitCode,
				DurationMs: finalResult.DurationMs,
				VerifiedBy: "command",
			}
		}

		// Case 2: Verification command failed -> Compare with Baseline for Delta Regressions
		var reportedErrors []string
		if baselineResult != nil && baselineResult.ExitCode != 0 {
			// Baseline was already broken before this turn began.
			// Only fail if the agent introduced NEW errors (delta > 0).
			newErrors := CalculateNewErrors(baselineResult.Errors, finalResult.Errors)
			if len(newErrors) == 0 {
				// No new regressions introduced; the failures were pre-existing repo debt!
				return EvaluationResult{
					Status:     EvalPass,
					Reason:     fmt.Sprintf("Pre-existing repository build/test failures unchanged (`%s` exited %d); no new regressions introduced by @%s", verificationCmd, finalResult.ExitCode, agentName),
					ExitCode:   &finalResult.ExitCode,
					DurationMs: finalResult.DurationMs,
					VerifiedBy: "command",
				}
			}
			reportedErrors = newErrors
		} else {
			// Baseline was clean (exit 0) or no baseline -> all final errors are new regressions!
			reportedErrors = finalResult.Errors
		}

		if len(reportedErrors) == 0 {
			reportedErrors = []string{fmt.Sprintf("Command `%s` exited with non-zero status code %d", verificationCmd, finalResult.ExitCode)}
		}

		var feedbackSb strings.Builder
		feedbackSb.WriteString(fmt.Sprintf("⚠️ [Pipeline Quality Gate - Retry %d/%d]\n", retryNum, maxRetries))
		feedbackSb.WriteString(fmt.Sprintf("Verification command `%s` failed with exit code %d during @%s's turn.\n", verificationCmd, finalResult.ExitCode, agentName))
		feedbackSb.WriteString("Detected error output:\n")
		for _, errLine := range reportedErrors {
			feedbackSb.WriteString(fmt.Sprintf("> %s\n", errLine))
		}
		feedbackSb.WriteString("\nPlease analyze the error details above, correct the code, and ensure the verification command passes.")

		return EvaluationResult{
			Status:          EvalFail,
			Reason:          fmt.Sprintf("Verification command failed with exit code %d (%d regression errors detected)", finalResult.ExitCode, len(reportedErrors)),
			ErrorDetails:    reportedErrors,
			FeedbackMessage: feedbackSb.String(),
			ExitCode:        &finalResult.ExitCode,
			DurationMs:      finalResult.DurationMs,
			VerifiedBy:      "command",
		}
	}

	// =========================================================================
	// Path B: Dialogue Error Scanning (No Verification Command Configured)
	// =========================================================================
	if len(turnMessages) == 0 {
		return EvaluationResult{
			Status:     EvalPass,
			Reason:     "Step completed with no dialogue messages; unverified (no test command configured)",
			VerifiedBy: "unverified",
		}
	}

	combinedText := strings.Join(turnMessages, "\n")

	// 1. Scan for hard failure signals in emitted output
	var allErrors []string
	for _, msg := range turnMessages {
		errs := ExtractErrorLines(msg, 3)
		allErrors = append(allErrors, errs...)
	}

	if len(allErrors) > 0 {
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
		feedbackSb.WriteString(fmt.Sprintf("Errors detected in @%s's output:\n", agentName))
		for _, errLine := range allErrors {
			feedbackSb.WriteString(fmt.Sprintf("> %s\n", errLine))
		}
		feedbackSb.WriteString("\nPlease analyze the error details above and correct the issue.")

		return EvaluationResult{
			Status:          EvalFail,
			Reason:          fmt.Sprintf("Found %d execution error signals in dialogue (unverified mode)", len(allErrors)),
			ErrorDetails:    allErrors,
			FeedbackMessage: feedbackSb.String(),
			VerifiedBy:      "unverified_error",
		}
	}

	// 2. Scan for positive pass signals vs standard completion
	hasExplicitPass := false
	for _, pat := range successPatterns {
		if pat.MatchString(combinedText) {
			hasExplicitPass = true
			break
		}
	}

	if hasExplicitPass {
		return EvaluationResult{
			Status:     EvalPass,
			Reason:     "Step completed with success signal in dialogue (unverified, no test command configured)",
			VerifiedBy: "unverified",
		}
	}

	// 3. Default: completed without configured command
	return EvaluationResult{
		Status:     EvalPass,
		Reason:     "Step completed without machine verification (no verification command configured)",
		VerifiedBy: "unverified",
	}
}

// EvaluateTurn maintains backward compatibility by evaluating turn messages with fallback regex mode.
func EvaluateTurn(agentName string, step models.PipelineStep, turnMessages []string) EvaluationResult {
	return EvaluateTurnWithVerification(agentName, step, turnMessages, "", "", nil)
}
