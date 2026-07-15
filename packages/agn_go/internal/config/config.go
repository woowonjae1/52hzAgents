// Package config 负责管理 agn 客户端本地配置的加载、保存和升级。
package config

// 导入必要的系统和文件操作库。
import (
	"bufio"         // 流式读取 TCP 响应。
	"encoding/json" // 解析与序列化 JSON 配置。
	"fmt"           // 格式化错误信息。
	"net"           // 发起 TCP 控制信道连接。
	"os"            // 操作系统调用及环境变量读取。
	"path/filepath" // 跨平台路径拼接。
	"strings"       // 端口字符串处理。
	"time"          // 拨号超时设定。
)

// WorkspaceConfig 代表本地配置中的单个 Workspace 连接参数。
type WorkspaceConfig struct {
	ID       string `json:"id"`                // 工作区 UUID 或 Slug 标识（为空时后端按 Token 反查）
	Name     string `json:"name"`              // 自定义工作区名称
	Token    string `json:"token"`             // 连接访问凭证令牌 (X-Workspace-Token)
	Endpoint string `json:"endpoint"`          // 后端服务基准 URL（如 http://localhost:8000）
	Channel  string `json:"channel,omitempty"` // 桥接投递/订阅的会话通道名（默认 general，阶段三新增）
}

// AgentConfig 代表本地注册的单个 AI 智能体客户端定义。
type AgentConfig struct {
	Name        string            `json:"name"`         // 智能体名称别名 (如 coder-claude)
	Type        string            `json:"type"`         // 运行时类型 (如 claude, aider)
	WorkspaceID string            `json:"workspace_id"` // 当前关联绑定的工作区 ID
	Env         map[string]string `json:"env"`          // 该智能体专用的环境变量字典
}

// GlobalConfig 代表 ~/.52hzagents/config.json 的整体结构。
type GlobalConfig struct {
	DaemonPort string                     `json:"daemon_port"` // 守护进程本地通信监听 TCP 端口（如 127.0.0.1:52000）
	Workspaces map[string]WorkspaceConfig `json:"workspaces"`  // 已配置工作区字典 (Key 为 ID 或 Slug)
	Agents     map[string]AgentConfig     `json:"agents"`      // 已注册智能体列表字典 (Key 为 Agent 名称)
}

// LoadedConfig 保存从磁盘载入的全局配置实例。
var LoadedConfig GlobalConfig

// configFilename 保存本地配置的文件名称。
const configFilename = "config.json"

// GetConfigDir 获取本地配置目录的绝对路径（确保目录存在）。
func GetConfigDir() (string, error) {
	home, err := os.UserHomeDir() // 获取用户主目录。
	if err != nil {
		return "", err
	}

	newDir := filepath.Join(home, ".52hzagents") // 推荐的新路径。

	// 确保新目录结构已被创建。
	err = os.MkdirAll(newDir, 0755)
	return newDir, err
}

// LoadConfig 从 ~/.52hzagents/config.json 载入配置。
func LoadConfig() error {
	dir, err := GetConfigDir() // 获取配置存储目录。
	if err != nil {
		return err
	}

	filePath := filepath.Join(dir, configFilename) // 拼接完整配置文件路径。

	// 如果新配置不存在，尝试从旧的 ~/.openagents 目录下只读复制 config.json。
	if _, err := os.Stat(filePath); os.IsNotExist(err) {
		home, _ := os.UserHomeDir()
		oldFilePath := filepath.Join(home, ".openagents", configFilename)
		
		// 如果旧配置存在，读取并保存到新位置
		if oldData, errOld := os.ReadFile(oldFilePath); errOld == nil {
			_ = os.WriteFile(filePath, oldData, 0644)
		} else {
			// 旧配置也不存在，初始化默认配置
			LoadedConfig = GlobalConfig{
				DaemonPort: "127.0.0.1:52000",                 // 默认本地后台控制端口。
				Workspaces: make(map[string]WorkspaceConfig), // 初始化空字典。
				Agents:     make(map[string]AgentConfig),     // 初始化空字典。
			}
			return SaveConfig()
		}
	}

	// 读取配置文件内容。
	data, err := os.ReadFile(filePath)
	if err != nil {
		return err
	}

	// 解析 JSON 反序列化到 LoadedConfig 中。
	if err := json.Unmarshal(data, &LoadedConfig); err != nil {
		return err
	}

	// 兜底校验端口参数，防止为空。
	if LoadedConfig.DaemonPort == "" {
		LoadedConfig.DaemonPort = "127.0.0.1:52000"
	}

	return nil
}

// SaveConfig 将内存配置持久化写入到配置文件中。
func SaveConfig() error {
	dir, err := GetConfigDir() // 获取存储目录。
	if err != nil {
		return err
	}

	filePath := filepath.Join(dir, configFilename) // 配置路径。

	// 序列化为 JSON 缩进格式。
	data, err := json.MarshalIndent(LoadedConfig, "", "  ")
	if err != nil {
		return err
	}

	// 写入文件，权限设为 0644（所有者可读写，其他人只读）。
	return os.WriteFile(filePath, data, 0644)
}

// AddAgent 向全局配置中新增一条 Agent 定义并持久化。
func AddAgent(name, agentType, workspaceID string) error {
	// 防止空参数。
	if name == "" {
		return fmt.Errorf("agent name cannot be empty")
	}

	// 初始化字典。
	if LoadedConfig.Agents == nil {
		LoadedConfig.Agents = make(map[string]AgentConfig)
	}

	// 检查是否已经存在同名。
	if _, exists := LoadedConfig.Agents[name]; exists {
		return fmt.Errorf("agent '%s' already exists", name)
	}

	// 创建新的 AgentConfig 并写入到字典中。
	LoadedConfig.Agents[name] = AgentConfig{
		Name:        name,
		Type:        agentType,
		WorkspaceID: workspaceID,
		Env:         make(map[string]string),
	}

	return SaveConfig() // 持久化保存到磁盘。
}

// RemoveAgent 从全局配置中移除指定名称的 Agent 定义并持久化。
func RemoveAgent(name string) error {
	if _, exists := LoadedConfig.Agents[name]; !exists {
		return fmt.Errorf("agent '%s' not found", name)
	}

	delete(LoadedConfig.Agents, name) // 从字典中删除。
	return SaveConfig()               // 持久化保存到磁盘。
}

// ConnectAgent 将指定 Agent 绑定到某个工作区连接，并把连接参数持久化到 config.json（阶段三新增）。
// network 可为空（后端将按 Token 反查工作区）；endpoint 与 channel 为空时使用默认值。
func ConnectAgent(name, network, token, endpoint, channel string) error {
	// 校验目标 Agent 是否已注册。
	ag, exists := LoadedConfig.Agents[name]
	if !exists {
		return fmt.Errorf("agent '%s' not found. Run 'agn create %s' first", name, name)
	}

	// 令牌是接入工作区的必要凭证。
	if token == "" {
		return fmt.Errorf("workspace token is required")
	}

	// 端点与通道兜底默认值。
	if endpoint == "" {
		endpoint = "http://localhost:8000"
	}
	if channel == "" {
		channel = "general"
	}

	// 合成工作区配置项的键：优先使用 network 标识，否则以 "ws-<agent>" 命名。
	wsKey := network
	if wsKey == "" {
		wsKey = "ws-" + name
	}

	// 初始化工作区字典。
	if LoadedConfig.Workspaces == nil {
		LoadedConfig.Workspaces = make(map[string]WorkspaceConfig)
	}

	// 写入/更新该工作区连接参数。
	LoadedConfig.Workspaces[wsKey] = WorkspaceConfig{
		ID:       network,
		Name:     wsKey,
		Token:    token,
		Endpoint: endpoint,
		Channel:  channel,
	}

	// 将 Agent 绑定到该工作区连接键。
	ag.WorkspaceID = wsKey
	LoadedConfig.Agents[name] = ag

	return SaveConfig() // 持久化保存到磁盘。
}

// DisconnectAgent 解除指定 Agent 与工作区的绑定关系并持久化（阶段三新增）。
func DisconnectAgent(name string) error {
	// 校验目标 Agent 是否存在。
	ag, exists := LoadedConfig.Agents[name]
	if !exists {
		return fmt.Errorf("agent '%s' not found", name)
	}

	// 清空其工作区绑定。
	ag.WorkspaceID = ""
	LoadedConfig.Agents[name] = ag

	return SaveConfig() // 持久化保存到磁盘。
}

// SendDaemonCommand 发送指令给守护进程。它会首先尝试 TCP 控制信道，若失败则退避到旧的文件 IPC (daemon.cmd)。
func SendDaemonCommand(command string) error {
	port := LoadedConfig.DaemonPort
	// 如果配置的端口不含冒号，默认绑定到 127.0.0.1
	if !strings.Contains(port, ":") {
		port = "127.0.0.1:" + port
	} else if strings.HasPrefix(port, ":") {
		port = "127.0.0.1" + port
	}

	// 尝试建立本地 TCP 连接（超时时间设为 2 秒）。
	conn, err := net.DialTimeout("tcp", port, 2*time.Second)
	if err == nil {
		defer conn.Close()

		// 发送指令行，必须以换行符结尾以便服务端按行读取。
		_, err = conn.Write([]byte(command + "\n"))
		if err != nil {
			return err
		}

		// 流式读取服务端的单行 JSON 回复。
		reader := bufio.NewReader(conn)
		respData, err := reader.ReadBytes('\n')
		if err != nil {
			return err
		}

		var resp struct {
			Success bool   `json:"success"`
			Message string `json:"message"`
		}
		if err := json.Unmarshal(respData, &resp); err != nil {
			return err
		}

		if !resp.Success {
			return fmt.Errorf("daemon error: %s", resp.Message)
		}
		return nil
	}

	// 如果 TCP 拨号失败，退避到文件级 IPC (写入 daemon.cmd)
	dir, errDir := GetConfigDir()
	if errDir != nil {
		return errDir
	}

	cmdFile := filepath.Join(dir, "daemon.cmd") // 拼接指令文件路径。
	return os.WriteFile(cmdFile, []byte(command), 0644)
}
