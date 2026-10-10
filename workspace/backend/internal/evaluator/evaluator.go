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
	VerifiedBy      string     `json:"verified_by,omitempty"` // "command" | "turn_error" | "unverified"
	// Final is the verification run this verdict was based on, nil when no
	// command ran. On a pass it is the state the next step starts from.
	Final *VerificationRunResult `json:"-"`
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
	// Windows locations toolchains resolve their caches from. Without
	// LOCALAPPDATA `go test` fails with "build cache is required" and npm
	// cannot find its cache -- every run failed the same way, so every step
	// "passed" as pre-existing breakage. None of these hold secrets.
	"LOCALAPPDATA=", "APPDATA=", "PROGRAMDATA=", "PROGRAMFILES=", "PROGRAMFILES(X86)=",
	"PROGRAMW6432=", "COMMONPROGRAMFILES=", "SYSTEMDRIVE=", "USERNAME=", "OS=",
	"NUMBER_OF_PROCESSORS=", "PROCESSOR_ARCHITECTURE=",
	"GOMODCACHE=", "GOFLAGS=", "XDG_CACHE_HOME=", "XDG_CONFIG_HOME=",
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
	setWindowsHidden(cmd)
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

	extractedErrors := dropGenericErrorLines(ExtractErrorLines(outputStr, 8))
	if exitCode != 0 && len(extractedErrors) == 0 {
		// Nothing specific matched (or only "exit status 1"-style lines did):
		// the tail of the output is the most specific evidence there is.
		rawLines := strings.Split(outputStr, "\n")
		for i := len(rawLines) - 1; i >= 0 && len(extractedErrors) < 4; i-- {
			trimmed := strings.TrimSpace(rawLines[i])
			if trimmed != "" && !isGenericErrorLine(trimmed) {
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
	// Digits elsewhere are line numbers and timings: an existing error that
	// moved down a few lines, or a test that ran 0.53s instead of 0.48s, is
	// still the same error.
	line = digitRun.ReplaceAllString(line, "#")
	return strings.TrimSpace(line)
}

var digitRun = regexp.MustCompile(`[0-9]+`)

// genericErrorLines carry no information about WHAT failed. Two different
// failures both end in "exit status 1", so comparing on such lines made a new
// failure look identical to the baseline's.
var genericErrorLines = []*regexp.Regexp{
	regexp.MustCompile(`(?i)^exit status \d+$`),
	regexp.MustCompile(`(?i)^npm\s+ERR!\s+(code|errno|syscall|path|command failed|lifecycle|a complete log|this is probably|failed at)`),
	regexp.MustCompile(`(?i)^\[quality gate\]`),
}

func isGenericErrorLine(line string) bool {
	for _, re := range genericErrorLines {
		if re.MatchString(strings.TrimSpace(line)) {
			return true
		}
	}
	return false
}

func dropGenericErrorLines(lines []string) []string {
	var out []string
	for _, l := range lines {
		if !isGenericErrorLine(l) {
			out = append(out, l)
		}
	}
	return out
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

// EvaluateStep judges one attempt at a pipeline step from evidence only:
//
//  1. The agent's turn ended in an error (the adapter said so): fail.
//  2. A verification command is configured: run it. Exit 0 passes. A failure
//     passes only when every error was already there before the step's first
//     attempt (baseline) -- pre-existing debt is not this step's regression.
//  3. No command: pass, marked "unverified".
//
// There is deliberately no prose heuristic. Scanning the agent's reply for
// "TypeError:" or "exit status 1" failed steps whenever an agent described
// an error it had fixed, and a keyword list ("check", "优化", ...) that
// exempted "analytical" steps also skipped the real command for any coding
// step that happened to contain one of those words.
func EvaluateStep(
	agentName string,
	step models.PipelineStep,
	turnError string,
	dir string,
	verificationCmd string,
	baseline *VerificationRunResult,
) EvaluationResult {
	retryNum := step.RetryCount + 1
	maxRetries := step.MaxRetries
	if maxRetries <= 0 {
		maxRetries = 3
	}

	if turnError = strings.TrimSpace(turnError); turnError != "" {
		details := []string{truncateLine(turnError, 400)}
		var fb strings.Builder
		fb.WriteString(fmt.Sprintf("[Pipeline Quality Gate - Retry %d/%d]\n", retryNum, maxRetries))
		fb.WriteString(fmt.Sprintf("@%s's turn ended with an error:\n> %s\n", agentName, details[0]))
		fb.WriteString("\nFix the cause and complete the step.")
		return EvaluationResult{
			Status:          EvalFail,
			Reason:          "The agent's turn ended with an error",
			ErrorDetails:    details,
			FeedbackMessage: fb.String(),
			VerifiedBy:      "turn_error",
		}
	}

	verificationCmd = strings.TrimSpace(verificationCmd)
	dir = strings.TrimSpace(dir)
	if verificationCmd == "" || dir == "" {
		return EvaluationResult{
			Status:     EvalPass,
			Reason:     "Step finished without machine verification (no verification command configured)",
			VerifiedBy: "unverified",
		}
	}

	final, runErr := RunVerificationCommand(dir, verificationCmd, 60*time.Second)
	if final == nil {
		reason := fmt.Sprintf("Failed to run verification command `%s`: %v", verificationCmd, runErr)
		return EvaluationResult{
			Status:          EvalFail,
			Reason:          reason,
			ErrorDetails:    []string{reason},
			FeedbackMessage: fmt.Sprintf("[Pipeline Quality Gate - Retry %d/%d]\n%s", retryNum, maxRetries, reason),
			VerifiedBy:      "command",
		}
	}
	if final.ExitCode == 0 {
		return EvaluationResult{
			Status:     EvalPass,
			Reason:     fmt.Sprintf("Verification command succeeded (`%s` exited with code 0)", verificationCmd),
			ExitCode:   &final.ExitCode,
			DurationMs: final.DurationMs,
			VerifiedBy: "command",
			Final:      final,
		}
	}

	reported := final.Errors
	if baseline != nil && baseline.ExitCode != 0 {
		reported = CalculateNewErrors(baseline.Errors, final.Errors)
		if len(reported) == 0 {
			return EvaluationResult{
				Status:     EvalPass,
				Reason:     fmt.Sprintf("Failures already present before this step are unchanged (`%s` exited %d); no new errors from @%s", verificationCmd, final.ExitCode, agentName),
				ExitCode:   &final.ExitCode,
				DurationMs: final.DurationMs,
				VerifiedBy: "command",
				Final:      final,
			}
		}
	}
	if len(reported) == 0 {
		reported = []string{fmt.Sprintf("Command `%s` exited with non-zero status code %d", verificationCmd, final.ExitCode)}
	}

	var fb strings.Builder
	fb.WriteString(fmt.Sprintf("[Pipeline Quality Gate - Retry %d/%d]\n", retryNum, maxRetries))
	fb.WriteString(fmt.Sprintf("Verification command `%s` failed with exit code %d after @%s's turn.\n", verificationCmd, final.ExitCode, agentName))
	fb.WriteString("Errors:\n")
	for _, line := range reported {
		fb.WriteString(fmt.Sprintf("> %s\n", line))
	}
	fb.WriteString("\nFix these and make sure the verification command passes.")

	return EvaluationResult{
		Status:          EvalFail,
		Reason:          fmt.Sprintf("Verification command failed with exit code %d (%d new errors)", final.ExitCode, len(reported)),
		ErrorDetails:    reported,
		FeedbackMessage: fb.String(),
		ExitCode:        &final.ExitCode,
		DurationMs:      final.DurationMs,
		VerifiedBy:      "command",
		Final:           final,
	}
}

func truncateLine(s string, n int) string {
	r := []rune(strings.TrimSpace(s))
	if len(r) <= n {
		return string(r)
	}
	return string(r[:n]) + "..."
}
