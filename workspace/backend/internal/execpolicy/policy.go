package execpolicy

import (
	"strings"
)

// PolicyMode dictates how aggressively the execution engine filters commands.
type PolicyMode string

const (
	// ModePermissive: Only blocks Forbidden commands. All others are allowed immediately. (Dev mode)
	ModePermissive PolicyMode = "permissive"
	// ModeBalanced: Forbidden is blocked, Safe is allowed, RequireApproval commands ask for human review. (Default)
	ModeBalanced PolicyMode = "balanced"
	// ModeStrict: Only explicitly Safe commands run automatically; all other commands require human approval.
	ModeStrict PolicyMode = "strict"
	// ModeReadOnly: Only Safe read-only inspection commands are permitted. State-modifying commands are rejected.
	ModeReadOnly PolicyMode = "read_only"
)

// Decision indicates the action the execution engine must take.
type Decision string

const (
	DecisionAllow           Decision = "allow"
	DecisionRequireApproval Decision = "require_approval"
	DecisionDeny            Decision = "deny"
)

// ExecPolicy represents workspace-configurable execution policy rules.
type ExecPolicy struct {
	Mode           PolicyMode `json:"mode"`
	CustomAllowed  []string   `json:"custom_allowed,omitempty"`  // Custom regex or prefix whitelist
	CustomDenied   []string   `json:"custom_denied,omitempty"`   // Custom regex or prefix blacklist
	CustomApproval []string   `json:"custom_approval,omitempty"` // Custom commands forced to ask approval
	MaxTimeoutSec  int        `json:"max_timeout_sec,omitempty"` // Max allowed execution timeout in seconds
}

// DefaultPolicy returns the recommended balanced security policy.
func DefaultPolicy() *ExecPolicy {
	return &ExecPolicy{
		Mode:          ModeBalanced,
		MaxTimeoutSec: 60,
	}
}

// EvaluationResult contains the final decision and explanation.
type EvaluationResult struct {
	Decision       Decision             `json:"decision"`
	Classification ClassificationResult `json:"classification"`
	Reason         string               `json:"reason"`
}

// EvaluateCommand assesses a command string against the given policy and returns the execution decision.
func EvaluateCommand(policy *ExecPolicy, rawCommand string) EvaluationResult {
	if policy == nil {
		policy = DefaultPolicy()
	}

	cmd := strings.TrimSpace(rawCommand)
	classification := ClassifyCommand(cmd)

	// 1. Check custom denied rules (explicit blacklist)
	for _, denied := range policy.CustomDenied {
		if strings.Contains(strings.ToLower(cmd), strings.ToLower(denied)) {
			return EvaluationResult{
				Decision:       DecisionDeny,
				Classification: classification,
				Reason:         "Command matches workspace custom denied rule: " + denied,
			}
		}
	}

	// 2. Check custom allowed rules (explicit whitelist - bypasses default classification)
	for _, allowed := range policy.CustomAllowed {
		if strings.Contains(strings.ToLower(cmd), strings.ToLower(allowed)) {
			// Even with whitelist, Forbidden commands cannot be bypassed for safety
			if classification.RiskLevel == RiskForbidden {
				return EvaluationResult{
					Decision:       DecisionDeny,
					Classification: classification,
					Reason:         "Dangerous system command cannot be whitelisted: " + classification.Reason,
				}
			}
			return EvaluationResult{
				Decision:       DecisionAllow,
				Classification: classification,
				Reason:         "Command matches workspace custom allowed rule: " + allowed,
			}
		}
	}

	// 3. Check custom approval rules
	for _, approval := range policy.CustomApproval {
		if strings.Contains(strings.ToLower(cmd), strings.ToLower(approval)) {
			return EvaluationResult{
				Decision:       DecisionRequireApproval,
				Classification: classification,
				Reason:         "Command matches workspace custom approval rule: " + approval,
			}
		}
	}

	// 4. Always deny Forbidden commands regardless of mode
	if classification.RiskLevel == RiskForbidden {
		return EvaluationResult{
			Decision:       DecisionDeny,
			Classification: classification,
			Reason:         classification.Reason,
		}
	}

	// 5. Apply Policy Mode logic
	switch policy.Mode {
	case ModeReadOnly:
		if classification.RiskLevel == RiskSafe {
			return EvaluationResult{
				Decision:       DecisionAllow,
				Classification: classification,
				Reason:         "Safe command allowed in read-only mode",
			}
		}
		return EvaluationResult{
			Decision:       DecisionDeny,
			Classification: classification,
			Reason:         "Workspace is in read-only mode; state-modifying commands are blocked",
		}

	case ModePermissive:
		return EvaluationResult{
			Decision:       DecisionAllow,
			Classification: classification,
			Reason:         "Allowed in permissive mode (audit logged)",
		}

	case ModeStrict:
		if classification.RiskLevel == RiskSafe {
			return EvaluationResult{
				Decision:       DecisionAllow,
				Classification: classification,
				Reason:         "Safe command allowed in strict mode",
			}
		}
		return EvaluationResult{
			Decision:       DecisionRequireApproval,
			Classification: classification,
			Reason:         "Strict mode requires human approval for non-safe commands",
		}

	case ModeBalanced:
		fallthrough
	default:
		if classification.RiskLevel == RiskSafe {
			return EvaluationResult{
				Decision:       DecisionAllow,
				Classification: classification,
				Reason:         "Safe command automatically approved",
			}
		}
		return EvaluationResult{
			Decision:       DecisionRequireApproval,
			Classification: classification,
			Reason:         "Command requires human review before execution in balanced mode",
		}
	}
}
