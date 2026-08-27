package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

type AgentRuntimeRequest struct {
	SessionID     string  `json:"session_id" binding:"required"`
	ProcessStatus string  `json:"process_status" binding:"required"`
	HealthStatus  string  `json:"health_status" binding:"required"`
	PID           *int    `json:"pid"`
	RestartCount  int     `json:"restart_count"`
	LastError     *string `json:"last_error"`
}

func validAgentProcessStatus(status string) bool {
	return status == "starting" || status == "running" || status == "stopped" || status == "failed"
}

func validAgentHealthStatus(status string) bool {
	return status == "unknown" || status == "healthy" || status == "degraded" || status == "unhealthy"
}

func requireAgentSession(c *gin.Context, workspace *models.Workspace, agentName, sessionID string) bool {
	if !authorizeWorkspace(c, workspace) {
		return false
	}
	var member models.WorkspaceMember
	if err := db.DB.Where("workspace_id = ? AND agent_name = ?", workspace.ID, agentName).First(&member).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Agent member not registered"})
		return false
	}
	if member.SessionID == nil || *member.SessionID != sessionID {
		c.JSON(http.StatusConflict, gin.H{"error": "session_revoked"})
		return false
	}
	return true
}

// ReportAgentRuntime accepts bridge-originated health reports. The current
// session is required so an older bridge cannot overwrite a rejoined agent.
func ReportAgentRuntime(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	var req AgentRuntimeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if !validAgentProcessStatus(req.ProcessStatus) || !validAgentHealthStatus(req.HealthStatus) || req.RestartCount < 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid runtime status"})
		return
	}
	agentName := c.Param("agent_name")
	if !requireAgentSession(c, workspace, agentName, req.SessionID) {
		return
	}
	record := models.AgentRuntimeRecord{
		WorkspaceID: workspace.ID, AgentName: agentName, SessionID: req.SessionID,
		ProcessStatus: req.ProcessStatus, HealthStatus: req.HealthStatus, PID: req.PID,
		RestartCount: req.RestartCount, LastError: req.LastError,
	}
	if err := db.DB.Where("workspace_id = ? AND agent_name = ?", workspace.ID, agentName).
		Assign(record).FirstOrCreate(&record).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save agent runtime"})
		return
	}
	if err := PublishWorkspaceStateEvent(workspace.ID, "workspace.agent.runtime.updated", "openagents:"+agentName, "", gin.H{"runtime": record}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to publish agent runtime"})
		return
	}
	c.JSON(http.StatusOK, record)
}

func GetAgentRuntime(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	var record models.AgentRuntimeRecord
	if err := db.DB.Where("workspace_id = ? AND agent_name = ?", workspace.ID, c.Param("agent_name")).First(&record).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Agent runtime not found"})
		return
	}
	c.JSON(http.StatusOK, record)
}

func ListAgentRuntimes(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	var records []models.AgentRuntimeRecord
	if err := db.DB.Where("workspace_id = ?", workspace.ID).Order("updated_at desc").Find(&records).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to list agent runtimes"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"runtimes": records})
}

type ReportAgentUsageRequest struct {
	SessionUsedPercent int     `json:"session_used_percent"`
	SessionResetsAt    *string `json:"session_resets_at"`
	WeekUsedPercent    int     `json:"week_used_percent"`
	WeekResetsAt       *string `json:"week_resets_at"`
	Last24hSummary     *string `json:"last_24h_summary"`
	Last7dSummary      *string `json:"last_7d_summary"`
	CurrentModel       *string `json:"current_model"`
	AvailableModels    *string `json:"available_models"`
	CurrentEffort      *string `json:"current_effort"`
	AvailableEfforts   *string `json:"available_efforts"`
	RawText            *string `json:"raw_text"`
}

func ReportAgentUsage(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	var req ReportAgentUsageRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	agentName := c.Param("agent_name")
	record := models.AgentUsageRecord{
		WorkspaceID:        workspace.ID,
		AgentName:          agentName,
		SessionUsedPercent: req.SessionUsedPercent,
		SessionResetsAt:    req.SessionResetsAt,
		WeekUsedPercent:    req.WeekUsedPercent,
		WeekResetsAt:       req.WeekResetsAt,
		Last24hSummary:     req.Last24hSummary,
		Last7dSummary:      req.Last7dSummary,
		CurrentModel:       req.CurrentModel,
		AvailableModels:    req.AvailableModels,
		CurrentEffort:      req.CurrentEffort,
		AvailableEfforts:   req.AvailableEfforts,
		RawText:            req.RawText,
	}
	if err := db.DB.Where("workspace_id = ? AND agent_name = ?", workspace.ID, agentName).
		Assign(record).FirstOrCreate(&record).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save agent usage"})
		return
	}
	_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.agent.usage.updated", "openagents:"+agentName, "", gin.H{"usage": record})
	c.JSON(http.StatusOK, record)
}

func GetAgentUsage(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	agentName := c.Param("agent_name")
	var record models.AgentUsageRecord
	if err := db.DB.Where("workspace_id = ? AND agent_name = ?", workspace.ID, agentName).First(&record).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Agent usage not found"})
		return
	}
	c.JSON(http.StatusOK, record)
}

type CreateAgentLogRequest struct {
	SessionID string `json:"session_id" binding:"required"`
	Level     string `json:"level"`
	Message   string `json:"message" binding:"required"`
}

func CreateAgentLog(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	var req CreateAgentLogRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	agentName := c.Param("agent_name")
	if !requireAgentSession(c, workspace, agentName, req.SessionID) {
		return
	}
	level := req.Level
	if level == "" {
		level = "info"
	}
	if level != "debug" && level != "info" && level != "warn" && level != "error" || strings.TrimSpace(req.Message) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid log level or empty message"})
		return
	}
	record := models.AgentLogRecord{ID: uuid.NewString(), WorkspaceID: workspace.ID, AgentName: agentName, Level: level, Message: strings.TrimSpace(req.Message)}
	if err := db.DB.Create(&record).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to store agent log"})
		return
	}
	c.JSON(http.StatusCreated, record)
}

func ListAgentLogs(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	limit, err := strconv.Atoi(c.DefaultQuery("limit", "100"))
	if err != nil || limit < 1 || limit > 500 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "limit must be between 1 and 500"})
		return
	}
	var logs []models.AgentLogRecord
	if err := db.DB.Where("workspace_id = ? AND agent_name = ?", workspace.ID, c.Param("agent_name")).Order("created_at desc").Limit(limit).Find(&logs).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to list agent logs"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"logs": logs})
}

type CreateAgentApprovalRequest struct {
	Network     string                 `json:"network" binding:"required"`
	AgentName   string                 `json:"agent_name" binding:"required"`
	RequestedBy string                 `json:"requested_by" binding:"required"`
	Action      string                 `json:"action" binding:"required"`
	Details     map[string]interface{} `json:"details"`
}

func CreateAgentApproval(c *gin.Context) {
	var req CreateAgentApprovalRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	workspace, err := resolveWorkspace(req.Network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Workspace not found"})
		return
	}
	if !authorizeWorkspace(c, workspace) {
		return
	}
	if strings.TrimSpace(req.Action) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "action is required"})
		return
	}
	details, err := json.Marshal(req.Details)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid approval details"})
		return
	}
	expiresAt := time.Now().UTC().Add(24 * time.Hour)
	record := models.AgentApprovalRecord{
		ID:          uuid.NewString(),
		WorkspaceID: workspace.ID,
		AgentName:   req.AgentName,
		RequestedBy: req.RequestedBy,
		Action:      strings.TrimSpace(req.Action),
		Details:     details,
		Status:      "pending",
		ExpiresAt:   &expiresAt,
	}
	if err := db.DB.Create(&record).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create approval"})
		return
	}
	if err := PublishWorkspaceStateEvent(workspace.ID, "workspace.agent.approval.requested", req.RequestedBy, "", gin.H{"approval": record}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to publish approval"})
		return
	}
	c.JSON(http.StatusCreated, record)
}

func ListAgentApprovals(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	query := db.DB.Where("workspace_id = ?", workspace.ID)
	if status := c.Query("status"); status != "" {
		query = query.Where("status = ?", status)
	}
	var approvals []models.AgentApprovalRecord
	if err := query.Order("created_at desc").Find(&approvals).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to list approvals"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"approvals": approvals})
}

func ResolveAgentApproval(c *gin.Context) {
	var req struct {
		Status     string `json:"status" binding:"required"`
		ResolvedBy string `json:"resolved_by"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if req.Status != "approved" && req.Status != "rejected" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "status must be approved or rejected"})
		return
	}
	var record models.AgentApprovalRecord
	if err := db.DB.Where("id = ?", c.Param("approval_id")).First(&record).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Approval not found"})
		return
	}
	workspace, err := resolveWorkspace(record.WorkspaceID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Workspace not found"})
		return
	}
	if !authorizeWorkspace(c, workspace) {
		return
	}
	if record.Status != "pending" {
		c.JSON(http.StatusConflict, gin.H{"error": "approval_already_resolved"})
		return
	}
	resolvedBy := req.ResolvedBy
	if resolvedBy == "" {
		resolvedBy = "human:user"
	}
	now := time.Now()
	if err := db.DB.Model(&record).Updates(map[string]interface{}{"status": req.Status, "resolved_by": resolvedBy, "resolved_at": now}).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to resolve approval"})
		return
	}
	record.Status, record.ResolvedBy, record.ResolvedAt = req.Status, &resolvedBy, &now
	if err := PublishWorkspaceStateEvent(workspace.ID, "workspace.agent.approval."+req.Status, resolvedBy, "", gin.H{"approval": record}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to publish approval update"})
		return
	}
	c.JSON(http.StatusOK, record)
}
