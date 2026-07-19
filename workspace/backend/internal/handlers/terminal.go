package handlers

import (
	"context"
	"net/http"
	"os/exec"
	"runtime"
	"time"

	"github.com/gin-gonic/gin"
)

type executeCommandRequest struct {
	Command string `json:"command" binding:"required"`
}

// ExecuteTerminalCommand handles POST /v1/terminal/execute
func ExecuteTerminalCommand(c *gin.Context) {
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

	// Set execution directory to workspace root
	cmd.Dir = ".."

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
