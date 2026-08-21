package compaction

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

// The fallback summarizer is persisted as a checkpoint and replayed to agents, so
// identical input must produce identical text. Participant names came from a Go
// map, whose iteration order is randomized per run.
func TestDeterministicSummaryIsStableAcrossRuns(t *testing.T) {
	msgs := []MessageItem{
		{EventID: "1", Source: "human:alice", Content: "build the importer"},
		{EventID: "2", Source: "agent:bob", Content: "Created importer.go"},
		{EventID: "3", Source: "agent:carol", Content: "reviewed it"},
		{EventID: "4", Source: "agent:dave", Content: "Modified schema.sql"},
		{EventID: "5", Source: "agent:erin", Content: "noted"},
	}

	first := GenerateDeterministicSummary("", msgs)
	for i := 1; i < 25; i++ {
		if got := GenerateDeterministicSummary("", msgs); got != first {
			t.Fatalf("run %d differs from run 0\n--- run 0 ---\n%s\n--- run %d ---\n%s", i, first, i, got)
		}
	}
}

// Sections 2 and 4 are two of the four advertised dimensions. They must carry
// extracted content, not a fixed sentence, whenever the dialogue states a decision
// or an open task.
func TestDeterministicSummaryExtractsDecisionsAndPending(t *testing.T) {
	msgs := []MessageItem{
		{EventID: "1", Source: "human:alice", Content: "we need retries on the uploader"},
		{EventID: "2", Source: "agent:bob", Content: "Analysis done.\nWe decided to use exponential backoff instead of a fixed delay."},
		{EventID: "3", Source: "agent:carol", Content: "Created uploader.go\nTODO: wire the metrics counter before release."},
		{EventID: "4", Source: "agent:dave", Content: "约定统一用 UTC 时间戳。\n还需补充单元测试。"},
	}

	summary := GenerateDeterministicSummary("", msgs)

	section2 := sectionBody(t, summary, "### 2. Key Decisions & Consensus")
	if !strings.Contains(section2, "exponential backoff") {
		t.Errorf("section 2 lost the stated decision:\n%s", section2)
	}
	if !strings.Contains(section2, "UTC") {
		t.Errorf("section 2 lost the Chinese-language decision:\n%s", section2)
	}

	section4 := sectionBody(t, summary, "### 4. Pending Tasks & Current State")
	if !strings.Contains(section4, "metrics counter") {
		t.Errorf("section 4 lost the TODO:\n%s", section4)
	}
	if !strings.Contains(section4, "单元测试") {
		t.Errorf("section 4 lost the Chinese-language pending item:\n%s", section4)
	}
}

func sectionBody(t *testing.T, summary, header string) string {
	t.Helper()
	idx := strings.Index(summary, header)
	if idx < 0 {
		t.Fatalf("summary is missing %q:\n%s", header, summary)
	}
	rest := summary[idx+len(header):]
	if next := strings.Index(rest, "### "); next >= 0 {
		rest = rest[:next]
	}
	return rest
}

// "Recent" has to mean newest. Ordering ascending before LIMIT returned the oldest
// messages after the checkpoint, so an agent resuming a channel read stale context
// and never saw the latest activity.
func TestGetCompactedChannelHistoryReturnsNewestMessages(t *testing.T) {
	database, ws, ch := setupTestDB(t)

	const total = 40
	for i := 0; i < total; i++ {
		payload, _ := json.Marshal(map[string]interface{}{
			"content":      fmt.Sprintf("msg-%02d", i),
			"message_type": "chat",
		})
		if err := database.Create(&models.EventRecord{
			ID: uuid.NewString(), NetworkID: ws.ID, Type: "workspace.message",
			Source: "human:alice", Target: "channel/" + ch.Name, Payload: payload,
			Timestamp: int64(1_700_000_000_000 + i*1000), Visibility: "channel",
		}).Error; err != nil {
			t.Fatalf("seed event %d: %v", i, err)
		}
	}

	result, err := CompactChannel(ws.ID, ch.Name, &CompactorConfig{
		MessageThreshold: 10, TokenThreshold: 100, KeepRecentVerbatim: 10,
	})
	if err != nil {
		t.Fatalf("compact: %v", err)
	}
	if result.Skipped {
		t.Fatalf("compaction skipped: %s", result.SkipReason)
	}

	// 30 compacted, 10 left verbatim. Asking for 5 must yield msg-35..msg-39.
	_, recent, err := GetCompactedChannelHistory(ws.ID, ch.Name, 5)
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	got := make([]string, 0, len(recent))
	for _, m := range recent {
		got = append(got, m.Content)
	}
	want := []string{"msg-35", "msg-36", "msg-37", "msg-38", "msg-39"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("recent window = %v, want %v", got, want)
	}

	// A limit above the remaining count returns the whole verbatim tail in order.
	_, all, err := GetCompactedChannelHistory(ws.ID, ch.Name, 50)
	if err != nil {
		t.Fatalf("history all: %v", err)
	}
	if len(all) != 10 {
		t.Fatalf("expected the 10 verbatim messages, got %d", len(all))
	}
	if all[0].Content != "msg-30" || all[9].Content != "msg-39" {
		t.Errorf("verbatim tail out of order: first=%s last=%s", all[0].Content, all[9].Content)
	}
}

// A checkpoint only earns its place if it is smaller than the window it replaces.
// Single-line messages used to be emitted into two or three sections at once, so a
// 30-message compaction produced a summary of the same size -- a 0% saving that
// still consumed a row, an event, and the compaction cursor.
func TestCompactionActuallyReducesTokens(t *testing.T) {
	database, ws, ch := setupTestDB(t)

	// Realistic single-line agent chatter: each line carries both an action and a
	// decision or TODO, which is what triggered the double-emission.
	bodies := []string{
		"make the importer streaming, step-%d",
		"Created importer_%d.go. We decided to use exponential backoff instead of a fixed delay.",
		"Modified schema_%d.sql. TODO: wire the metrics counter before release.",
		"Ran the suite. Still need integration coverage for retries.",
	}
	sources := []string{"human:alice", "agent:coder", "agent:review", "agent:qa"}

	for i := 0; i < 40; i++ {
		payload, _ := json.Marshal(map[string]interface{}{
			"content":      fmt.Sprintf(bodies[i%4], i),
			"message_type": "chat",
		})
		if err := database.Create(&models.EventRecord{
			ID: uuid.NewString(), NetworkID: ws.ID, Type: "workspace.message",
			Source: sources[i%4], Target: "channel/" + ch.Name, Payload: payload,
			Timestamp: int64(1_700_000_000_000 + i*1000), Visibility: "channel",
		}).Error; err != nil {
			t.Fatalf("seed event %d: %v", i, err)
		}
	}

	result, err := CompactChannel(ws.ID, ch.Name, &CompactorConfig{
		MessageThreshold: 10, TokenThreshold: 100, KeepRecentVerbatim: 10,
	})
	if err != nil {
		t.Fatalf("compact: %v", err)
	}
	if result.Skipped {
		t.Fatalf("compaction skipped on a 30-message window: %s", result.SkipReason)
	}

	before := result.Record.EstimatedTokensBefore
	after := result.Record.EstimatedTokensAfter
	if after >= before {
		t.Fatalf("summary did not shrink the window: %d -> %d tokens", before, after)
	}
	// The window is highly repetitive, so a real compaction should cut it by a lot
	// more than a rounding error.
	if saved := float64(before-after) / float64(before); saved < 0.25 {
		t.Errorf("token reduction was only %.0f%% (%d -> %d); expected at least 25%%", saved*100, before, after)
	}

	// No bullet may appear twice anywhere in the summary.
	seen := map[string]int{}
	for _, line := range strings.Split(result.Record.Summary, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "- ") {
			continue
		}
		seen[line]++
		if seen[line] > 1 {
			t.Errorf("summary repeats a bullet %d times: %q", seen[line], line)
		}
	}
}

// The guard must refuse to persist a checkpoint that saves nothing.
func TestCompactionRefusesUnprofitableCheckpoint(t *testing.T) {
	database, ws, ch := setupTestDB(t)

	// Very short messages: any structured summary costs more than the originals.
	for i := 0; i < 20; i++ {
		payload, _ := json.Marshal(map[string]interface{}{"content": "ok", "message_type": "chat"})
		database.Create(&models.EventRecord{
			ID: uuid.NewString(), NetworkID: ws.ID, Type: "workspace.message",
			Source: "agent:bot", Target: "channel/" + ch.Name, Payload: payload,
			Timestamp: int64(1_700_000_000_000 + i*1000), Visibility: "channel",
		})
	}

	result, err := CompactChannel(ws.ID, ch.Name, &CompactorConfig{
		MessageThreshold: 5, TokenThreshold: 10, KeepRecentVerbatim: 5,
	})
	if err != nil {
		t.Fatalf("compact: %v", err)
	}
	if !result.Skipped {
		t.Fatalf("expected an unprofitable compaction to be skipped, got %d -> %d tokens",
			result.Record.EstimatedTokensBefore, result.Record.EstimatedTokensAfter)
	}
	if !strings.Contains(result.SkipReason, "not smaller") {
		t.Errorf("skip reason should explain the guard, got %q", result.SkipReason)
	}

	var count int64
	db2 := database.Model(&models.ChannelCompactionRecord{}).Where("workspace_id = ?", ws.ID)
	if err := db2.Count(&count).Error; err != nil {
		t.Fatalf("count records: %v", err)
	}
	if count != 0 {
		t.Errorf("a refused checkpoint must not be persisted, found %d record(s)", count)
	}
}
