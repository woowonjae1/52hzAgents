//go:build windows

package main

import (
	"log"

	"golang.org/x/sys/windows"
)

/*
watchParent calls onExit once the process `pid` has ended.

It holds a SYNCHRONIZE handle and blocks on it, rather than re-opening the PID
on a timer as this used to. A PID is only a number: once the parent is gone
Windows may hand it to an unrelated process, and a poll that re-opens it by
number then sees "alive" forever. An open handle pins the process object, so the
wait wakes on the real exit, immediately, whatever the PID becomes.
*/
func watchParent(pid int, onExit func()) {
	h, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		// Already gone (or never ours): there is nothing to outlive.
		log.Printf("[52hz-server] Parent PID %d not reachable (%v); treating it as exited", pid, err)
		go onExit()
		return
	}
	go func() {
		defer windows.CloseHandle(h)
		if _, err := windows.WaitForSingleObject(h, windows.INFINITE); err != nil {
			log.Printf("[52hz-server] Waiting on parent PID %d failed: %v", pid, err)
			return
		}
		onExit()
	}()
}
