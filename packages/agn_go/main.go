// Package main 是 agn (Go 版) 命令行客户端的入口。
package main

// 导入必要的库文件用于命令行参数解析、系统信号捕获、系统调用及配置文件操作。
import (
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

	"github.com/woowonjae1/52hzAgents/packages/agn_go/internal/config" // 本地配置。
	"github.com/woowonjae1/52hzAgents/packages/agn_go/internal/daemon" // 后台守护进程。
)

const version = "0.2.150" // 定义客户端版本号。

// main 客户端入口。
func main() {
	// 定义命令行子命令参数。
	upCmd := flag.NewFlagSet("up", flag.ExitOnError) // 定义 up 子命令。
	foregroundOpt := upCmd.Bool("foreground", false, "Run daemon in the foreground") // up 命令的可选前台运行参数。
	logToFileOpt := upCmd.Bool("log-to-file", false, "Redirect logs to daemon.log") // 新增：可选重定向日志到日志文件参数。

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
  version                     Show version
  help                        Show this help

Options:
  --foreground                Run daemon in foreground (only with 'up')
`)
}

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
