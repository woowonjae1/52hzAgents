package db

import (
	"log"
	"strings"

	"github.com/glebarez/sqlite"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

var DB *gorm.DB

func InitDB() {
	var err error
	dbURL := config.GlobalConfig.DatabaseURL

	if strings.HasPrefix(dbURL, "sqlite://") || strings.HasSuffix(dbURL, ".db") {
		// SQLite mode
		sqlitePath := strings.TrimPrefix(dbURL, "sqlite://")
		if sqlitePath == "" {
			sqlitePath = "gorm.db"
		}
		DB, err = gorm.Open(sqlite.Open(sqlitePath), &gorm.Config{})
	} else {
		// Postgres mode
		DB, err = gorm.Open(postgres.Open(dbURL), &gorm.Config{})
	}

	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}

	log.Println("Database connection established successfully.")

	// Run migrations
	err = DB.AutoMigrate(
		&models.EventRecord{},
		&models.Workspace{},
		&models.WorkspaceMember{},
		&models.Channel{},
		&models.ChannelMember{},
		&models.ChannelHumanMember{},
		&models.Invitation{},
		&models.WorkspaceCollaborator{},
		&models.KnowledgeEntry{},
		&models.FileRecord{},
		&models.BrowserTab{},
		&models.BrowserContext{},
		&models.BrowserUsage{},
		&models.DeviceToken{},
		&models.TodoRecord{},
		&models.TimerRecord{},
		&models.RoutineRecord{},
		&models.NotificationRecord{},
		&models.AgentRuntimeRecord{},
		&models.AgentLogRecord{},
		&models.AgentApprovalRecord{},
		&models.AuditRecord{},
		&models.CloudAgentConfig{},
		&models.ShareSnapshot{},
		&models.Agent{},
	)
	if err != nil {
		log.Fatalf("Failed to auto-migrate database: %v", err)
	}

	log.Println("Database auto-migration completed successfully.")
}
