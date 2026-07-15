// Package install 负责智能体运行时的自动下载与本地隔离安装。
package install

// 导入必要的库依赖。
import (
	"encoding/json" // 序列化与反序列化安装标记。
	"fmt"           // 格式化输出。
	"log"           // 打印异常信息。
	"os"            // 系统环境变量及文件读写。
	"os/exec"       // 启动系统 Shell 执行安装指令。
	"path/filepath" // 跨平台路径拼接。
	"runtime"       // 判断当前操作系统平台。
	"strings"       // 字符串文本替换。

	"github.com/woowonjae1/52hzAgents/packages/agn_go/internal/config"   // 本地配置路径解析。
	"github.com/woowonjae1/52hzAgents/packages/agn_go/internal/registry" // 嵌入的智能体注册表。
)

// InstallAgent 执行指定智能体类型的本地安装。
func InstallAgent(agentType string) error {
	entry := registry.GetEntry(agentType)
	if entry == nil {
		return fmt.Errorf("agent type '%s' not found in registry", agentType)
	}

	// 1. 如果是仅 API 类型，无需下载安装二进制，直接标记已安装并返回。
	// 虽然当前 registry.json 中没有明示 api_only 字段，但我们可以通过是否存在 install 节点进行兜底。
	// 这里直接检测是否在 registry.json 申明了特定平台的安装命令。
	cmdStr := getInstallCommand(entry)
	if cmdStr == "" {
		markInstalled(agentType)
		log.Printf("Agent %s does not require binary installation.", agentType)
		return nil
	}

	// 2. 隔离化 Npm 本地安装优化。
	// 若安装指令是 npm install -g 类似指令，为了防止全局安装权限报错（如 Linux 下的 sudo 或 Windows 下的管理员权限），
	// 我们将其重定向到本地隔离目录：~/.52hzagents/runtimes/<type>/
	if strings.HasPrefix(cmdStr, "npm install") {
		configDir, err := config.GetConfigDir()
		if err != nil {
			return err
		}
		prefixDir := filepath.Join(configDir, "runtimes", agentType)
		_ = os.MkdirAll(prefixDir, 0755)

		// 替换 -g 参数为指定的 prefix 目录。
		args := cmdStr
		args = strings.Replace(args, "npm install", "install --save", 1)
		args = strings.Replace(args, " -g ", fmt.Sprintf(" --prefix \"%s\" ", prefixDir), 1)

		// 补全可执行命令名。在 Windows 下使用 npm.cmd，Unix 下使用 npm。
		npmCmd := "npm"
		if runtime.GOOS == "windows" {
			npmCmd = "npm.cmd"
		}
		
		// 转换参数切片并执行。
		shellArgs := splitArgs(args)
		log.Printf("Executing npm local install: %s %s", npmCmd, strings.Join(shellArgs, " "))
		runCmd := exec.Command(npmCmd, shellArgs...)
		runCmd.Stdout = os.Stdout
		runCmd.Stderr = os.Stderr
		if err := runCmd.Run(); err != nil {
			return fmt.Errorf("npm local install failed: %w", err)
		}
	} else {
		// 3. 非 Npm 命令，直接作为 Shell 脚本执行。
		log.Printf("Executing install script: %s", cmdStr)
		var runCmd *exec.Cmd
		if runtime.GOOS == "windows" {
			runCmd = exec.Command("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmdStr)
		} else {
			runCmd = exec.Command("bash", "-c", cmdStr)
		}
		runCmd.Stdout = os.Stdout
		runCmd.Stderr = os.Stderr
		if err := runCmd.Run(); err != nil {
			return fmt.Errorf("install script failed: %w", err)
		}
	}

	// 4. 成功执行后，在本地写入安装标记文件。
	markInstalled(agentType)
	log.Printf("Agent type %s installed successfully.", agentType)
	return nil
}

// IsAgentInstalled 判断某个智能体是否已被安装。
func IsAgentInstalled(agentType string) bool {
	// 首先通过 exec.LookPath 检查系统环境变量 PATH 中是否存在。
	entry := registry.GetEntry(agentType)
	binary := agentType
	if entry != nil && entry.Install.Binary != "" {
		binary = entry.Install.Binary
	}
	if _, err := exec.LookPath(binary); err == nil {
		return true
	}

	// 其次检查本地沙箱 bin/ 目录下是否存在。
	configDir, err := config.GetConfigDir()
	if err == nil {
		ext := ""
		if runtime.GOOS == "windows" {
			ext = ".exe"
		}
		localBin := filepath.Join(configDir, "bin", binary+ext)
		if _, err := os.Stat(localBin); err == nil {
			return true
		}
		
		// 检查 Npm 本地隔离目录下的 .bin 是否存在。
		if runtime.GOOS == "windows" {
			ext = ".cmd" // Npm 脚本在 Windows 下封装为 .cmd / .ps1
		}
		npmBin := filepath.Join(configDir, "runtimes", agentType, "node_modules", ".bin", binary+ext)
		if _, err := os.Stat(npmBin); err == nil {
			return true
		}
	}

	// 最后读取 ~/.52hzagents/installed_agents.json 中保存的安装标记列表。
	installedList := ListInstalledAgents()
	for _, item := range installedList {
		if item == agentType {
			return true
		}
	}

	return false
}

// ListInstalledAgents 读取本地已成功运行过安装标记的所有智能体类型。
func ListInstalledAgents() []string {
	configDir, err := config.GetConfigDir()
	if err != nil {
		return nil
	}

	markersFile := filepath.Join(configDir, "installed_agents.json")
	if _, err := os.Stat(markersFile); os.IsNotExist(err) {
		return []string{}
	}

	data, err := os.ReadFile(markersFile)
	if err != nil {
		return []string{}
	}

	var list []string
	if err := json.Unmarshal(data, &list); err != nil {
		return []string{}
	}
	return list
}

// markInstalled 向本地 installed_agents.json 写入安装标记。
func markInstalled(agentType string) {
	configDir, err := config.GetConfigDir()
	if err != nil {
		return
	}

	// 在 ~/.52hzagents/installed/<type> 下创建空标记文件以保持兼容。
	markersDir := filepath.Join(configDir, "installed")
	_ = os.MkdirAll(markersDir, 0755)
	_ = os.WriteFile(filepath.Join(markersDir, agentType), []byte(""), 0644)

	// 更新 ~/.52hzagents/installed_agents.json 列表。
	list := ListInstalledAgents()
	found := false
	for _, item := range list {
		if item == agentType {
			found = true
			break
		}
	}
	if !found {
		list = append(list, agentType)
		data, _ := json.Marshal(list)
		_ = os.WriteFile(filepath.Join(configDir, "installed_agents.json"), data, 0644)
	}
}

// getInstallCommand 提取当前平台特供的安装命令行脚本。
func getInstallCommand(entry *registry.RegistryEntry) string {
	// 我们暂时通过直接解析内嵌的 json 映射到 RegistryEntry。
	// 这里通过反序列化为动态 map 获取平台命令，因为 Go struct 定义可能未包含全部 install 字段。
	rawJSON, _ := json.Marshal(entry)
	var data map[string]interface{}
	_ = json.Unmarshal(rawJSON, &data)

	installNode, ok := data["install"].(map[string]interface{})
	if !ok {
		return ""
	}

	platformKey := "linux"
	if runtime.GOOS == "darwin" {
		platformKey = "macos"
	} else if runtime.GOOS == "windows" {
		platformKey = "windows"
	}

	cmd, _ := installNode[platformKey].(string)
	return cmd
}

// splitArgs 辅助工具函数：把命令行字符串简单切分为切片（照顾到带双引号的路径）。
func splitArgs(s string) []string {
	var args []string
	var current strings.Builder
	inQuotes := false
	for i := 0; i < len(s); i++ {
		r := s[i]
		if r == '"' {
			inQuotes = !inQuotes
		} else if r == ' ' && !inQuotes {
			if current.Len() > 0 {
				args = append(args, current.String())
				current.Reset()
			}
		} else {
			current.WriteByte(r)
		}
	}
	if current.Len() > 0 {
		args = append(args, current.String())
	}
	return args
}
