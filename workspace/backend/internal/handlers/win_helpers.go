package handlers

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// resolveGitBinary dynamically resolves the git executable on any machine.
// On Windows, if git is not in %PATH%, it falls back to standard installation paths.
func resolveGitBinary() string {
	if p, err := exec.LookPath("git"); err == nil {
		return p
	}
	if runtime.GOOS == "windows" {
		programFiles := os.Getenv("ProgramFiles")
		programFilesX86 := os.Getenv("ProgramFiles(x86)")
		localAppData := os.Getenv("LOCALAPPDATA")

		candidates := []string{
			filepath.Join(programFiles, "Git", "cmd", "git.exe"),
			filepath.Join(programFiles, "Git", "bin", "git.exe"),
			filepath.Join(programFilesX86, "Git", "cmd", "git.exe"),
			filepath.Join(localAppData, "Programs", "Git", "cmd", "git.exe"),
		}
		for _, c := range candidates {
			if c != "" {
				if _, err := os.Stat(c); err == nil {
					return c
				}
			}
		}
	}
	return "git"
}

// resolvePowerShellBinary dynamically resolves powershell on Windows.
// If powershell is not in %PATH%, it falls back to the canonical System32 location.
func resolvePowerShellBinary() string {
	if p, err := exec.LookPath("powershell"); err == nil {
		return p
	}
	if runtime.GOOS == "windows" {
		sysRoot := os.Getenv("SystemRoot")
		if sysRoot == "" {
			sysRoot = "C:\\Windows"
		}
		ps := filepath.Join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
		if _, err := os.Stat(ps); err == nil {
			return ps
		}
	}
	return "powershell"
}

// resolveNodeCommand builds an *exec.Cmd to execute a Node.js script.
// If node is not found in %PATH%, it checks:
// 1. Portable Node in ~/.wwj/nodejs/node.exe
// 2. Standard Program Files / LocalAppData Node.js installations
// 3. Bundled Electron runtime (ELECTRON_EXE) with ELECTRON_RUN_AS_NODE=1
func resolveNodeCommand(scriptPath string, args ...string) *exec.Cmd {
	var nodeBin string
	var extraEnv []string

	if p, err := exec.LookPath("node"); err == nil {
		nodeBin = p
	} else if runtime.GOOS == "windows" {
		userProfile := os.Getenv("USERPROFILE")
		programFiles := os.Getenv("ProgramFiles")
		programFilesX86 := os.Getenv("ProgramFiles(x86)")
		localAppData := os.Getenv("LOCALAPPDATA")
		appData := os.Getenv("APPDATA")

		candidates := []string{
			filepath.Join(userProfile, ".wwj", "nodejs", "node.exe"),
			filepath.Join(programFiles, "nodejs", "node.exe"),
			filepath.Join(programFilesX86, "nodejs", "node.exe"),
			filepath.Join(localAppData, "Programs", "node", "node.exe"),
			filepath.Join(appData, "nvm", "current", "node.exe"),
		}
		for _, c := range candidates {
			if c != "" {
				if _, err := os.Stat(c); err == nil {
					nodeBin = c
					break
				}
			}
		}
	}

	if nodeBin == "" {
		if electronExe := os.Getenv("ELECTRON_EXE"); electronExe != "" {
			if _, err := os.Stat(electronExe); err == nil {
				nodeBin = electronExe
				extraEnv = append(extraEnv, "ELECTRON_RUN_AS_NODE=1")
			}
		}
	}

	if nodeBin == "" {
		nodeBin = "node"
	}

	allArgs := append([]string{scriptPath}, args...)
	cmd := exec.Command(nodeBin, allArgs...)
	if len(extraEnv) > 0 {
		cmd.Env = append(os.Environ(), extraEnv...)
	}
	return cmd
}
