package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

// postExecute drives POST /v1/terminal/execute the way an agent would.
func postExecute(t *testing.T, router http.Handler, wsID, token, cmd, approvalID string) (int, map[string]interface{}) {
	t.Helper()
	payload := map[string]string{"network": wsID, "command": cmd, "agent_name": "coder-agent"}
	if approvalID != "" {
		payload["approval_id"] = approvalID
	}
	body, _ := json.Marshal(payload)
	req := httptest.NewRequest("POST", "/v1/terminal/execute", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Workspace-Token", token)
	req.RemoteAddr = "127.0.0.1:12345"
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, req)
	var decoded map[string]interface{}
	_ = json.Unmarshal(recorder.Body.Bytes(), &decoded)
	return recorder.Code, decoded
}

// forceApprovalPolicy makes `echo` require approval, so the grant lifecycle can be
// exercised with a command whose execution has no side effects on the checkout.
func forceApprovalPolicy(t *testing.T, wsID string) {
	t.Helper()
	settings := []byte(`{"exec_policy":{"mode":"balanced","max_timeout_sec":30,"custom_approval":["echo"]}}`)
	if err := db.DB.Model(&models.Workspace{}).Where("id = ?", wsID).Update("settings", settings).Error; err != nil {
		t.Fatalf("set workspace policy: %v", err)
	}
}

// grantApproval writes an already-approved grant for cmd, as a human resolving the
// request through ResolveAgentApproval would.
func grantApproval(t *testing.T, wsID, cmd string, resolvedAt time.Time) string {
	t.Helper()
	details, _ := json.Marshal(map[string]interface{}{"command": cmd})
	resolvedBy := "human:admin"
	record := models.AgentApprovalRecord{
		ID:          uuid.NewString(),
		WorkspaceID: wsID,
		AgentName:   "coder-agent",
		RequestedBy: "coder-agent",
		Action:      "terminal.execute",
		Details:     details,
		Status:      "approved",
		ResolvedBy:  &resolvedBy,
		ResolvedAt:  &resolvedAt,
	}
	if err := db.DB.Create(&record).Error; err != nil {
		t.Fatalf("create approval: %v", err)
	}
	return record.ID
}

func approvalStatus(t *testing.T, approvalID string) string {
	t.Helper()
	var record models.AgentApprovalRecord
	if err := db.DB.Where("id = ?", approvalID).First(&record).Error; err != nil {
		t.Fatalf("reload approval: %v", err)
	}
	return record.Status
}

// An approval is a single-use grant. Without consumption, one human "yes" lets an
// agent re-run the command forever by resubmitting the same approval_id.
func TestTerminalExecute_ApprovalIsSingleUse(t *testing.T) {
	router, ws, token := terminalTestRouter(t)
	forceApprovalPolicy(t, ws.ID)

	cmd := "echo single-use-grant"
	approvalID := grantApproval(t, ws.ID, cmd, time.Now())

	code, first := postExecute(t, router, ws.ID, token, cmd, approvalID)
	if code != http.StatusOK || first["status"] != "executed" {
		t.Fatalf("first redemption should execute, got %d %v", code, first["status"])
	}
	if got := approvalStatus(t, approvalID); got != "consumed" {
		t.Fatalf("approval status after redemption = %q, want consumed", got)
	}

	code, second := postExecute(t, router, ws.ID, token, cmd, approvalID)
	if code != http.StatusOK {
		t.Fatalf("replay returned %d, body %v", code, second)
	}
	if second["status"] != "approval_required" {
		t.Fatalf("replayed approval executed again: status = %v", second["status"])
	}
	if reason, _ := second["reason"].(string); !strings.Contains(reason, "consumed") {
		t.Errorf("replay reason should name the spent grant, got %q", reason)
	}
}

// Forbidden commands are absolute. An agent-supplied approval must not launder one
// into execution, no matter how the grant was obtained.
func TestTerminalExecute_ApprovalCannotOverrideForbidden(t *testing.T) {
	router, ws, token := terminalTestRouter(t)

	cmd := "rm -rf /"
	approvalID := grantApproval(t, ws.ID, cmd, time.Now())

	code, resp := postExecute(t, router, ws.ID, token, cmd, approvalID)
	if code != http.StatusForbidden {
		t.Fatalf("forbidden command with approval returned %d, want 403. body: %v", code, resp)
	}
	if got := approvalStatus(t, approvalID); got != "approved" {
		t.Errorf("grant should be left untouched on a denied command, status = %q", got)
	}
}

// A grant covers one exact command string, so it cannot be pointed at a different
// command than the reviewer saw.
func TestTerminalExecute_ApprovalBoundToExactCommand(t *testing.T) {
	router, ws, token := terminalTestRouter(t)
	forceApprovalPolicy(t, ws.ID)

	approvalID := grantApproval(t, ws.ID, "echo alpha", time.Now())

	code, resp := postExecute(t, router, ws.ID, token, "echo beta", approvalID)
	if code != http.StatusOK || resp["status"] != "approval_required" {
		t.Fatalf("substituted command should need its own approval, got %d %v", code, resp["status"])
	}
	if got := approvalStatus(t, approvalID); got != "approved" {
		t.Errorf("grant for another command must not be spent, status = %q", got)
	}
}

// A grant expires, so an approval cannot be banked and redeemed long after the
// reviewer had the context to judge it.
func TestTerminalExecute_ApprovalExpires(t *testing.T) {
	router, ws, token := terminalTestRouter(t)
	forceApprovalPolicy(t, ws.ID)

	cmd := "echo stale-grant"
	approvalID := grantApproval(t, ws.ID, cmd, time.Now().Add(-2*approvalGrantTTL))

	code, resp := postExecute(t, router, ws.ID, token, cmd, approvalID)
	if code != http.StatusOK || resp["status"] != "approval_required" {
		t.Fatalf("expired grant should not execute, got %d %v", code, resp["status"])
	}
	if reason, _ := resp["reason"].(string); !strings.Contains(reason, "expired") {
		t.Errorf("reason should say the grant expired, got %q", reason)
	}
}

// read_only mode has to hold against writes that lead with a read-only verb.
func TestTerminalExecute_ReadOnlyModeBlocksRedirectedWrite(t *testing.T) {
	router, ws, token := terminalTestRouter(t)
	settings := []byte(`{"exec_policy":{"mode":"read_only","max_timeout_sec":30}}`)
	if err := db.DB.Model(&models.Workspace{}).Where("id = ?", ws.ID).Update("settings", settings).Error; err != nil {
		t.Fatalf("set read_only policy: %v", err)
	}

	code, resp := postExecute(t, router, ws.ID, token, "echo pwned > internal/db/db.go", "")
	if code != http.StatusForbidden {
		t.Fatalf("redirected write in read_only mode returned %d, want 403. body: %v", code, resp)
	}

	code, resp = postExecute(t, router, ws.ID, token, "git status", "")
	if code != http.StatusOK || resp["status"] != "executed" {
		t.Fatalf("read_only mode should still run inspection commands, got %d %v", code, resp["status"])
	}
}

func TestCapTerminalOutput(t *testing.T) {
	short := strings.Repeat("a", 128)
	if capTerminalOutput(short) != short {
		t.Errorf("output under the cap must pass through unchanged")
	}

	long := strings.Repeat("b", maxTerminalOutputBytes+4096)
	capped := capTerminalOutput(long)
	if len(capped) >= len(long) {
		t.Errorf("oversized output was not truncated: %d bytes", len(capped))
	}
	if !strings.Contains(capped, "Output truncated") {
		t.Errorf("truncated output should say so, got tail %q", capped[len(capped)-64:])
	}
}
