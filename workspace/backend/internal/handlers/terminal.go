package handlers

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

type executeCommandRequest struct {
	Command string `json:"command" binding:"required"`
}

// ExecuteTerminalCommand handles POST /v1/terminal/execute
func ExecuteTerminalCommand(c *gin.Context) {
	// Strict RCE Prevention: Only allow loopback requests (localhost / 127.0.0.1 / ::1)
	clientIP := c.ClientIP()
	if clientIP != "127.0.0.1" && clientIP != "::1" && clientIP != "localhost" {
		c.JSON(http.StatusForbidden, gin.H{"error": "Terminal execution is restricted to localhost loopback calls only"})
		return
	}

	_, ok := requestWorkspace(c)
	if !ok {
		return
	}

	// Token requirement: Even in dev mode, terminal execution requires a valid X-Workspace-Token
	token := workspaceToken(c)
	if token == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "X-Workspace-Token required for terminal execution"})
		return
	}

	var req executeCommandRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "powershell", "-Command", req.Command)
	} else {
		cmd = exec.CommandContext(ctx, "sh", "-c", req.Command)
	}

	// Dynamically resolve workspace root directory
	if wd, err := os.Getwd(); err == nil {
		if strings.HasSuffix(filepath.ToSlash(wd), "/backend") {
			cmd.Dir = filepath.Dir(wd)
		} else {
			cmd.Dir = wd
		}
	} else {
		cmd.Dir = ".."
	}

	outputBytes, err := cmd.CombinedOutput()
	output := string(outputBytes)

	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			c.JSON(http.StatusOK, gin.H{
				"output": output + "\n[SYSTEM ERROR] Command execution timed out after 20 seconds.",
			})
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"output": output + "\n[SYSTEM ERROR] " + err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"output": output,
	})
}
