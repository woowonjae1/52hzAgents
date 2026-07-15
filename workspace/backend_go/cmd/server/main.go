package main

import (
	"fmt"
	"log"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/woowonjae1/52hzAgents/workspace/backend_go/internal/config"
	"github.com/woowonjae1/52hzAgents/workspace/backend_go/internal/db"
)

func main() {
	log.Println("Initializing 52hzAgents Workspace Server (Go Edition)...")

	// Load configuration
	config.LoadConfig()
	log.Printf("Configuration loaded: Host=%s, Port=%d, AuthMode=%s",
		config.GlobalConfig.Host,
		config.GlobalConfig.Port,
		config.GlobalConfig.AuthMode,
	)

	// Initialize Database (SQLite/Postgres) and run migrations
	db.InitDB()

	// Initialize Gin router
	router := gin.Default()

	// Core API routes
	v1 := router.Group("/v1")
	{
		v1.GET("/health", func(c *gin.Context) {
			c.JSON(http.StatusOK, gin.H{
				"status":      "ok",
				"service":     "52hzagents-workspace-backend",
				"auth_mode":   config.GlobalConfig.AuthMode,
				"db_dialect":  db.DB.Dialector.Name(),
			})
		})
	}

	// Legacy /health endpoint matching the health checks
	router.GET("/api/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status": "ok",
		})
	})

	address := fmt.Sprintf("%s:%d", config.GlobalConfig.Host, config.GlobalConfig.Port)
	log.Printf("Starting server on %s", address)
	if err := router.Run(address); err != nil {
		log.Fatalf("Server failed to run: %v", err)
	}
}
