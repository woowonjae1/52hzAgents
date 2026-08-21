package compaction

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"gorm.io/gorm"
)

func setupTestDB(t *testing.T) (*gorm.DB, models.Workspace, models.Channel) {
	t.Helper()
	database, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:%s?mode=memory&cache=shared", uuid.NewString())), &gorm.Config{})
	if err != nil {
		t.Fatalf("open test db: %v", err)
	}

	if err := database.AutoMigrate(
		&models.Workspace{},
		&models.Channel{},
		&models.EventRecord{},
		&models.ChannelCompactionRecord{},
	); err != nil {
		t.Fatalf("migrate test db: %v", err)
	}
	db.DB = database

	wsID := uuid.NewString()
	ws := models.Workspace{ID: wsID, Name: "Compaction WS", Slug: "compaction-ws"}
	database.Create(&ws)

	chID := uuid.NewString()
	ch := models.Channel{ID: chID, WorkspaceID: wsID, Name: "general"}
	database.Create(&ch)

	return database, ws, ch
}

func TestEstimateTokens(t *testing.T) {
	tests := []struct {
		text    string
		minWant int
		maxWant int
	}{
		{"", 0, 0},
		{"Hello world", 2, 4},
		{"这是一段中文测试消息，包含多个汉字。", 15, 25},
		{"func main() { fmt.Println(\"Hello, 52hzAgents!\") }", 8, 20},
	}

	for _, tt := range tests {
		got := EstimateTokens(tt.text)
		if got < tt.minWant || got > tt.maxWant {
			t.Errorf("EstimateTokens(%q) = %d, want between %d and %d", tt.text, got, tt.minWant, tt.maxWant)
		}
	}
}

func TestGenerateDeterministicSummary(t *testing.T) {
	messages := []MessageItem{
		{EventID: "1", Source: "human:alice", Content: "Please refactor the database layer to pure Go.", Type: "chat"},
		{EventID: "2", Source: "openagents:coder", Content: "I modified internal/db/db.go and replaced cgo sqlite driver.", Type: "chat"},
		{EventID: "3", Source: "openagents:reviewer", Content: "Verified all unit tests pass with zero warnings.", Type: "chat"},
	}

	summary := GenerateDeterministicSummary("", messages)
	if !strings.Contains(summary, "Goals & Objectives") {
		t.Errorf("Summary missing Goals section: %s", summary)
	}
	if !strings.Contains(summary, "Key Decisions & Consensus") {
		t.Errorf("Summary missing Decisions section: %s", summary)
	}
	if !strings.Contains(summary, "Actions & Modifications") {
		t.Errorf("Summary missing Actions section: %s", summary)
	}
	if !strings.Contains(summary, "human:alice") {
		t.Errorf("Summary missing participant alice: %s", summary)
	}
}

func TestCompactChannel_SlidingWindow(t *testing.T) {
	database, ws, _ := setupTestDB(t)

	// Insert 25 simulated chat messages into the channel
	for i := 1; i <= 25; i++ {
		payloadBytes, _ := json.Marshal(map[string]interface{}{
			"content":      fmt.Sprintf("Step %d: Discussion on task item %d", i, i),
			"message_type": "chat",
		})
		rec := models.EventRecord{
			ID:        fmt.Sprintf("evt-%03d", i),
			NetworkID: ws.ID,
			Type:      "workspace.message.posted",
			Source:    "openagents:agent1",
			Target:    "channel/general",
			Payload:   payloadBytes,
			Timestamp: int64(1000 + i*10),
			CreatedAt: time.Now(),
		}
		database.Create(&rec)
	}

	// 1. Run compaction with MessageThreshold = 20, KeepRecentVerbatim = 5
	cfg := &CompactorConfig{
		MessageThreshold:   20,
		TokenThreshold:     10000,
		KeepRecentVerbatim: 5,
	}

	result, err := CompactChannel(ws.ID, "general", cfg)
	if err != nil {
		t.Fatalf("CompactChannel failed: %v", err)
	}
	if result.Skipped {
		t.Fatalf("Compaction should not be skipped: %s", result.SkipReason)
	}

	if result.CompactedCount != 20 { // 25 total - 5 kept = 20 compacted
		t.Errorf("Expected 20 compacted messages, got %d", result.CompactedCount)
	}

	if result.Record.FromEventID != "evt-001" || result.Record.ToEventID != "evt-020" {
		t.Errorf("Expected compacted range evt-001..evt-020, got %s..%s", result.Record.FromEventID, result.Record.ToEventID)
	}

	// 2. Query Compacted Channel History
	summary, recent, err := GetCompactedChannelHistory(ws.ID, "general", 10)
	if err != nil {
		t.Fatalf("GetCompactedChannelHistory failed: %v", err)
	}

	if strings.TrimSpace(summary) == "" {
		t.Errorf("Expected non-empty summary from compaction")
	}
	if len(recent) != 5 { // The 5 recent verbatim messages
		t.Errorf("Expected 5 recent messages, got %d", len(recent))
	}
	if recent[0].EventID != "evt-021" {
		t.Errorf("Expected first recent message to be evt-021, got %s", recent[0].EventID)
	}
}
