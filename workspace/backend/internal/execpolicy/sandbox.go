package execpolicy

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// SandboxConfig specifies working directory boundaries and environment constraints.
type SandboxConfig struct {
	WorkspaceRoot string            `json:"workspace_root"`
	WorkingDir    string            `json:"working_dir"`
	ExtraEnv      map[string]string `json:"extra_env,omitempty"`
}

// ResolveSandboxedDir validates and resolves the target working directory.
// It enforces that the requested directory does NOT escape the allowed root boundary.
//
// Scope of the guarantee: this pins where the process STARTS, not what it can
// reach. There is no OS-level jail here, so a command is still free to name an
// absolute path, follow a symlink out, or walk upward on its own -- `npm install`
// run from a directory with no package.json will climb past the root and install
// into an ancestor. Containment against a determined command needs OS isolation
// (a container, job object, or AppContainer); what this layer provides is that a
// caller-supplied working_dir cannot be used as the escape, and that the command
// itself was risk-classified before it ever ran.
func ResolveSandboxedDir(workspaceRoot string, requestedDir string) (string, error) {
	// If workspaceRoot is not set, default to current working directory
	if workspaceRoot == "" {
		wd, err := os.Getwd()
		if err != nil {
			return "", fmt.Errorf("failed to get current working directory: %w", err)
		}
		if strings.HasSuffix(filepath.ToSlash(wd), "/backend") {
			workspaceRoot = filepath.Dir(wd)
		} else {
			workspaceRoot = wd
		}
	}

	absRoot, err := filepath.Abs(workspaceRoot)
	if err != nil {
		return "", fmt.Errorf("invalid workspace root path: %w", err)
	}
	absRoot = filepath.Clean(absRoot)

	// If no specific working dir requested, use the workspace root
	if strings.TrimSpace(requestedDir) == "" {
		return absRoot, nil
	}

	var targetPath string
	if filepath.IsAbs(requestedDir) {
		targetPath = filepath.Clean(requestedDir)
	} else {
		targetPath = filepath.Clean(filepath.Join(absRoot, requestedDir))
	}

	// Boundary check: ensure targetPath is within or equal to absRoot
	rel, err := filepath.Rel(absRoot, targetPath)
	if err != nil || strings.HasPrefix(rel, "..") || rel == ".." {
		return "", fmt.Errorf("sandboxing error: directory '%s' is outside the workspace root '%s'", requestedDir, absRoot)
	}

	// Verify directory exists
	info, err := os.Stat(targetPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("requested working directory does not exist: %s", targetPath)
		}
		return "", fmt.Errorf("error accessing working directory: %w", err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("requested path is not a directory: %s", targetPath)
	}

	return targetPath, nil
}

// BuildSanitizedEnv constructs a safe environment variable slice for the sub-process.
// It strips dangerous variables and injects non-interactive safety flags.
func BuildSanitizedEnv(extraEnv map[string]string) []string {
	baseEnv := os.Environ()
	var sanitized []string

	// Variables to filter out to prevent unintended shell escapes or token leakage
	filterOut := map[string]bool{
		"SUDO_ASKPASS": true,
		"SSH_ASKPASS":  true,
	}

	for _, e := range baseEnv {
		pair := strings.SplitN(e, "=", 2)
		if len(pair) > 0 && filterOut[strings.ToUpper(pair[0])] {
			continue
		}
		sanitized = append(sanitized, e)
	}

	// Injected safety environment variables
	safetyDefaults := map[string]string{
		"GIT_TERMINAL_PROMPT": "0", // Prevent git from hanging waiting for interactive username/password
		"NONINTERACTIVE":      "1", // Signal scripts to avoid interactive prompts
		"DEBIAN_FRONTEND":     "noninteractive",
		"CI":                  "true",
	}

	for k, v := range safetyDefaults {
		sanitized = append(sanitized, fmt.Sprintf("%s=%s", k, v))
	}

	for k, v := range extraEnv {
		sanitized = append(sanitized, fmt.Sprintf("%s=%s", k, v))
	}

	return sanitized
}
