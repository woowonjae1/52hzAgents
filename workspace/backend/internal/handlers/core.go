package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/hub"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
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

	channelItems := make([]gin.H, 0, len(channels))
	for _, channel := range channels {
		var channelMembers []models.ChannelMember
		db.DB.Where("channel_id = ?", channel.ID).Find(&channelMembers)
		participants := make([]string, 0, len(channelMembers))
		for _, member := range channelMembers {
			participants = append(participants, member.AgentName)
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
	return gin.H{
		"id": record.ID, "type": record.Type, "source": record.Source,
		"target": record.Target, "payload": payload, "metadata": metadata,
		"timestamp": record.Timestamp, "visibility": record.Visibility,
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
				query = query.Where("timestamp "+cursor.op+" ?", boundary.Timestamp)
			}
		}
	}
	order := "timestamp asc"
	if c.Query("sort") == "desc" || c.Query("before") != "" {
		order = "timestamp desc"
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
		hasStreamHead = headQuery.Order("timestamp desc").First(&streamHead).Error == nil
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
		oldestID, newestID = records[0].ID, records[len(records)-1].ID
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
	db.DB.Where("network_id = ? AND target LIKE ?", workspace.ID, "channel/%").Order("timestamp desc").Limit(1000).Find(&records)
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
		if err := db.DB.Create(&channel).Error; err != nil {
			return err
		}
		if participants, ok := req.Payload["participants"].([]interface{}); ok {
			for _, item := range participants {
				if name, ok := item.(string); ok && name != "" {
					db.DB.Create(&models.ChannelMember{ChannelID: channel.ID, AgentName: name})
				}
			}
		}
		req.Metadata["channel_name"] = channelName
	case "network.channel.join", "network.channel.leave":
		var channel models.Channel
		if db.DB.Where("workspace_id = ? AND name = ?", workspaceID, channelName).First(&channel).Error == nil {
			name, _ := req.Payload["agent_name"].(string)
			if req.Type == "network.channel.join" {
				db.DB.FirstOrCreate(&models.ChannelMember{ChannelID: channel.ID, AgentName: name})
			} else {
				db.DB.Where("channel_id = ? AND agent_name = ?", channel.ID, name).Delete(&models.ChannelMember{})
			}
		}
	}
	if strings.HasPrefix(req.Target, "channel/") {
		var channel models.Channel
		if db.DB.Where("workspace_id = ? AND name = ?", workspaceID, channelName).First(&channel).Error == nil {
			db.DB.Model(&channel).Update("last_event_at", timestamp)
			targets, routed, err := routeMessage(workspaceID, &channel, req)
			if err != nil {
				return err
			}
			if routed {
				req.Metadata["target_agents"] = targets
				if isHumanSource(req.Source) && !strings.HasPrefix(channel.Name, "routines:") {
					for _, target := range targets {
						if target != noResponseAgent {
							db.DB.FirstOrCreate(&models.ChannelMember{ChannelID: channel.ID, AgentName: target})
						}
					}
				}
			}
		}
	}

	if contentStr, ok := req.Payload["content"].(string); ok && contentStr != "" {
		autoMaterializeMessageFiles(workspaceID, contentStr)
	}

	return nil
}

func autoMaterializeMessageFiles(workspaceID string, content string) {
	if content == "" {
		return
	}

	var filenames []string
	lines := strings.Split(content, "\n")
	for _, line := range lines {
		if strings.Contains(line, ".md") || strings.Contains(line, ".py") || strings.Contains(line, ".csv") || strings.Contains(line, ".txt") || strings.Contains(line, ".json") {
			words := strings.Fields(line)
			for _, w := range words {
				wClean := strings.Trim(w, " `\"'()[]:→,")
				if strings.HasSuffix(wClean, ".md") || strings.HasSuffix(wClean, ".py") || strings.HasSuffix(wClean, ".csv") || strings.HasSuffix(wClean, ".txt") || strings.HasSuffix(wClean, ".json") {
					if len(wClean) > 3 && !strings.Contains(wClean, "/") && !strings.Contains(wClean, "\\") {
						filenames = append(filenames, wClean)
					}
				}
			}
		}
	}

	if len(filenames) == 0 {
		return
	}

	basePath := config.GlobalConfig.FileStoragePath
	wsDir := filepath.Join(basePath, workspaceID)
	_ = os.MkdirAll(wsDir, 0755)

	for _, fname := range filenames {
		var count int64
		db.DB.Model(&models.FileRecord{}).Where("workspace_id = ? AND filename = ?", workspaceID, fname).Count(&count)
		if count == 0 {
			filePath := filepath.Join(wsDir, fname)
			if _, err := os.Stat(filePath); os.IsNotExist(err) {
				_ = os.WriteFile(filePath, []byte(content), 0644)
			}

			info, _ := os.Stat(filePath)
			sizeVal := len(content)
			if info != nil {
				sizeVal = int(info.Size())
			}

			storageKey := fmt.Sprintf("%s/%s", workspaceID, fname)
			cType := "application/octet-stream"
			if strings.HasSuffix(fname, ".md") || strings.HasSuffix(fname, ".txt") {
				cType = "text/markdown; charset=utf-8"
			}
			db.DB.Create(&models.FileRecord{
				ID:          uuid.New().String(),
				WorkspaceID: workspaceID,
				Filename:    fname,
				ContentType: cType,
				Size:        sizeVal,
				StorageKey:  storageKey,
				UploadedBy:  "openagents:agent",
				ChannelName: nil,
				Status:      "active",
				CreatedAt:   time.Now(),
			})
		}
	}
}

func LaunchAgent(c *gin.Context) {
	agentName := c.Param("agent_name")
	network := c.Query("network")
	if network == "" {
		network = c.PostForm("network")
	}
	workspace, err := resolveWorkspace(network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Workspace not found"})
		return
	}

	lowerName := strings.ToLower(agentName)
	var execErr error

	// Determine correct Windows CMD launcher syntax (cmd /k handles || fallback natively without PowerShell syntax errors)
	var runCmd *exec.Cmd
	switch {
	case strings.Contains(lowerName, "claude"):
		runCmd = exec.Command("cmd", "/c", "start", "cmd", "/k", "claude || npx -y @anthropic-ai/claude-code")
	case strings.Contains(lowerName, "codex"):
		runCmd = exec.Command("cmd", "/c", "start", "cmd", "/k", "codex || npx -y codex")
	case strings.Contains(lowerName, "cline"):
		runCmd = exec.Command("cmd", "/c", "start", "cmd", "/k", "cline || npx -y cline")
	case strings.Contains(lowerName, "hermes"):
		runCmd = exec.Command("cmd", "/c", "start", "cmd", "/k", "hermes || npx -y hermes")
	case strings.Contains(lowerName, "kilo"):
		runCmd = exec.Command("cmd", "/c", "start", "cmd", "/k", "kilo || npx -y kilo")
	case strings.Contains(lowerName, "aider"):
		runCmd = exec.Command("cmd", "/c", "start", "cmd", "/k", "aider || npx -y aider")
	default:
		connectorPath := filepath.Join("D:\\code\\wwj-agent-launcher", "bin", "agent-connector.js")
		if _, err := os.Stat(connectorPath); err == nil {
			runCmd = exec.Command("node", connectorPath, "up", "--foreground")
			runCmd.Dir = "D:\\code\\wwj-agent-launcher"
		} else {
			runCmd = exec.Command("cmd", "/c", "start", "cmd", "/k", fmt.Sprintf("node bin/agent-connector.js connect --agent=%s", agentName))
		}
	}

	if runCmd != nil {
		execErr = runCmd.Start()
	}

	if execErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": fmt.Sprintf("Failed to launch agent process: %v", execErr)})
		return
	}

	// Process launched successfully -> update database state to online
	var member models.WorkspaceMember
	err = db.DB.Where("workspace_id = ? AND agent_name = ?", workspace.ID, agentName).First(&member).Error
	nowTime := time.Now()
	agentTypeStr := strings.ToUpper(agentName)
	if strings.Contains(agentName, "-") {
		parts := strings.Split(agentName, "-")
		agentTypeStr = strings.ToUpper(parts[0])
	}
	hostStr := "localhost"
	dirStr := workspace.ID
	descStr := fmt.Sprintf("Auto-launched %s agent runtime", agentName)

	if err != nil {
		member = models.WorkspaceMember{
			WorkspaceID:   workspace.ID,
			AgentName:     agentName,
			Role:          "worker",
			AgentType:     &agentTypeStr,
			ServerHost:    &hostStr,
			WorkingDir:    &dirStr,
			Description:   &descStr,
			EnabledSkills: []byte(`{"installed":["web_search","file_ops","terminal_exec","code_edit"]}`),
			Status:        "online",
			LastHeartbeat: &nowTime,
			JoinedAt:      nowTime,
		}
		db.DB.Create(&member)
	} else {
		db.DB.Model(&member).Updates(map[string]interface{}{
			"status":         "online",
			"last_heartbeat": nowTime,
			"agent_type":     agentTypeStr,
		})
	}

	payloadBytes, _ := json.Marshal(gin.H{"agent_name": agentName, "status": "online", "action": "launched"})
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
		"payload":   gin.H{"agent_name": agentName, "status": "online", "action": "launched"},
		"timestamp": nowMs,
	})

	hub.GlobalHub.Broadcast(hub.BroadcastMsg{
		WorkspaceID: workspace.ID,
		ChannelName: "core",
		Payload:     string(fullBytes),
	})

	c.JSON(http.StatusOK, gin.H{"message": "Agent launched successfully", "agent_name": agentName, "status": "online"})
}
