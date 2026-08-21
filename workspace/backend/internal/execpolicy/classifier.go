package execpolicy

import (
	"regexp"
	"strings"
)

// RiskLevel represents the security risk classification of a shell command.
type RiskLevel string

const (
	// RiskSafe: Read-only, inspection, testing, and benign commands.
	RiskSafe RiskLevel = "safe"
	// RiskRequireApproval: State-modifying, package installation, network, or high-impact commands.
	RiskRequireApproval RiskLevel = "require_approval"
	// RiskForbidden: System-destructive, privilege escalation, or irreversible dangerous commands.
	RiskForbidden RiskLevel = "forbidden"
)

// ClassificationResult contains details about how a command was classified.
type ClassificationResult struct {
	RiskLevel RiskLevel `json:"risk_level"`
	Reason    string    `json:"reason"`
	Matched   string    `json:"matched,omitempty"`
}

// Pre-compiled regex patterns for dangerous system-level commands
var forbiddenPatterns = []*regexp.Regexp{
	// Destruction & Partitioning
	regexp.MustCompile(`(?i)\brm\s+-[rRfF]*[rR][rRfF]*\s+(/|/\*|~|~/\*|\$HOME|\$HOME/\*|\.\.|\.\./\*)`),
	regexp.MustCompile(`(?i)\b(mkfs|fdisk|parted|sfdisk|gdisk)\b`),
	regexp.MustCompile(`(?i)\bdd\s+if=`),
	regexp.MustCompile(`(?i)\b(format-volume|diskpart|initialize-disk|clear-disk)\b`),
	regexp.MustCompile(`(?i)\bremove-item\s+.*-(recurse|r).*(c:\\|\$env:systemdrive|c:/\*)`),
	// System control / power
	regexp.MustCompile(`(?i)\b(shutdown|reboot|poweroff|halt|init\s+[06]|stop-computer|restart-computer)\b`),
	// Privilege escalation
	regexp.MustCompile(`(?i)\b(sudo|doas|runas)\b`),
	// `su` only counts in command position so filenames containing "su" are not denied.
	regexp.MustCompile(`(?i)(^|[;&|]\s*)su(\s|$)`),
	// Fork bombs & malicious pipes
	regexp.MustCompile(`:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:`),
	regexp.MustCompile(`(?i)(curl|wget|iwr|irm)\s+.*\|\s*(bash|sh|zsh|powershell|pwsh|cmd|iex|invoke-expression)`),
	// Encoded or dynamically evaluated commands defeat every pattern below them,
	// so the indirection itself is treated as the dangerous act.
	regexp.MustCompile(`(?i)\b(powershell|pwsh)\b[^|;]*\s-(e|ec|enc|encod|encoded|encodedcommand)\b`),
	regexp.MustCompile(`(?i)\b(iex|invoke-expression)\b[^|;]*\b(downloadstring|downloadfile|webclient|invoke-webrequest|iwr|invoke-restmethod|irm)\b`),
	regexp.MustCompile(`(?i)\beval\b[^|;]*\b(curl|wget|iwr|irm)\b`),
	regexp.MustCompile(`(?i)\bbase64\s+(-d|--decode)\b[^|]*\|\s*(bash|sh|zsh|powershell|pwsh)`),
	// Dangerous registry & system modifications
	regexp.MustCompile(`(?i)\breg\s+(delete|add)\s+hklm\b`),
	regexp.MustCompile(`(?i)\bchmod\s+(-[rRfF]*\s+)?(777|000)\s+(/|/\*|/etc|/boot|/usr|/var)`),
}

// Pre-compiled regex patterns for commands that require human confirmation/approval
var requireApprovalPatterns = []*regexp.Regexp{
	// File deletions & moves
	regexp.MustCompile(`(?i)\b(rm|unlink|del|erase|remove-item|rmdir|rd)\b`),
	regexp.MustCompile(`(?i)\b(mv|move|rename|ren|move-item|rename-item)\b`),
	// Package managers / dependency installs
	regexp.MustCompile(`(?i)\b(npm|yarn|pnpm|bun)\s+(install|i|add|remove|uninstall|update)\b`),
	regexp.MustCompile(`(?i)\b(pip|pip3|poetry|uv)\s+(install|uninstall|update|add)\b`),
	regexp.MustCompile(`(?i)\b(go\s+(get|install)|cargo\s+(install|add|remove))\b`),
	regexp.MustCompile(`(?i)\b(apt|apt-get|apk|dnf|yum|pacman|brew|choco|winget|scoop)\s+(install|remove|upgrade|update)\b`),
	// Git state changes & destructive git actions
	regexp.MustCompile(`(?i)\bgit\s+(push|commit|reset|checkout\s+-f|restore|clean|rebase|merge|stash\s+drop|branch\s+-[dD])\b`),
	// Network egress
	regexp.MustCompile(`(?i)\b(curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm|nc|netcat|ncat|ssh|scp|sftp|ftp|telnet|rsync)\b`),
	// In-place rewriting and file-writing utilities. These read as inspection
	// commands but mutate the workspace, so they must not fall through to Safe.
	regexp.MustCompile(`(?i)\b(sed|perl|ruby)\s+(-[a-z]*i\b|--in-place)`),
	regexp.MustCompile(`(?i)\b(tee|out-file|set-content|add-content|clear-content)\b`),
	regexp.MustCompile(`(?i)\b(truncate|shred|chown|chmod|icacls|attrib)\b`),
	regexp.MustCompile(`(?i)\b(mkdir|touch|new-item)\b`),
	// find/xargs invoked to mutate rather than to inspect.
	regexp.MustCompile(`(?i)\bfind\b[^|]*\s-(delete|exec)\b`),
	// Process management & container controls
	regexp.MustCompile(`(?i)\b(kill|pkill|killall|stop-process|taskkill)\b`),
	regexp.MustCompile(`(?i)\b(docker|podman|kubectl)\s+(run|exec|rm|rmi|stop|kill|apply|delete)\b`),
}

// Pre-compiled regex patterns for known safe/read-only commands
var safePatterns = []*regexp.Regexp{
	// Inspection & file reading
	regexp.MustCompile(`(?i)^\s*(ls|dir|cat|type|head|tail|more|less|view|get-content|gc)\b`),
	regexp.MustCompile(`(?i)^\s*(pwd|cd|echo|write-output|printf)\b`),
	regexp.MustCompile(`(?i)^\s*(grep|find|findstr|select-string|where-object|wc|sort|uniq|cut|awk|sed)\b`),
	regexp.MustCompile(`(?i)^\s*(which|where|type|command\s+-v|get-command)\b`),
	regexp.MustCompile(`(?i)^\s*(uname|hostname|whoami|date|time|uptime|df|du|free|ps|top|htop|tasklist)\b`),
	// Testing & linting & building check
	regexp.MustCompile(`(?i)^\s*go\s+(test|vet|version|env|doc)\b`),
	regexp.MustCompile(`(?i)^\s*(npm|yarn|pnpm|bun)\s+(test|run\s+test|run\s+lint|run\s+check)\b`),
	regexp.MustCompile(`(?i)^\s*(pytest|python\s+-m\s+unittest|python\s+--version|node\s+-v|go\s+version|cargo\s+--version)\b`),
	regexp.MustCompile(`(?i)^\s*cargo\s+(test|check|clippy)\b`),
	// Git read-only inspection
	regexp.MustCompile(`(?i)^\s*git\s+(status|log|diff|branch|show|remote\s+-v|tag|describe|rev-parse)\b`),
}

// benignRedirect matches redirections that cannot alter the workspace: writes to
// the null device and file-descriptor merges such as `2>&1` or `>&2`.
var benignRedirect = regexp.MustCompile(`(?i)(\d*>>?\s*(/dev/null|\$null|nul)\b|\d*>&\s*\d|&>>?\s*(/dev/null|\$null|nul)\b)`)

// hasFileWriteRedirect reports whether a command redirects output into a file.
// Benign forms are stripped first so `grep x y 2>/dev/null` stays a safe read.
// A literal ">" inside an argument (for example `grep "a->b" f`) is treated as a
// write as well: over-reporting costs an approval prompt, under-reporting would
// let `echo pwned > main.go` run unattended.
func hasFileWriteRedirect(cmd string) bool {
	return strings.Contains(benignRedirect.ReplaceAllString(cmd, ""), ">")
}

// ClassifyCommand analyzes a command string and determines its intrinsic risk level.
func ClassifyCommand(rawCommand string) ClassificationResult {
	cmd := strings.TrimSpace(rawCommand)
	if cmd == "" {
		return ClassificationResult{
			RiskLevel: RiskSafe,
			Reason:    "empty command",
		}
	}

	// 1. Check for Forbidden patterns first (highest priority)
	for _, pattern := range forbiddenPatterns {
		if matched := pattern.FindString(cmd); matched != "" {
			return ClassificationResult{
				RiskLevel: RiskForbidden,
				Reason:    "Command matches dangerous or system-destructive pattern",
				Matched:   matched,
			}
		}
	}

	// 2. Check for Safe patterns
	// If a command matches safe patterns AND does NOT match require-approval patterns
	isSafe := false
	var safeMatched string
	for _, pattern := range safePatterns {
		if matched := pattern.FindString(cmd); matched != "" {
			isSafe = true
			safeMatched = matched
			break
		}
	}

	// 3. Check for RequireApproval patterns
	for _, pattern := range requireApprovalPatterns {
		if matched := pattern.FindString(cmd); matched != "" {
			return ClassificationResult{
				RiskLevel: RiskRequireApproval,
				Reason:    "Command modifies workspace state, installs packages, or performs network egress",
				Matched:   matched,
			}
		}
	}

	// 3b. Output redirection writes a file even when the leading command is read-only.
	if hasFileWriteRedirect(cmd) {
		return ClassificationResult{
			RiskLevel: RiskRequireApproval,
			Reason:    "Command redirects output into a file, which modifies workspace state",
			Matched:   ">",
		}
	}

	if isSafe {
		return ClassificationResult{
			RiskLevel: RiskSafe,
			Reason:    "Command is a recognized safe inspection, test, or read-only operation",
			Matched:   safeMatched,
		}
	}

	// 4. Default for unclassified commands: treated as RequireApproval for safety
	return ClassificationResult{
		RiskLevel: RiskRequireApproval,
		Reason:    "Unclassified command default",
		Matched:   cmd,
	}
}
