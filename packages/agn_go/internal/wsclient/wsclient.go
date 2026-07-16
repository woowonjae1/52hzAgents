// Package wsclient 实现了 Agent 子进程与 Go 后端工作区之间的 WebSocket 双向桥接客户端。
// 它负责：1) 通过 HTTP 完成 join/leave/presence 握手与心跳；
//  2. 通过 WebSocket 长连接接收工作区下行消息并写入 Agent 的 stdin；
//  3. 将 Agent 的 stdout 输出封装为聊天事件，经 WebSocket 上行投递到工作区通道。
package wsclient

// 导入所需的标准库与第三方 WebSocket 库。
import (
	"bytes"         // 构造 HTTP 请求体的字节缓冲区。
	"encoding/json" // 编解码 JSON 事件与握手负载。
	"fmt"           // 拼接错误信息。
	"io"            // 读取 HTTP 响应体。
	"log"           // 打印桥接过程的运行日志。
	"net/http"      // 发起 join/leave/presence 的 HTTP 请求。
	"net/url"       // 构造并转义 WebSocket 连接 URL。
	"os"            // 获取宿主主机名。
	"strings"       // 字符串裁剪与协议前缀替换。
	"sync"          // 写操作互斥与一次性关闭保护。
	"time"          // 心跳定时器与 HTTP 超时。

	"github.com/gorilla/websocket" // 业界主流的 WebSocket 客户端实现。
)

// httpClient 是本包共享的带超时 HTTP 客户端，防止握手请求无限阻塞。
var httpClient = &http.Client{Timeout: 10 * time.Second}

type ackResult struct {
	Status  string
	EventID string
	Error   string
}

// Bridge 代表单个 Agent 到某个工作区的双向桥接会话上下文。
type Bridge struct {
	channelMu   sync.RWMutex
	AckTimeout  time.Duration
	MaxRetries  int
	ackMu       sync.Mutex
	pendingAcks map[string]chan ackResult
	Endpoint    string // 后端服务基准 URL，如 http://localhost:8000。
	Network     string // 工作区 ID 或 Slug（用于 join 请求；为空时后端按 Token 反查）。
	Token       string // 工作区访问令牌（X-Workspace-Token）。
	AgentName   string // 本 Agent 的名称别名。
	AgentType   string // 本 Agent 的运行时类型（如 claude）。
	Channel     string // 订阅与投递所使用的会话通道名（默认 general）。

	networkID string          // join 成功后返回的真实工作区 UUID。
	sessionID string          // join 成功后返回的会话 ID（用于心跳保活与事件元数据）。
	source    string          // 事件来源标识，固定为 openagents:<AgentName>。
	conn      *websocket.Conn // 底层 WebSocket 长连接句柄。
	onMessage func(string)    // 收到工作区下行消息时的回调（由守护进程注入，用于写入 Agent stdin）。
	stopCh    chan struct{}   // 关闭广播信号通道，用于终止心跳等后台协程。
	writeMu   sync.Mutex      // WebSocket 写操作互斥锁（gorilla/websocket 不允许并发写同一连接）。
	closeOnce sync.Once       // 保证 Close 逻辑只被执行一次。
}

// Connect 完成整套接入流程：HTTP join 握手 -> 建立 WebSocket 长连接 -> 启动读循环与心跳循环。
// 参数 onMessage 是守护进程注入的回调，用于把工作区下行消息写入 Agent 的标准输入。
func (b *Bridge) Connect(onMessage func(string)) error {
	if b.AckTimeout <= 0 {
		b.AckTimeout = 3 * time.Second
	}
	if b.MaxRetries <= 0 {
		b.MaxRetries = 3
	}
	b.pendingAcks = make(map[string]chan ackResult)
	b.onMessage = onMessage                // 保存下行消息回调。
	b.source = "openagents:" + b.AgentName // 组装事件来源标识。
	if b.Channel == "" {                   // 若未指定通道，则兜底为 general。
		b.Channel = "general"
	}
	if b.Endpoint == "" { // 若未指定后端地址，则兜底为本地默认端口。
		b.Endpoint = "http://localhost:8000"
	}
	b.stopCh = make(chan struct{}) // 初始化关闭信号通道。

	// 第一步：通过 HTTP POST /v1/join 完成鉴权握手，取得 networkID 与 sessionID。
	if err := b.join(); err != nil {
		return fmt.Errorf("join failed: %w", err)
	}

	// 第二步：升级建立到 /v1/events/ws 的 WebSocket 双向长连接。
	if err := b.dial(); err != nil {
		return fmt.Errorf("websocket dial failed: %w", err)
	}

	// 第三步：分别启动下行读取循环与周期心跳保活循环。
	go b.readPump()      // 读取工作区下行消息并转发到 Agent stdin。
	go b.heartbeatPump() // 定期上报在线心跳，防止会话被判定超时下线。

	return nil
}

// join 调用后端 POST /v1/join 接口完成登入握手。
func (b *Bridge) join() error {
	// 组装 join 请求体（字段与后端 JoinRequest 结构严格对应）。
	body := map[string]string{
		"network":     b.Network,   // 工作区 ID / Slug（可为空）。
		"token":       b.Token,     // 访问令牌。
		"agent_name":  b.AgentName, // Agent 名称（后端必填）。
		"agent_type":  b.AgentType, // Agent 类型。
		"server_host": hostname(),  // 宿主主机名。
		"working_dir": "",          // 工作目录（当前不上报）。
	}
	data, _ := json.Marshal(body) // 序列化为 JSON。

	// 发起 POST 请求。
	resp, err := httpClient.Post(b.Endpoint+"/v1/join", "application/json", bytes.NewReader(data))
	if err != nil {
		return err
	}
	defer resp.Body.Close() // 确保响应体被关闭。

	respBody, _ := io.ReadAll(resp.Body) // 读取响应内容。

	// 非 200 状态码视为握手失败。
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("server returned status %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}

	// 解析握手返回的关键字段。
	var jr struct {
		NetworkID string `json:"network_id"` // 真实工作区 UUID。
		SessionID string `json:"session_id"` // 会话 ID。
	}
	if err := json.Unmarshal(respBody, &jr); err != nil {
		return fmt.Errorf("failed to parse join response: %w", err)
	}

	b.networkID = jr.NetworkID // 记录真实工作区 UUID（后续 WS、心跳、事件均使用它）。
	b.sessionID = jr.SessionID // 记录会话 ID。
	return nil
}

// dial 建立到后端 /v1/events/ws 的 WebSocket 双向长连接。
func (b *Bridge) dial() error {
	// 将 http(s):// 前缀替换为 ws(s):// 前缀。
	base := toWebSocketURL(b.Endpoint)

	// 拼接 WebSocket 连接地址并附加必要的查询参数。
	u, err := url.Parse(base + "/v1/events/ws")
	if err != nil {
		return err
	}
	q := u.Query()
	q.Set("network", b.networkID) // 指定订阅的工作区。
	q.Set("token", b.Token)       // 通过查询参数携带鉴权令牌。
	u.RawQuery = q.Encode()

	// 同时在 HTTP Header 中携带工作区令牌（兼容基于 Header 的鉴权路径）。
	header := http.Header{}
	header.Set("X-Workspace-Token", b.Token)

	// 执行 WebSocket 协议升级握手。
	conn, _, err := websocket.DefaultDialer.Dial(u.String(), header)
	if err != nil {
		return err
	}

	b.conn = conn // 保存连接句柄。
	return nil
}

// readPump 持续读取工作区下行消息，筛选出聊天消息并通过回调写入 Agent stdin。
func (b *Bridge) readPumpLegacy() {
	for {
		// 阻塞读取一条下行文本帧。
		_, message, err := b.conn.ReadMessage()
		if err != nil {
			// 连接断开或读取异常时打印日志并退出读循环。
			log.Printf("[bridge:%s] websocket read closed: %v", b.AgentName, err)
			return
		}

		// 解析下行事件负载的关键字段。
		var ev struct {
			Type    string `json:"type"`   // 事件类型。
			Source  string `json:"source"` // 事件来源。
			Payload struct {
				Content string `json:"content"` // 聊天消息文本内容。
			} `json:"payload"`
		}
		if err := json.Unmarshal(message, &ev); err != nil {
			continue // 非结构化 JSON（如心跳）直接忽略。
		}

		// 仅关心聊天消息事件。
		if ev.Type != "workspace.message.posted" {
			continue
		}

		// 跳过由本 Agent 自己发出的消息，防止回声自激。
		if ev.Source == b.source {
			continue
		}

		var route struct {
			Target string `json:"target"`
			Payload struct {
				Mentions []string `json:"mentions"`
			} `json:"payload"`
			Metadata struct {
				TargetAgents []string `json:"target_agents"`
			} `json:"metadata"`
		}
		_ = json.Unmarshal(message, &route)
		inConfiguredChannel := strings.TrimPrefix(route.Target, "channel/") == strings.TrimPrefix(b.currentChannel(), "channel/")
		targeted := containsAgent(route.Metadata.TargetAgents, b.AgentName) || containsAgent(route.Payload.Mentions, b.AgentName)
		if !inConfiguredChannel && !targeted {
			continue
		}
		if strings.HasPrefix(route.Target, "channel/") {
			b.channelMu.Lock()
			b.Channel = strings.TrimPrefix(route.Target, "channel/")
			b.channelMu.Unlock()
		}

		// 裁剪空白后校验内容非空。
		content := strings.TrimSpace(ev.Payload.Content)
		if content == "" {
			continue
		}

		// 通过回调把消息内容写入 Agent 的标准输入。
		if b.onMessage != nil {
			b.onMessage(content)
		}
	}
}

// heartbeatPump 周期性向后端上报在线心跳，维持会话活跃。
func containsAgent(items []string, agentName string) bool {
	for _, item := range items {
		if strings.TrimPrefix(item, "openagents:") == agentName {
			return true
		}
	}
	return false
}

func (b *Bridge) currentChannel() string {
	b.channelMu.RLock()
	defer b.channelMu.RUnlock()
	return b.Channel
}

func (b *Bridge) heartbeatPump() {
	ticker := time.NewTicker(20 * time.Second) // 每 20 秒上报一次心跳。
	defer ticker.Stop()

	for {
		select {
		case <-b.stopCh: // 收到关闭信号则退出。
			return
		case <-ticker.C: // 定时触发心跳上报。
			b.sendHeartbeat()
		}
	}
}

// sendHeartbeat 调用后端 POST /v1/workspaces/:id/presence 上报心跳。
func (b *Bridge) sendHeartbeat() {
	// 组装心跳请求体（字段与后端 PresenceRequest 对应）。
	body := map[string]string{
		"agent_name": b.AgentName, // Agent 名称。
		"session_id": b.sessionID, // 会话 ID（后端据此校验会话是否被旋转失效）。
		"status":     "online",    // 声明在线状态。
	}
	data, _ := json.Marshal(body)

	// 构造带鉴权 Header 的请求。
	reqURL := fmt.Sprintf("%s/v1/workspaces/%s/presence", b.Endpoint, b.networkID)
	req, err := http.NewRequest(http.MethodPost, reqURL, bytes.NewReader(data))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Workspace-Token", b.Token)

	// 发送并立即关闭响应体（心跳无需读取内容）。
	resp, err := httpClient.Do(req)
	if err != nil {
		log.Printf("[bridge:%s] heartbeat failed: %v", b.AgentName, err)
		return
	}
	_ = resp.Body.Close()
}

// SendOutput 将 Agent 的一行 stdout 输出封装为聊天事件，通过 WebSocket 上行投递到工作区通道。
func (b *Bridge) sendOutputLegacy(line string) {
	line = strings.TrimSpace(line) // 裁剪首尾空白。
	if line == "" {
		return // 空行不投递。
	}

	// 组装上行事件（字段与后端 SendEventRequest 严格对应）。
	ev := map[string]interface{}{
		"type":    "workspace.message.posted", // 聊天消息事件类型。
		"source":  b.source,                   // 来源为本 Agent。
		"target":  "channel/" + b.currentChannel(), // Reply to the channel that triggered the agent.
		"network": b.networkID,                // 所属工作区。
		"payload": map[string]interface{}{ // 消息负载。
			"content":      line,   // 消息正文。
			"message_type": "chat", // 消息类型标记为普通聊天。
		},
		"metadata": map[string]interface{}{ // 附加元数据。
			"session_id": b.sessionID, // 携带会话 ID，供后端校验会话有效性。
		},
	}
	data, _ := json.Marshal(ev)

	// 加锁进行 WebSocket 写操作（防止与其它写操作并发冲突）。
	b.writeMu.Lock()
	defer b.writeMu.Unlock()

	if b.conn == nil {
		return // 连接不存在时直接返回。
	}

	// 以文本帧形式上行发送事件。
	if err := b.conn.WriteMessage(websocket.TextMessage, data); err != nil {
		log.Printf("[bridge:%s] failed to send output: %v", b.AgentName, err)
	}
}

// Close 优雅关闭桥接：停止后台协程、上报离线、关闭底层连接。多次调用是安全的。
func (b *Bridge) Close() {
	b.closeOnce.Do(func() {
		if b.stopCh != nil {
			close(b.stopCh) // 广播关闭信号，终止心跳循环。
		}

		b.leave() // 尽力通知后端本 Agent 离线（忽略错误）。

		// 加锁关闭 WebSocket 连接。
		b.writeMu.Lock()
		if b.conn != nil {
			_ = b.conn.Close()
			b.conn = nil
		}
		b.writeMu.Unlock()
	})
}

// leave 调用后端 POST /v1/leave 接口标记本 Agent 离线（尽力而为，忽略错误）。
func (b *Bridge) leave() {
	// 组装 leave 请求体。
	body := map[string]string{
		"network":    b.networkID, // 工作区 UUID。
		"agent_name": b.AgentName, // Agent 名称。
		"session_id": b.sessionID, // 会话 ID。
	}
	data, _ := json.Marshal(body)

	req, err := http.NewRequest(http.MethodPost, b.Endpoint+"/v1/leave", bytes.NewReader(data))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Workspace-Token", b.Token)

	resp, err := httpClient.Do(req)
	if err != nil {
		return
	}
	_ = resp.Body.Close()
}

// toWebSocketURL 将 http(s):// 协议前缀转换为 ws(s):// 前缀。
func toWebSocketURL(endpoint string) string {
	if strings.HasPrefix(endpoint, "https://") {
		return "wss://" + strings.TrimPrefix(endpoint, "https://")
	}
	if strings.HasPrefix(endpoint, "http://") {
		return "ws://" + strings.TrimPrefix(endpoint, "http://")
	}
	// 若未带协议前缀，默认按明文 ws:// 处理。
	return "ws://" + endpoint
}

// hostname 获取当前宿主机主机名，失败时兜底返回 "unknown"。
func hostname() string {
	name, err := os.Hostname()
	if err != nil {
		return "unknown"
	}
	return name
}
