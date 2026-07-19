package handlers

// Workspace member and collaborator management.
//
//	DELETE /v1/workspaces/:workspace_id/members/:agent_name                       Remove an agent
//	PATCH  /v1/workspaces/:workspace_id/members/:agent_name                       Update agent metadata
//	POST   /v1/workspaces/:workspace_id/members/:agent_name/generate-description  Draft a role line via the router LLM
//	GET    /v1/workspaces/:workspace_id/collaborators                             List email collaborators
//	POST   /v1/workspaces/:workspace_id/collaborators                             Add / update a collaborator
//	DELETE /v1/workspaces/:workspace_id/collaborators/:email                      Remove a collaborator

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

// workspaceForParam resolves the :workspace_id path param and enforces the
// workspace credential. It is the members/collaborators analogue of
// requestWorkspace (which prefers the ?network query param).
func workspaceForParam(c *gin.Context) (*models.Workspace, bool) {
	workspace, err := resolveWorkspace(c.Param("workspace_id"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Workspace not found"})
		return nil, false
	}
	if !authorizeWorkspace(c, workspace) {
		return nil, false
	}
	return workspace, true
}

func memberForParam(c *gin.Context, workspace *models.Workspace) (*models.WorkspaceMember, bool) {
	var member models.WorkspaceMember
	if err := db.DB.Where("workspace_id = ? AND agent_name = ?", workspace.ID, c.Param("agent_name")).
		First(&member).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Member not found"})
		return nil, false
	}
	return &member, true
}

// RemoveMember handles DELETE /v1/workspaces/:workspace_id/members/:agent_name.
func RemoveMember(c *gin.Context) {
	workspace, ok := workspaceForParam(c)
	if !ok {
		return
	}
	member, ok := memberForParam(c, workspace)
	if !ok {
		return
	}
	if err := db.DB.Delete(member).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to remove member"})
		return
	}
	_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.member.removed", "human:user", "", gin.H{
		"agent_name": member.AgentName,
	})
	c.JSON(http.StatusOK, gin.H{"agent_name": member.AgentName, "removed": true})
}

type memberUpdateRequest struct {
	Description   *string          `json:"description"`
	Role          *string          `json:"role"`
	EnabledSkills map[string]bool  `json:"enabled_skills"`
}

// UpdateMember handles PATCH /v1/workspaces/:workspace_id/members/:agent_name.
func UpdateMember(c *gin.Context) {
	workspace, ok := workspaceForParam(c)
	if !ok {
		return
	}
	var req memberUpdateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	member, ok := memberForParam(c, workspace)
	if !ok {
		return
	}
	updates := map[string]interface{}{}
	if req.Description != nil {
		updates["description"] = *req.Description
		member.Description = req.Description
	}
	if req.Role != nil {
		updates["role"] = *req.Role
		member.Role = *req.Role
	}
	if req.EnabledSkills != nil {
		skillsBytes, _ := json.Marshal(req.EnabledSkills)
		updates["enabled_skills"] = skillsBytes
		member.EnabledSkills = skillsBytes
	}
	if len(updates) > 0 {
		if err := db.DB.Model(member).Updates(updates).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update member"})
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"agentName":     member.AgentName,
		"description":   member.Description,
		"role":          member.Role,
		"enabledSkills": decodeJSONMap(member.EnabledSkills),
	})
}

const memberDescriptionPrompt = `Write a ONE-LINE role description for an AI agent in a multi-agent workspace, so a router can decide when to delegate tasks to it.

Agent name: %s
Type: %s
Working directory: %s
Installed skills: %s

Recent messages this agent has posted (newest last):
%s

Write ONE concise sentence (max ~16 words), third person, describing this agent's specialty/role and the kinds of tasks it handles. No name prefix, no quotes, no trailing period needed. If signal is thin, infer from the name, type, working directory, and skills. Output ONLY the sentence.`

// GenerateMemberDescription handles POST
// /v1/workspaces/:workspace_id/members/:agent_name/generate-description. It
// drafts a one-line role description via the router LLM and returns it WITHOUT
// saving; the client persists it via PATCH if accepted.
func GenerateMemberDescription(c *gin.Context) {
	workspace, ok := workspaceForParam(c)
	if !ok {
		return
	}
	member, ok := memberForParam(c, workspace)
	if !ok {
		return
	}
	settings := config.GlobalConfig
	if settings == nil || settings.RouterLLMAPIKey == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Description generation is unavailable (no router LLM key configured)"})
		return
	}

	agentName := member.AgentName
	var recent []models.EventRecord
	db.DB.Where("network_id = ? AND source = ? AND type = ?", workspace.ID, "openagents:"+agentName, "workspace.message.posted").
		Order("timestamp desc").Limit(15).Find(&recent)
	snippets := make([]string, 0, len(recent))
	for i := len(recent) - 1; i >= 0; i-- {
		var payload map[string]interface{}
		if json.Unmarshal(recent[i].Payload, &payload) != nil {
			continue
		}
		if messageType(payload) != "chat" {
			continue
		}
		text, _ := payload["content"].(string)
		text = strings.ReplaceAll(strings.TrimSpace(text), "\n", " ")
		if text != "" {
			snippets = append(snippets, "- "+truncateRouterText(text, 200))
		}
	}
	history := "(no recent messages)"
	if len(snippets) > 0 {
		history = strings.Join(snippets, "\n")
	}

	agentType := "unknown"
	if member.AgentType != nil && *member.AgentType != "" {
		agentType = *member.AgentType
	}
	workingDir := "(unknown)"
	if member.WorkingDir != nil && *member.WorkingDir != "" {
		workingDir = *member.WorkingDir
	}
	skills := "(none listed)"
	enabled := decodeJSONMap(member.EnabledSkills)
	if installed, ok := enabled["installed"].([]interface{}); ok && len(installed) > 0 {
		names := make([]string, 0, len(installed))
		for _, item := range installed {
			if name, ok := item.(string); ok {
				names = append(names, name)
			}
		}
		if len(names) > 0 {
			skills = strings.Join(names, ", ")
		}
	}

	prompt := fmt.Sprintf(memberDescriptionPrompt, agentName, agentType, workingDir, skills, history)
	text, err := requestRouterDecision(settings, prompt)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to generate description"})
		return
	}
	text = strings.TrimSpace(text)
	text = strings.Trim(text, "\"'")
	text = strings.TrimRight(text, ".")
	text = strings.TrimSpace(text)
	c.JSON(http.StatusOK, gin.H{"agentName": agentName, "description": text})
}

func formatCollaborator(collab *models.WorkspaceCollaborator) gin.H {
	return gin.H{
		"email":       collab.Email,
		"displayName": collab.DisplayName,
		"role":        collab.Role,
		"addedBy":     collab.AddedBy,
		"addedAt":     collab.AddedAt,
	}
}

// ListCollaborators handles GET /v1/workspaces/:workspace_id/collaborators.
func ListCollaborators(c *gin.Context) {
	workspace, ok := workspaceForParam(c)
	if !ok {
		return
	}
	var collaborators []models.WorkspaceCollaborator
	db.DB.Where("workspace_id = ?", workspace.ID).Order("added_at asc").Find(&collaborators)
	items := make([]gin.H, 0, len(collaborators))
	for i := range collaborators {
		items = append(items, formatCollaborator(&collaborators[i]))
	}
	c.JSON(http.StatusOK, gin.H{"collaborators": items, "owner": workspace.CreatorEmail})
}

type collaboratorAddRequest struct {
	Email string `json:"email" binding:"required"`
	Role  string `json:"role"`
}

// AddCollaborator handles POST /v1/workspaces/:workspace_id/collaborators.
func AddCollaborator(c *gin.Context) {
	workspace, ok := workspaceForParam(c)
	if !ok {
		return
	}
	var req collaboratorAddRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if email == "" || !strings.Contains(email, "@") {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid email address"})
		return
	}
	role := req.Role
	if role != "viewer" {
		role = "editor"
	}
	if workspace.CreatorEmail != nil && email == strings.ToLower(*workspace.CreatorEmail) {
		c.JSON(http.StatusConflict, gin.H{"error": "This email is already the workspace owner"})
		return
	}

	var existing models.WorkspaceCollaborator
	if db.DB.Where("workspace_id = ? AND email = ?", workspace.ID, email).First(&existing).Error == nil {
		existing.Role = role
		db.DB.Save(&existing)
		c.JSON(http.StatusOK, formatCollaborator(&existing))
		return
	}

	collab := models.WorkspaceCollaborator{
		ID:          uuid.NewString(),
		WorkspaceID: workspace.ID,
		Email:       email,
		Role:        role,
	}
	if err := db.DB.Create(&collab).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to add collaborator"})
		return
	}
	c.JSON(http.StatusOK, formatCollaborator(&collab))
}

// RemoveCollaborator handles DELETE /v1/workspaces/:workspace_id/collaborators/:email.
func RemoveCollaborator(c *gin.Context) {
	workspace, ok := workspaceForParam(c)
	if !ok {
		return
	}
	email := strings.ToLower(strings.TrimSpace(c.Param("email")))
	var collab models.WorkspaceCollaborator
	if err := db.DB.Where("workspace_id = ? AND email = ?", workspace.ID, email).First(&collab).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Collaborator not found"})
		return
	}
	if err := db.DB.Delete(&collab).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to remove collaborator"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"email": email, "removed": true})
}
