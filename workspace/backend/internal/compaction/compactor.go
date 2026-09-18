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

/*
ResolveChannelAdaptiveCompactorConfig reads the channel's participants and
sizes compaction to fit the SMALLEST of them.

This function used to do the arithmetic inline too, and got it backwards --
see the note at the top of budget.go. It now does only what genuinely needs a
database (who is in this channel, and what has each one told us about itself)
and hands plain numbers to ChannelBudget/ResolveConfig, which are unit-tested.

Capacity is read in order of trustworthiness:

 1. `ContextWindowSize` reported by the agent's own CLI. This field already
    existed and was never read here -- the old code went straight to guessing
    from the model string even when the agent had told us the answer.
 2. The static table, from the reported model name.
 3. UnknownWindow. NOT 128k, and NOT a guess from the agent's name: agent
    names are user-chosen, so passing one to the model table (as the old code
    did) matched nothing and silently produced 128k for every agent that had
    not reported a model. That invented denominator is what made the context
    health percentages wrong.
*/
func ResolveChannelAdaptiveCompactorConfig(workspaceID, channelName string) *CompactorConfig {
	rawName := strings.TrimPrefix(channelName, "channel/")
	budgets := agentBudgetsForChannel(workspaceID, rawName)

	participantCount := len(budgets)
	if participantCount == 0 {
		participantCount = 1
	}
	return ResolveConfig(ChannelBudget(budgets), participantCount)
}

// agentBudgetsForChannel resolves who is in the channel and what each one can
// hold. Returns nil when the channel or the DB is unavailable, which
// ResolveConfig handles as "use the conservative default".
/*
agentBudgetsForChannel resolves who the channel's compaction must fit, and
what each of them can hold.

IT ASKS WHO WORKED HERE, NOT WHO IS ON THE ROSTER.

This used to read `channel_members`, which sounds like the answer and is not:
the backend puts every agent in the workspace into a new channel's membership,
so on 2026-09-18 fourteen of fifteen channels listed the identical eight names.
Sizing a channel's history to the smallest of THOSE means an agent that has
never opened the thread -- in this workspace, never been launched at all --
sets the budget for the one doing the work. That is the same roster-as-truth
mistake the sidebar had, one layer down, where the cost is capability rather
than an icon.

Participation is: the master agent, plus every agent that has actually sent a
message here. An agent assigned and silent constrains nothing, because it is
not reading this history either.

Falling back to online workspace members when nothing is found is kept -- a
channel whose first turn is still in flight has no senders yet, and the agents
about to receive it are the online ones.
*/
func agentBudgetsForChannel(workspaceID, rawName string) []AgentBudget {
	if db.DB == nil {
		return nil
	}
	var channel models.Channel
	if err := db.DB.Where("workspace_id = ? AND name = ?", workspaceID, rawName).First(&channel).Error; err != nil {
		return nil
	}

	seen := map[string]bool{}
	var agentNames []string
	addName := func(n string) {
		n = strings.TrimSpace(n)
		if n == "" || seen[strings.ToLower(n)] {
			return
		}
		seen[strings.ToLower(n)] = true
		agentNames = append(agentNames, n)
	}

	if channel.MasterAgent != nil {
		addName(*channel.MasterAgent)
	}

	// Everyone who has actually spoken in this channel. DISTINCT over source
	// keeps this one row per author however long the thread is.
	var sources []string
	if err := db.DB.Model(&models.EventRecord{}).
		Where("network_id = ? AND target = ? AND type LIKE ?", workspaceID, "channel/"+rawName, "workspace.message%").
		Distinct().Pluck("source", &sources).Error; err == nil {
		for _, src := range sources {
			addName(AgentNameFromSource(src))
		}
	}

	if len(agentNames) == 0 {
		var members []models.WorkspaceMember
		if err := db.DB.Where("workspace_id = ? AND status = ?", workspaceID, "online").Find(&members).Error; err == nil {
			for _, m := range members {
				addName(m.AgentName)
			}
		}
	}

	budgets := make([]AgentBudget, 0, len(agentNames))
	for _, name := range agentNames {
		b := AgentBudget{AgentName: name, Window: UnknownWindow}
		var usage models.AgentUsageRecord
		if err := db.DB.Where("workspace_id = ? AND agent_name = ?", workspaceID, name).First(&usage).Error; err == nil {
			model := ""
			if usage.CurrentModel != nil {
				model = *usage.CurrentModel
			}
			// A self-report is the best source ONLY if it is a report at all.
			// See TrustReportedCapability for the two ways it turned out not
			// to be one.
			if TrustReportedCapability(name, model, usage.TotalTokens) {
				if usage.ContextWindowSize > 0 {
					b.Window = usage.ContextWindowSize
					b.Reported = true
				} else {
					b.Window = ModelContextWindow(model)
				}
			}
		}
		budgets = append(budgets, b)
	}
	return budgets
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
		customCfg = ResolveChannelAdaptiveCompactorConfig(workspaceID, channelName)
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
	return getChannelHistory(workspaceID, channelName, recentLimit, false)
}

/*
getChannelHistory renders a channel's history for ONE reader.

`crossCheckpoint` is the per-recipient half of the fix described on
ChannelBudget: compaction picks one threshold for the whole channel, sized to
its smallest participant, and until now every reader got that same summary --
so a 1M-window agent read a digest compressed to fit a 128k one.

Compaction never deleted anything; it only moved where retrieval STOPS. So a
reader whose own budget can hold more is allowed to read straight through the
checkpoint into the raw messages behind it, bounded by its own recentLimit.
The cost is the same `recentLimit` rows either way -- older raw turns instead
of a summary plus newer ones -- so this does not enlarge any prompt.

The summary is then returned only when it still covers something the reader
did not reach: if the oldest row we handed back is at or before the
checkpoint, the reader has the real messages and the digest of them would be
duplicate context, which is worse than none.
*/
func getChannelHistory(workspaceID, channelName string, recentLimit int, crossCheckpoint bool) (string, []MessageItem, error) {
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

	// The checkpoint boundary, when there is one. `haveBoundary` stays false
	// if the row it names has since been pruned, in which case there is
	// nothing to compare against and the summary is kept as-is.
	var boundary models.EventRecord
	haveBoundary := false
	if hasSummary && latestCompaction.ToEventID != "" {
		if db.DB.Where("id = ? AND network_id = ?", latestCompaction.ToEventID, workspaceID).First(&boundary).Error == nil {
			haveBoundary = true
		}
	}

	// A reader that cannot afford to look behind the checkpoint is served the
	// summary plus what came after it, as before. One that can is not clamped.
	if haveBoundary && !crossCheckpoint {
		query = query.Where("(timestamp > ? OR (timestamp = ? AND id > ?))", boundary.Timestamp, boundary.Timestamp, boundary.ID)
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

	// Did this reader actually reach back past the checkpoint? If so the raw
	// turns it just read ARE what the summary summarises, and sending both
	// spends the budget twice to say the same thing.
	if crossCheckpoint && haveBoundary && len(eventRecords) > 0 {
		oldest := eventRecords[0]
		if oldest.Timestamp < boundary.Timestamp ||
			(oldest.Timestamp == boundary.Timestamp && oldest.ID <= boundary.ID) {
			summary = ""
		}
	}

	return summary, recentMessages, nil
}

// GetCompactedChannelHistoryForAgent serves tailored context window to a specific agent:
// Gemini / Claude 3.7 (1M~2M) gets 150+ full recent messages without truncation;
// Claude 3.5 / GPT-4o (128k~200k) gets 80 recent messages; smaller models get safe 25 messages.
func GetCompactedChannelHistoryForAgent(workspaceID, channelName, agentName string) (string, []MessageItem, error) {
	window := 128000
	if db.DB != nil && agentName != "" {
		var usage models.AgentUsageRecord
		if db.DB.Where("workspace_id = ? AND agent_name = ?", workspaceID, agentName).First(&usage).Error == nil {
			if usage.ContextWindowSize > 0 {
				window = usage.ContextWindowSize
			} else if usage.CurrentModel != nil && *usage.CurrentModel != "" {
				window = ModelContextWindow(*usage.CurrentModel)
			}
		}
		// No `else` guessing from agentName: an agent with no usage record
		// has told us nothing, and inventing a window for it is what put wrong
		// denominators on the dashboard. `window` stays at its caller default.
	}

	var recentLimit int
	switch {
	case window >= 1000000:
		recentLimit = 150
	case window >= 128000:
		recentLimit = 80
	default:
		recentLimit = 25
	}

	/*
		This reader crosses the shared checkpoint when its own window is
		bigger than the one the channel was compacted for.

		Equal is not bigger: if this agent IS the constraint, the summary was
		sized for it and reading behind it would be exactly the overflow
		compaction exists to prevent. Unknown on either side means we have not
		measured the comparison, and an unmeasured budget is not licence to
		read more -- so it stays clamped, which is the old behaviour.
	*/
	channelBudget := ChannelWindow(workspaceID, channelName)
	crossCheckpoint := window > 0 && channelBudget > 0 && window > channelBudget

	return getChannelHistory(workspaceID, channelName, recentLimit, crossCheckpoint)
}

// ChannelContextDiagnostics returns diagnostic multi-agent window analysis for a channel.
func ChannelContextDiagnostics(workspaceID, channelName string) ChannelDiagnostics {
	rawName := strings.TrimPrefix(channelName, "channel/")
	budgets := agentBudgetsForChannel(workspaceID, rawName)
	return AnalyzeChannelBudgets(budgets)
}
