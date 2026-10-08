//go:build windows

package main

import (
	"bufio"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

/*
THE DESKTOP SHELL'S JOB OBJECT.

`52hz-server.exe --job-guard` is a second, tiny process the Electron shell
starts before anything else. It owns one Windows Job Object configured with
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, and the shell writes the PID of every child
it spawns (this server, the wwj connector) to the guard's stdin, one per line.
Each one is assigned to the job, and so is everything those processes start
afterwards: agent CLIs, verification commands, launched terminals.

The guard lives exactly as long as the shell. Its stdin is a pipe only the
shell holds, so when the shell goes -- quit, crash, or killed from Task Manager
where no cleanup code runs -- the pipe hits EOF, the guard exits, its job handle
closes, and the kernel terminates every process in the job. No exit hook has to
run for that to happen, which is the point: the hooks in main.js only cover the
exits that let them run.

Why a separate process and not the server itself: the server is restarted by
the shell when it crashes. If it held the job, every server crash would also
take the connector and every running agent with it.
*/
func runJobGuard() {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		log.Fatalf("[job-guard] CreateJobObject: %v", err)
	}

	var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)),
		uint32(unsafe.Sizeof(info)),
	); err != nil {
		log.Fatalf("[job-guard] SetInformationJobObject: %v", err)
	}

	var once sync.Once
	done := make(chan struct{})
	stop := func() { once.Do(func() { close(done) }) }

	// The stdin EOF already covers the shell dying; the PID wait is the backstop
	// for a pipe handle that leaked into some other process and stays open.
	if ppid, err := strconv.Atoi(os.Getenv("PARENT_PID")); err == nil && ppid > 0 {
		watchParent(ppid, stop)
	}

	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			pid, err := strconv.Atoi(line)
			if err != nil || pid <= 0 {
				log.Printf("[job-guard] ignoring %q: not a PID", line)
				continue
			}
			if err := adoptIntoJob(job, pid); err != nil {
				log.Printf("[job-guard] could not adopt PID %d: %v", pid, err)
			}
		}
		stop()
	}()

	<-done

	// Grace period before the kill. The server watches the same parent and is
	// already stopping on its own: closing its listener and then SQLite, which
	// checkpoints the WAL. Killing it mid-way would leave the database to be
	// recovered on next start. So wait -- bounded -- for the adopted processes
	// to leave by themselves, and only then let the job take what remains.
	deadline := time.Now().Add(jobGuardGrace)
	rootsMu.Lock()
	for _, h := range roots {
		remaining := time.Until(deadline)
		if remaining <= 0 {
			break
		}
		windows.WaitForSingleObject(h, uint32(remaining.Milliseconds()))
	}
	rootsMu.Unlock()

	// Exiting closes the last handle to the job, which is what kills its members.
	os.Exit(0)
}

// Longer than the server's own 3s HTTP shutdown plus the database close.
const jobGuardGrace = 5 * time.Second

var (
	rootsMu sync.Mutex
	// Handles to every adopted process, kept open so the grace wait above can
	// block on them. Never closed: the guard's exit releases them.
	roots []windows.Handle
)

func adoptIntoJob(job windows.Handle, pid int) error {
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return err
	}
	if err := windows.AssignProcessToJobObject(job, h); err != nil {
		windows.CloseHandle(h)
		return err
	}
	rootsMu.Lock()
	roots = append(roots, h)
	rootsMu.Unlock()
	return nil
}
