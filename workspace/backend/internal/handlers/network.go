// Package handlers 实现了核心业务逻辑处理器，包括工作区、通道及文件管理。
package handlers

// 导入包依赖项。
import (
	"encoding/json" // 用于解析 JSON 或序列化事件负载。
	"net/http"      // 包含标准的 HTTP 常量和响应写入方法。
	"time"          // 用于时间戳的捕获与心跳更新。

	"github.com/gin-gonic/gin"                                           // Gin 框架控制。
	"github.com/google/uuid"                                             // 用于生成 Session ID。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"     // 数据库操作全局连接。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/hub"    // 内存消息 Hub 单例。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models" // 数据结构体模型。
)

// JoinRequest 代表 Agent 登入工作区的请求载荷。
type JoinRequest struct {
	Network    string `json:"network"`                       // 工作区 ID 或 Slug
	Token      string `json:"token"`                         // 访问 Token
	AgentName  string `json:"agent_name" binding:"required"` // 智能体唯一标识名称 (必填)
	AgentType  string `json:"agent_type"`                    // 智能体类型（如 claude）
	ServerHost string `json:"server_host"`                   // 智能体运行机器宿主主机地址
	WorkingDir string `json:"working_dir"`                   // 智能体运行所在的本地工作路径
}

// JoinResponse 包含 Agent 成功加入工作区后的鉴权结果元数据。
type JoinResponse struct {
	NetworkID string `json:"network_id"` // 成功连接的工作区 UUID
	AgentName string `json:"agent_name"` // 智能体名称
	Role      string `json:"role"`       // 智能体在工作区中的角色: master | member | observer
	Status    string `json:"status"`     // 状态: online
	SessionID string `json:"session_id"` // 本次连入会话生命周期的 Session ID
}

// JoinNetwork 处理 POST /v1/join 接口，完成 Agent 的注册和 Session 初始化。
func JoinNetwork(c *gin.Context) {
	var req JoinRequest // 声明接收变量。
	// 解析 JSON 并验证必填。
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	var workspace models.Workspace // 声明工作区容器。
	var err error

	// 如果指定了工作区标识，通过 ID 或 Slug 解析。
	if req.Network != "" {
		err = db.DB.Where("id = ? OR slug = ?", req.Network, req.Network).First(&workspace).Error
	} else {
		// 如果未传工作区标识，尝试通过全局 Token 反查对应的工作区（适用于公开接入场景）。
		err = db.DB.Where("(password_hash = ? OR password_hash = ?) AND status != ?", req.Token, hashWorkspaceToken(req.Token), "deleted").First(&workspace).Error
	}

	// 如果没找到匹配的工作区，返回 404。
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}

	// 校验工作区的 Token 访问密码。
	if !verifyWorkspaceAccess(&workspace, req.Token) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid network token"})
		return
	}

	// 为此次会话生成唯一的 Session ID，并记录当前的时间。
	newSessionID := uuid.New().String()
	now := time.Now()

	// 尝试在数据库中寻找已注册的同名成员记录。
	var member models.WorkspaceMember
	memberErr := db.DB.Where("workspace_id = ? AND agent_name = ?", workspace.ID, req.AgentName).First(&member).Error

	if memberErr == nil {
		// 如果记录已经存在，更新其状态为 online 并重置 Session ID 与心跳。
		member.Status = "online"
		member.LastHeartbeat = &now
		member.SessionID = &newSessionID
		member.SessionStartedAt = &now
		if req.AgentType != "" {
			member.AgentType = &req.AgentType
		}
		if req.ServerHost != "" {
			member.ServerHost = &req.ServerHost
		}
		if req.WorkingDir != "" {
			member.WorkingDir = &req.WorkingDir
		}
		// 保存更新到数据库。
		db.DB.Save(&member)
	} else {
		// 如果记录不存在，则新建一条在线成员记录。
		role := "member" // 默认角色设定。
		member = models.WorkspaceMember{
			WorkspaceID:      workspace.ID,
			AgentName:        req.AgentName,
			Role:             role,
			AgentType:        &req.AgentType,
			ServerHost:       &req.ServerHost,
			WorkingDir:       &req.WorkingDir,
			Status:           "online",
			LastHeartbeat:    &now,
			SessionID:        &newSessionID,
			SessionStartedAt: &now,
			JoinedAt:         now,
		}
		// 保存写入。
		db.DB.Create(&member)
	}

	// 更新工作区最后的活跃时间。
	db.DB.Model(&workspace).Update("last_activity_at", now)
	var defaultChannel models.Channel
	if db.DB.Where("workspace_id = ? AND name = ?", workspace.ID, "general").First(&defaultChannel).Error == nil {
		db.DB.FirstOrCreate(&models.ChannelMember{ChannelID: defaultChannel.ID, AgentName: req.AgentName})
	}

	// 构造 Agent 接入事件，并广播到消息通道中。
	payloadData := map[string]interface{}{
		"agent_name":  req.AgentName,
		"agent_type":  req.AgentType,
		"server_host": req.ServerHost,
		"working_dir": req.WorkingDir,
	}
	payloadBytes, _ := json.Marshal(payloadData)

	eventID := uuid.New().String()
	nowUnixMs := time.Now().UnixNano() / int64(time.Millisecond)

	// 持久化 network.agent.join 事件到 events 表。
	eventRec := models.EventRecord{
		ID:        eventID,
		NetworkID: workspace.ID,
		Type:      "network.agent.join",
		Source:    "openagents:" + req.AgentName,
		Target:    "core",
		Payload:   payloadBytes,
		Timestamp: nowUnixMs,
	}
	db.DB.Create(&eventRec)

	// 序列化 JSON 事件字符用于 Hub 广播。
	fullEventBytes, _ := json.Marshal(gin.H{
		"id":        eventID,
		"network":   workspace.ID,
		"type":      "network.agent.join",
		"source":    "openagents:" + req.AgentName,
		"target":    "core",
		"payload":   payloadData,
		"timestamp": nowUnixMs,
	})

	// 广播事件至 Hub 通道。
	hub.GlobalHub.Broadcast(hub.BroadcastMsg{
		WorkspaceID: workspace.ID,
		ChannelName: "core",
		Payload:     string(fullEventBytes),
	})

	// 返回接入成功的握手详情。
	c.JSON(http.StatusOK, JoinResponse{
		NetworkID: workspace.ID,
		AgentName: req.AgentName,
		Role:      member.Role,
		Status:    "online",
		SessionID: newSessionID,
	})
}

// LeaveRequest 代表 Agent 离线的请求载荷。
type LeaveRequest struct {
	Network   string `json:"network" binding:"required"`    // 工作区 ID 或 Slug (必选)
	AgentName string `json:"agent_name" binding:"required"` // 智能体唯一名称 (必选)
	SessionID string `json:"session_id"`                    // 会话 ID (可选)
}

// LeaveNetwork 处理 POST /v1/leave 接口，标记 Agent 离线。
func LeaveNetwork(c *gin.Context) {
	var req LeaveRequest // 声明接收变量。
	// 绑定并验证。
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// 检索解析对应的工作区。
	workspace, err := resolveWorkspace(req.Network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}

	// 寻找并更新成员的在线状态。
	var member models.WorkspaceMember
	memberErr := db.DB.Where("workspace_id = ? AND agent_name = ?", workspace.ID, req.AgentName).First(&member).Error
	if !authorizeWorkspace(c, workspace) {
		return
	}
	if memberErr == nil {
		if member.SessionID != nil && *member.SessionID != req.SessionID {
			c.JSON(http.StatusConflict, gin.H{"error": "session_revoked"})
			return
		}
		member.Status = "offline" // 设定为离线。
		db.DB.Save(&member)       // 保存更新。
	}

	// 构造退出事件。
	payloadData := map[string]interface{}{
		"agent_name": req.AgentName,
	}
	payloadBytes, _ := json.Marshal(payloadData)

	eventID := uuid.New().String()
	nowUnixMs := time.Now().UnixNano() / int64(time.Millisecond)

	// 持久化退出事件。
	eventRec := models.EventRecord{
		ID:        eventID,
		NetworkID: workspace.ID,
		Type:      "network.agent.leave",
		Source:    "openagents:" + req.AgentName,
		Target:    "core",
		Payload:   payloadBytes,
		Timestamp: nowUnixMs,
	}
	db.DB.Create(&eventRec)

	// 序列化后推送广播。
	fullEventBytes, _ := json.Marshal(gin.H{
		"id":        eventID,
		"network":   workspace.ID,
		"type":      "network.agent.leave",
		"source":    "openagents:" + req.AgentName,
		"target":    "core",
		"payload":   payloadData,
		"timestamp": nowUnixMs,
	})

	hub.GlobalHub.Broadcast(hub.BroadcastMsg{
		WorkspaceID: workspace.ID,
		ChannelName: "core",
		Payload:     string(fullEventBytes),
	})

	// 返回成功。
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// PresenceRequest 代表心跳包保活请求。
type PresenceRequest struct {
	AgentName string `json:"agent_name" binding:"required"` // 智能体名称 (必选)
	SessionID string `json:"session_id" binding:"required"` // 连接会话 ID (必选)
	Status    string `json:"status"`                        // 状态: online
}

// UpdatePresence 处理 POST /v1/workspaces/:workspace_id/presence 接口，接收心跳更新活跃状态。
func UpdatePresence(c *gin.Context) {
	wsID := c.Param("workspace_id") // 工作区标识。

	// 解析工作区记录。
	workspace, err := resolveWorkspace(wsID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}

	// 解析请求体。
	var req PresenceRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// 锁定匹配的成员实体。
	if !authorizeWorkspace(c, workspace) {
		return
	}
	var member models.WorkspaceMember
	memberErr := db.DB.Where("workspace_id = ? AND agent_name = ?", workspace.ID, req.AgentName).First(&member).Error
	if memberErr != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Agent member not registered"})
		return
	}

	// 刷新成员的最后一次心跳及状态。
	now := time.Now()
	member.LastHeartbeat = &now
	if req.Status != "" {
		member.Status = req.Status
	} else {
		member.Status = "online"
	}
	if req.SessionID != "" {
		member.SessionID = &req.SessionID
	}

	// 保存心跳记录。
	db.DB.Save(&member)

	// 同样向工作区最后活跃时间刷新。
	db.DB.Model(workspace).Update("last_activity_at", now)

	// 渲染返回成功。
	c.JSON(http.StatusOK, gin.H{"success": true})
}
