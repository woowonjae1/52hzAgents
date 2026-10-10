package handlers

import (
	"net/http"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

/*
SAVED PROFILES: WHO DOES DELEGATED WORK, AND HOW.

A profile names one way of running a workspace agent -- the agent, an optional
model, and Fix (execute) or Review (plan) -- with a line saying when to use it.
Orchestrating agents read them (workspace_list_profiles) and pick one per task
when they delegate (delegation.go), so "review this carefully" can go to a
read-only reviewer on a strong model and "rename these files" to a cheap fixer,
without the agent knowing provider model ids.

Fix/Review is the same mode the composer's switch sets for a thread; a profile
just fixes it for one lane. Nothing here is enforced by this file: the lane's
dispatch carries mode and model, and the adapter applies them per turn.
*/

var profileNamePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,39}$`)

func validWorkMode(mode string) bool { return mode == "execute" || mode == "plan" }

// WorkProfileRequest is the body of POST and PATCH .../profiles. On PATCH an
// omitted field keeps its value.
type WorkProfileRequest struct {
	Name      *string `json:"name,omitempty"`
	Agent     *string `json:"agent,omitempty"`
	Model     *string `json:"model,omitempty"`
	Mode      *string `json:"mode,omitempty"`
	WhenToUse *string `json:"when_to_use,omitempty"`
}

// WorkProfilesResponse is GET .../profiles: the profiles, and whether each
// profile's agent is online, offline or gone from the workspace.
type WorkProfilesResponse struct {
	Profiles    []models.WorkProfile `json:"profiles"`
	AgentStatus map[string]string    `json:"agent_status"`
}

// applyProfileRequest validates req onto p. Returns a user-facing error.
func applyProfileRequest(workspaceID string, p *models.WorkProfile, req WorkProfileRequest) string {
	if req.Name != nil {
		name := strings.ToLower(strings.TrimSpace(*req.Name))
		if !profileNamePattern.MatchString(name) {
			return "name must be 1-40 characters: lowercase letters, digits, - or _, starting with a letter or digit"
		}
		var clash int64
		db.DB.Model(&models.WorkProfile{}).Where("workspace_id = ? AND name = ? AND id <> ?", workspaceID, name, p.ID).Count(&clash)
		if clash > 0 {
			return "a profile named " + name + " already exists"
		}
		p.Name = name
	}
	if req.Agent != nil {
		agent := strings.TrimPrefix(strings.TrimSpace(*req.Agent), "@")
		canonical, ok := workspaceAgents(db.DB, workspaceID)[strings.ToLower(agent)]
		if !ok {
			return "no agent @" + agent + " in this workspace"
		}
		p.Agent = canonical
	}
	if req.Model != nil {
		model := strings.TrimSpace(*req.Model)
		if len(model) > 200 {
			return "model id is too long"
		}
		p.Model = model
	}
	if req.Mode != nil {
		mode := strings.ToLower(strings.TrimSpace(*req.Mode))
		if !validWorkMode(mode) {
			return "mode must be execute (Fix) or plan (Review)"
		}
		p.Mode = mode
	}
	if req.WhenToUse != nil {
		when := strings.TrimSpace(*req.WhenToUse)
		if len([]rune(when)) > 1000 {
			return "when_to_use is limited to 1000 characters"
		}
		p.WhenToUse = when
	}
	if p.Name == "" || p.Agent == "" {
		return "name and agent are required"
	}
	if p.Mode == "" {
		p.Mode = "execute"
	}
	return ""
}

// ListWorkProfiles handles GET /v1/workspaces/:workspace_id/profiles.
func ListWorkProfiles(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	profiles := []models.WorkProfile{}
	db.DB.Where("workspace_id = ?", workspace.ID).Order("name").Find(&profiles)
	agents := workspaceAgents(db.DB, workspace.ID)
	var names []string
	for _, p := range profiles {
		names = append(names, p.Agent)
	}
	online := onlineParticipants(db.DB, workspace.ID, names)
	status := map[string]string{}
	for _, p := range profiles {
		switch {
		case agents[strings.ToLower(p.Agent)] == "":
			status[p.Agent] = "missing"
		case online[p.Agent]:
			status[p.Agent] = "online"
		default:
			status[p.Agent] = "offline"
		}
	}
	c.JSON(http.StatusOK, WorkProfilesResponse{Profiles: profiles, AgentStatus: status})
}

// CreateWorkProfile handles POST /v1/workspaces/:workspace_id/profiles.
func CreateWorkProfile(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	var req WorkProfileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	p := models.WorkProfile{ID: uuid.NewString(), WorkspaceID: workspace.ID}
	if msg := applyProfileRequest(workspace.ID, &p, req); msg != "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": msg})
		return
	}
	if err := db.DB.Create(&p).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not save the profile: " + err.Error()})
		return
	}
	_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.profiles.updated", "system:profiles", "", gin.H{"profile_id": p.ID})
	c.JSON(http.StatusOK, p)
}

func requestProfile(c *gin.Context) (*models.WorkProfile, bool) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return nil, false
	}
	var p models.WorkProfile
	if db.DB.Where("workspace_id = ? AND id = ?", workspace.ID, c.Param("profile_id")).Limit(1).Find(&p).RowsAffected == 0 {
		c.JSON(http.StatusNotFound, gin.H{"error": "profile not found"})
		return nil, false
	}
	return &p, true
}

// UpdateWorkProfile handles PATCH /v1/workspaces/:workspace_id/profiles/:profile_id.
func UpdateWorkProfile(c *gin.Context) {
	p, ok := requestProfile(c)
	if !ok {
		return
	}
	var req WorkProfileRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if msg := applyProfileRequest(p.WorkspaceID, p, req); msg != "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": msg})
		return
	}
	if err := db.DB.Save(p).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "could not save the profile: " + err.Error()})
		return
	}
	_ = PublishWorkspaceStateEvent(p.WorkspaceID, "workspace.profiles.updated", "system:profiles", "", gin.H{"profile_id": p.ID})
	c.JSON(http.StatusOK, p)
}

// DeleteWorkProfile handles DELETE /v1/workspaces/:workspace_id/profiles/:profile_id.
// Lanes already started from it keep their mode and model (copied on start).
func DeleteWorkProfile(c *gin.Context) {
	p, ok := requestProfile(c)
	if !ok {
		return
	}
	db.DB.Delete(p)
	_ = PublishWorkspaceStateEvent(p.WorkspaceID, "workspace.profiles.updated", "system:profiles", "", gin.H{"profile_id": p.ID, "deleted": true})
	c.JSON(http.StatusOK, gin.H{"deleted": p.ID})
}
