//go:build !windows

package daemon

// 导入必要的进程执行库。
import (
	"os"      // 获取并控制系统进程。
	"os/exec" // 派生进程执行命令。
	"syscall" // 底层 POSIX API 调用。
)

// setDetachedAttrs 设置 Unix/Linux 下脱离终端的 Setsid 独立会话属性。
func setDetachedAttrs(cmd *exec.Cmd) {
	// 在 POSIX 兼容系统下，设置 Setsid 使子进程拥有独立 SessionID，彻底脱离父终端。
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid: true,
	}
}

// IsProcessRunning 判断特定 PID 的进程在 POSIX 系统下是否生存。
func IsProcessRunning(pid int) bool {
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	// 向目标进程发送 0 无害信号以判断其状态是否存在。
	err = proc.Signal(syscall.Signal(0))
	return err == nil
}
