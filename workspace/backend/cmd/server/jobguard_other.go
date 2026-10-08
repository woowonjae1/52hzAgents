//go:build !windows

package main

import "log"

// Job Objects are Windows-only. The desktop shell starts the guard only on
// win32, so reaching this means someone ran the flag by hand.
func runJobGuard() {
	log.Fatal("[job-guard] --job-guard is only supported on Windows")
}
