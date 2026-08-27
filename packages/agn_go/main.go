// Package main 是 agn (Go 版) 命令行客户端的入口。
package main

// 导入必要的库文件用于命令行参数解析、系统信号捕获、系统调用及配置文件操作。
import (
	"bytes"
	"io"
	"net/http"
	"encoding/json" // 解析状态 JSON。
	"flag"          // 标准命令行参数解析。
	"fmt"           // 终端格式化输出。
	"log"           // 打印守护进程日志。
	"os"            // 系统调用、退出和信号。
	"os/signal"     // 捕捉 ctrl+c 信号。
	"path/filepath" // 跨平台路径拼接。
	"strconv"       // 数值类型转换。
	"strings"       // 字符串检索。
	"syscall"       // 进程信号常数。
	"time"          // 格式化输出时间。

	"github.com/woowonjae1/52hzAgents/packages/agn_go/internal/config"   // 本地配置。
	"github.com/woowonjae1/52hzAgents/packages/agn_go/internal/daemon"   // 后台守护进程。
	"github.com/woowonjae1/52hzAgents/packages/agn_go/internal/install"  // 运行包安装器 (阶段四新增)。
	"github.com/woowonjae1/52hzAgents/packages/agn_go/internal/registry" // 智能体注册表。
)

const version = "0.4.0" // 定义客户端版本号（阶段三升级：工作区连接与双向桥接）。

// main 客户端入口。
func main() {
	// 定义命令行子命令参数。
	upCmd := flag.NewFlagSet("up", flag.ExitOnError) // 定义 up 子命令。
	foregroundOpt := upCmd.Bool("foreground", false, "Run daemon in the foreground") // up 命令的可选前台运行参数。
	logToFileOpt := upCmd.Bool("log-to-file", false, "Redirect logs to daemon.log") // 可选重定向日志到日志文件参数。

	// 如果命令行输入参数太少，打印帮助并退出。
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	// 载入本地配置 config.json。
	if err := config.LoadConfig(); err != nil {
		fmt.Printf("Error loading config: %v\n", err)
		os.Exit(1)
	}

	cmd := os.Args[1] // 获取子命令关键字。

	// 路由解析各子命令。
	switch cmd {
	case "up":
		_ = upCmd.Parse(os.Args[2:]) // 解析参数。
		if *foregroundOpt {
			runForeground(*logToFileOpt) // 前台阻塞运行，传入重定向选项。
		} else {
			runBackground() // 后台派生运行。
		}
	case "down":
		runDown() // 关闭守护进程。
	case "status":
		runStatus() // 查看状态。
	case "list":
		runList() // 列出智能体。
	case "create":
		runCreate() // 创建新智能体。
	case "remove":
		runRemove() // 移除智能体。
	case "start":
		runStart() // 启动特定智能体。
	case "stop":
		runStop() // 停止特定智能体。
	case "restart":
		runRestart() // 重启特定智能体。
	case "connect":
		runConnect() // 连接智能体到工作区并建立双向桥接（阶段三）。
	case "workspace":
		runWorkspace()
	case "disconnect":
		runDisconnect() // 断开智能体的工作区连接（阶段三）。
	case "install":
		runInstall() // 安装特定智能体运行时环境（阶段四新增）。
	case "runtimes":
		runRuntimes() // 查看可用与已安装的智能体类型列表（阶段四新增）。
	case "env":
		runEnv() // 配置或查询类型级的环境变量（阶段四新增）。
	case "version", "-v", "--version":
		fmt.Printf("agn Launcher Version: %s (Go Edition)\n", version)
	case "help", "-h", "--help":
		printUsage()
	default:
		fmt.Printf("Unknown command: %s\n", cmd)
		printUsage()
		os.Exit(1)
	}
}

// printUsage 打印帮助菜单说明。
func printUsage() {
	fmt.Printf(`Usage: agn <command> [options]

Commands:
  up [--foreground]           Start daemon (background by default)
  down                        Stop daemon
  status                      Show agent status
  list                        List configured agents
  create <name> [--type T]    Create a new agent
  remove <name>               Remove an agent
  start <name>                Start a specific agent
  stop <name>                 Stop a specific agent
  restart <name>              Restart a specific agent
  connect <name> <token>      Connect an agent to a workspace (bidirectional bridge)
  workspace create [name]     Create a workspace and save its token
  workspace list              List saved workspaces
  disconnect <name>           Disconnect an agent from its workspace
  install <type>              Install agent runtime environment
  runtimes                    List available and installed runtimes
  env [type]                  Manage environment configuration variables
  version                     Show version
  help                        Show this help

Options:
  --foreground                Run daemon in foreground (only with 'up')
  --type <type>               Agent runtime type (default: openclaw)
  --endpoint <url>            Workspace backend base URL (default: http://localhost:8000)
  --network <id|slug>         Workspace ID or slug (optional; resolved by token if omitted)
  --channel <name>            Workspace channel to bridge (default: general)
`)
}

// ============================================================================
// 阶段一命令实现
// ============================================================================

// runForeground 在前台阻塞运行守护进程。
func runForeground(logToFile bool) {
	configDir, err := config.GetConfigDir() // 获取配置根路径。
	if err != nil {
		log.Fatalf("Failed to resolve config directory: %v", err)
	}

	// 如果开启了 log-to-file，则重定向 log 包的输出到 daemon.log 文件中。
	if logToFile {
		logFile := filepath.Join(configDir, "daemon.log")
		lf, err := os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
		if err == nil {
			log.SetOutput(lf)
		}
	}

	d := daemon.NewDaemon(configDir) // 实例化守护进程。
	if err := d.Start(); err != nil { // 启动。
		log.Fatalf("Daemon failed to start: %v", err)
	}

	log.Printf("Daemon running in foreground (PID %d)...", os.Getpid())

	// 监听系统中断信号（SIGINT, SIGTERM），以进行优雅退出清理。
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)

	sig := <-sigs // 阻塞在此直到收到中断信号。
	log.Printf("Received signal: %v. Initiating daemon shutdown...", sig)

	d.Stop() // 优雅退出。
}

// runBackground 将守护进程派生至后台独立运行。
func runBackground() {
	err := daemon.Daemonize() // 执行双进程派生。
	if err != nil {
		fmt.Printf("Failed to daemonize: %v\n", err)
		os.Exit(1)
	}
}

// runDown 关闭当前在运行的守护进程。
func runDown() {
	configDir, _ := config.GetConfigDir()
	pidFile := filepath.Join(configDir, "daemon.pid")
	cmdFile := filepath.Join(configDir, "daemon.cmd")

	// 读取 PID。
	data, err := os.ReadFile(pidFile)
	if err != nil {
		fmt.Println("Daemon is not running (PID file missing).")
		return
	}

	pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
	if err != nil {
		fmt.Println("Invalid PID file content.")
		return
	}

	process, err := os.FindProcess(pid) // 寻找到进程对象。
	if err != nil {
		fmt.Printf("Failed to find daemon process (PID %d).\n", pid)
		return
	}

	// 写入 stop 指令到 cmd 文件供其捕捉（若正常轮询可优雅退出）。
	_ = os.WriteFile(cmdFile, []byte("stop_all_and_exit"), 0644)

	fmt.Println("Stopping daemon...")

	// 稍等一秒，给守护进程自动读取删除 cmd 文件并关闭资源的时间。
	time.Sleep(1 * time.Second)

	// 发送 SIGTERM 强力终止。
	_ = process.Signal(syscall.SIGTERM)

	// 重试并强制 Kill 防止挂起。
	_ = process.Kill()

	// 清除残留。
	_ = os.Remove(pidFile)
	_ = os.Remove(cmdFile)

	// 清理 status.json 里的 PID。
	statusFile := filepath.Join(configDir, "daemon.status.json")
	_ = os.Remove(statusFile)

	fmt.Println("Daemon stopped successfully.")
}

// runStatus 展示当前的守护进程及各个 Agent 状态。
func runStatus() {
	configDir, _ := config.GetConfigDir()
	pidFile := filepath.Join(configDir, "daemon.pid")
	statusFile := filepath.Join(configDir, "daemon.status.json")

	// 检测守护进程本身是否在活跃中。
	running := false
	data, err := os.ReadFile(pidFile)
	if err == nil {
		pid, err := strconv.Atoi(strings.TrimSpace(string(data)))
		if err == nil {
			running = daemon.IsProcessRunning(pid) // 调用平台适配的检测机制。
		}
	}

	if !running {
		fmt.Println("Daemon State: [STOPPED]")
		return
	}

	fmt.Println("Daemon State: [RUNNING]")

	// 读取状态 status.json。
	dataStatus, err := os.ReadFile(statusFile)
	if err != nil {
		fmt.Println("No active agent status recorded yet.")
		return
	}

	var status daemon.DaemonStatus
	if err := json.Unmarshal(dataStatus, &status); err != nil {
		fmt.Println("Failed to parse status file.")
		return
	}

	fmt.Printf("Daemon PID: %d\n", status.PID)
	fmt.Println("--------------------------------------------------------------------------------")
	fmt.Printf("%-20s %-12s %-20s %-10s\n", "AGENT NAME", "TYPE", "WORKSPACE ID", "STATUS")
	fmt.Println("--------------------------------------------------------------------------------")

	if len(status.Agents) == 0 {
		fmt.Println("(No agents registered or running)")
		return
	}

	// 遍历智能体集合输出格式化数据。
	for name, state := range status.Agents {
		fmt.Printf("%-20s %-12s %-20s %-10s\n", name, state.Type, state.Network, state.State)
	}
	fmt.Println("--------------------------------------------------------------------------------")
}

// runList 列出配置文件中注册的全部智能体客户端。
func runList() {
	if len(config.LoadedConfig.Agents) == 0 {
		fmt.Println("No agents configured. Run 'agn create <name>' to create one.")
		return
	}

	fmt.Println("Configured Agents:")
	fmt.Println("--------------------------------------------------------------------------------")
	fmt.Printf("%-20s %-12s %-20s\n", "AGENT NAME", "TYPE", "ACTIVE WORKSPACE")
	fmt.Println("--------------------------------------------------------------------------------")
	for name, ag := range config.LoadedConfig.Agents {
		fmt.Printf("%-20s %-12s %-20s\n", name, ag.Type, ag.WorkspaceID)
	}
	fmt.Println("--------------------------------------------------------------------------------")
}

// ============================================================================
// 阶段二命令实现：智能体创建/删除/启动/停止
// ============================================================================

// runCreate 创建一个新的智能体定义并写入 config.json。
func runCreate() {
	// 手动解析 os.Args[2:] 参数。Go 的 flag 包不支持混合顺序的位置参数与 flag 参数。
	remaining := os.Args[2:]
	agentType := "openclaw" // 默认类型。
	var name string

	for i := 0; i < len(remaining); i++ {
		arg := remaining[i]
		if arg == "--type" || arg == "-type" {
			// 下一个参数是类型值。
			if i+1 < len(remaining) {
				agentType = remaining[i+1]
				i++ // 跳过已消费的类型值。
			}
		} else if strings.HasPrefix(arg, "--type=") {
			agentType = strings.TrimPrefix(arg, "--type=")
		} else if !strings.HasPrefix(arg, "-") {
			name = arg // 位置参数 => Agent 名称。
		}
	}

	if name == "" {
		fmt.Println("Usage: agn create <name> [--type <type>]")
		os.Exit(1)
	}

	entry := registry.GetEntry(agentType)
	if entry == nil {
		fmt.Printf("Error: unknown agent type '%s'.\n", agentType)
		fmt.Printf("Supported types: %s\n", strings.Join(registry.GetSupportedTypes(), ", "))
		os.Exit(1)
	}

	// 调用配置模块的 AddAgent 方法向配置写入新 Agent。
	if err := config.AddAgent(name, agentType, ""); err != nil {
		fmt.Printf("Error: %v\n", err)
		os.Exit(1)
	}

	// 尝试通知守护进程重新加载。
	_ = config.SendDaemonCommand("reload")

	fmt.Printf("Created local agent: %s (type: %s)\n", name, agentType)
	fmt.Println("")
	fmt.Println("This agent is local-only and will not appear in Workspace Dashboard yet.")
	fmt.Println("")
	fmt.Println("To connect it to a Workspace, run:")
	fmt.Printf("  agn connect %s <workspace-token>\n", name)
}

// runRemove 移除已注册的智能体定义。
func runRemove() {
	if len(os.Args) < 3 {
		fmt.Println("Usage: agn remove <name>")
		os.Exit(1)
	}

	name := os.Args[2] // 需要移除的 Agent 名称。

	// 先通知守护进程停止该 Agent（如在运行中）。
	_ = config.SendDaemonCommand("stop:" + name)

	// 调用配置模块的 RemoveAgent 方法从配置中移除。
	if err := config.RemoveAgent(name); err != nil {
		fmt.Printf("Error: %v\n", err)
		os.Exit(1)
	}

	// 通知守护进程重新加载配置。
	_ = config.SendDaemonCommand("reload")

	fmt.Printf("Agent '%s' removed\n", name)
}

// runStart 向守护进程发送启动特定 Agent 的指令。
func runStart() {
	if len(os.Args) < 3 {
		fmt.Println("Usage: agn start <name>")
		os.Exit(1)
	}

	name := os.Args[2]

	// 校验该 Agent 是否在配置中已注册。
	if _, exists := config.LoadedConfig.Agents[name]; !exists {
		fmt.Printf("Error: agent '%s' not found in config. Run 'agn create %s' first.\n", name, name)
		os.Exit(1)
	}

	// 写入 start:<name> 到 daemon.cmd 文件。
	if err := config.SendDaemonCommand("start:" + name); err != nil {
		fmt.Printf("Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Sent start command for '%s'\n", name)
}

// runStop 向守护进程发送停止特定 Agent 的指令。
func runStop() {
	if len(os.Args) < 3 {
		fmt.Println("Usage: agn stop <name>")
		os.Exit(1)
	}

	name := os.Args[2]

	// 写入 stop:<name> 到 daemon.cmd 文件。
	if err := config.SendDaemonCommand("stop:" + name); err != nil {
		fmt.Printf("Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Sent stop command for '%s'\n", name)
}

// runRestart 向守护进程发送重启特定 Agent 的指令。
func runRestart() {
	if len(os.Args) < 3 {
		fmt.Println("Usage: agn restart <name>")
		os.Exit(1)
	}

	name := os.Args[2]

	// 写入 restart:<name> 到 daemon.cmd 文件。
	if err := config.SendDaemonCommand("restart:" + name); err != nil {
		fmt.Printf("Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Sent restart command for '%s'\n", name)
}

// ============================================================================
// 阶段三命令实现：工作区连接与实时双向桥接
// ============================================================================

// runConnect 将指定智能体连接到工作区，持久化连接参数并通知守护进程建立双向桥接。
// 用法: agn connect <name> <token> [--endpoint URL] [--network ID|slug] [--channel NAME]
func runWorkspace() {
	if len(os.Args) < 3 {
		fmt.Println("Usage: agn workspace <create|list> [name] [--endpoint URL]")
		return
	}
	switch os.Args[2] {
	case "list":
		if len(config.LoadedConfig.Workspaces) == 0 {
			fmt.Println("No saved workspaces.")
			return
		}
		for key, workspace := range config.LoadedConfig.Workspaces {
			fmt.Printf("%-24s %-20s %s\n", key, workspace.Name, workspace.Endpoint)
		}
	case "create":
		name := "My Workspace"
		endpoint := "http://localhost:8000"
		for i := 3; i < len(os.Args); i++ {
			arg := os.Args[i]
			if (arg == "--endpoint" || arg == "-endpoint") && i+1 < len(os.Args) {
				endpoint = strings.TrimRight(os.Args[i+1], "/")
				i++
			} else if strings.HasPrefix(arg, "--endpoint=") {
				endpoint = strings.TrimRight(strings.TrimPrefix(arg, "--endpoint="), "/")
			} else if !strings.HasPrefix(arg, "-") {
				name = arg
			}
		}
		body, _ := json.Marshal(map[string]string{"name": name})
		resp, err := http.Post(endpoint+"/v1/workspaces", "application/json", bytes.NewReader(body))
		if err != nil {
			fmt.Printf("Error creating workspace: %v\n", err)
			return
		}
		defer resp.Body.Close()
		data, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != http.StatusCreated {
			fmt.Printf("Server returned %d: %s\n", resp.StatusCode, strings.TrimSpace(string(data)))
			return
		}
		var created struct {
			ID string `json:"id"`
			Slug string `json:"slug"`
			Name string `json:"name"`
			Token string `json:"token"`
		}
		if err := json.Unmarshal(data, &created); err != nil || created.Token == "" {
			fmt.Println("Server returned an invalid workspace response.")
			return
		}
		if err := config.StoreWorkspace(created.ID, created.Slug, created.Name, created.Token, endpoint); err != nil {
			fmt.Printf("Workspace created, but saving local config failed: %v\n", err)
			return
		}
		fmt.Printf("Workspace created: %s\n", created.Name)
		fmt.Printf("  Slug:  %s\n", created.Slug)
		fmt.Printf("  Token: %s\n", created.Token)
		fmt.Printf("  URL:   http://localhost:3000/%s?token=%s\n", created.Slug, created.Token)
		fmt.Printf("Connect an agent with: agn connect <name> %s --network %s --endpoint %s\n", created.Token, created.Slug, endpoint)
	default:
		fmt.Printf("Unknown workspace command: %s\n", os.Args[2])
	}
}

func runConnect() {
	// 手动解析位置参数与可选 flag（Go flag 包不支持位置参数与 flag 混排）。
	remaining := os.Args[2:]
	var positional []string
	var endpoint, network, channel string

	for i := 0; i < len(remaining); i++ {
		arg := remaining[i]
		switch {
		case arg == "--endpoint" || arg == "-endpoint":
			if i+1 < len(remaining) {
				endpoint = remaining[i+1]
				i++
			}
		case strings.HasPrefix(arg, "--endpoint="):
			endpoint = strings.TrimPrefix(arg, "--endpoint=")
		case arg == "--network" || arg == "-network":
			if i+1 < len(remaining) {
				network = remaining[i+1]
				i++
			}
		case strings.HasPrefix(arg, "--network="):
			network = strings.TrimPrefix(arg, "--network=")
		case arg == "--channel" || arg == "-channel":
			if i+1 < len(remaining) {
				channel = remaining[i+1]
				i++
			}
		case strings.HasPrefix(arg, "--channel="):
			channel = strings.TrimPrefix(arg, "--channel=")
		case !strings.HasPrefix(arg, "-"):
			positional = append(positional, arg) // 位置参数（name, token）。
		}
	}

	// 校验必填的位置参数。
	if len(positional) < 2 {
		fmt.Println("Usage: agn connect <name> <token> [--endpoint URL] [--network ID|slug] [--channel NAME]")
		os.Exit(1)
	}
	name := positional[0]
	token := positional[1]

	// 校验该智能体已注册。
	if _, exists := config.LoadedConfig.Agents[name]; !exists {
		fmt.Printf("Error: agent '%s' not found. Run 'agn create %s' first.\n", name, name)
		os.Exit(1)
	}

	// 持久化工作区连接绑定到 config.json。
	if err := config.ConnectAgent(name, network, token, endpoint, channel); err != nil {
		fmt.Printf("Error: %v\n", err)
		os.Exit(1)
	}

	// 通知守护进程建立桥接（若守护进程未运行，将在下次 'agn up' 时自动重连）。
	if err := config.SendDaemonCommand("connect:" + name); err != nil {
		fmt.Printf("Warning: failed to notify daemon: %v\n", err)
	}

	fmt.Printf("Connecting agent '%s' to workspace...\n", name)
	if network != "" {
		fmt.Printf("  Network:  %s\n", network)
	}
	if endpoint == "" {
		endpoint = "http://localhost:8000"
	}
	if channel == "" {
		channel = "general"
	}
	fmt.Printf("  Endpoint: %s\n", endpoint)
	fmt.Printf("  Channel:  %s\n", channel)
	fmt.Println("")
	fmt.Println("The daemon will join the workspace and bridge the agent's stdin/stdout in real time.")
	fmt.Println("Run 'agn status' to verify, or check ~/.52hzagents/daemon.log for bridge activity.")
}

// runDisconnect 断开指定智能体的工作区连接。
// 用法: agn disconnect <name>
func runDisconnect() {
	if len(os.Args) < 3 {
		fmt.Println("Usage: agn disconnect <name>")
		os.Exit(1)
	}

	name := os.Args[2]

	// 先通知守护进程关闭桥接会话（尽力而为）。
	if err := config.SendDaemonCommand("disconnect:" + name); err != nil {
		fmt.Printf("Warning: failed to notify daemon: %v\n", err)
	}

	// 解除本地配置中的工作区绑定。
	if err := config.DisconnectAgent(name); err != nil {
		fmt.Printf("Error: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Disconnected agent '%s' from its workspace.\n", name)
}

// ============================================================================
// 阶段四命令实现：安装器、运行时环境与环境变量配置
// ============================================================================

// runInstall 调用安装器拉起指定 Agent 的二进制文件下载与隔离部署。
func runInstall() {
	if len(os.Args) < 3 {
		fmt.Println("Usage: agn install <agent-type>")
		os.Exit(1)
	}

	agentType := os.Args[2]
	fmt.Printf("Installing agent runtime environment: %s...\n", agentType)
	
	if err := install.InstallAgent(agentType); err != nil {
		fmt.Printf("Installation failed: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Agent runtime '%s' installed successfully.\n", agentType)
}

// runRuntimes 列出内嵌注册表的所有可用 Agent 运行时，并显示其是否在本地已安装。
func runRuntimes() {
	entries := registry.GetAllEntries()
	if len(entries) == 0 {
		fmt.Println("Registry is empty or failed to load.")
		return
	}

	fmt.Println("Available Agent Runtimes:")
	fmt.Println("--------------------------------------------------------------------------------")
	fmt.Printf("%-20s %-12s %-40s\n", "NAME", "INSTALLED", "DESCRIPTION")
	fmt.Println("--------------------------------------------------------------------------------")

	for _, entry := range entries {
		installedStatus := "[ ] No"
		if install.IsAgentInstalled(entry.Name) {
			installedStatus = "[x] Yes"
		}
		
		// 截短描述信息防止排版错位。
		desc := entry.Description
		if len(desc) > 38 {
			desc = desc[:35] + "..."
		}
		fmt.Printf("%-20s %-12s %-40s\n", entry.Name, installedStatus, desc)
	}
	fmt.Println("--------------------------------------------------------------------------------")
}

// runEnv 管理特定 Agent 运行时的全局类型环境变量文件（位于 ~/.52hzagents/env/）。
func runEnv() {
	if len(os.Args) < 3 {
		fmt.Println("Usage:")
		fmt.Println("  agn env <agent-type>                Show current env values")
		fmt.Println("  agn env <agent-type> KEY=VALUE      Set env value")
		os.Exit(1)
	}

	agentType := os.Args[2]
	configDir, err := config.GetConfigDir()
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		os.Exit(1)
	}

	// 拼接该类智能体的环境变量专用文件路径。
	envDir := filepath.Join(configDir, "env")
	_ = os.MkdirAll(envDir, 0755)
	envFile := filepath.Join(envDir, agentType+".env")

	// 1. 如果没有后续参数，读取并打印当前已配的环境变量。
	if len(os.Args) == 3 {
		data, err := os.ReadFile(envFile)
		if err != nil {
			fmt.Printf("No environment variables configured for '%s' yet.\n", agentType)
			return
		}
		fmt.Printf("Environment variables for '%s':\n", agentType)
		fmt.Println(string(data))
		return
	}

	// 2. 如果携带了 KEY=VALUE 的参数，解析并持久化写入。
	kvStr := os.Args[3]
	parts := strings.SplitN(kvStr, "=", 2)
	if len(parts) != 2 {
		fmt.Println("Error: env argument must be in KEY=VALUE format")
		os.Exit(1)
	}
	key := strings.TrimSpace(parts[0])
	val := strings.TrimSpace(parts[1])

	// 简单读取现有文件以支持增量合并写入。
	envMap := make(map[string]string)
	if data, err := os.ReadFile(envFile); err == nil {
		lines := strings.Split(string(data), "\n")
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			partsSub := strings.SplitN(line, "=", 2)
			if len(partsSub) == 2 {
				envMap[strings.TrimSpace(partsSub[0])] = strings.TrimSpace(partsSub[1])
			}
		}
	}

	// 更新或增加值。
	envMap[key] = val

	// 重新写回文件。
	var sb strings.Builder
	for k, v := range envMap {
		sb.WriteString(fmt.Sprintf("%s=%s\n", k, v))
	}

	if err := os.WriteFile(envFile, []byte(sb.String()), 0644); err != nil {
		fmt.Printf("Error saving env configuration: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("Successfully updated environment variable for '%s': %s=%s\n", agentType, key, val)
}

