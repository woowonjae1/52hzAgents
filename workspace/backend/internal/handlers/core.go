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
	token := c.GetHeader("X-Workspace-Token")
	if token == "" {
		token = c.Query("token")
	}
	if !verifyWorkspaceAccess(workspace, token) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid workspace credentials"})
		return nil, false
	}
	return workspace, true
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
			"participants": participants, "created_at": channel.CreatedAt.UnixMilli(),
			"last_event_at": channel.LastEventAt, "status": channel.Status, "starred": channel.Starred,
		})
	}
	c.JSON(http.StatusOK, gin.H{"agents": agents, "channels": channelItems, "mods": []string{}, "resources": []string{"files", "todos", "timers", "routines"}})
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
		"capabilities": []string{"events", "files", "todos", "timers", "routines"}, "agents_online": online,
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
	var records []models.EventRecord
	query.Order(order).Limit(limit + 1).Find(&records)
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
	c.JSON(http.StatusOK, gin.H{"events": events, "has_more": hasMore, "oldest_id": oldestID, "newest_id": newestID})
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
			var members []models.ChannelMember
			db.DB.Where("channel_id = ?", channel.ID).Find(&members)
			targets := make([]string, 0, len(members))
			for _, member := range members {
				targets = append(targets, member.AgentName)
			}
			req.Metadata["target_agents"] = targets
		}
	}
	return nil
}
