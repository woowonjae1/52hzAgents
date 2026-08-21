package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/execpolicy"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

// Helper to extract ExecPolicy from Workspace.Settings JSON
func getWorkspacePolicy(workspace *models.Workspace) *execpolicy.ExecPolicy {
	if workspace == nil || len(workspace.Settings) == 0 {
		return execpolicy.DefaultPolicy()
	}

	var settings map[string]interface{}
	if err := json.Unmarshal(workspace.Settings, &settings); err != nil {
		return execpolicy.DefaultPolicy()
	}

	rawPolicy, exists := settings["exec_policy"]
	if !exists {
		return execpolicy.DefaultPolicy()
	}

	policyBytes, err := json.Marshal(rawPolicy)
	if err != nil {
		return execpolicy.DefaultPolicy()
	}

	var policy execpolicy.ExecPolicy
	if err := json.Unmarshal(policyBytes, &policy); err != nil {
		return execpolicy.DefaultPolicy()
	}

	if policy.Mode == "" {
		policy.Mode = execpolicy.ModeBalanced
	}
	if policy.MaxTimeoutSec <= 0 {
		policy.MaxTimeoutSec = 60
	}

	return &policy
}

// GetWorkspaceExecPolicy handles GET /v1/workspaces/:workspace_id/policy/exec
func GetWorkspaceExecPolicy(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}

	policy := getWorkspacePolicy(workspace)
	c.JSON(http.StatusOK, gin.H{
		"workspace_id": workspace.ID,
		"policy":       policy,
	})
}

// UpdateWorkspaceExecPolicy handles PUT /v1/workspaces/:workspace_id/policy/exec
func UpdateWorkspaceExecPolicy(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}

	if !authorizeWorkspace(c, workspace) {
		return
	}

	var newPolicy execpolicy.ExecPolicy
	if err := c.ShouldBindJSON(&newPolicy); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Validate mode
	validModes := map[execpolicy.PolicyMode]bool{
		execpolicy.ModePermissive: true,
		execpolicy.ModeBalanced:   true,
		execpolicy.ModeStrict:     true,
		execpolicy.ModeReadOnly:   true,
	}
	if !validModes[newPolicy.Mode] {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid policy mode. Allowed: permissive, balanced, strict, read_only"})
		return
	}

	if newPolicy.MaxTimeoutSec <= 0 {
		newPolicy.MaxTimeoutSec = 60
	} else if newPolicy.MaxTimeoutSec > 300 {
		newPolicy.MaxTimeoutSec = 300
	}

	// Merge into workspace.Settings
	var settings map[string]interface{}
	if len(workspace.Settings) > 0 {
		_ = json.Unmarshal(workspace.Settings, &settings)
	}
	if settings == nil {
		settings = make(map[string]interface{})
	}

	settings["exec_policy"] = newPolicy
	updatedSettingsBytes, err := json.Marshal(settings)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to serialize settings"})
		return
	}

	if err := db.DB.Model(workspace).Update("settings", updatedSettingsBytes).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update workspace policy"})
		return
	}

	workspace.Settings = updatedSettingsBytes
	_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.policy.exec.updated", "human:user", "", gin.H{"policy": newPolicy})

	c.JSON(http.StatusOK, gin.H{
		"workspace_id": workspace.ID,
		"policy":       newPolicy,
	})
}
