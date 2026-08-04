package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
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
			"address": "openagents:" + member.AgentName, "role": member.Role,
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
			title = "New Thread"
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
				if isHumanSource(req.Source) && !strings.HasPrefix(channel.Name, "routines:") {
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

func LaunchAgent(c *gin.Context) {
	agentName := c.Param("agent_name")
	network := c.Query("network")
	if network == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "network is required"})
		return
	}
	workspace, err := resolveWorkspace(network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Workspace not found"})
		return
	}

	lowerName := strings.ToLower(agentName)
	var execErr error

	// Safe local launcher syntax routing through the workspace connector.
	// We locate the local wwj CLI script relative to the backend cwd.
	cliPath := "../../packages/wwj/src/cli.js"
	if _, err := os.Stat(cliPath); os.IsNotExist(err) {
		if _, err2 := os.Stat("../packages/wwj/src/cli.js"); err2 == nil {
			cliPath = "../packages/wwj/src/cli.js"
		} else {
			// Fallback if not running in the monorepo structure
			cliPath = "wwj"
		}
	}

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

	runArgs := []string{"/c", "start", "cmd", "/k"}
	if cliPath == "wwj" {
		runArgs = append(runArgs, "wwj", "connect", agentName, "-", "--endpoint", "http://localhost:8000")
	} else {
		runArgs = append(runArgs, "node", cliPath, "connect", agentName, "-", "--endpoint", "http://localhost:8000")
	}
	runCmd := exec.Command("cmd", runArgs...)
	runCmd.Env = append(os.Environ(),
		"WWJ_WORKSPACE_TOKEN="+reqToken,
		"OPENAGENTS_TOKEN="+reqToken,
		"WWJ_WORKSPACE_ENDPOINT=http://localhost:8000",
	)

	execErr = runCmd.Start()
	if execErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to launch agent process: " + execErr.Error()})
		return
	}

	nowTime := time.Now()
	var member models.WorkspaceMember
	err = db.DB.Where("workspace_id = ? AND agent_name = ?", workspace.ID, agentName).First(&member).Error

	agentTypeStr := lowerName
	hostStr := "localhost"
	dirStr := "."
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
		db.DB.Model(&member).Updates(map[string]interface{}{
			"status":         "launching",
			"last_heartbeat": nowTime,
			"agent_type":     agentTypeStr,
		})
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
		Target:    "openagents:" + agentName,
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
		"target":    "openagents:" + agentName,
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
