package compaction

import (
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/hub"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

// CompactorConfig defines parameters for automated and manual channel compaction.
type CompactorConfig struct {
	MessageThreshold   int  `json:"message_threshold"`    // Minimum message count to trigger auto-compaction (default: 30)
	TokenThreshold     int  `json:"token_threshold"`      // Token count estimate threshold (default: 6000)
	KeepRecentVerbatim int  `json:"keep_recent_verbatim"` // Number of most recent messages to keep uncompressed (default: 10)
	Force              bool `json:"force"`                // Force compaction even if below threshold
}

// DefaultCompactorConfig provides standard production defaults.
func DefaultCompactorConfig() *CompactorConfig {
	return &CompactorConfig{
		MessageThreshold:   30,
		TokenThreshold:     6000,
		KeepRecentVerbatim: 10,
	}
}

// CompactResult contains metrics and the created compaction record.
type CompactResult struct {
	Record         *models.ChannelCompactionRecord `json:"record"`
	Skipped        bool                            `json:"skipped"`
	SkipReason     string                          `json:"skip_reason,omitempty"`
	TokensSaved    int                             `json:"tokens_saved"`
	CompactedCount int                             `json:"compacted_count"`
}

// ExtractMessageItems converts raw database event records into normalized MessageItems.
func ExtractMessageItems(records []models.EventRecord) []MessageItem {
	var items []MessageItem
	for _, rec := range records {
		var payload map[string]interface{}
		_ = json.Unmarshal(rec.Payload, &payload)
		if payload == nil {
			payload = make(map[string]interface{})
		}

		content, _ := payload["content"].(string)
		msgType, _ := payload["message_type"].(string)
		if msgType == "" {
			msgType = "chat"
		}

		// Don't compact ephemeral status updates
		if msgType == "status" {
			continue
		}

		items = append(items, MessageItem{
			EventID:   rec.ID,
			Source:    rec.Source,
			Target:    rec.Target,
			Content:   content,
			Type:      msgType,
			Timestamp: rec.Timestamp,
		})
	}
	return items
}

// CompactChannel executes a compaction cycle on a specific workspace channel.
func CompactChannel(workspaceID, channelName string, customCfg *CompactorConfig) (*CompactResult, error) {
	if customCfg == nil {
		customCfg = DefaultCompactorConfig()
	}

	target := "channel/" + strings.TrimPrefix(channelName, "channel/")
	rawChannelName := strings.TrimPrefix(channelName, "channel/")

	// 1. Fetch channel entity to verify existence
	var channel models.Channel
	if err := db.DB.Where("workspace_id = ? AND name = ?", workspaceID, rawChannelName).First(&channel).Error; err != nil {
		return nil, fmt.Errorf("channel not found: %w", err)
	}

	// 2. Fetch all historical chat events for this channel in chronological order
	var eventRecords []models.EventRecord
	err := db.DB.Where("network_id = ? AND target = ? AND type LIKE ?", workspaceID, target, "workspace.message%").
		Order("timestamp asc, id asc").
		Find(&eventRecords).Error
	if err != nil {
		return nil, fmt.Errorf("failed to fetch channel events: %w", err)
	}

	allMessages := ExtractMessageItems(eventRecords)

	// 3. Find the previous latest compaction record (if any)
	// A channel with no prior checkpoint is the normal case, so this uses Find
	// rather than First: First logs ErrRecordNotFound as an error, which the
	// scheduler would then emit for every uncompacted channel every 60 seconds.
	var previousRecords []models.ChannelCompactionRecord
	if err := db.DB.Where("workspace_id = ? AND channel_id = ?", workspaceID, channel.ID).
		Order("created_at desc").Limit(1).Find(&previousRecords).Error; err != nil {
		return nil, fmt.Errorf("failed to read compaction history: %w", err)
	}
	var latestCompaction models.ChannelCompactionRecord
	hasPrevious := len(previousRecords) > 0
	if hasPrevious {
		latestCompaction = previousRecords[0]
	}

	// Determine starting index of uncompacted messages
	startIndex := 0
	if hasPrevious && latestCompaction.ToEventID != "" {
		for i, m := range allMessages {
			if m.EventID == latestCompaction.ToEventID {
				startIndex = i + 1
				break
			}
		}
	}

	uncompactedMessages := allMessages[startIndex:]
	uncompactedCount := len(uncompactedMessages)

	keepVerbatim := customCfg.KeepRecentVerbatim
	if keepVerbatim < 2 {
		keepVerbatim = 2
	}

	// Check if compaction is needed
	estimatedTokens := EstimateMessagesTokens(uncompactedMessages)
	if !customCfg.Force {
		if uncompactedCount < customCfg.MessageThreshold && estimatedTokens < customCfg.TokenThreshold {
			return &CompactResult{
				Skipped:    true,
				SkipReason: fmt.Sprintf("uncompacted messages (%d) and tokens (%d) below thresholds (%d / %d)", uncompactedCount, estimatedTokens, customCfg.MessageThreshold, customCfg.TokenThreshold),
			}, nil
		}
	}

	// If total uncompacted messages are fewer than keepVerbatim, nothing to compact
	if uncompactedCount <= keepVerbatim {
		return &CompactResult{
			Skipped:    true,
			SkipReason: fmt.Sprintf("not enough messages to compact after reserving %d verbatim messages", keepVerbatim),
		}, nil
	}

	// 4. Split: messages to summarize vs recent verbatim messages
	cutoffIndex := len(uncompactedMessages) - keepVerbatim
	messagesToCompact := uncompactedMessages[:cutoffIndex]
	if len(messagesToCompact) == 0 {
		return &CompactResult{
			Skipped:    true,
			SkipReason: "no messages in compaction slice",
		}, nil
	}

	fromEventID := messagesToCompact[0].EventID
	toEventID := messagesToCompact[len(messagesToCompact)-1].EventID

	tokensBefore := EstimateMessagesTokens(messagesToCompact)

	// 5. Generate summary
	previousSummary := ""
	if hasPrevious {
		previousSummary = latestCompaction.Summary
	}

	summary, err := GenerateSummary(config.GlobalConfig, previousSummary, messagesToCompact)
	if err != nil {
		return nil, fmt.Errorf("failed to generate summary: %w", err)
	}

	tokensAfter := EstimateTokens(summary)

	// A checkpoint that costs as much as the messages it replaces is worse than no
	// checkpoint: it adds a row, fires an event, and advances the compaction cursor
	// while saving nothing. Refuse it and say so instead of recording a no-op win.
	if tokensAfter >= tokensBefore {
		log.Printf("compaction: skipping unprofitable checkpoint for channel %s (%d msgs, %d -> %d tokens)",
			rawChannelName, len(messagesToCompact), tokensBefore, tokensAfter)
		return &CompactResult{
			Skipped: true,
			SkipReason: fmt.Sprintf("summary (%d tokens) is not smaller than the %d messages it would replace (%d tokens)",
				tokensAfter, len(messagesToCompact), tokensBefore),
		}, nil
	}

	// 6. Save Compaction Record
	record := models.ChannelCompactionRecord{
		ID:                    uuid.NewString(),
		WorkspaceID:           workspaceID,
		ChannelID:             channel.ID,
		ChannelName:           rawChannelName,
		Summary:               summary,
		FromEventID:           fromEventID,
		ToEventID:             toEventID,
		CompactedCount:        len(messagesToCompact),
		EstimatedTokensBefore: tokensBefore,
		EstimatedTokensAfter:  tokensAfter,
		CreatedAt:             time.Now(),
	}

	if err := db.DB.Create(&record).Error; err != nil {
		return nil, fmt.Errorf("failed to save compaction record: %w", err)
	}

	// 7. Emit WebSocket / SSE Event
	eventID := uuid.NewString()
	nowUnixMs := time.Now().UnixNano() / int64(time.Millisecond)
	payloadData := map[string]interface{}{
		"channel":         rawChannelName,
		"summary":         summary,
		"compacted_count": len(messagesToCompact),
		"tokens_before":   tokensBefore,
		"tokens_after":    tokensAfter,
		"from_event_id":   fromEventID,
		"to_event_id":     toEventID,
	}
	payloadBytes, _ := json.Marshal(payloadData)

	eventRec := models.EventRecord{
		ID:         eventID,
		NetworkID:  workspaceID,
		Type:       "workspace.channel.compacted",
		Source:     "system:compactor",
		Target:     target,
		Payload:    payloadBytes,
		Timestamp:  nowUnixMs,
		Visibility: "channel",
	}
	_ = db.DB.Create(&eventRec)

	fullEvent, _ := json.Marshal(ginH(workspaceID, "workspace.channel.compacted", target, payloadData, nowUnixMs, eventID))
	if hub.GlobalHub != nil {
		hub.GlobalHub.Broadcast(hub.BroadcastMsg{
			WorkspaceID: workspaceID,
			ChannelName: target,
			Payload:     string(fullEvent),
		})
	}

	return &CompactResult{
		Record:         &record,
		Skipped:        false,
		TokensSaved:    tokensBefore - tokensAfter,
		CompactedCount: len(messagesToCompact),
	}, nil
}

func ginH(workspaceID, eventType, target string, payload map[string]interface{}, timestamp int64, eventID string) map[string]interface{} {
	return map[string]interface{}{
		"id":        eventID,
		"event_id":  eventID,
		"network":   workspaceID,
		"type":      eventType,
		"source":    "system:compactor",
		"target":    target,
		"payload":   payload,
		"timestamp": timestamp,
		"status":    "confirmed",
	}
}

// GetCompactedChannelHistory returns a combined view: latest summary checkpoint + recent active messages.
func GetCompactedChannelHistory(workspaceID, channelName string, recentLimit int) (string, []MessageItem, error) {
	if recentLimit <= 0 {
		recentLimit = 15
	}
	rawChannelName := strings.TrimPrefix(channelName, "channel/")
	target := "channel/" + rawChannelName

	var channel models.Channel
	if err := db.DB.Where("workspace_id = ? AND name = ?", workspaceID, rawChannelName).First(&channel).Error; err != nil {
		return "", nil, fmt.Errorf("channel not found: %w", err)
	}

	// 1. Fetch latest compaction record
	var checkpointRecords []models.ChannelCompactionRecord
	if err := db.DB.Where("workspace_id = ? AND channel_id = ?", workspaceID, channel.ID).
		Order("created_at desc").Limit(1).Find(&checkpointRecords).Error; err != nil {
		return "", nil, fmt.Errorf("failed to read compaction history: %w", err)
	}
	var latestCompaction models.ChannelCompactionRecord
	summary := ""
	hasSummary := len(checkpointRecords) > 0
	if hasSummary {
		latestCompaction = checkpointRecords[0]
		summary = latestCompaction.Summary
	}

	// 2. Fetch recent messages
	var eventRecords []models.EventRecord
	query := db.DB.Where("network_id = ? AND target = ? AND type LIKE ?", workspaceID, target, "workspace.message%")

	// If we have a compaction checkpoint, we only need messages that came after ToEventID or recentLimit
	if hasSummary && latestCompaction.ToEventID != "" {
		var boundary models.EventRecord
		if db.DB.Where("id = ? AND network_id = ?", latestCompaction.ToEventID, workspaceID).First(&boundary).Error == nil {
			query = query.Where("(timestamp > ? OR (timestamp = ? AND id > ?))", boundary.Timestamp, boundary.Timestamp, boundary.ID)
		}
	}

	// Take the newest recentLimit rows, then restore chronological order. Ordering
	// ascending before LIMIT would return the OLDEST rows after the checkpoint,
	// which is the opposite of the recent window callers ask for.
	err := query.Order("timestamp desc, id desc").Limit(recentLimit).Find(&eventRecords).Error
	if err != nil {
		return "", nil, err
	}
	for i, j := 0, len(eventRecords)-1; i < j; i, j = i+1, j-1 {
		eventRecords[i], eventRecords[j] = eventRecords[j], eventRecords[i]
	}

	recentMessages := ExtractMessageItems(eventRecords)
	return summary, recentMessages, nil
}
