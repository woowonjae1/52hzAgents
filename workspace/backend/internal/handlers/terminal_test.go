package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/execpolicy"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"gorm.io/gorm"
)

func terminalTestRouter(t *testing.T) (*gin.Engine, models.Workspace, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	database, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:%s?mode=memory&cache=shared", uuid.NewString())), &gorm.Config{})
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	if err := database.AutoMigrate(
		&models.Workspace{}, &models.WorkspaceMember{}, &models.Channel{}, &models.ChannelMember{},
		&models.EventRecord{}, &models.AgentApprovalRecord{},
	); err != nil {
		t.Fatalf("migrate test database: %v", err)
	}
	db.DB = database

	token := "test-terminal-token"
	hash := hashWorkspaceToken(token)
	workspace := models.Workspace{
		ID:           uuid.NewString(),
		Slug:         "test-ws",
		Name:         "Terminal Test WS",
		PasswordHash: &hash,
		Settings:     []byte(`{"exec_policy":{"mode":"balanced","max_timeout_sec":30}}`),
	}
	if err := database.Create(&workspace).Error; err != nil {
		t.Fatalf("create workspace: %v", err)
	}

	router := gin.New()
	router.POST("/v1/terminal/execute", ExecuteTerminalCommand)
	router.GET("/v1/workspaces/:workspace_id/policy/exec", GetWorkspaceExecPolicy)
	router.PUT("/v1/workspaces/:workspace_id/policy/exec", UpdateWorkspaceExecPolicy)
	router.PATCH("/v1/approvals/:approval_id", ResolveAgentApproval)

	return router, workspace, token
}

func TestTerminalExecute_ForbiddenCommand(t *testing.T) {
	router, ws, token := terminalTestRouter(t)

	body, _ := json.Marshal(map[string]string{
		"network": ws.ID,
		"command": "rm -rf /",
	})
	req := httptest.NewRequest("POST", "/v1/terminal/execute", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Workspace-Token", token)
	req.RemoteAddr = "127.0.0.1:12345"

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("Expected 403 Forbidden for 'rm -rf /', got %d. Body: %s", w.Code, w.Body.String())
	}
}

func TestTerminalExecute_SafeCommand(t *testing.T) {
	router, ws, token := terminalTestRouter(t)

	body, _ := json.Marshal(map[string]string{
		"network": ws.ID,
		"command": "echo 'safe command execution test'",
	})
	req := httptest.NewRequest("POST", "/v1/terminal/execute", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Workspace-Token", token)
	req.RemoteAddr = "127.0.0.1:12345"

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK for safe echo command, got %d. Body: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("Failed to parse response JSON: %v", err)
	}

	if resp["status"] != "executed" {
		t.Errorf("Expected status 'executed', got %v", resp["status"])
	}
}

func TestTerminalExecute_RequireApprovalFlow(t *testing.T) {
	router, ws, token := terminalTestRouter(t)

	// 1. Send modifying command that requires approval (in balanced mode)
	modCmd := "npm install lodash"
	body, _ := json.Marshal(map[string]string{
		"network":    ws.ID,
		"command":    modCmd,
		"agent_name": "coder-agent",
	})
	req := httptest.NewRequest("POST", "/v1/terminal/execute", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Workspace-Token", token)
	req.RemoteAddr = "127.0.0.1:12345"

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK for approval request, got %d. Body: %s", w.Code, w.Body.String())
	}

	var resp map[string]interface{}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if resp["status"] != "approval_required" {
		t.Fatalf("Expected status 'approval_required', got %v", resp["status"])
	}

	approvalID, ok := resp["approval_id"].(string)
	if !ok || approvalID == "" {
		t.Fatalf("Expected non-empty approval_id in response")
	}

	// Verify approval record was created in database
	var approval models.AgentApprovalRecord
	if err := db.DB.Where("id = ?", approvalID).First(&approval).Error; err != nil {
		t.Fatalf("Approval record not found in DB: %v", err)
	}
	if approval.Status != "pending" {
		t.Errorf("Expected pending approval status, got %s", approval.Status)
	}

	// 2. Approve the command as human
	resolveBody, _ := json.Marshal(map[string]string{
		"status":      "approved",
		"resolved_by": "human:admin",
	})
	resolveReq := httptest.NewRequest("PATCH", "/v1/approvals/"+approvalID, bytes.NewReader(resolveBody))
	resolveReq.Header.Set("Content-Type", "application/json")
	resolveReq.Header.Set("X-Workspace-Token", token)
	resolveReq.RemoteAddr = "127.0.0.1:12345"

	wResolve := httptest.NewRecorder()
	router.ServeHTTP(wResolve, resolveReq)
	if wResolve.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK resolving approval, got %d. Body: %s", wResolve.Code, wResolve.Body.String())
	}

	// 3. Now re-run command supplying the approved approval_id
	approvedEchoCmd := "echo 'now approved and running'"
	detailsBytes, _ := json.Marshal(map[string]interface{}{"command": approvedEchoCmd})
	approvedRecord := models.AgentApprovalRecord{
		ID:          uuid.NewString(),
		WorkspaceID: ws.ID,
		AgentName:   "coder-agent",
		RequestedBy: "coder-agent",
		Action:      "terminal.execute",
		Details:     detailsBytes,
		Status:      "approved",
	}
	db.DB.Create(&approvedRecord)

	execBody, _ := json.Marshal(map[string]string{
		"network":     ws.ID,
		"command":     approvedEchoCmd,
		"approval_id": approvedRecord.ID,
	})
	execReq := httptest.NewRequest("POST", "/v1/terminal/execute", bytes.NewReader(execBody))
	execReq.Header.Set("Content-Type", "application/json")
	execReq.Header.Set("X-Workspace-Token", token)
	execReq.RemoteAddr = "127.0.0.1:12345"

	wExec := httptest.NewRecorder()
	router.ServeHTTP(wExec, execReq)
	if wExec.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK executing approved command, got %d. Body: %s", wExec.Code, wExec.Body.String())
	}

	var execResp map[string]interface{}
	_ = json.Unmarshal(wExec.Body.Bytes(), &execResp)
	if execResp["status"] != "executed" {
		t.Errorf("Expected status 'executed' for approved command, got %v", execResp["status"])
	}
}

func TestWorkspaceExecPolicy_GetAndPut(t *testing.T) {
	router, ws, token := terminalTestRouter(t)

	// 1. Get current policy
	getReq := httptest.NewRequest("GET", "/v1/workspaces/"+ws.ID+"/policy/exec", nil)
	getReq.Header.Set("X-Workspace-Token", token)
	getReq.RemoteAddr = "127.0.0.1:12345"

	wGet := httptest.NewRecorder()
	router.ServeHTTP(wGet, getReq)
	if wGet.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK getting policy, got %d. Body: %s", wGet.Code, wGet.Body.String())
	}

	// 2. Update to strict mode with custom rules
	newPolicy := execpolicy.ExecPolicy{
		Mode:          execpolicy.ModeStrict,
		CustomAllowed: []string{"npm run build"},
		CustomDenied:  []string{"curl http://test.com"},
		MaxTimeoutSec: 45,
	}
	putBody, _ := json.Marshal(newPolicy)
	putReq := httptest.NewRequest("PUT", "/v1/workspaces/"+ws.ID+"/policy/exec", bytes.NewReader(putBody))
	putReq.Header.Set("Content-Type", "application/json")
	putReq.Header.Set("X-Workspace-Token", token)
	putReq.RemoteAddr = "127.0.0.1:12345"

	wPut := httptest.NewRecorder()
	router.ServeHTTP(wPut, putReq)
	if wPut.Code != http.StatusOK {
		t.Fatalf("Expected 200 OK updating policy, got %d. Body: %s", wPut.Code, wPut.Body.String())
	}

	var putResp map[string]interface{}
	_ = json.Unmarshal(wPut.Body.Bytes(), &putResp)
	policyMap, _ := putResp["policy"].(map[string]interface{})
	if policyMap["mode"] != "strict" {
		t.Errorf("Expected mode 'strict', got %v", policyMap["mode"])
	}
}
