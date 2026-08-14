// Package hub 实现了实时的多播事件总线系统 (Event Hub)，用于在 Agent 之间广播和路由消息。
package hub

import (
	"log"
	"strings"
	"sync"
)

// normalizeChannel 标准化通道名称，统一去除 channel/ 前缀。
func normalizeChannel(name string) string {
	return strings.TrimPrefix(name, "channel/")
}

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
	clients    map[string]*Client                            // 全局 Client 索引表，Key 为 Client.ID
	wsClients  map[string]map[string]map[string]*Client       // 二级分桶索引: WorkspaceID -> ChannelName ("" 代表全局) -> ClientID -> Client
	register   chan *Client                                  // 注册信道（带缓冲）
	unregister chan *Client                                  // 注销信道（带缓冲）
	broadcast  chan BroadcastMsg                             // 广播信道（带缓冲）
	mu         sync.RWMutex                                  // 读写锁，保护 clients 和 wsClients
}

// GlobalHub 是全局唯一的事件总线单例。
var GlobalHub *EventHub

// InitHub 初始化全局事件总线并启动后台的生命周期管理协程。
func InitHub() {
	GlobalHub = &EventHub{
		clients:    make(map[string]*Client),
		wsClients:  make(map[string]map[string]map[string]*Client),
		register:   make(chan *Client, 256),
		unregister: make(chan *Client, 256),
		broadcast:  make(chan BroadcastMsg, 2048),
	}
	go GlobalHub.run()
}

// Register 用于向总线注册一个新客户端。
func (h *EventHub) Register(c *Client) {
	h.register <- c
}

// Unregister 用于从总线注销一个已断开连接的客户端。
func (h *EventHub) Unregister(c *Client) {
	h.unregister <- c
}

// Broadcast 用于向总线发布一条待分发的消息。
func (h *EventHub) Broadcast(msg BroadcastMsg) {
	h.broadcast <- msg
}

// run 是事件总线的核心生命周期管理循环，持续监听注册、注销及广播事件。
func (h *EventHub) run() {
	log.Println("Event Hub background routing service started.")

	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client.ID] = client

			wsID := client.WorkspaceID
			ch := normalizeChannel(client.ChannelName)

			if _, ok := h.wsClients[wsID]; !ok {
				h.wsClients[wsID] = make(map[string]map[string]*Client)
			}
			if _, ok := h.wsClients[wsID][ch]; !ok {
				h.wsClients[wsID][ch] = make(map[string]*Client)
			}
			h.wsClients[wsID][ch][client.ID] = client
			h.mu.Unlock()

			log.Printf("Client registered to Hub: %s (Workspace: %s, Channel: %s)", client.ID, client.WorkspaceID, client.ChannelName)

		case client := <-h.unregister:
			h.mu.Lock()
			if c, ok := h.clients[client.ID]; ok {
				delete(h.clients, client.ID)

				wsID := c.WorkspaceID
				ch := normalizeChannel(c.ChannelName)

				if wsMap, ok := h.wsClients[wsID]; ok {
					if chMap, ok := wsMap[ch]; ok {
						delete(chMap, client.ID)
						if len(chMap) == 0 {
							delete(wsMap, ch)
						}
					}
					if len(wsMap) == 0 {
						delete(h.wsClients, wsID)
					}
				}
				close(c.Send)
			}
			h.mu.Unlock()

			log.Printf("Client unregistered from Hub: %s", client.ID)

		case msg := <-h.broadcast:
			h.mu.RLock()
			wsMap, wsOk := h.wsClients[msg.WorkspaceID]
			if wsOk {
				targetCh := normalizeChannel(msg.ChannelName)

				sendToBucket := func(chBucket map[string]*Client) {
					for _, client := range chBucket {
						select {
						case client.Send <- msg.Payload:
						default:
							log.Printf("Warning: Client %s buffer is full, event dropped", client.ID)
						}
					}
				}

				// 1. 发送给工作区全局订阅者 (ChannelName 为空)
				if globalBucket, ok := wsMap[""]; ok {
					sendToBucket(globalBucket)
				}

				// 2. 发送给指定频道的订阅者 (当目标频道非空时)
				if targetCh != "" {
					if chBucket, ok := wsMap[targetCh]; ok {
						sendToBucket(chBucket)
					}
				}
			}
			h.mu.RUnlock()
		}
	}
}
