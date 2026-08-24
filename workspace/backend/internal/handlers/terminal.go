package handlers

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/execpolicy"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

type executeCommandRequest struct {
	Network    string `json:"network"`
	Command    string `json:"command" binding:"required"`
	WorkingDir string `json:"working_dir"`
	AgentName  string `json:"agent_name"`
	ApprovalID string `json:"approval_id"`
}

// approvalGrantTTL bounds how long a human "yes" stays spendable so an approval
// cannot be banked and replayed long after the reviewer saw the context.
const approvalGrantTTL = 15 * time.Minute

// maxTerminalOutputBytes bounds the response body so one `cat` of a large binary
// cannot exhaust server memory or the client.
const maxTerminalOutputBytes = 256 * 1024

func capTerminalOutput(out string) string {
	if len(out) <= maxTerminalOutputBytes {
		return out
	}
	return out[:maxTerminalOutputBytes] + "\n[SYSTEM] Output truncated at " + strconv.Itoa(maxTerminalOutputBytes/1024) + " KiB."
}

// consumeTerminalApproval validates an approval against this exact command and
// atomically spends it. Grants are single-use: without consumption one human
// approval would let an agent re-run the command indefinitely.
func consumeTerminalApproval(approvalID, workspaceID, cmdStr string) (bool, string) {
	approvalID = strings.TrimSpace(approvalID)
	if approvalID == "" {
		return false, "no approval supplied"
	}
	var approval models.AgentApprovalRecord
	if err := db.DB.Where("id = ? AND workspace_id = ?", approvalID, workspaceID).First(&approval).Error; err != nil {
		return false, "approval not found in this workspace"
	}
	if approval.Status != "approved" {
		return false, "approval status is " + approval.Status + ", not approved"
	}
	if approval.Action != "terminal.execute" {
		return false, "approval was not issued for terminal execution"
	}
	if approval.ResolvedAt != nil && time.Since(*approval.ResolvedAt) > approvalGrantTTL {
		return false, "approval expired; request a new one"
	}
	var details map[string]interface{}
	if err := json.Unmarshal(approval.Details, &details); err != nil {
		return false, "approval details unreadable"
	}
	approvedCmd, ok := details["command"].(string)
	if !ok || strings.TrimSpace(approvedCmd) != cmdStr {
		return false, "approval does not cover this exact command"
	}
	// The status predicate in WHERE makes this the atomic spend step, so two
	// concurrent requests cannot both redeem the same grant.
	res := db.DB.Model(&models.AgentApprovalRecord{}).
		Where("id = ? AND workspace_id = ? AND status = ?", approvalID, workspaceID, "approved").
		Update("status", "consumed")
	if res.Error != nil || res.RowsAffected != 1 {
		return false, "approval was already consumed"
	}
	return true, ""
}

// logExecDecision emits one structured audit line per execution attempt. The
// command text lives here rather than in AuditRecord, which deliberately stores
// request metadata only so auditing does not become a second secret store.
func logExecDecision(workspaceID, agentName, outcome, approvalID, workingDir, cmdStr string, eval execpolicy.EvaluationResult, elapsedMs int64) {
	log.Printf("execpolicy: outcome=%s workspace=%s agent=%s risk=%s decision=%s approval=%q duration_ms=%d dir=%q command=%q reason=%q",
		outcome, workspaceID, agentName, eval.Classification.RiskLevel, eval.Decision,
		approvalID, elapsedMs, workingDir, cmdStr, eval.Reason)
}

// ExecuteTerminalCommand handles POST /v1/terminal/execute
func ExecuteTerminalCommand(c *gin.Context) {
	// Strict RCE Prevention: Only allow loopback requests (localhost / 127.0.0.1 / ::1)
	clientIP := c.ClientIP()
	if clientIP != "127.0.0.1" && clientIP != "::1" && clientIP != "localhost" {
		c.JSON(http.StatusForbidden, gin.H{"error": "Terminal execution is restricted to localhost loopback calls only"})
		return
	}

	// Token requirement: Even in dev mode, terminal execution requires a valid X-Workspace-Token
	token := workspaceToken(c)
	if token == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "X-Workspace-Token required for terminal execution"})
		return
	}

	var req executeCommandRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	network := req.Network
	if network == "" {
		network = c.Query("network")
	}
	if network == "" {
		network = c.Param("workspace_id")
	}

	workspace, err := resolveWorkspace(network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Workspace not found"})
		return
	}
	if !authorizeWorkspace(c, workspace) {
		return
	}

	cmdStr := strings.TrimSpace(req.Command)
	if cmdStr == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "command cannot be empty"})
		return
	}

	// 1. Resolve Workspace Execution Policy
	policy := getWorkspacePolicy(workspace)

	agentName := strings.TrimSpace(req.AgentName)
	if agentName == "" {
		agentName = "agent:terminal"
	}

	// 2. Evaluate the command against the workspace policy.
	eval := execpolicy.EvaluateCommand(policy, cmdStr)

	// 3. A supplied approval can only lift a require_approval verdict. A Forbidden
	// command, or one denied by read_only mode, is never redeemable: the whole
	// point of those verdicts is that no agent-supplied token overrides them.
	approvalUsed := ""
	if eval.Decision == execpolicy.DecisionRequireApproval && strings.TrimSpace(req.ApprovalID) != "" {
		if ok, why := consumeTerminalApproval(req.ApprovalID, workspace.ID, cmdStr); ok {
			approvalUsed = strings.TrimSpace(req.ApprovalID)
			eval.Decision = execpolicy.DecisionAllow
			eval.Reason = "Execution granted by human approval " + approvalUsed
		} else {
			// Fall through to a fresh approval request rather than executing, and
			// keep the rejection reason so the caller can tell a stale grant from
			// a first-time prompt.
			eval.Reason = eval.Reason + " (supplied approval rejected: " + why + ")"
		}
	}

	// 4. Handle Policy Decisions
	switch eval.Decision {
	case execpolicy.DecisionDeny:
		logExecDecision(workspace.ID, agentName, "denied", approvalUsed, req.WorkingDir, cmdStr, eval, 0)
		c.JSON(http.StatusForbidden, gin.H{
			"error":          "Command blocked by security policy",
			"reason":         eval.Reason,
			"classification": eval.Classification,
		})
		return

	case execpolicy.DecisionRequireApproval:
		// Automatically create an approval record and notify workspace via WebSocket/SSE
		approvalDetails := map[string]interface{}{
			"command":        cmdStr,
			"working_dir":    req.WorkingDir,
			"agent_name":     agentName,
			"classification": eval.Classification,
			"reason":         eval.Reason,
		}
		detailsBytes, _ := json.Marshal(approvalDetails)

		expiresAt := time.Now().UTC().Add(24 * time.Hour)
		record := models.AgentApprovalRecord{
			ID:          uuid.NewString(),
			WorkspaceID: workspace.ID,
			AgentName:   agentName,
			RequestedBy: agentName,
			Action:      "terminal.execute",
			Details:     detailsBytes,
			Status:      "pending",
			ExpiresAt:   &expiresAt,
		}

		if err := db.DB.Create(&record).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create approval request"})
			return
		}

		_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.agent.approval.requested", agentName, "", gin.H{"approval": record})
		logExecDecision(workspace.ID, agentName, "approval_required", record.ID, req.WorkingDir, cmdStr, eval, 0)

		c.JSON(http.StatusOK, gin.H{
			"status":         "approval_required",
			"approval_id":    record.ID,
			"reason":         eval.Reason,
			"classification": eval.Classification,
			"message":        "Command requires user approval before execution.",
		})
		return

	case execpolicy.DecisionAllow:
		// Proceed to sandboxed execution
	}

	// 5. Sandboxed Directory Resolution
	var workspaceRoot string
	if wd, err := os.Getwd(); err == nil {
		if strings.HasSuffix(filepath.ToSlash(wd), "/backend") {
			workspaceRoot = filepath.Dir(wd)
		} else {
			workspaceRoot = wd
		}
	}

	sandboxedDir, err := execpolicy.ResolveSandboxedDir(workspaceRoot, req.WorkingDir)
	if err != nil {
		logExecDecision(workspace.ID, agentName, "sandbox_violation", approvalUsed, req.WorkingDir, cmdStr, eval, 0)
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Sandbox boundary violation: " + err.Error(),
		})
		return
	}

	// 6. Execution with Timeout & Environment Sanitization
	timeoutSec := policy.MaxTimeoutSec
	if timeoutSec <= 0 {
		timeoutSec = 60
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSec)*time.Second)
	defer cancel()

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", cmdStr)
	} else {
		cmd = exec.CommandContext(ctx, "sh", "-c", cmdStr)
	}

	cmd.Dir = sandboxedDir
	cmd.Env = execpolicy.BuildSanitizedEnv(nil)
	setWindowsHidden(cmd)

	startTime := time.Now()
	outputBytes, err := cmd.CombinedOutput()
	elapsedMs := time.Since(startTime).Milliseconds()
	output := string(outputBytes)

	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			logExecDecision(workspace.ID, agentName, "timeout", approvalUsed, sandboxedDir, cmdStr, eval, elapsedMs)
			c.JSON(http.StatusOK, gin.H{
				"status":         "timeout",
				"output":         capTerminalOutput(output) + "\n[SYSTEM ERROR] Command execution timed out after " + strconv.Itoa(timeoutSec) + " seconds.",
				"duration_ms":    elapsedMs,
				"classification": eval.Classification,
			})
			return
		}
		logExecDecision(workspace.ID, agentName, "error", approvalUsed, sandboxedDir, cmdStr, eval, elapsedMs)
		c.JSON(http.StatusOK, gin.H{
			"status":         "error",
			"output":         capTerminalOutput(output) + "\n[SYSTEM ERROR] " + err.Error(),
			"duration_ms":    elapsedMs,
			"classification": eval.Classification,
		})
		return
	}

	logExecDecision(workspace.ID, agentName, "executed", approvalUsed, sandboxedDir, cmdStr, eval, elapsedMs)
	c.JSON(http.StatusOK, gin.H{
		"status":         "executed",
		"output":         capTerminalOutput(output),
		"duration_ms":    elapsedMs,
		"classification": eval.Classification,
	})
}
