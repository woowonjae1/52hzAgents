//go:build windows

package daemon

// 导入必要的系统和进程执行库。
import (
	"os/exec" // 派生进程执行命令。
	"syscall" // 底层 Windows API 调用常数。
)

// setDetachedAttrs 设置 Windows 下脱离父控制台运行的 Detached 属性参数。
func setDetachedAttrs(cmd *exec.Cmd) {
	// 在 Windows 系统下：
	// 0x00000008 (DETACHED_PROCESS): 不为子进程创建新的控制台窗口。
	// 0x00000200 (CREATE_NEW_PROCESS_GROUP): 为子进程建立新的进程组。
	// 0x00001000 (CREATE_BREAKAWAY_FROM_JOB): 脱离父进程的作业（Job）限制，防止父进程退出时子进程被链式杀死。
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: 0x00000008 | 0x00000200 | 0x00001000,
	}
}

// IsProcessRunning 判断特定 PID 的进程在 Windows 下是否依然生存。
func IsProcessRunning(pid int) bool {
	// 定义有限的查询权限。
	const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
	// 试图打开目标 PID 的进程句柄。
	handle, err := syscall.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		// 如果返回系统错误 87 (参数错误)，代表 PID 对应的进程不存在。
		if err == syscall.Errno(87) {
			return false
		}
		// 如果返回系统错误 5 (拒绝访问)，说明进程存在但无权访问，因此它依然在运行中。
		if err == syscall.Errno(5) {
			return true
		}
		return false
	}
	defer syscall.CloseHandle(handle) // 结束后关闭句柄释放资源。

	var exitCode uint32 // 用于存取退出码。
	// 查询目标进程的退出码。
	err = syscall.GetExitCodeProcess(handle, &exitCode)
	if err != nil {
		return true // 若查询失败，兜底认为其仍在运行中。
	}

	const STILL_ACTIVE = 259 // Windows 下的进程活跃常数状态码。
	return exitCode == STILL_ACTIVE
}
