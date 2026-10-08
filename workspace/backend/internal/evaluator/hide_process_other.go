//go:build !windows

package evaluator

import "os/exec"

func setWindowsHidden(cmd *exec.Cmd) {
	// No-op on non-Windows platforms.
}
