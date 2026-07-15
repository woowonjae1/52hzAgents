// Package hub 实现了实时的多播事件总线系统 (Event Hub)，用于在 Agent 之间广播和路由消息。
package hub

// 引入 sync 用于读写锁安全，并且用于保存并管理多个连接的协程安全。
import (
	"strings"
	"log"  // 导入日志库，用于输出注册、注销和广播的统计日志。
	"sync" // 导入互斥锁库，保证 map 在多协程并发读写时的安全。
)

// Client 结构体代表一个活动的流连接客户端（可以是 SSE 或是 WebSocket 连接）。
type Client struct {
	ID          string      // 客户端的唯一标识符（一般是 UUID 或随机生成）。
	WorkspaceID string      // 客户端所属的工作区 ID，用于进行工作区级别隔离。
	ChannelName string      // 客户端订阅的特定会话通道名，若为空则订阅该工作区下的所有通道。
	Send        chan string // 每个客户端独占的一个缓冲信道，用于异步接收即将推送给客户端的事件字符串。
}

// BroadcastMsg 结构体包装了要广播的消息数据以及路由过滤信息。
type BroadcastMsg struct {
	WorkspaceID string // 消息所属的工作区 ID，只有匹配该工作区的客户端才能收到消息。
	ChannelName string // 消息所属的通道名称（如 general ），用于精确路由。
	Payload     string // 消息的具体内容负载，以 JSON 格式的字符串形式传递。
}

// EventHub 结构体负责管理所有活跃的 Client 连接，并异步地处理注册、注销和事件广播。
type EventHub struct {
	clients    map[string]*Client // 存储所有在线客户端的哈希表，Key 为 Client.ID，Value 为 Client 指针。
	register   chan *Client       // 注册信道，当有新客户端连入时，将 Client 指针写入此信道。
	unregister chan *Client       // 注销信道，当客户端断开连接时，将 Client 指针写入此信道。
	broadcast  chan BroadcastMsg  // 广播信道，有新事件需要分发时，将 BroadcastMsg 写入此信道。
	mu         sync.RWMutex       // 读写锁，用于对在线客户端哈希表进行并发安全读写操作。
}

// GlobalHub 是全局唯一的事件总线单例。
var GlobalHub *EventHub

// InitHub 初始化全局事件总线并启动后台的生命周期管理协程。
func InitHub() {
	// 创建 EventHub 实例，并初始化内部所有的 map 和通信信道。
	GlobalHub = &EventHub{
		clients:    make(map[string]*Client), // 初始化客户端哈希表。
		register:   make(chan *Client),       // 初始化注册信道，无缓冲。
		unregister: make(chan *Client),       // 初始化注销信道，无缓冲。
		broadcast:  make(chan BroadcastMsg),  // 初始化广播信道，无缓冲。
	}
	// 启动一个常驻后台的主循环协程，处理注册、注销和消息多播广播。
	go GlobalHub.run()
}

// Register 用于向总线注册一个新客户端。
func (h *EventHub) Register(c *Client) {
	h.register <- c // 将客户端指针发送至注册通道，由主协程异步处理。
}

// Unregister 用于从总线注销一个已断开连接的客户端。
func (h *EventHub) Unregister(c *Client) {
	h.unregister <- c // 将客户端指针发送至注销通道，由主协程异步处理。
}

// Broadcast 用于向总线发布一条待分发的消息。
func (h *EventHub) Broadcast(msg BroadcastMsg) {
	h.broadcast <- msg // 将待分发消息发送至广播通道，由主协程异步分发。
}

// run 是事件总线的核心生命周期管理循环，持续监听注册、注销及广播事件。
func (h *EventHub) run() {
	// 输出日志，表示事件总线后台服务成功启动。
	log.Println("Event Hub background routing service started.")

	// 进入无限循环，使用 select 监听来自各个通道的并发信号。
	for {
		select {
		// 监听注册信道，当有新客户端连接加入时：
		case client := <-h.register:
			h.mu.Lock()                           // 申请加排他锁，防止并发读写图（Map）。
			h.clients[client.ID] = client         // 将新客户端指针存入图（Map）中，以 ID 为键。
			h.mu.Unlock()                         // 释放锁。
			log.Printf("Client registered to Hub: %s (Workspace: %s, Channel: %s)", client.ID, client.WorkspaceID, client.ChannelName) // 打印注册日志。

		// 监听注销信道，当客户端关闭连接时：
		case client := <-h.unregister:
			h.mu.Lock()                           // 申请加排他锁。
			if _, ok := h.clients[client.ID]; ok { // 判断该客户端是否仍在在线列表里。
				delete(h.clients, client.ID)      // 在线列表图中删除该客户端。
				close(client.Send)                // 关闭该客户端的消息通道，释放管道资源。
			}
			h.mu.Unlock()                         // 释放锁。
			log.Printf("Client unregistered from Hub: %s", client.ID) // 打印注销日志。

		// 监听广播信道，当有新事件到达需要派发时：
		case msg := <-h.broadcast:
			h.mu.RLock() // 申请读锁，支持多个协程同时进行路由检索，提高并发吞吐量。

			// 遍历哈希表中的所有活跃客户端。
			for _, client := range h.clients {
				// 检查客户端所属的工作区是否与消息匹配。如果不匹配，直接跳过该客户端。
				if client.WorkspaceID != msg.WorkspaceID {
					continue
				}

				// 检查客户端的通道过滤器。如果客户端设置了通道过滤器，且与消息通道不一致，直接跳过。
				clientChannel := strings.TrimPrefix(client.ChannelName, "channel/")
				messageChannel := strings.TrimPrefix(msg.ChannelName, "channel/")
				if clientChannel != "" && clientChannel != messageChannel {
					continue
				}

				// 使用 select 非阻塞发送消息，防止某个卡住的慢连接阻塞整个总线的事件分发。
				select {
				case client.Send <- msg.Payload: // 若客户端信道畅通，将 JSON 消息字符串写入其独占通道。
				default:
					// 若该客户端通道已满（说明连接假死或读取极慢），则不等待直接跳过，防止被拖慢性能。
					log.Printf("Warning: Client %s buffer is full, event dropped", client.ID)
				}
			}
			h.mu.RUnlock() // 释放读锁。
		}
	}
}
