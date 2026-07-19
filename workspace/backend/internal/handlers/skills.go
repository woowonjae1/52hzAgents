package handlers

// Skill Hub — third-party agent skill catalog, per-agent install lifecycle, and
// workspace-scoped custom skills.
//
//	GET  /v1/workspaces/skill-catalog                                        Public static catalog
//	POST /v1/workspaces/:workspace_id/members/:agent_name/skills/install     Queue an install
//	POST /v1/workspaces/:workspace_id/members/:agent_name/skills/status      Launcher progress callback
//	POST /v1/workspaces/:workspace_id/members/:agent_name/skills/uninstall   Uninstall
//	GET  /v1/workspaces/:workspace_id/skills/custom                          List custom skills
//	POST /v1/workspaces/:workspace_id/skills/custom                          Register an uploaded file as a skill
//
// Per-agent assignments live in WorkspaceMember.enabled_skills (JSON):
//
//	{ "installed": ["id", …], "skill_status": { "id": {state, updated_at, …} }, …module toggles… }
//
// Custom skills live in Workspace.settings["custom_skills"] as id → metadata.

import (
	"archive/zip"
	"bytes"
	_ "embed"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/hub"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

//go:embed skill_catalog.json
var skillCatalogJSON []byte

var (
	skillCatalogOnce  []map[string]interface{}
	skillCatalogByID  map[string]map[string]interface{}
	skillIDPattern    = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)
	skillIDClean      = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)
	customSkillCat    = "custom"
	customSkillSource = "workspace_file"
)

func loadSkillCatalog() {
	if skillCatalogOnce != nil {
		return
	}
	_ = json.Unmarshal(skillCatalogJSON, &skillCatalogOnce)
	if skillCatalogOnce == nil {
		skillCatalogOnce = []map[string]interface{}{}
	}
	skillCatalogByID = make(map[string]map[string]interface{}, len(skillCatalogOnce))
	for _, entry := range skillCatalogOnce {
		if id, ok := entry["id"].(string); ok {
			skillCatalogByID[id] = entry
		}
	}
}

func findCatalogSkill(skillID string) map[string]interface{} {
	loadSkillCatalog()
	return skillCatalogByID[skillID]
}

// GetSkillCatalog handles GET /v1/workspaces/skill-catalog (public, static).
func GetSkillCatalog(c *gin.Context) {
	loadSkillCatalog()
	c.JSON(http.StatusOK, skillCatalogOnce)
}

// emitAgentControlEvent persists a workspace.agent.control event addressed to a
// single agent and broadcasts it. The launcher's control poller
// (GET /v1/events?type=workspace.agent.control&target=openagents:<name>) picks
// it up and dispatches the action to the adapter.
func emitAgentControlEvent(workspaceID, agentName, action string, payload gin.H) {
	fullPayload := gin.H{"action": action}
	for k, v := range payload {
		fullPayload[k] = v
	}
	payloadBytes, _ := json.Marshal(fullPayload)
	timestamp := time.Now().UnixMilli()
	record := models.EventRecord{
		ID:         uuid.NewString(),
		NetworkID:  workspaceID,
		Type:       "workspace.agent.control",
		Source:     "human:system",
		Target:     "openagents:" + agentName,
		Payload:    payloadBytes,
		Timestamp:  timestamp,
		Visibility: "direct",
	}
	if err := db.DB.Create(&record).Error; err != nil {
		return
	}
	if hub.GlobalHub != nil {
		if eventBytes, err := json.Marshal(eventResponse(record)); err == nil {
			hub.GlobalHub.Broadcast(hub.BroadcastMsg{WorkspaceID: workspaceID, ChannelName: "", Payload: string(eventBytes)})
		}
	}
}

// stringSlice extracts a []string from a decoded JSON value that may be
// []interface{} of strings.
func stringSlice(value interface{}) []string {
	raw, ok := value.([]interface{})
	if !ok {
		return []string{}
	}
	out := make([]string, 0, len(raw))
	for _, item := range raw {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// setSkillStatus updates the per-skill status map inside an enabled_skills dict,
// keeping the legacy "installed" list in sync.
func setSkillStatus(skills map[string]interface{}, skillID, state, path, errMsg string, partial bool) {
	statusMap, _ := skills["skill_status"].(map[string]interface{})
	if statusMap == nil {
		statusMap = map[string]interface{}{}
	}
	entry := map[string]interface{}{"state": state, "updated_at": time.Now().UnixMilli()}
	if path != "" {
		entry["path"] = path
	}
	if errMsg != "" {
		if len(errMsg) > 2000 {
			errMsg = errMsg[:2000]
		}
		entry["error"] = errMsg
	}
	if partial {
		entry["partial"] = true
	}
	statusMap[skillID] = entry
	skills["skill_status"] = statusMap

	installed := stringSlice(skills["installed"])
	filtered := make([]string, 0, len(installed))
	for _, s := range installed {
		if s != skillID {
			filtered = append(filtered, s)
		}
	}
	if state == "installed" {
		filtered = append(filtered, skillID)
	}
	skills["installed"] = filtered
}

func customSkillsMap(workspace *models.Workspace) map[string]interface{} {
	settings := decodeJSONMap(workspace.Settings)
	if raw, ok := settings["custom_skills"].(map[string]interface{}); ok {
		return raw
	}
	return map[string]interface{}{}
}

type skillInstallRequest struct {
	SkillID string `json:"skill_id" binding:"required"`
}

type skillStatusRequest struct {
	SkillID string  `json:"skill_id" binding:"required"`
	State   string  `json:"state" binding:"required"`
	Path    *string `json:"path"`
	Error   *string `json:"error"`
	Partial *bool   `json:"partial"`
}

var validSkillStates = map[string]bool{"installing": true, "installed": true, "failed": true, "uninstalled": true}

// InstallSkill handles POST /v1/workspaces/:workspace_id/members/:agent_name/skills/install.
func InstallSkill(c *gin.Context) {
	workspace, ok := workspaceForParam(c)
	if !ok {
		return
	}
	var req skillInstallRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	member, ok := memberForParam(c, workspace)
	if !ok {
		return
	}

	skill := findCatalogSkill(req.SkillID)
	var custom map[string]interface{}
	if skill == nil {
		if raw, ok := customSkillsMap(workspace)[req.SkillID].(map[string]interface{}); ok {
			custom = raw
		}
	}
	if skill == nil && custom == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Unknown skill: " + req.SkillID})
		return
	}

	// A custom skill's backing upload must still exist in this workspace.
	if custom != nil {
		fileID, _ := custom["file_id"].(string)
		var fileRec models.FileRecord
		found := fileID != "" && db.DB.Where("id = ?", fileID).First(&fileRec).Error == nil
		if !found || fileRec.Status != "active" || fileRec.WorkspaceID != workspace.ID {
			c.JSON(http.StatusConflict, gin.H{"error": "This skill's uploaded file was deleted. Please re-upload the skill."})
			return
		}
	}

	skills := decodeJSONMap(member.EnabledSkills)
	setSkillStatus(skills, req.SkillID, "installing", "", "", false)
	skillsBytes, _ := json.Marshal(skills)
	if err := db.DB.Model(member).Update("enabled_skills", skillsBytes).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update skills"})
		return
	}

	if custom != nil {
		emitAgentControlEvent(workspace.ID, member.AgentName, "skill.install", gin.H{"skill": gin.H{
			"id": custom["id"], "name": customStr(custom, "name", req.SkillID),
			"description": customStr(custom, "description", ""), "source_type": customStr(custom, "source_type", customSkillSource),
			"file_id": custom["file_id"], "filename": custom["filename"], "content_type": custom["content_type"], "package_type": custom["package_type"],
		}})
	} else {
		emitAgentControlEvent(workspace.ID, member.AgentName, "skill.install", gin.H{"skill": gin.H{
			"id": skill["id"], "name": catalogStr(skill, "name", req.SkillID),
			"description": catalogStr(skill, "description", ""), "source_repo": catalogStr(skill, "source_repo", ""), "source_path": catalogStr(skill, "source_path", ""),
		}})
	}

	c.JSON(http.StatusOK, gin.H{
		"agentName": member.AgentName, "skillId": req.SkillID, "action": "installing", "state": "installing",
		"installedSkills": stringSlice(skills["installed"]), "skillStatus": skills["skill_status"],
	})
}

// ReportSkillStatus handles POST /v1/workspaces/:workspace_id/members/:agent_name/skills/status.
func ReportSkillStatus(c *gin.Context) {
	workspace, ok := workspaceForParam(c)
	if !ok {
		return
	}
	var req skillStatusRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if !validSkillStates[req.State] {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid state: " + req.State})
		return
	}
	member, ok := memberForParam(c, workspace)
	if !ok {
		return
	}

	skills := decodeJSONMap(member.EnabledSkills)
	if req.State == "uninstalled" {
		if statusMap, ok := skills["skill_status"].(map[string]interface{}); ok {
			delete(statusMap, req.SkillID)
			skills["skill_status"] = statusMap
		}
		installed := stringSlice(skills["installed"])
		filtered := make([]string, 0, len(installed))
		for _, s := range installed {
			if s != req.SkillID {
				filtered = append(filtered, s)
			}
		}
		skills["installed"] = filtered
	} else {
		path, errMsg := "", ""
		if req.Path != nil {
			path = *req.Path
		}
		if req.Error != nil {
			errMsg = *req.Error
		}
		partial := req.Partial != nil && *req.Partial
		setSkillStatus(skills, req.SkillID, req.State, path, errMsg, partial)
	}
	skillsBytes, _ := json.Marshal(skills)
	if err := db.DB.Model(member).Update("enabled_skills", skillsBytes).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update skills"})
		return
	}

	// Publish a lightweight status event so connected UIs update instantly.
	_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.skill.status", "openagents:"+member.AgentName, "", gin.H{
		"skill_id": req.SkillID, "state": req.State, "error": req.Error,
	})

	c.JSON(http.StatusOK, gin.H{
		"agentName": member.AgentName, "skillId": req.SkillID, "state": req.State,
		"installedSkills": stringSlice(skills["installed"]), "skillStatus": skills["skill_status"],
	})
}

// UninstallSkill handles POST /v1/workspaces/:workspace_id/members/:agent_name/skills/uninstall.
func UninstallSkill(c *gin.Context) {
	workspace, ok := workspaceForParam(c)
	if !ok {
		return
	}
	var req skillInstallRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	member, ok := memberForParam(c, workspace)
	if !ok {
		return
	}

	skills := decodeJSONMap(member.EnabledSkills)
	installed := stringSlice(skills["installed"])
	filtered := make([]string, 0, len(installed))
	for _, s := range installed {
		if s != req.SkillID {
			filtered = append(filtered, s)
		}
	}
	skills["installed"] = filtered
	if statusMap, ok := skills["skill_status"].(map[string]interface{}); ok {
		delete(statusMap, req.SkillID)
		skills["skill_status"] = statusMap
	}
	skillsBytes, _ := json.Marshal(skills)
	if err := db.DB.Model(member).Update("enabled_skills", skillsBytes).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update skills"})
		return
	}

	skill := findCatalogSkill(req.SkillID)
	if skill == nil {
		skill = map[string]interface{}{"id": req.SkillID}
	}
	emitAgentControlEvent(workspace.ID, member.AgentName, "skill.uninstall", gin.H{"skill": gin.H{
		"id": skill["id"], "name": catalogStr(skill, "name", req.SkillID),
		"source_repo": catalogStr(skill, "source_repo", ""), "source_path": catalogStr(skill, "source_path", ""),
	}})

	c.JSON(http.StatusOK, gin.H{
		"agentName": member.AgentName, "skillId": req.SkillID, "action": "uninstalled", "installedSkills": filtered,
	})
}

// ListCustomSkills handles GET /v1/workspaces/:workspace_id/skills/custom.
func ListCustomSkills(c *gin.Context) {
	workspace, ok := workspaceForParam(c)
	if !ok {
		return
	}
	skillsMap := customSkillsMap(workspace)
	items := make([]interface{}, 0, len(skillsMap))
	for _, v := range skillsMap {
		items = append(items, v)
	}
	c.JSON(http.StatusOK, gin.H{"skills": items})
}

type customSkillRegisterRequest struct {
	FileID      string `json:"file_id" binding:"required"`
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Filename    string `json:"filename"`
}

// RegisterCustomSkill handles POST /v1/workspaces/:workspace_id/skills/custom.
func RegisterCustomSkill(c *gin.Context) {
	workspace, ok := workspaceForParam(c)
	if !ok {
		return
	}
	var req customSkillRegisterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var fileRec models.FileRecord
	if db.DB.Where("id = ?", req.FileID).First(&fileRec).Error != nil || fileRec.Status != "active" {
		c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
		return
	}
	if fileRec.WorkspaceID != workspace.ID {
		c.JSON(http.StatusNotFound, gin.H{"error": "File not found in this workspace"})
		return
	}

	filename := req.Filename
	if filename == "" {
		filename = fileRec.Filename
	}
	skillID := strings.TrimSpace(req.ID)
	if skillID == "" {
		skillID = deriveSkillID(filename)
	}
	if !isValidSkillID(skillID) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid skill id. Use letters, digits, '.', '_' or '-' and do not start with a dash."})
		return
	}
	if findCatalogSkill(skillID) != nil {
		c.JSON(http.StatusConflict, gin.H{"error": "'" + skillID + "' conflicts with a built-in catalog skill"})
		return
	}
	if _, exists := customSkillsMap(workspace)[skillID]; exists {
		c.JSON(http.StatusConflict, gin.H{"error": "A custom skill '" + skillID + "' already exists in this workspace"})
		return
	}

	data, err := os.ReadFile(filepath.Join(config.GlobalConfig.FileStoragePath, fileRec.StorageKey))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Could not read the uploaded file"})
		return
	}
	pkg, err := inspectSkillPackage(data, fileRec.Filename)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	name := strings.TrimSpace(req.Name)
	if name == "" {
		name = skillID
	}
	entry := map[string]interface{}{
		"id": skillID, "name": name, "description": strings.TrimSpace(req.Description),
		"category": customSkillCat, "tags": []string{}, "author": "Workspace user",
		"source_type": customSkillSource, "file_id": fileRec.ID, "filename": filepath.Base(filename),
		"content_type": pkg["content_type"], "package_type": pkg["package_type"],
		"created_at": time.Now(),
	}

	settings := decodeJSONMap(workspace.Settings)
	skills, _ := settings["custom_skills"].(map[string]interface{})
	if skills == nil {
		skills = map[string]interface{}{}
	}
	skills[skillID] = entry
	settings["custom_skills"] = skills
	settingsBytes, _ := json.Marshal(settings)
	if err := db.DB.Model(workspace).Update("settings", settingsBytes).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to register custom skill"})
		return
	}

	c.JSON(http.StatusOK, entry)
}

func deriveSkillID(filename string) string {
	base := filepath.Base(filename)
	stem := strings.TrimSuffix(base, filepath.Ext(base))
	cleaned := skillIDClean.ReplaceAllString(stem, "-")
	cleaned = strings.Trim(cleaned, "-._")
	if len(cleaned) > 64 {
		cleaned = cleaned[:64]
	}
	if cleaned == "" {
		return "custom-skill"
	}
	return cleaned
}

func isValidSkillID(skillID string) bool {
	return skillID != "" && skillID != "." && skillID != ".." && skillIDPattern.MatchString(skillID)
}

// inspectSkillPackage validates a .md or .zip skill package by inspecting bytes,
// returning its content_type and package_type. A .zip must contain a SKILL.md at
// the root or inside a single top-level directory.
func inspectSkillPackage(data []byte, filename string) (map[string]interface{}, error) {
	ext := strings.ToLower(filepath.Ext(filename))
	switch ext {
	case ".md", ".markdown":
		return map[string]interface{}{"content_type": "text/markdown", "package_type": "md"}, nil
	case ".zip":
		reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			return nil, errBadSkill("Uploaded file is not a valid .zip archive")
		}
		names := make([]string, 0, len(reader.File))
		for _, f := range reader.File {
			if zipNameUnsafe(f.Name) {
				return nil, errBadSkill("Zip archive contains an unsafe path entry")
			}
			names = append(names, f.Name)
		}
		if !zipHasSkillMD(names) {
			return nil, errBadSkill("Zip archive must contain a SKILL.md at its root or in a single top-level folder")
		}
		return map[string]interface{}{"content_type": "application/zip", "package_type": "zip"}, nil
	default:
		return nil, errBadSkill("Unsupported skill file. Upload a .md or .zip package.")
	}
}

type badSkillError struct{ msg string }

func (e badSkillError) Error() string { return e.msg }
func errBadSkill(msg string) error    { return badSkillError{msg} }

func zipNameUnsafe(name string) bool {
	if name == "" {
		return true
	}
	if strings.HasPrefix(name, "/") || strings.HasPrefix(name, "\\") {
		return true
	}
	if len(name) >= 2 && name[1] == ':' {
		return true
	}
	for _, part := range strings.FieldsFunc(name, func(r rune) bool { return r == '/' || r == '\\' }) {
		if part == ".." {
			return true
		}
	}
	return false
}

func zipHasSkillMD(names []string) bool {
	topLevelFiles := map[string]bool{}
	dirRoots := map[string]bool{}
	for _, n := range names {
		n2 := strings.Trim(n, "/")
		if n2 == "" {
			continue
		}
		segs := strings.Split(n2, "/")
		if len(segs) == 1 {
			topLevelFiles[segs[0]] = true
		} else {
			dirRoots[segs[0]] = true
		}
	}
	for f := range topLevelFiles {
		if strings.EqualFold(f, "skill.md") {
			return true
		}
	}
	if len(dirRoots) == 1 && len(topLevelFiles) == 0 {
		var only string
		for d := range dirRoots {
			only = d
		}
		for _, n := range names {
			segs := strings.Split(strings.Trim(n, "/"), "/")
			if len(segs) == 2 && segs[0] == only && strings.EqualFold(segs[1], "skill.md") {
				return true
			}
		}
	}
	return false
}

func catalogStr(m map[string]interface{}, key, fallback string) string {
	if v, ok := m[key].(string); ok && v != "" {
		return v
	}
	return fallback
}

func customStr(m map[string]interface{}, key, fallback string) string {
	if v, ok := m[key].(string); ok && v != "" {
		return v
	}
	return fallback
}
