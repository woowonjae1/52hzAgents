package handlers

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

var workflowNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,49}$`)

// SavedWorkflowRequest is the body of POST /v1/workspaces/:workspace_id/workflows.
type SavedWorkflowRequest struct {
	Name        string                `json:"name"`
	Description string                `json:"description,omitempty"`
	Steps       []models.PipelineStep `json:"steps"`
}

// SavedWorkflowRunRequest is POST .../workflows/:id/run.
type SavedWorkflowRunRequest struct {
	Channel string `json:"channel"`
	Source  string `json:"source,omitempty"`
}

// ListSavedWorkflows handles GET /v1/workspaces/:workspace_id/workflows.
func ListSavedWorkflows(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	var workflows []models.SavedWorkflow
	if err := db.DB.Where("workspace_id = ?", workspace.ID).Order("name asc").Find(&workflows).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to query workflows"})
		return
	}
	type item struct {
		ID          string                `json:"id"`
		Name        string                `json:"name"`
		Description string                `json:"description"`
		Steps       []models.PipelineStep `json:"steps"`
		CreatedAt   time.Time             `json:"created_at"`
		UpdatedAt   time.Time             `json:"updated_at"`
	}
	items := make([]item, 0, len(workflows))
	for _, w := range workflows {
		var steps []models.PipelineStep
		_ = json.Unmarshal([]byte(w.StepsJSON), &steps)
		items = append(items, item{
			ID:          w.ID,
			Name:        w.Name,
			Description: w.Description,
			Steps:       steps,
			CreatedAt:   w.CreatedAt,
			UpdatedAt:   w.UpdatedAt,
		})
	}
	c.JSON(http.StatusOK, gin.H{"workflows": items})
}

// SaveWorkflow handles POST /v1/workspaces/:workspace_id/workflows.
func SaveWorkflow(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	var req SavedWorkflowRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body: " + err.Error()})
		return
	}
	name := strings.ToLower(strings.TrimSpace(req.Name))
	if !workflowNamePattern.MatchString(name) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name must be 1-50 characters: lowercase letters, digits, - or _, starting with a letter or digit"})
		return
	}
	if len(req.Steps) < 2 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "workflow requires at least 2 pipeline steps"})
		return
	}
	for i, step := range req.Steps {
		if strings.TrimSpace(step.Agent) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "step agent cannot be empty"})
			return
		}
		if strings.TrimSpace(step.Instruction) == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "step instruction cannot be empty"})
			return
		}
		req.Steps[i].Status = "pending"
	}
	encoded, err := json.Marshal(req.Steps)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "failed to encode steps: " + err.Error()})
		return
	}

	var existing models.SavedWorkflow
	if err := db.DB.Where("workspace_id = ? AND name = ?", workspace.ID, name).First(&existing).Error; err == nil {
		// Update existing
		existing.Description = req.Description
		existing.StepsJSON = string(encoded)
		existing.UpdatedAt = time.Now()
		if err := db.DB.Save(&existing).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update workflow"})
			return
		}
		c.JSON(http.StatusOK, existing)
		return
	}

	wf := models.SavedWorkflow{
		ID:          uuid.NewString(),
		WorkspaceID: workspace.ID,
		Name:        name,
		Description: req.Description,
		StepsJSON:   string(encoded),
	}
	if err := db.DB.Create(&wf).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to create workflow"})
		return
	}
	c.JSON(http.StatusCreated, wf)
}

// DeleteSavedWorkflow handles DELETE /v1/workspaces/:workspace_id/workflows/:id.
func DeleteSavedWorkflow(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	id := c.Param("id")
	res := db.DB.Where("workspace_id = ? AND id = ?", workspace.ID, id).Delete(&models.SavedWorkflow{})
	if res.Error != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete workflow"})
		return
	}
	if res.RowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "workflow not found"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// RunSavedWorkflow handles POST /v1/workspaces/:workspace_id/workflows/:id/run.
func RunSavedWorkflow(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	id := c.Param("id")
	var wf models.SavedWorkflow
	if err := db.DB.Where("workspace_id = ? AND id = ?", workspace.ID, id).First(&wf).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "workflow not found"})
		return
	}

	var req SavedWorkflowRunRequest
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Channel) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "channel is required"})
		return
	}

	var channel models.Channel
	chName := strings.TrimSpace(req.Channel)
	if err := db.DB.Where("workspace_id = ? AND (id = ? OR name = ?)", workspace.ID, chName, chName).First(&channel).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "channel not found"})
		return
	}

	// Check for active pipeline in channel
	var active models.ChannelPipeline
	if err := db.DB.Where("channel_id = ? AND status IN ?", channel.ID, []string{"running", "retrying"}).First(&active).Error; err == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "a pipeline is already running in this channel"})
		return
	}

	var steps []models.PipelineStep
	if err := json.Unmarshal([]byte(wf.StepsJSON), &steps); err != nil || len(steps) < 2 {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "corrupted workflow steps"})
		return
	}

	now := time.Now().UnixMilli()
	steps[0].Status = "running"
	steps[0].StartedAt = &now
	encodedSteps, _ := json.Marshal(steps)

	source := req.Source
	if source == "" {
		source = "workflow:" + wf.Name
	}

	pipeline := models.ChannelPipeline{
		ID:              uuid.NewString(),
		WorkspaceID:     workspace.ID,
		ChannelID:       channel.ID,
		Steps:           encodedSteps,
		CurrentIndex:    0,
		Status:          "running",
		TotalRetries:    0,
		MaxTotalRetries: 6,
		StartedBy:       source,
	}

	if err := db.DB.Create(&pipeline).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to start workflow pipeline"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"ok":          true,
		"pipeline_id": pipeline.ID,
		"workflow":    wf.Name,
		"step":        steps[0],
	})
}
