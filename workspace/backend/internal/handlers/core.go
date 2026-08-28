package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/hub"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"gorm.io/gorm"
)

func requestWorkspace(c *gin.Context) (*models.Workspace, bool) {
	network := c.Query("network")
	if network == "" {
		network = c.Param("workspace_id")
	}
	workspace, err := resolveWorkspace(network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Workspace not found"})
		return nil, false
	}
	if !authorizeWorkspace(c, workspace) {
		return nil, false
	}
	return workspace, true
}

// workspaceToken returns the workspace credential from the canonical header,
// while retaining query-token compatibility for existing shared workspace links.
func workspaceToken(c *gin.Context) string {
	if token := c.GetHeader("X-Workspace-Token"); token != "" {
		return token
	}
	return c.Query("token")
}

// authorizeWorkspace consistently enforces the workspace credential for every
// route that mutates or exposes workspace-scoped resources.
func authorizeWorkspace(c *gin.Context, workspace *models.Workspace) bool {
	if verifyWorkspaceAccess(workspace, workspaceToken(c)) {
		return true
	}
	c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid workspace credentials"})
	return false
}

func currentActor(c *gin.Context) string {
	if actor := c.GetHeader("X-Actor-Id"); strings.TrimSpace(actor) != "" {
		return strings.TrimSpace(actor)
	}
	if actor := c.Query("actor"); strings.TrimSpace(actor) != "" {
		return strings.TrimSpace(actor)
	}
	if actor := c.GetHeader("X-Created-By"); strings.TrimSpace(actor) != "" {
		return strings.TrimSpace(actor)
	}
	return ""
}

func authorizeResourceOwner(c *gin.Context, workspace *models.Workspace, createdBy string) bool {
	if !authorizeWorkspace(c, workspace) {
		return false
	}
	actor := currentActor(c)
	if actor != "" && createdBy != "" && !strings.EqualFold(actor, createdBy) && !verifyWorkspaceAccess(workspace, workspaceToken(c)) {
		c.JSON(http.StatusForbidden, gin.H{"error": "Only the creator or workspace administrator can modify this resource"})
		return false
	}
	return true
}

func UpdateWorkspace(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	var req struct {
		Name     *string                `json:"name"`
		Settings map[string]interface{} `json:"settings"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	updates := map[string]interface{}{}
	if req.Name != nil && strings.TrimSpace(*req.Name) != "" {
		updates["name"] = strings.TrimSpace(*req.Name)
	}
	if req.Settings != nil {
		settingsBytes, _ := json.Marshal(req.Settings)
		updates["settings"] = settingsBytes
	}
	if len(updates) > 0 {
		if err := db.DB.Model(workspace).Updates(updates).Error; err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update workspace"})
			return
		}
	}
	GetWorkspace(c)
}

func DiscoverNetwork(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	var members []models.WorkspaceMember
	var channels []models.Channel
	db.DB.Where("workspace_id = ?", workspace.ID).Find(&members)
	db.DB.Where("workspace_id = ? AND status != ?", workspace.ID, "deleted").Order("created_at desc").Find(&channels)

	agents := make([]gin.H, 0, len(members))
	for _, member := range members {
		agents = append(agents, gin.H{
			"address": "52hz:" + member.AgentName, "role": member.Role,
			"status": member.Status, "agent_type": member.AgentType,
			"server_host": member.ServerHost, "working_dir": member.WorkingDir,
			"description": member.Description, "enabled_skills": decodeJSONMap(member.EnabledSkills),
			"last_heartbeat_at": member.LastHeartbeat, "joined_at": member.JoinedAt,
		})
	}

	channelIDs := make([]string, 0, len(channels))
	for _, ch := range channels {
		channelIDs = append(channelIDs, ch.ID)
	}

	var allMembers []models.ChannelMember
	if len(channelIDs) > 0 {
		db.DB.Where("channel_id IN ?", channelIDs).Find(&allMembers)
	}

	membersByChannel := make(map[string][]string)
	for _, m := range allMembers {
		membersByChannel[m.ChannelID] = append(membersByChannel[m.ChannelID], m.AgentName)
	}

	channelItems := make([]gin.H, 0, len(channels))
	for _, channel := range channels {
		participants := membersByChannel[channel.ID]
		if participants == nil {
			participants = []string{}
		}
		channelItems = append(channelItems, gin.H{
			"address": "channel/" + channel.Name, "title": channel.Title,
			"master": channel.MasterAgent, "orchestration_mode": channel.OrchestrationMode,
			"orchestration_instruction": channel.OrchestrationInstruction,
			"participants":              participants, "created_at": channel.CreatedAt.UnixMilli(),
			"last_event_at": channel.LastEventAt, "status": channel.Status, "starred": channel.Starred,
			"working_dir": channel.WorkingDir,
		})
	}
	c.JSON(http.StatusOK, gin.H{"agents": agents, "channels": channelItems, "mods": []string{}, "resources": []string{"files", "todos", "timers", "routines", "notifications"}})
}

func NetworkProfile(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	var online int64
	db.DB.Model(&models.WorkspaceMember{}).Where("workspace_id = ? AND status = ?", workspace.ID, "online").Count(&online)
	c.JSON(http.StatusOK, gin.H{
		"id": workspace.ID, "slug": workspace.Slug, "name": workspace.Name,
		"status": workspace.Status, "access": gin.H{"policy": "workspace_token", "min_verification": 0},
		"capabilities": []string{"events", "files", "todos", "timers", "routines", "notifications"}, "agents_online": online,
	})
}

func eventResponse(record models.EventRecord) gin.H {
	var payload map[string]interface{}
	var metadata map[string]interface{}
	_ = json.Unmarshal(record.Payload, &payload)
	_ = json.Unmarshal(record.Metadata, &metadata)
	if payload == nil {
		payload = map[string]interface{}{}
	}
	if metadata == nil {
		metadata = map[string]interface{}{}
	}
	// client_message_id must survive the round trip: the web client reconciles
	// its optimistic copy of a sent message against the server echo by this id.
	// Omitting it here (the SSE broadcast has always included it) left polled
	// and backfilled history unmatchable, so every sent message rendered twice.
	var clientMessageID interface{}
	if record.ClientMessageID != nil {
		clientMessageID = *record.ClientMessageID
	}
	return gin.H{
		"id": record.ID, "type": record.Type, "source": record.Source,
		"target": record.Target, "payload": payload, "metadata": metadata,
		"timestamp": record.Timestamp, "visibility": record.Visibility,
		"client_message_id": clientMessageID,
	}
}

func ListEvents(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "100"))
	if limit < 1 || limit > 500 {
		limit = 100
	}
	query := db.DB.Where("network_id = ?", workspace.ID)
	if channel := c.Query("channel"); channel != "" {
		query = query.Where("target = ?", "channel/"+strings.TrimPrefix(channel, "channel/"))
	}
	if target := c.Query("target"); target != "" {
		query = query.Where("target = ?", target)
	}
	if eventType := c.Query("type"); eventType != "" {
		if eventType == "workspace.message" {
			query = query.Where("type LIKE ?", "workspace.message%")
		} else {
			query = query.Where("type = ?", eventType)
		}
	}
	for _, cursor := range []struct{ key, op string }{{"after", ">"}, {"before", "<"}} {
		if id := c.Query(cursor.key); id != "" {
			var boundary models.EventRecord
			if db.DB.Where("id = ? AND network_id = ?", id, workspace.ID).First(&boundary).Error == nil {
				if cursor.key == "after" {
					query = query.Where("(timestamp > ? OR (timestamp = ? AND id > ?))", boundary.Timestamp, boundary.Timestamp, boundary.ID)
				} else {
					query = query.Where("(timestamp < ? OR (timestamp = ? AND id < ?))", boundary.Timestamp, boundary.Timestamp, boundary.ID)
				}
			}
		}
	}
	// The id tiebreak is load-bearing, not cosmetic: the after/before cursors above
	// compare (timestamp, id) as a pair, so rows sharing a millisecond have to come
	// back in id order too. Ordering by timestamp alone leaves ties in whatever
	// order the database happens to emit, and the next page's "id > boundary"
	// then silently drops the ones that sorted first.
	order := "timestamp asc, id asc"
	isDesc := c.Query("sort") == "desc" || c.Query("before") != ""
	if isDesc {
		order = "timestamp desc, id desc"
	}
	targetAgent := strings.TrimSpace(c.Query("target_agents"))
	var streamHead models.EventRecord
	hasStreamHead := false
	if targetAgent != "" {
		// A targeted poll can return no event even while unrelated traffic is
		// advancing. Capture the unfiltered head so the connector can advance
		// its cursor past that traffic (the original next_cursor contract).
		headQuery := db.DB.Where("network_id = ?", workspace.ID)
		if channel := c.Query("channel"); channel != "" {
			headQuery = headQuery.Where("target = ?", "channel/"+strings.TrimPrefix(channel, "channel/"))
		}
		if target := c.Query("target"); target != "" {
			headQuery = headQuery.Where("target = ?", target)
		}
		if eventType := c.Query("type"); eventType != "" {
			if eventType == "workspace.message" {
				headQuery = headQuery.Where("type LIKE ?", "workspace.message%")
			} else {
				headQuery = headQuery.Where("type = ?", eventType)
			}
		}
		hasStreamHead = headQuery.Order("timestamp desc, id desc").First(&streamHead).Error == nil
	}
	var records []models.EventRecord
	if targetAgent == "" {
		query.Order(order).Limit(limit + 1).Find(&records)
	} else if db.DB.Dialector.Name() == "postgres" {
		targetJSON, _ := json.Marshal(map[string][]string{"target_agents": {targetAgent}})
		query.Where("(metadata::jsonb @> ?::jsonb OR (source LIKE 'human:%' AND NOT (metadata::jsonb ? 'target_agents')))", string(targetJSON)).Order(order).Limit(limit + 1).Find(&records)
	} else {
		// Keep filtering on the server so connectors do not repeatedly download
		// every other agent's traffic. JSON decoding here remains portable across
		// SQLite development and PostgreSQL production.
		var candidates []models.EventRecord
		query.Order(order).Limit(5000).Find(&candidates)
		for _, record := range candidates {
			if eventTargetsAgent(record, targetAgent) {
				records = append(records, record)
			}
		}
	}
	hasMore := len(records) > limit
	if hasMore {
		records = records[:limit]
	}
	events := make([]gin.H, 0, len(records))
	for _, record := range records {
		events = append(events, eventResponse(record))
	}
	var oldestID, newestID interface{}
	if len(records) > 0 {
		if isDesc {
			oldestID, newestID = records[len(records)-1].ID, records[0].ID
		} else {
			oldestID, newestID = records[0].ID, records[len(records)-1].ID
		}
	}
	response := gin.H{"events": events, "has_more": hasMore, "oldest_id": oldestID, "newest_id": newestID}
	if targetAgent != "" {
		nextCursor := newestID
		if !hasMore && hasStreamHead {
			nextCursor = streamHead.ID
		}
		response["next_cursor"] = nextCursor
	}
	if c.Query("compact") == "true" && c.Query("channel") != "" {
		rawCh := strings.TrimPrefix(c.Query("channel"), "channel/")
		var channelRec models.Channel
		if db.DB.Where("workspace_id = ? AND name = ?", workspace.ID, rawCh).First(&channelRec).Error == nil {
			var compactionRec models.ChannelCompactionRecord
			if db.DB.Where("workspace_id = ? AND channel_id = ?", workspace.ID, channelRec.ID).Order("created_at desc").First(&compactionRec).Error == nil {
				response["context_summary"] = compactionRec.Summary
				response["compacted_to_event_id"] = compactionRec.ToEventID
			}
		}
	}
	c.JSON(http.StatusOK, response)
}

func LatestEventsPerChannel(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	var records []models.EventRecord
	db.DB.Where("network_id = ? AND target LIKE ?", workspace.ID, "channel/%").Order("timestamp desc, id desc").Limit(1000).Find(&records)
	channels := map[string]gin.H{}
	for _, record := range records {
		name := strings.TrimPrefix(record.Target, "channel/")
		if _, exists := channels[name]; !exists {
			channels[name] = eventResponse(record)
		}
	}
	c.JSON(http.StatusOK, gin.H{"channels": channels})
}

func materializeEvent(workspaceID string, req *SendEventRequest, timestamp int64) error {
	return materializeEventTx(db.DB, workspaceID, req, timestamp)
}

func materializeEventTx(tx *gorm.DB, workspaceID string, req *SendEventRequest, timestamp int64) error {
	if tx == nil {
		tx = db.DB
	}
	if req.Payload == nil {
		req.Payload = map[string]interface{}{}
	}
	if req.Metadata == nil {
		req.Metadata = map[string]interface{}{}
	}
	channelName := strings.TrimPrefix(req.Target, "channel/")
	switch req.Type {
	case "network.channel.create":
		channelName = "thread-" + strings.ReplaceAll(uuid.New().String(), "-", "")[:12]
		title, _ := req.Payload["title"].(string)
		if title == "" {
			title = "新频道"
		}
		master, _ := req.Payload["master"].(string)
		channel := models.Channel{ID: uuid.New().String(), WorkspaceID: workspaceID, Name: channelName, Title: &title, Status: "active", OrchestrationMode: "dynamic", CreatedAt: time.Now()}
		if master != "" {
			channel.MasterAgent = &master
		}
		if err := tx.Create(&channel).Error; err != nil {
			return err
		}
		if participants, ok := req.Payload["participants"].([]interface{}); ok {
			for _, item := range participants {
				if name, ok := item.(string); ok && name != "" {
					tx.Create(&models.ChannelMember{ChannelID: channel.ID, AgentName: name})
				}
			}
		}
		req.Metadata["channel_name"] = channelName
	case "network.channel.join", "network.channel.leave":
		var channel models.Channel
		if tx.Where("workspace_id = ? AND name = ?", workspaceID, channelName).First(&channel).Error == nil {
			name, _ := req.Payload["agent_name"].(string)
			if req.Type == "network.channel.join" {
				tx.FirstOrCreate(&models.ChannelMember{ChannelID: channel.ID, AgentName: name})
			} else {
				tx.Where("channel_id = ? AND agent_name = ?", channel.ID, name).Delete(&models.ChannelMember{})
			}
		}
	}
	if strings.HasPrefix(req.Target, "channel/") {
		var channel models.Channel
		if tx.Where("workspace_id = ? AND name = ?", workspaceID, channelName).First(&channel).Error == nil {
			tx.Model(&channel).Update("last_event_at", timestamp)
			targets, routed, err := routeMessage(workspaceID, &channel, req)
			if err != nil {
				return err
			}
			if routed {
				req.Metadata["target_agents"] = targets
				if !strings.HasPrefix(channel.Name, "routines:") {
					for _, target := range targets {
						if target != noResponseAgent {
							tx.FirstOrCreate(&models.ChannelMember{ChannelID: channel.ID, AgentName: target})
						}
					}
				}
			}
		}
	}

	return nil
}

// ensureWorkspaceConnectorToken returns the raw token that the connector must
// send to /v1/token/resolve. A password hash cannot be reversed, so legacy
// workspaces that predate settings["token"] (or whose setting was overwritten)
// need a newly issued credential. Keep the JSON copy and password hash in sync
// so the token is immediately resolvable by every authentication path.
func ensureWorkspaceConnectorToken(workspace *models.Workspace) (string, error) {
	settings := decodeJSONMap(workspace.Settings)
	if token, ok := settings["token"].(string); ok && token != "" && verifyWorkspaceAccess(workspace, token) {
		return token, nil
	}

	token := "ws_" + strings.ReplaceAll(uuid.New().String(), "-", "")
	hash := hashWorkspaceToken(token)
	settings["token"] = token
	settingsBytes, err := json.Marshal(settings)
	if err != nil {
		return "", err
	}
	if err := db.DB.Model(workspace).Updates(map[string]interface{}{
		"password_hash": hash,
		"settings":      settingsBytes,
	}).Error; err != nil {
		return "", err
	}

	workspace.PasswordHash = &hash
	workspace.Settings = settingsBytes
	return token, nil
}

// agentIdentRe bounds agent names and runtime types. The launcher below hands
// the name to `cmd /c start`, so an unconstrained value would be a command
// injection vector.
var agentIdentRe = regexp.MustCompile(`^[A-Za-z0-9._-]{1,64}$`)

// wwjCLIPath locates the local wwj CLI relative to the backend's cwd, falling
// back to a `wwj` on PATH outside the monorepo layout.
// wwjCLIPath resolves the workspace connector CLI that /launch and /create
// shell out to.
//
// The packaged desktop app ships its own connector under resources/wwj
// (build-desktop.ps1 assembles it), so that copy is tried FIRST and is resolved
// from the backend executable's own location. Working-directory-relative paths
// cannot be used for it: they do not survive packaging, and /launch deliberately
// sets the child's cwd to the user's chosen project directory. Previously only
// the two dev-tree paths below were tried, so a packaged build always fell
// through to the bare "wwj" on PATH — making the app depend on a global npm
// install (and fail outright when that install was stale or broken), while the
// bundled copy went unused.
func wwjCLIPath() string {
	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		bundled := []string{
			// packaged: resources/bin/52hz-server.exe -> resources/wwj/src/cli.js
			filepath.Join(exeDir, "..", "wwj", "src", "cli.js"),
			// binary sitting directly alongside the wwj directory
			filepath.Join(exeDir, "wwj", "src", "cli.js"),
		}
		for _, candidate := range bundled {
			if _, err := os.Stat(candidate); err == nil {
				return candidate
			}
		}
	}

	// Development tree: backend run from workspace/backend, or from workspace.
	for _, candidate := range []string{"../../packages/wwj/src/cli.js", "../packages/wwj/src/cli.js"} {
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
	}

	return "wwj"
}

// CreateAgentRequest registers a new local agent with the launcher. This is the
// path for agents wwj has no featured catalog entry for — either one of its
// non-featured runtimes (goose, cline, aider…) or, with AgentType "custom", an
// arbitrary CLI defined entirely by Command/Args.
type CreateAgentRequest struct {
	Network    string `json:"network" binding:"required"`
	AgentName  string `json:"agent_name" binding:"required"`
	AgentType  string `json:"agent_type" binding:"required"`
	Command    string `json:"command"`
	Args       string `json:"args"`
	WorkingDir string `json:"working_dir"`
}

// CreateAgent registers the agent with the local launcher (`wwj create`). It
// does NOT start it — the caller follows up with /launch, so one code path owns
// connecting and its bookkeeping.
func CreateAgent(c *gin.Context) {
	var req CreateAgentRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	if !agentIdentRe.MatchString(req.AgentName) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "agent_name may contain only letters, digits, dot, underscore and hyphen (max 64)"})
		return
	}
	if !agentIdentRe.MatchString(req.AgentType) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "agent_type is not a valid runtime type"})
		return
	}
	// A custom agent is nothing but its command. Creating one without it would
	// register an agent that can never run.
	if strings.EqualFold(req.AgentType, "custom") && strings.TrimSpace(req.Command) == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "command is required when agent_type is 'custom'"})
		return
	}

	workspace, err := resolveWorkspace(req.Network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Workspace not found"})
		return
	}

	localDevMode := config.GlobalConfig != nil && config.GlobalConfig.AuthMode == "none"
	if !localDevMode {
		token := workspaceToken(c)
		if token == "" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "X-Workspace-Token required to create an agent"})
			return
		}
		if !verifyWorkspaceAccess(workspace, token) {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid workspace credentials"})
			return
		}
	}

	cliPath := wwjCLIPath()
	args := []string{"create", req.AgentName, "--type", req.AgentType}
	if strings.TrimSpace(req.Command) != "" {
		args = append(args, "--command", strings.TrimSpace(req.Command))
	}
	if strings.TrimSpace(req.Args) != "" {
		args = append(args, "--args", strings.TrimSpace(req.Args))
	}
	if strings.TrimSpace(req.WorkingDir) != "" {
		args = append(args, "--path", strings.TrimSpace(req.WorkingDir))
	}

	// Run directly, not through a shell: Command/Args are user-supplied and must
	// reach the CLI as literal argv entries.
	var runCmd *exec.Cmd
	if cliPath == "wwj" {
		runCmd = exec.Command("wwj", args...)
	} else {
		runCmd = exec.Command("node", append([]string{cliPath}, args...)...)
	}
	setWindowsHidden(runCmd)
	output, execErr := runCmd.CombinedOutput()
	out := strings.TrimSpace(string(output))

	if execErr != nil {
		// Re-creating an existing agent is not a failure for this endpoint — the
		// caller's next step is /launch either way.
		if strings.Contains(out, "already exists") {
			c.JSON(http.StatusOK, gin.H{"agent_name": req.AgentName, "status": "exists", "output": out})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create agent: " + execErr.Error(), "output": out})
		return
	}

	c.JSON(http.StatusOK, gin.H{"agent_name": req.AgentName, "status": "created", "output": out})
}

func LaunchAgent(c *gin.Context) {
	agentName := c.Param("agent_name")
	network := c.Query("network")
	workingDir := c.Query("working_dir")
	if network == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "network is required"})
		return
	}
	workspace, err := resolveWorkspace(network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Workspace not found"})
		return
	}

	// The connect step below goes through `cmd /c start`, so the name must be
	// constrained before it reaches a shell.
	if !agentIdentRe.MatchString(agentName) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "agent_name may contain only letters, digits, dot, underscore and hyphen (max 64)"})
		return
	}

	lowerName := strings.ToLower(agentName)
	var execErr error

	// Safe local launcher syntax routing through the workspace connector.
	cliPath := wwjCLIPath()

	// In local development the browser may carry a stale workspace identifier
	// in the token slot. Always use the database-backed connector credential so
	// wwj receives a token that /v1/token/resolve can actually authenticate.
	localDevMode := config.GlobalConfig != nil && config.GlobalConfig.AuthMode == "none"
	reqToken := workspaceToken(c)
	if localDevMode {
		var tokenErr error
		reqToken, tokenErr = ensureWorkspaceConnectorToken(workspace)
		if tokenErr != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to prepare workspace connector token"})
			return
		}
	} else {
		// Production callers must prove they are allowed to start a local agent
		// for this workspace.
		if reqToken == "" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "X-Workspace-Token required to launch an agent"})
			return
		}
		if !verifyWorkspaceAccess(workspace, reqToken) {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid workspace credentials"})
			return
		}
	}

	serverPort := "8000"
	if envPort := os.Getenv("PORT"); envPort != "" {
		serverPort = envPort
	} else if config.GlobalConfig != nil && config.GlobalConfig.Port > 0 {
		serverPort = fmt.Sprintf("%d", config.GlobalConfig.Port)
	}
	endpoint := fmt.Sprintf("http://127.0.0.1:%s", serverPort)
	if envEndpoint := os.Getenv("WWJ_WORKSPACE_ENDPOINT"); envEndpoint != "" {
		endpoint = envEndpoint
	}

	var runCmd *exec.Cmd
	if cliPath == "wwj" {
		runCmd = exec.Command("wwj", "connect", agentName, reqToken, "--endpoint", endpoint)
	} else {
		runCmd = exec.Command("node", cliPath, "connect", agentName, reqToken, "--endpoint", endpoint)
	}
	runCmd.Env = append(os.Environ(),
		"WWJ_WORKSPACE_TOKEN="+reqToken,
		"WWJ_WORKSPACE_ENDPOINT="+endpoint,
	)
	// The chosen project directory becomes the connector process's cwd, so the
	// agent it spawns reads/edits files there instead of the backend's own
	// working directory.
	if workingDir != "" {
		runCmd.Dir = workingDir
	}
	setWindowsHidden(runCmd)

	output, execErr := runCmd.CombinedOutput()
	if execErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to launch agent process: " + execErr.Error(), "output": string(output)})
		return
	}

	nowTime := time.Now()
	var member models.WorkspaceMember
	err = db.DB.Where("workspace_id = ? AND agent_name = ?", workspace.ID, agentName).First(&member).Error

	agentTypeStr := lowerName
	hostStr := "localhost"
	dirStr := "."
	if workingDir != "" {
		dirStr = workingDir
	}
	descStr := fmt.Sprintf("Launched %s agent runtime", agentName)

	if err != nil {
		member = models.WorkspaceMember{
			WorkspaceID:   workspace.ID,
			AgentName:     agentName,
			Role:          "worker",
			AgentType:     &agentTypeStr,
			ServerHost:    &hostStr,
			WorkingDir:    &dirStr,
			Description:   &descStr,
			EnabledSkills: []byte(`{"installed":[]}`), // Real skills empty until agent reports heartbeat
			Status:        "launching",                // True status: launching until heartbeat confirms readiness
			LastHeartbeat: &nowTime,
			JoinedAt:      nowTime,
		}
		db.DB.Create(&member)
	} else {
		updates := map[string]interface{}{
			"status":         "launching",
			"last_heartbeat": nowTime,
			"agent_type":     agentTypeStr,
		}
		if workingDir != "" {
			updates["working_dir"] = workingDir
		}
		db.DB.Model(&member).Updates(updates)
	}

	// The launcher only proves a process was spawned — never that the agent
	// connected. Report "launching" on the wire too, so the event log and the
	// API response agree with the member row instead of claiming readiness.
	payloadBytes, _ := json.Marshal(gin.H{"agent_name": agentName, "status": "launching", "action": "launched"})
	metaBytes, _ := json.Marshal(gin.H{})
	eventID := uuid.New().String()
	nowMs := time.Now().UnixMilli()

	record := models.EventRecord{
		ID:        eventID,
		NetworkID: workspace.ID,
		Type:      "workspace.agent.control",
		Source:    "system:launcher",
		Target:    "52hz:" + agentName,
		Payload:   payloadBytes,
		Metadata:  metaBytes,
		Timestamp: nowMs,
		CreatedAt: time.Now(),
	}
	db.DB.Create(&record)

	fullBytes, _ := json.Marshal(gin.H{
		"id":        eventID,
		"network":   workspace.ID,
		"type":      "workspace.agent.control",
		"source":    "system:launcher",
		"target":    "52hz:" + agentName,
		"payload":   gin.H{"agent_name": agentName, "status": "launching", "action": "launched"},
		"timestamp": nowMs,
	})

	hub.GlobalHub.Broadcast(hub.BroadcastMsg{
		WorkspaceID: workspace.ID,
		ChannelName: "core",
		Payload:     string(fullBytes),
	})

	c.JSON(http.StatusOK, gin.H{"message": "Launcher started; waiting for the agent to connect", "agent_name": agentName, "status": "launching"})
}
