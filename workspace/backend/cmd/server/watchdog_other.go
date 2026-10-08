//go:build !windows

package main

import (
	"os"
	"syscall"
	"time"
)

/*
watchParent calls onExit once the process `pid` has ended.

Unix has no wait-on-foreign-process primitive, so this polls. Two checks,
because either alone is fooled: signal 0 succeeds for a recycled PID, and
getppid only changes once the kernel has re-parented us. Losing the parent
shows up in the second immediately and is never masked by PID reuse.
*/
func watchParent(pid int, onExit func()) {
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for range ticker.C {
			if os.Getppid() != pid || syscall.Kill(pid, 0) != nil {
				onExit()
				return
			}
		}
	}()
}
