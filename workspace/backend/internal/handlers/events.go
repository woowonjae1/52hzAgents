// Package handlers 实现了用于事件接收、多通道分发、以及流式监听（WebSocket/SSE）的路由处理器。
package handlers

// 导入必要的库文件，处理 Web 协议、长连接、并发和 JSON 编解码。
import (
	"crypto/sha256"
	"encoding/json" // 用于将事件结构体编码为 JSON 字节流或解码请求。
	"fmt"           // 用于进行字符串格式化拼接。
	"log"           // 用于输出连接断开或消息处理过程中的错误日志。
	"net/http"      // 包含标准的 HTTP 常量和响应写入方法。
	"strings"
	"time" // 用于定时器心跳包的 Tick 触发。

	"github.com/gin-gonic/gin"     // Gin 框架的核心上下文及路由引擎。
	"github.com/google/uuid"       // 用于生成客户端唯一的 Session ID。
	"github.com/gorilla/websocket" // 业界主流的 WebSocket 升级和协议工具。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"     // 本地 GORM 数据库连接包。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/hub"    // 自研的内存级多路复用广播 Hub。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models" // 表结构模型映射定义。
)

// upgrader 是 gorilla/websocket 的升级器配置，允许跨域请求并设定缓冲区大小。
var upgrader = websocket.Upgrader{
	ReadBufferSize:  2048, // 读取消息的缓冲区大小为 2KB。
	WriteBufferSize: 2048, // 写入消息的缓冲区大小为 2KB。
	CheckOrigin: func(r *http.Request) bool {
		return config.GlobalConfig != nil && config.GlobalConfig.IsAllowedOrigin(r.Header.Get("Origin"))
	},
}

// SendEventRequest 代表发送事件接口 POST /v1/events 的请求体结构。
type SendEventRequest struct {
	ClientMessageID string                 `json:"client_message_id"`
	Type            string                 `json:"type" binding:"required"`    // 事件类型，如 workspace.message.posted (必填)
	Source          string                 `json:"source" binding:"required"`  // 事件源，如 openagents:claude (必填)
	Target          string                 `json:"target" binding:"required"`  // 路由目标，如 channel/session-abc (必填)
	Payload         map[string]interface{} `json:"payload"`                    // 核心数据负载负载图
	Metadata        map[string]interface{} `json:"metadata"`                   // 附加元数据信息图
	Visibility      string                 `json:"visibility"`                 // 消息可见度范围限制（默认为 channel）
	Network         string                 `json:"network" binding:"required"` // 工作区 ID 或 Slug (必填)
}

// verifyWorkspaceAccess 校验客户端请求是否拥有该工作区的合法访问权限。
func verifyWorkspaceAccess(workspace *models.Workspace, token string) bool {
	// 如果工作区密码哈希为空，则该工作区属于公有模式，允许任何人直接免密访问。
	if workspace.PasswordHash == nil || *workspace.PasswordHash == "" {
		return true
	}
	// 如果客户端携带的 Token 与工作区密码哈希一致，则校验成功通过。
	if token != "" {
		hash := hashWorkspaceToken(token)
		if token == *workspace.PasswordHash || hash == *workspace.PasswordHash {
			return true
		}
	}
	// 其余情况（如 Firebase OAuth 校验）在自托管模式下默认按校验失败处理。
	return false
}

func hashWorkspaceToken(token string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(token)))
}

// resolveWorkspace 通过 Network 的 ID 或 Slug 检索对应工作区实体。
func resolveWorkspace(network string) (*models.Workspace, error) {
	var ws models.Workspace // 声明 workspace 结构体。
	// 通过 GORM 查询 ID 等于给定参数或 Slug 等于给定参数的第一条匹配记录。
	err := db.DB.Where("id = ? OR slug = ?", network, network).First(&ws).Error
	if err != nil {
		return nil, err // 若查询失败（如未找到），返回数据库底层错误。
	}
	return &ws, nil // 查询成功，返回工作区记录指针。
}

// SendEvent 处理 POST /v1/events 接口，将事件持久化并广播分发。
func SendEvent(c *gin.Context) {
	var req SendEventRequest // 声明请求数据结构体。
	// 解析 JSON 格式的 HTTP Body，如果解析失败或缺失必填字段，返回 400 Bad Request。
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// 检索与入参匹配的工作区。如果工作区不存在，返回 404 Not Found。
	workspace, err := resolveWorkspace(req.Network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}

	// 获取客户端授权 Token（优先从 X-Workspace-Token Header 获取，其次从请求 Header 或是查询参数获取）。
	token := c.GetHeader("X-Workspace-Token")
	if !verifyWorkspaceAccess(workspace, token) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid workspace credentials"})
		return
	}

	// 幂等性检查：如果携带了 client_message_id，先检查是否已存在
	clientMessageID := strings.TrimSpace(req.ClientMessageID)
	if clientMessageID != "" {
		var existing models.EventRecord
		if err := db.DB.Where("network_id = ? AND client_message_id = ?", workspace.ID, clientMessageID).First(&existing).Error; err == nil {
			var payload map[string]interface{}
			var metadata map[string]interface{}
			_ = json.Unmarshal(existing.Payload, &payload)
			_ = json.Unmarshal(existing.Metadata, &metadata)
			c.JSON(http.StatusOK, gin.H{
				"id":                existing.ID,
				"event_id":          existing.ID,
				"network":           existing.NetworkID,
				"type":              existing.Type,
				"source":            existing.Source,
				"target":            existing.Target,
				"payload":           payload,
				"metadata":          metadata,
				"timestamp":         existing.Timestamp,
				"visibility":        existing.Visibility,
				"client_message_id": clientMessageID,
				"status":            "confirmed",
				"duplicate":         true,
			})
			return
		}
	}

	// 序列化 Payload 图为 JSON 字节数组，准备存入数据库 JSONB 字段。
	payloadBytes, err := json.Marshal(req.Payload)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to marshal payload"})
		return
	}

	// 序列化 Metadata 图为 JSON 字节数组，准备存入数据库 JSONB 字段。
	metaBytes, err := json.Marshal(req.Metadata)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to marshal metadata"})
		return
	}

	// 生成事件记录的唯一 ID（UUID 字符串）。
	eventID := uuid.New().String()
	// 获取当前的高精度毫秒级 Unix 时间戳。
	nowUnixMs := time.Now().UnixNano() / int64(time.Millisecond)
	if err := materializeEvent(workspace.ID, &req, nowUnixMs); err != nil {
		if err == errSessionRevoked {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "session_revoked: another client is now running as this agent"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to apply event"})
		return
	}
	payloadBytes, _ = json.Marshal(req.Payload)
	metaBytes, _ = json.Marshal(req.Metadata)

	// 创建 GORM 对应的数据表记录对象。
	eventRec := models.EventRecord{
		ID:         eventID,
		NetworkID:  workspace.ID,
		Type:       req.Type,
		Source:     req.Source,
		Target:     req.Target,
		Payload:    payloadBytes,
		Metadata:   metaBytes,
		Timestamp:  nowUnixMs,
		Visibility: req.Visibility,
	}
	if clientMessageID != "" {
		eventRec.ClientMessageID = &clientMessageID
	}

	// 将事件持久化写入数据库。如果写入失败，返回 500 服务器错误。
	if err := db.DB.Create(&eventRec).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save event to database"})
		return
	}

	// 将整条事件记录打包序列化为 JSON 字符串，以便广播。
	fullEvent := gin.H{
		"id":                eventRec.ID,
		"event_id":          eventRec.ID,
		"network":           eventRec.NetworkID,
		"type":              eventRec.Type,
		"source":            eventRec.Source,
		"target":            eventRec.Target,
		"payload":           req.Payload,
		"metadata":          req.Metadata,
		"timestamp":         eventRec.Timestamp,
		"visibility":        eventRec.Visibility,
		"client_message_id": clientMessageID,
		"status":            "confirmed",
		"duplicate":         false,
	}
	fullEventBytes, err := json.Marshal(fullEvent)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to marshal full event payload"})
		return
	}

	// 将序列化的 JSON 写入全局 EventHub 中广播给当前所有订阅长连接的客户端。
	hub.GlobalHub.Broadcast(hub.BroadcastMsg{
		WorkspaceID: workspace.ID,
		ChannelName: req.Target, // 精确路由到目标会话通道。
		Payload:     string(fullEventBytes),
	})

	// 返回成功响应，包含已生成的 event_id。
	c.JSON(http.StatusOK, fullEvent)
}

// StreamEventsSSE 处理 GET /v1/events/stream 接口，建立单向服务器发送事件长连接（SSE）。
func StreamEventsSSE(c *gin.Context) {
	// 获取必需的工作区参数，若未传直接返回 400 Bad Request。
	network := c.Query("network")
	if network == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "network parameter is required"})
		return
	}

	// 检索与入参匹配的工作区。如果工作区不存在，返回 404 Not Found。
	workspace, err := resolveWorkspace(network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}

	// 校验鉴权 Token（优先读取 Header 中的，其次读取 query 参数中的）。
	token := c.GetHeader("X-Workspace-Token")
	if token == "" {
		token = c.Query("token")
	}
	if !verifyWorkspaceAccess(workspace, token) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid workspace credentials"})
		return
	}

	// 设定 HTTP 长连接头部，通知客户端以及代理该请求为流式数据传送 (SSE)。
	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache, no-transform")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.Header().Set("X-Accel-Buffering", "no")

	// 生成当前 SSE 客户端的唯一连接 ID，并在全局总线中注册。
	clientID := uuid.New().String()
	channelFilter := c.Query("channel")  // 可选的特定通道监听过滤器（例如 general）。
	clientChan := make(chan string, 100) // 创建带 100 缓冲的消息分发通道。

	sseClient := &hub.Client{
		ID:          clientID,
		WorkspaceID: workspace.ID,
		ChannelName: channelFilter,
		Send:        clientChan,
	}

	// 在全局 Hub 中进行注册。
	hub.GlobalHub.Register(sseClient)

	// 使用 Context 监听客户端的主动关闭信号。
	ctx := c.Request.Context()

	// 开启一个心跳计时器，每 30 秒向流管道发送一次 keepalive，防止代理断连。
	keepaliveTicker := time.NewTicker(30 * time.Second)
	defer func() {
		keepaliveTicker.Stop()              // 关闭计时器释放资源。
		hub.GlobalHub.Unregister(sseClient) // 发生断连时，立刻从 EventHub 中注销该客户端。
	}()

	// 执行循环监听并流式写入。
	for {
		select {
		// 监听客户端的主动退出信号：
		case <-ctx.Done():
			log.Printf("SSE connection closed by client: %s", clientID)
			return

		// 监听心跳计时器，发送 keepalive 包：
		case <-keepaliveTicker.C:
			// 写入 SSE 格式的心跳 keepalive 内容。
			_, err := fmt.Fprintf(c.Writer, ": keepalive\n\n")
			if err != nil {
				log.Printf("Failed to write keepalive to SSE client: %v", err)
				return
			}
			c.Writer.Flush() // 强制将缓冲区数据刷新推送给客户端。

		// 监听 Hub 分发过来的实时事件消息：
		case msg, ok := <-clientChan:
			if !ok {
				// 如果通道关闭，退出循环。
				return
			}
			// 写入符合 SSE 协议的结构数据（包含事件 id 和 data 内容）。
			_, err := fmt.Fprintf(c.Writer, "data: %s\n\n", msg)
			if err != nil {
				log.Printf("Failed to write event to SSE client: %v", err)
				return
			}
			c.Writer.Flush() // 强制流式推送。
		}
	}
}

// StreamEventsWS 处理 GET /v1/events/ws 接口，建立双向 WebSocket 长连接。
func StreamEventsWS(c *gin.Context) {
	// 获取必需的工作区参数，若未传直接返回 400 Bad Request。
	network := c.Query("network")
	if network == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "network parameter is required"})
		return
	}

	// 检索与入参匹配的工作区。如果工作区不存在，返回 404 Not Found。
	workspace, err := resolveWorkspace(network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}

	// 校验鉴权 Token。
	token := c.GetHeader("X-Workspace-Token")
	if token == "" {
		token = c.Query("token")
	}
	if !verifyWorkspaceAccess(workspace, token) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid workspace credentials"})
		return
	}

	// 升级当前 HTTP 连接协议为长连接 WebSocket。
	wsConn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("Failed to upgrade HTTP connection to WebSocket: %v", err)
		return
	}

	// 生成当前连接的唯一 ID，并配置总线客户端信息。
	clientID := uuid.New().String()
	channelFilter := c.Query("channel")  // 可选过滤。
	clientChan := make(chan string, 100) // 缓冲区大小设定为 100。

	wsClient := &hub.Client{
		ID:          clientID,
		WorkspaceID: workspace.ID,
		ChannelName: channelFilter,
		Send:        clientChan,
	}

	// 在全局 Hub 中进行注册上线。
	hub.GlobalHub.Register(wsClient)

	// 声明连接清理的 Defer 方法。
	defer func() {
		wsConn.Close()                     // 断开 WebSocket 底层连接。
		hub.GlobalHub.Unregister(wsClient) // 从在线总线中剔除该客户端。
	}()

	// 开启独立的 Goroutine 用于处理服务器向该客户端的写入（推送）任务。
	go func() {
		// 监听该客户端独立的 Send 通道：
		for msg := range clientChan {
			// 将接收到的消息作为 Text 帧发送给客户端。
			err := wsConn.WriteMessage(websocket.TextMessage, []byte(msg))
			if err != nil {
				log.Printf("Failed to write message to WebSocket client: %v", err)
				return // 发生写入错误，停止写协程（外部 Close 会自动回收连接）。
			}
		}
	}()

	sendAck := func(ack gin.H) {
		encoded, _ := json.Marshal(ack)
		select {
		case clientChan <- string(encoded):
		case <-time.After(2 * time.Second):
			log.Printf("WebSocket ACK dropped for client %s", clientID)
		}
	}

	// 主 Goroutine 在此循环读取该客户端发来的上行消息。
	for {
		// 读取客户端发送过来的数据包。
		_, message, err := wsConn.ReadMessage()
		if err != nil {
			// 如果客户端断开或者网络异常，会在此捕获，打印日志并退出。
			log.Printf("WebSocket connection closed or error encountered: %v", err)
			break
		}

		// 解析客户端上传的 Event 结构体（若为 JSON）。
		var parsedReq SendEventRequest
		if err := json.Unmarshal(message, &parsedReq); err != nil {
			sendAck(gin.H{"type": "system.event.ack", "status": "rejected", "error": "invalid_json"})
			continue
		}
		if parsedReq.Type == "" || parsedReq.Source == "" || parsedReq.Target == "" {
			sendAck(gin.H{
				"type":              "system.event.ack",
				"status":            "rejected",
				"client_message_id": parsedReq.ClientMessageID,
				"error":             "missing_required_field",
			})
			continue
		}

		// 幂等性检查：如果携带了 client_message_id，先检查是否已存在
		clientMessageID := strings.TrimSpace(parsedReq.ClientMessageID)
		if clientMessageID != "" {
			var existing models.EventRecord
			if err := db.DB.Where("network_id = ? AND client_message_id = ?", workspace.ID, clientMessageID).First(&existing).Error; err == nil {
				sendAck(gin.H{
					"type":              "system.event.ack",
					"status":            "confirmed",
					"event_id":          existing.ID,
					"client_message_id": clientMessageID,
					"timestamp":         existing.Timestamp,
					"duplicate":         true,
				})
				continue
			}
		}

		// 生成并持久化数据。
		eventID := uuid.New().String()
		nowUnixMs := time.Now().UnixNano() / int64(time.Millisecond)
		if err := materializeEvent(workspace.ID, &parsedReq, nowUnixMs); err != nil {
			sendAck(gin.H{
				"type":              "system.event.ack",
				"status":            "rejected",
				"client_message_id": clientMessageID,
				"error":             err.Error(),
			})
			continue
		}

		payloadBytes, _ := json.Marshal(parsedReq.Payload)
		metaBytes, _ := json.Marshal(parsedReq.Metadata)

		eventRec := models.EventRecord{
			ID:         eventID,
			NetworkID:  workspace.ID,
			Type:       parsedReq.Type,
			Source:     parsedReq.Source,
			Target:     parsedReq.Target,
			Payload:    payloadBytes,
			Metadata:   metaBytes,
			Timestamp:  nowUnixMs,
			Visibility: parsedReq.Visibility,
		}
		if clientMessageID != "" {
			eventRec.ClientMessageID = &clientMessageID
		}

		// 保存入库。
		if err := db.DB.Create(&eventRec).Error; err != nil {
			sendAck(gin.H{
				"type":              "system.event.ack",
				"status":            "rejected",
				"client_message_id": clientMessageID,
				"error":             err.Error(),
			})
			continue
		}

		fullEvent := gin.H{
			"id":                eventRec.ID,
			"event_id":          eventRec.ID,
			"network":           eventRec.NetworkID,
			"type":              eventRec.Type,
			"source":            eventRec.Source,
			"target":            eventRec.Target,
			"payload":           parsedReq.Payload,
			"metadata":          parsedReq.Metadata,
			"timestamp":         eventRec.Timestamp,
			"visibility":        eventRec.Visibility,
			"client_message_id": clientMessageID,
			"status":            "confirmed",
			"duplicate":         false,
		}
		fullEventBytes, _ := json.Marshal(fullEvent)
		// 广播至全局。
		hub.GlobalHub.Broadcast(hub.BroadcastMsg{
			WorkspaceID: workspace.ID,
			ChannelName: parsedReq.Target,
			Payload:     string(fullEventBytes),
		})

		sendAck(gin.H{
			"type":              "system.event.ack",
			"status":            "confirmed",
			"event_id":          eventRec.ID,
			"client_message_id": clientMessageID,
			"timestamp":         eventRec.Timestamp,
			"duplicate":         false,
		})
	}
}
