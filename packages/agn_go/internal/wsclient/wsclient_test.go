// Package wsclient 的集成测试。
// 由于本机环境缺少 CGO/Postgres 无法运行真实后端，这里用一个 httptest 服务器
// 忠实复刻后端 /v1/join、/v1/events/ws、/v1/workspaces/:id/presence、/v1/leave
// 四个接口的报文契约，端到端验证 Bridge 的双向桥接行为。
package wsclient

import (
	"encoding/json"     // 解析测试期间的握手与事件负载。
	"net/http"          // 构建模拟后端路由。
	"net/http/httptest" // 启动进程内测试 HTTP 服务器。
	"strings"           // 从 URL 中裁剪路径。
	"sync"              // 保护上行消息切片的并发写入。
	"testing"           // Go 测试框架。
	"time"              // 超时等待断言。

	"github.com/gorilla/websocket" // 服务端 WebSocket 升级器。
)

// serverUpgrader 是测试后端使用的 WebSocket 升级器（允许任意来源）。
var serverUpgrader = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}

// TestBridgeEndToEnd 验证：join 握手、下行消息写入 stdin、自发消息过滤、
// stdout 上行投递、心跳与离线上报。
func TestBridgeEndToEnd(t *testing.T) {
	var (
		mu           sync.Mutex
		presenceHits int                                    // 记录心跳命中次数。
		leaveHit     bool                                   // 记录 leave 是否被调用。
		upstream     = make(chan map[string]interface{}, 8) // 收集客户端上行事件。
		serverWS     = make(chan *websocket.Conn, 1)        // 把服务端 WS 连接交给测试主协程。
	)

	// 构建模拟后端路由。
	mux := http.NewServeMux()

	// POST /v1/join —— 返回真实工作区 UUID 与会话 ID。
	mux.HandleFunc("/v1/join", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["agent_name"] != "coder" {
			t.Errorf("join: unexpected agent_name %q", body["agent_name"])
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"network_id": "net-123",
			"session_id": "sess-abc",
		})
	})

	// GET /v1/events/ws —— 升级为 WebSocket，读取上行事件并把连接交给测试。
	mux.HandleFunc("/v1/events/ws", func(w http.ResponseWriter, r *http.Request) {
		// 校验查询参数按契约携带了 network 与 token。
		if r.URL.Query().Get("network") != "net-123" {
			t.Errorf("ws: expected network=net-123, got %q", r.URL.Query().Get("network"))
		}
		if r.URL.Query().Get("token") != "secret" {
			t.Errorf("ws: expected token=secret, got %q", r.URL.Query().Get("token"))
		}
		conn, err := serverUpgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("ws upgrade failed: %v", err)
			return
		}
		serverWS <- conn
		// 持续读取客户端上行事件并投递到 upstream 通道。
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var ev map[string]interface{}
			if json.Unmarshal(msg, &ev) == nil {
				upstream <- ev
				_ = conn.WriteJSON(map[string]interface{}{
					"type":              "system.event.ack",
					"status":            "confirmed",
					"event_id":          "event-123",
					"client_message_id": ev["client_message_id"],
				})
			}
		}
	})

	// POST /v1/workspaces/:id/presence —— 记录心跳命中。
	mux.HandleFunc("/v1/workspaces/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/presence") {
			mu.Lock()
			presenceHits++
			mu.Unlock()
		}
		w.WriteHeader(http.StatusOK)
	})

	// POST /v1/leave —— 记录离线上报。
	mux.HandleFunc("/v1/leave", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		leaveHit = true
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	})

	server := httptest.NewServer(mux)
	defer server.Close()

	// 构造被测桥接客户端。
	br := &Bridge{
		Endpoint:  server.URL,
		Token:     "secret",
		AgentName: "coder",
		AgentType: "claude",
		Channel:   "dev",
	}

	// onMessage 回调：把下行消息收集到通道，模拟写入 Agent stdin。
	toStdin := make(chan string, 4)
	if err := br.Connect(func(content string) { toStdin <- content }); err != nil {
		t.Fatalf("Connect failed: %v", err)
	}
	defer br.Close()

	// 校验 join 返回值已被正确解析。
	if br.networkID != "net-123" || br.sessionID != "sess-abc" {
		t.Fatalf("join parse mismatch: networkID=%q sessionID=%q", br.networkID, br.sessionID)
	}

	// 取得服务端 WS 连接。
	var conn *websocket.Conn
	select {
	case conn = <-serverWS:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for websocket connection")
	}

	// 下行场景 1：来自他人的聊天消息应写入 stdin。
	_ = conn.WriteJSON(map[string]interface{}{
		"type":    "workspace.message.posted",
		"source":  "openagents:human",
		"payload": map[string]interface{}{"content": "hello agent"},
	})
	select {
	case got := <-toStdin:
		if got != "hello agent" {
			t.Fatalf("stdin got %q, want %q", got, "hello agent")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for downstream message on stdin")
	}

	// 下行场景 2：本 Agent 自己发出的消息应被过滤，不写入 stdin。
	_ = conn.WriteJSON(map[string]interface{}{
		"type":    "workspace.message.posted",
		"source":  "openagents:coder", // 即 br.source。
		"payload": map[string]interface{}{"content": "echo of myself"},
	})
	select {
	case got := <-toStdin:
		t.Fatalf("self-message should be filtered, but stdin got %q", got)
	case <-time.After(500 * time.Millisecond):
		// 预期路径：无消息到达。
	}

	// 上行场景：Agent stdout 一行应被封装为聊天事件投递到工作区。
	if err := br.SendOutput("agent reply"); err != nil {
		t.Fatalf("SendOutput failed: %v", err)
	}
	select {
	case ev := <-upstream:
		if ev["type"] != "workspace.message.posted" {
			t.Errorf("upstream type = %v", ev["type"])
		}
		if ev["source"] != "openagents:coder" {
			t.Errorf("upstream source = %v", ev["source"])
		}
		if ev["target"] != "channel/dev" {
			t.Errorf("upstream target = %v", ev["target"])
		}
		if ev["network"] != "net-123" {
			t.Errorf("upstream network = %v", ev["network"])
		}
		if ev["client_message_id"] == "" {
			t.Error("upstream client_message_id is empty")
		}
		payload, _ := ev["payload"].(map[string]interface{})
		if payload["content"] != "agent reply" {
			t.Errorf("upstream payload.content = %v", payload["content"])
		}
		if payload["message_type"] != "chat" {
			t.Errorf("upstream payload.message_type = %v", payload["message_type"])
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for upstream event")
	}

	// 直接触发一次心跳，验证 presence 接口按契约被调用。
	br.sendHeartbeat()
	mu.Lock()
	hits := presenceHits
	mu.Unlock()
	if hits < 1 {
		t.Errorf("expected at least 1 presence hit, got %d", hits)
	}

	// 关闭桥接并验证 leave 被调用。
	br.Close()
	time.Sleep(200 * time.Millisecond)
	mu.Lock()
	left := leaveHit
	mu.Unlock()
	if !left {
		t.Error("expected leave endpoint to be called on Close")
	}
}
