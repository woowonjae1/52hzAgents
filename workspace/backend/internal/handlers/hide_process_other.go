//go:build !windows

package handlers

import (
	"os/exec"
)

func setWindowsHidden(cmd *exec.Cmd) {
	// No-op on non-Windows platforms
}
