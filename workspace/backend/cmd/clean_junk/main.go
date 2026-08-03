package main

import (
	"log"
	"strings"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

func main() {
	config.LoadConfig()
	config.GlobalConfig.DatabaseURL = "sqlite://../.dev-sqlite/workspace.db"
	db.InitDB()

	var records []models.FileRecord
	if err := db.DB.Where("status != ?", "deleted").Find(&records).Error; err != nil {
		log.Fatalf("Failed to query file records: %v", err)
	}

	log.Printf("Total active file records: %d", len(records))

	junkCount := 0
	for _, rec := range records {
		f := rec.Filename
		isJunk := strings.Contains(f, "(") ||
			strings.Contains(f, "'") ||
			strings.Contains(f, "\"") ||
			strings.Contains(f, "f\"") ||
			strings.Contains(f, "output_") ||
			strings.Contains(f, "endswith") ||
			len(f) > 50

		if isJunk {
			log.Printf("[Junk Found] ID: %s | Filename: %s | Size: %d", rec.ID, f, rec.Size)
			db.DB.Model(&rec).Update("status", "deleted")
			junkCount++
		}
	}

	log.Printf("Soft-deleted %d junk file records successfully.", junkCount)
}
