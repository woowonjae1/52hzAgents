// Package daemon 负责管理后台守护进程，控制智能体子进程生命周期并处理本地文件指令通信。
package daemon

// 导入所需的包依赖。
import (
	"bufio"        // 按行流式读取子进程输出。
	"encoding/json" // 序列化与反序列化 JSON。
	"fmt"          // 拼接格式化字符串。
	"io"           // 关闭管道输入输出。
	"log"          // 打印守护系统日志。
	"os"           // 系统环境变量及文件操作。
	"os/exec"      // 启动并控制外部子进程。
	"path/filepath" // 跨平台拼接路径。
	"runtime"      // 获取运行平台操作系统。
	"strconv"      // 类型转换。
	"strings"      // 字符串处理。
	"sync"         // 进程操作线程锁。
	"time"         // 时间计时器。

	"github.com/woowonjae1/52hzAgents/packages/agn_go/internal/config"   // 本地配置包。
	"github.com/woowonjae1/52hzAgents/packages/agn_go/internal/registry" // 嵌入式注册表。
)

// AgentState 代表单个运行中 Agent 的实时状态。
type AgentState struct {
	State       string    `json:"state"`                  // 状态: running | stopped | starting | failed
	Type        string    `json:"type"`                   // 智能体类型 (如 claude)
	Network     string    `json:"network"`                // 关联的工作区 (如 local)
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
	activeCmds    map[string]*exec.Cmd   // 记录当前活跃的外部子进程句柄 (阶段二新增)
	stoppedAgents map[string]bool        // 被手动停止的智能体集合
	isShutdown    chan struct{}          // 关机通道信号
	mu            sync.Mutex             // 操作并发锁，防范 start/stop 同步冲突 (阶段二新增)
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
		activeCmds:    make(map[string]*exec.Cmd),
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

	// 默认启动所有在配置中注册的智能体。
	for name, ag := range config.LoadedConfig.Agents {
		d.processes[name] = AgentState{
			State:   "stopped",
			Type:    ag.Type,
			Network: ag.WorkspaceID,
		}
		// 后台启动该智能体的生命周期监督循环 (阶段二实现)。
		go d.spawnLoop(name, ag)
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

	d.mu.Lock()
	// 遍历杀掉所有正在运行的 Agent 子进程。
	for name, cmd := range d.activeCmds {
		log.Printf("Killing process for agent %s (PID: %d)", name, cmd.Process.Pid)
		_ = cmd.Process.Kill()
	}
	d.mu.Unlock()

	_ = os.Remove(d.pidFile) // 清理 PID 遗留文件。
	d.writeStatus()          // 更新最终状态。
	log.Println("Daemon stopped cleanly.")
}

// getLaunchCommand 从配置和嵌入的 registry.json 匹配拼接启动命令。
func (d *Daemon) getLaunchCommand(ag config.AgentConfig) ([]string, string, error) {
	entry := registry.GetEntry(ag.Type) // 从注册表中寻找该 Agent 类别。
	var binary string
	if entry != nil && entry.Install.Binary != "" {
		binary = entry.Install.Binary
	} else {
		binary = ag.Type
	}

	// 利用 exec.LookPath 在环境变量 PATH 中搜寻该执行文件名。
	resolvedPath, err := exec.LookPath(binary)
	if err != nil {
		// 搜寻不到时，兜底去 ~/.52hzagents/bin/ 下查看是否被安装在该本地私有沙箱中。
		home, _ := os.UserHomeDir()
		localBin := filepath.Join(home, ".52hzagents", "bin", binary)
		if runtime.GOOS == "windows" {
			// 在 Windows 上补充常见的扩展名检测。
			for _, ext := range []string{".exe", ".cmd", ".bat"} {
				pathWithExt := localBin + ext
				if _, statErr := os.Stat(pathWithExt); statErr == nil {
					resolvedPath = pathWithExt
					err = nil
					break
				}
			}
		} else {
			if _, statErr := os.Stat(localBin); statErr == nil {
				resolvedPath = localBin
				err = nil
			}
		}

		if err != nil {
			return nil, "", fmt.Errorf("agent runtime binary '%s' not found on PATH or local sandbox", binary)
		}
	}

	args := make([]string, 0)
	// 拼接注册表设定的默认参数，并将占位符 {agent_name} 实名替换为 Agent 配置名。
	if entry != nil && len(entry.Launch.Args) > 0 {
		for _, arg := range entry.Launch.Args {
			args = append(args, strings.ReplaceAll(arg, "{agent_name}", ag.Name))
		}
	}

	// 如果没有参数设定，根据类别进行快捷命令的参数兜底注入。
	if len(args) == 0 {
		if ag.Type == "claude" {
			args = append(args, "--print")
		} else if ag.Type == "codex" {
			args = append(args, "--quiet")
		}
	}

	return args, resolvedPath, nil
}

// buildAgentEnv 组装运行外部 Agent 子进程的环境变量。
func (d *Daemon) buildAgentEnv(ag config.AgentConfig) []string {
	// 从父进程继承所有环境变量。
	envMap := make(map[string]string)
	for _, env := range os.Environ() {
		parts := strings.SplitN(env, "=", 2)
		if len(parts) == 2 {
			envMap[parts[0]] = parts[1]
		}
	}

	// 注入 Agent 专用的环境变量定义。
	for k, v := range ag.Env {
		envMap[k] = v
	}

	// 实现快捷 LLM_API_KEY 的变量映射（兼容主流大模型 Key 分发映射规范）。
	if key, ok := envMap["LLM_API_KEY"]; ok && key != "" {
		if _, has := envMap["OPENAI_API_KEY"]; !has {
			envMap["OPENAI_API_KEY"] = key
		}
		if _, has := envMap["ANTHROPIC_API_KEY"]; !has {
			envMap["ANTHROPIC_API_KEY"] = key
		}
		if _, has := envMap["GEMINI_API_KEY"]; !has {
			envMap["GEMINI_API_KEY"] = key
		}
	}

	// 转化为 os/exec 能够识别的 "KEY=VALUE" 字符串切片格式。
	envSlice := make([]string, 0, len(envMap))
	for k, v := range envMap {
		envSlice = append(envSlice, fmt.Sprintf("%s=%s", k, v))
	}
	return envSlice
}

// spawnLoop 负责特定的 Agent 生命周期的维持与监督循环（含异常崩溃重启）。
func (d *Daemon) spawnLoop(name string, ag config.AgentConfig) {
	backoff := 1 * time.Second // 崩溃重试避退初值设为 1s。

	for {
		// 监听守护进程终止信号，或判断该 Agent 已经被手动停止。
		select {
		case <-d.isShutdown:
			return
		default:
		}

		d.mu.Lock()
		if d.stoppedAgents[name] {
			d.mu.Unlock()
			return
		}
		d.mu.Unlock()

		// 标志为 starting。
		d.mu.Lock()
		state := d.processes[name]
		state.State = "starting"
		d.processes[name] = state
		d.mu.Unlock()
		d.writeStatus()

		// 解析组装子进程运行的完整指令。
		args, binaryPath, err := d.getLaunchCommand(ag)
		if err != nil {
			d.mu.Lock()
			state = d.processes[name]
			state.State = "failed"
			state.LastError = err.Error()
			state.ErrorReason = "runtime_missing"
			d.processes[name] = state
			d.mu.Unlock()
			d.writeStatus()

			log.Printf("Agent [%s] failed to resolve binary path: %v", name, err)
			return // 缺少运行时二进制属于硬错误，不再重启。
		}

		// 创建执行命令。
		var cmd *exec.Cmd
		if runtime.GOOS == "windows" {
			// 在 Windows 下通过 cmd.exe /c 启动以确保能顺利解析 PATH 下的 .cmd 与 .bat 脚本包装。
			fullArgs := append([]string{"/c", binaryPath}, args...)
			cmd = exec.Command("cmd.exe", fullArgs...)
		} else {
			cmd = exec.Command(binaryPath, args...)
		}

		// 加载专用环境变量。
		cmd.Env = d.buildAgentEnv(ag)
		// 设定执行的工作目录目录（默认为 ~/.52hzagents/workdirs/<name>）。
		if ag.WorkspaceID != "" {
			home, _ := os.UserHomeDir()
			cmd.Dir = filepath.Join(home, ".52hzagents", "workdirs", name)
			_ = os.MkdirAll(cmd.Dir, 0755)
		}

		// 截取管道捕获标准输出和错误输出，用于中继打印。
		stdout, err := cmd.StdoutPipe()
		if err != nil {
			log.Printf("Agent [%s] failed to pipe stdout: %v", name, err)
			return
		}
		stderr, err := cmd.StderrPipe()
		if err != nil {
			log.Printf("Agent [%s] failed to pipe stderr: %v", name, err)
			return
		}

		// 启动子进程。
		if err := cmd.Start(); err != nil {
			d.mu.Lock()
			state = d.processes[name]
			state.State = "failed"
			state.LastError = err.Error()
			state.ErrorReason = "spawn_error"
			d.processes[name] = state
			d.mu.Unlock()
			d.writeStatus()

			log.Printf("Agent [%s] failed to start process: %v", name, err)
			return
		}

		// 启动成功，标记为 running。
		d.mu.Lock()
		state = d.processes[name]
		state.State = "running"
		state.StartedAt = time.Now()
		state.LastError = ""
		state.ErrorReason = ""
		d.processes[name] = state
		d.activeCmds[name] = cmd // 保存进程句柄。
		d.mu.Unlock()
		d.writeStatus()

		log.Printf("Agent [%s] launched successfully (PID: %d)", name, cmd.Process.Pid)

		// 开启辅助协程流式按行读取子进程 Stdout 与 Stderr，并加上 Agent 统一前缀合并输出到全局 daemon.log 中。
		go func(r io.Reader) {
			scanner := bufio.NewScanner(r)
			for scanner.Scan() {
				log.Printf("[%s] %s", name, scanner.Text())
			}
		}(stdout)

		go func(r io.Reader) {
			scanner := bufio.NewScanner(r)
			for scanner.Scan() {
				log.Printf("[%s][stderr] %s", name, scanner.Text())
			}
		}(stderr)

		// 阻塞等待子进程退出。
		exitErr := cmd.Wait()

		// 退出后进行资源清理。
		d.mu.Lock()
		delete(d.activeCmds, name) // 从运行中列表中剥离。
		d.mu.Unlock()

		d.mu.Lock()
		isStopped := d.stoppedAgents[name]
		d.mu.Unlock()

		// 判断是手动停止的，则优雅退出循环，不触发崩溃重启避退。
		if isStopped {
			d.mu.Lock()
			state = d.processes[name]
			state.State = "stopped"
			d.processes[name] = state
			d.mu.Unlock()
			d.writeStatus()
			log.Printf("Agent [%s] stopped manually", name)
			return
		}

		// 否则被视为异常崩出。更新其状态，累加重启次数，并进行指数退避规避连续死锁崩溃。
		d.mu.Lock()
		state = d.processes[name]
		state.State = "failed"
		state.Restarts++
		if exitErr != nil {
			state.LastError = exitErr.Error()
			state.ErrorReason = "process_crashed"
		} else {
			state.LastError = "Process exited cleanly"
		}
		d.processes[name] = state
		d.mu.Unlock()
		d.writeStatus()

		log.Printf("Agent [%s] crashed (Restarts: %d, Code: %v), retrying in %v...", name, state.Restarts, exitErr, backoff)

		// 监听退避时间间隔，且支持在退避期间及时响应守护进程终止。
		select {
		case <-time.After(backoff):
			// 每次重启，避退时长翻倍，最高限制在 30 秒。
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		case <-d.isShutdown:
			return
		}
	}
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
		} else if cmd == "stop_all_and_exit" { // 新增：供 runDown 发送退出指令。
			d.Stop()
			os.Exit(0)
		}
	}
}

// handleStopAgent 停止特定智能体。
func (d *Daemon) handleStopAgent(name string) {
	log.Printf("Action: Stopping agent %s", name)

	d.mu.Lock()
	d.stoppedAgents[name] = true
	cmd, isRunning := d.activeCmds[name]
	d.mu.Unlock()

	// 若处于活跃，发送中断结束进程。
	if isRunning && cmd != nil {
		_ = cmd.Process.Kill()
	}

	// 更新内存状态。
	d.mu.Lock()
	if state, ok := d.processes[name]; ok {
		state.State = "stopped"
		d.processes[name] = state
	}
	d.mu.Unlock()
	d.writeStatus()
}

// handleStartAgent 开启特定智能体。
func (d *Daemon) handleStartAgent(name string) {
	log.Printf("Action: Starting agent %s", name)

	d.mu.Lock()
	delete(d.stoppedAgents, name)
	_, isRunning := d.activeCmds[name]
	d.mu.Unlock()

	// 已在运行中则跳过。
	if isRunning {
		log.Printf("Agent %s is already running. Skipping.", name)
		return
	}

	ag, exists := config.LoadedConfig.Agents[name]
	if !exists {
		log.Printf("Agent %s not found in config.json.", name)
		return
	}

	// 异步起动全新的生命周期监督协程。
	go d.spawnLoop(name, ag)
}

// handleRestartAgent 重启特定智能体。
func (d *Daemon) handleRestartAgent(name string) {
	d.handleStopAgent(name)
	// 给退出子进程一个缓和的退出窗口（0.5s）。
	time.Sleep(500 * time.Millisecond)
	d.handleStartAgent(name)
}

// handleReloadConfig 热重载配置文件。
func (d *Daemon) handleReloadConfig() {
	log.Println("Action: Reloading config.json")
	_ = config.LoadConfig() // 重读本地磁盘配置。

	d.mu.Lock()
	// 根据新载入的配置增减内存中的 processes 占位。
	for name, ag := range config.LoadedConfig.Agents {
		if _, ok := d.processes[name]; !ok {
			d.processes[name] = AgentState{
				State:   "stopped",
				Type:    ag.Type,
				Network: ag.WorkspaceID,
			}
			// 自动在后台启动该新增智能体。
			go d.spawnLoop(name, ag)
		}
	}
	d.mu.Unlock()
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
