// Package daemon 负责管理后台守护进程，控制智能体子进程生命周期并处理本地文件指令通信。
package daemon

// 导入包依赖。
import (
	"encoding/json" // 用于序列化状态写入 JSON。
	"fmt"           // 格式化输出。
	"log"           // 打印守护进程系统日志。
	"os"            // 获取 PID 及文件读取删除。
	"os/exec"       // 启动后台守护进程。
	"path/filepath" // 拼接文件路径。
	"strconv"       // 数值转换。
	"strings"       // 文本分割处理。
	"time"          // 轮询心跳计时器。

	"github.com/woowonjae1/52hzAgents/packages/agn_go/internal/config" // 引入全局配置模块。
)

// AgentState 代表单个运行中 Agent 的实时状态。
type AgentState struct {
	State       string    `json:"state"`                  // 状态: running | stopped | starting | failed
	Type        string    `json:"type"`                   // 智能体类型 (如 claude)
	Network     string    `json:"network"`                // 关联的 Workspace (如 local)
	Restarts    int       `json:"restarts"`               // 重启次数
	StartedAt   time.Time `json:"started_at,omitempty"`   // 启动时间
	LastError   string    `json:"last_error,omitempty"`   // 最后的错误信息
	ErrorReason string    `json:"error_reason,omitempty"` // 错误诱因
}

// DaemonStatus 代表写入 daemon.status.json 的状态数据结构。
type DaemonStatus struct {
	Agents map[string]AgentState `json:"agents"` // 智能体状态字典
	PID    int                   `json:"pid"`    // 守护进程 PID
}

// Daemon 代表守护进程的运行上下文。
type Daemon struct {
	configDir     string                 // 配置文件夹路径
	statusFile    string                 // daemon.status.json 文件路径
	pidFile       string                 // daemon.pid 文件路径
	cmdFile       string                 // daemon.cmd 文件路径
	logFile       string                 // daemon.log 文件路径
	processes     map[string]AgentState  // 各个智能体的当前状态机字典
	stoppedAgents map[string]bool        // 被手动停止的智能体集合
	isShutdown    chan struct{}          // 关机通道信号
}

// NewDaemon 构造并初始化 Daemon 实例。
func NewDaemon(configDir string) *Daemon {
	return &Daemon{
		configDir:     configDir,
		statusFile:    filepath.Join(configDir, "daemon.status.json"),
		pidFile:       filepath.Join(configDir, "daemon.pid"),
		cmdFile:       filepath.Join(configDir, "daemon.cmd"),
		logFile:       filepath.Join(configDir, "daemon.log"),
		processes:     make(map[string]AgentState),
		stoppedAgents: make(map[string]bool),
		isShutdown:    make(chan struct{}),
	}
}

// Start 启动守护进程循环，开始监听本地指令及周期写入状态。
func (d *Daemon) Start() error {
	log.Println("Daemon starting...")

	// 写入当前守护进程的 PID 到 daemon.pid。
	if err := d.writePid(); err != nil {
		return err
	}

	// 默认启动所有在配置中注册的智能体（阶段二实现 launchAgent，此处暂行日志打印存占位）。
	for name, ag := range config.LoadedConfig.Agents {
		d.processes[name] = AgentState{
			State:   "stopped",
			Type:    ag.Type,
			Network: ag.WorkspaceID,
		}
		log.Printf("Agent auto-launch initialized: %s (Type: %s)", name, ag.Type)
	}

	// 立即写入一次当前状态文件。
	d.writeStatus()

	// 开启 200ms 一次的指令轮询。
	cmdTicker := time.NewTicker(200 * time.Millisecond)
	// 开启 5s 一次的状态写入。
	statusTicker := time.NewTicker(5 * time.Second)

	// 开启监听循环协程。
	go func() {
		for {
			select {
			case <-cmdTicker.C:
				d.processCommands() // 轮询执行来自命令行写入的指令。
			case <-statusTicker.C:
				d.writeStatus() // 定期刷新状态文件。
			case <-d.isShutdown:
				cmdTicker.Stop()
				statusTicker.Stop()
				return
			}
		}
	}()

	return nil
}

// Stop 停止守护进程并释放所有已分配的资源。
func (d *Daemon) Stop() {
	log.Println("Daemon shutting down...")
	close(d.isShutdown) // 广播关闭心跳协程。

	// TODO: 阶段二优雅关闭和杀掉所有正在运行的 Agent 子进程。

	_ = os.Remove(d.pidFile) // 清理 PID 遗留文件。
	d.writeStatus()          // 更新最终状态。
	log.Println("Daemon stopped cleanly.")
}

// writePid 写入 PID 锁定文件。
func (d *Daemon) writePid() error {
	pid := os.Getpid() // 获取当前进程 PID。
	return os.WriteFile(d.pidFile, []byte(strconv.Itoa(pid)), 0644)
}

// writeStatus 将状态写入磁盘 status.json 中。
func (d *Daemon) writeStatus() {
	status := DaemonStatus{
		Agents: d.processes,
		PID:    os.Getpid(),
	}
	data, err := json.MarshalIndent(status, "", "  ")
	if err == nil {
		_ = os.WriteFile(d.statusFile, data, 0644)
	}
}

// processCommands 读取并轮询 daemon.cmd。
func (d *Daemon) processCommands() {
	// 如果指令文件不存在，则直接返回。
	if _, err := os.Stat(d.cmdFile); os.IsNotExist(err) {
		return
	}

	// 读取指令内容。
	data, err := os.ReadFile(d.cmdFile)
	if err != nil {
		return
	}

	// 读完立即将指令文件物理删除（原子吞吐防冲突）。
	_ = os.Remove(d.cmdFile)

	raw := strings.TrimSpace(string(data))
	if raw == "" {
		return
	}

	// 支持换行多指令执行。
	lines := strings.Split(raw, "\n")
	for _, line := range lines {
		cmd := strings.TrimSpace(line)
		if cmd == "" {
			continue
		}

		log.Printf("Received command: %s", cmd)

		// 路由解析指令。
		if strings.HasPrefix(cmd, "stop:") {
			agentName := strings.TrimSpace(strings.TrimPrefix(cmd, "stop:"))
			d.handleStopAgent(agentName)
		} else if strings.HasPrefix(cmd, "start:") {
			agentName := strings.TrimSpace(strings.TrimPrefix(cmd, "start:"))
			d.handleStartAgent(agentName)
		} else if strings.HasPrefix(cmd, "restart:") {
			agentName := strings.TrimSpace(strings.TrimPrefix(cmd, "restart:"))
			d.handleRestartAgent(agentName)
		} else if cmd == "reload" {
			d.handleReloadConfig()
		}
	}
}

// handleStopAgent 停止特定智能体。
func (d *Daemon) handleStopAgent(name string) {
	log.Printf("Action: Stopping agent %s", name)
	d.stoppedAgents[name] = true

	// 更新内存状态。
	if state, ok := d.processes[name]; ok {
		state.State = "stopped"
		d.processes[name] = state
	}
	// TODO: 阶段二在此杀掉真实子进程。
	d.writeStatus()
}

// handleStartAgent 开启特定智能体。
func (d *Daemon) handleStartAgent(name string) {
	log.Printf("Action: Starting agent %s", name)
	delete(d.stoppedAgents, name)

	// 更新状态。
	if state, ok := d.processes[name]; ok {
		state.State = "running"
		state.StartedAt = time.Now()
		d.processes[name] = state
	}
	// TODO: 阶段二在此启动真实的子进程命令。
	d.writeStatus()
}

// handleRestartAgent 重启特定智能体。
func (d *Daemon) handleRestartAgent(name string) {
	d.handleStopAgent(name)
	d.handleStartAgent(name)
}

// handleReloadConfig 热重载配置文件。
func (d *Daemon) handleReloadConfig() {
	log.Println("Action: Reloading config.json")
	_ = config.LoadConfig() // 重读本地磁盘配置。

	// 根据新载入的配置增减内存中的 processes 占位。
	for name, ag := range config.LoadedConfig.Agents {
		if _, ok := d.processes[name]; !ok {
			d.processes[name] = AgentState{
				State:   "stopped",
				Type:    ag.Type,
				Network: ag.WorkspaceID,
			}
		}
	}
	d.writeStatus()
}

// Daemonize 将守护进程派生至后台独立运行（等效于 detached 运行）。
func Daemonize() error {
	configDir, err := config.GetConfigDir() // 获取配置根目录。
	if err != nil {
		return err
	}

	pidFile := filepath.Join(configDir, "daemon.pid")

	// 校验当前是否已有正在运行的守护进程。
	if isDaemonRunning(pidFile) {
		return fmt.Errorf("daemon is already running")
	}

	// 准备启动后台子命令。携带 "--foreground" 及 "--log-to-file" 参数运行，以作为子进程真正的服务逻辑。
	args := []string{"up", "--foreground", "--log-to-file"}
	cmd := exec.Command(os.Args[0], args...)

	// 打开系统的空设备（DevNull），避免子进程与父进程的主控制台标准流绑定。
	nullFile, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err == nil {
		cmd.Stdin = nullFile
		cmd.Stdout = nullFile
	}

	// 新建或追加错误日志文件（daemon.err），捕获子进程运行时可能发生的 panic 或异常。
	errFile := filepath.Join(configDir, "daemon.err")
	ef, err := os.OpenFile(errFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err == nil {
		cmd.Stderr = ef
	}

	// 设置平台独立的 Detached 脱离控制台运行参数。
	setDetachedAttrs(cmd)

	// 异步非阻塞起动进程。
	if err := cmd.Start(); err != nil {
		if nullFile != nil {
			_ = nullFile.Close()
		}
		if ef != nil {
			_ = ef.Close()
		}
		return err
	}

	// 在父进程中关闭空设备文件及错误重定向句柄（子进程已拥有其拷贝）。
	if nullFile != nil {
		_ = nullFile.Close()
	}
	if ef != nil {
		_ = ef.Close()
	}

	// 将启动得到的子进程 PID 记录回 pid 文件。
	_ = os.WriteFile(pidFile, []byte(strconv.Itoa(cmd.Process.Pid)), 0644)

	log.Printf("Daemonized successfully. Child PID: %d", cmd.Process.Pid)
	return nil
}

// isDaemonRunning 检查锁定 PID 文件是否存在且其 PID 进程是否依然在活跃中。
func isDaemonRunning(pidFile string) bool {
	data, err := os.ReadFile(pidFile) // 读取 PID 文件。
	if err != nil {
		return false
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(data))) // 解析。
	if err != nil {
		return false
	}

	return IsProcessRunning(pid) // 调用平台适配的检测机制。
}
