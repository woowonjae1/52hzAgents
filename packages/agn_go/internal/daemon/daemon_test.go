package daemon

import (
	"bufio"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/woowonjae1/52hzAgents/packages/agn_go/internal/config"
)

// TestDaemonTCPControlChannel 测试本地 TCP 控制信道的指令监听、解析、处理与 JSON 回复。
func TestDaemonTCPControlChannel(t *testing.T) {
	// 创建临时测试用配置目录。
	tempDir, err := os.MkdirTemp("", "agn_daemon_test")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// 配置默认端口用于测试，避免与生产的 52000 端口冲突。
	config.LoadedConfig.DaemonPort = "127.0.0.1:52100"
	config.LoadedConfig.Agents = make(map[string]config.AgentConfig)
	config.LoadedConfig.Agents["test-agent"] = config.AgentConfig{
		Name: "test-agent",
		Type: "claude",
	}

	d := NewDaemon(tempDir)
	if err := d.Start(); err != nil {
		t.Fatalf("failed to start daemon: %v", err)
	}
	defer d.Stop()

	// 给守护进程启动监听一点时间。
	time.Sleep(100 * time.Millisecond)

	// 1. 测试发送成功指令：启动 test-agent。
	conn, err := net.Dial("tcp", "127.0.0.1:52100")
	if err != nil {
		t.Fatalf("failed to connect to daemon TCP: %v", err)
	}
	_, err = conn.Write([]byte("start:test-agent\n"))
	if err != nil {
		t.Fatalf("failed to write command: %v", err)
	}

	reader := bufio.NewReader(conn)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		t.Fatalf("failed to read response: %v", err)
	}
	conn.Close()

	var resp struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(line, &resp); err != nil {
		t.Fatalf("failed to parse response JSON: %v", err)
	}

	if !resp.Success {
		t.Errorf("expected success=true, got success=false, message: %s", resp.Message)
	}

	// 2. 测试发送失败指令：对不存在的 agent 发送指令，应该返回即时报错。
	conn2, err := net.Dial("tcp", "127.0.0.1:52100")
	if err != nil {
		t.Fatalf("failed to connect for second test: %v", err)
	}
	_, _ = conn2.Write([]byte("start:nonexistent-agent\n"))

	reader2 := bufio.NewReader(conn2)
	line2, err := reader2.ReadBytes('\n')
	conn2.Close()

	if err != nil {
		t.Fatalf("failed to read error response: %v", err)
	}

	var resp2 struct {
		Success bool   `json:"success"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(line2, &resp2); err != nil {
		t.Fatalf("failed to parse second response JSON: %v", err)
	}

	if resp2.Success {
		t.Error("expected success=false for nonexistent agent, got success=true")
	}

	// 3. 校验 PID 文件是否正确写入。
	pidData, err := os.ReadFile(filepath.Join(tempDir, "daemon.pid"))
	if err != nil {
		t.Errorf("failed to read daemon.pid: %v", err)
	}
	if len(pidData) == 0 {
		t.Error("daemon.pid is empty")
	}
}
