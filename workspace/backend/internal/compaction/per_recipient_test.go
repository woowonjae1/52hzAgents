package compaction

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

/*
The cases below are the live 2026-09-18 workspace, not invented ones. Four of
the five agents in it reported a capability that was not a measurement, and the
budget code believed all four because "the agent told us" was treated as
self-evidently trustworthy.
*/
func TestTrustReportedCapabilityRejectsPlaceholders(t *testing.T) {
	cases := []struct {
		name        string
		agent       string
		model       string
		totalTokens int64
		want        bool
		why         string
	}{
		{"real report", "antigravity", "gemini-3.6-flash-medium", 12621, true,
			"a distinct model name and turns on the clock"},
		{"model echoes the agent name", "claude", "claude", 194, false,
			"an adapter writing the agent name into the model field is not reporting a model"},
		{"never launched", "amp", "amp", 0, false,
			"zero tokens ever, yet it claimed a 1,000,000-token window"},
		{"never launched, plausible model", "amp", "gemini-2.0-pro", 0, false,
			"a window is a property of a running model"},
		{"no model at all", "cline", "", 500, false,
			"nothing to fall back to and nothing to trust"},
		{"case and space insensitive", "Pi", " pi ", 900, false,
			"the echo check must not be defeated by formatting"},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := TrustReportedCapability(c.agent, c.model, c.totalTokens); got != c.want {
				t.Errorf("TrustReportedCapability(%q, %q, %d) = %v, want %v -- %s",
					c.agent, c.model, c.totalTokens, got, c.want, c.why)
			}
		})
	}
}

func TestAgentNameFromSourceIgnoresNonAgents(t *testing.T) {
	cases := map[string]string{
		"52hz:antigravity":  "antigravity",
		"openagents:pi":     "pi",
		"agent:worker-1":    "worker-1",
		"52hzagents:claude": "claude",
		// Humans and the system author messages too, and neither has a
		// context window to contribute.
		"human:81f830c6-ac05-4ffb-82e6-eeb84227ea33": "",
		"system:routine": "",
		"system":         "",
		"":               "",
	}
	for src, want := range cases {
		if got := AgentNameFromSource(src); got != want {
			t.Errorf("AgentNameFromSource(%q) = %q, want %q", src, got, want)
		}
	}
}

// seedUsage writes the capability an agent claims about itself.
func seedUsage(t *testing.T, wsID, agent, model string, window int, totalTokens int64) {
	t.Helper()
	m := model
	if err := db.DB.Create(&models.AgentUsageRecord{
		WorkspaceID:       wsID,
		AgentName:         agent,
		CurrentModel:      &m,
		ContextWindowSize: window,
		TotalTokens:       totalTokens,
	}).Error; err != nil {
		t.Fatalf("seed usage for %s: %v", agent, err)
	}
}

func seedMessage(t *testing.T, wsID, channel, source, content string, ts int64) {
	t.Helper()
	payload, _ := json.Marshal(map[string]interface{}{"content": content, "message_type": "chat"})
	if err := db.DB.Create(&models.EventRecord{
		ID: uuid.NewString(), NetworkID: wsID, Type: "workspace.message",
		Source: source, Target: "channel/" + channel, Payload: payload,
		Timestamp: ts, Visibility: "channel",
	}).Error; err != nil {
		t.Fatalf("seed message: %v", err)
	}
}

func migrateBudgetTables(t *testing.T) {
	t.Helper()
	if err := db.DB.AutoMigrate(&models.AgentUsageRecord{}, &models.WorkspaceMember{}); err != nil {
		t.Fatalf("migrate budget tables: %v", err)
	}
}

/*
The roster bug, one layer below the sidebar.

A silent agent used to set the whole channel's compaction budget purely by
being in `channel_members`, which the backend fills with every agent in the
workspace. Here `tiny` has a real, trusted 32k window and has never said a
word in this channel; if it can still constrain the channel, the budget comes
back 32000 instead of the speaker's 1,000,000.
*/
func TestChannelBudgetIgnoresAgentsThatNeverSpoke(t *testing.T) {
	_, ws, ch := setupTestDB(t)
	migrateBudgetTables(t)

	seedUsage(t, ws.ID, "worker", "gemini-3.6-flash-medium", 1000000, 50000)
	seedUsage(t, ws.ID, "tiny", "mistral-large", 32000, 4000)

	seedMessage(t, ws.ID, ch.Name, "human:alice", "start", 1_700_000_000_000)
	seedMessage(t, ws.ID, ch.Name, "52hz:worker", "on it", 1_700_000_001_000)

	if got := ChannelWindow(ws.ID, ch.Name); got != 1000000 {
		t.Errorf("ChannelWindow = %d, want 1000000 -- a silent agent must not set the budget", got)
	}

	// ...and the moment it actually speaks, it counts.
	seedMessage(t, ws.ID, ch.Name, "52hz:tiny", "me too", 1_700_000_002_000)
	if got := ChannelWindow(ws.ID, ch.Name); got != 32000 {
		t.Errorf("ChannelWindow after tiny speaks = %d, want 32000 -- a real participant IS a constraint", got)
	}
}

/*
An untrusted self-report must not become the channel's constraint.

`ghost` claims a 16k window, which would be the minimum and therefore the
budget -- but its model field is its own name and it has never produced a
token, which is exactly the shape `amp` had in production.
*/
func TestChannelBudgetIgnoresUntrustedReports(t *testing.T) {
	_, ws, ch := setupTestDB(t)
	migrateBudgetTables(t)

	seedUsage(t, ws.ID, "worker", "gemini-3.6-flash-medium", 1000000, 50000)
	seedUsage(t, ws.ID, "ghost", "ghost", 16000, 0)

	seedMessage(t, ws.ID, ch.Name, "52hz:worker", "hello", 1_700_000_000_000)
	seedMessage(t, ws.ID, ch.Name, "52hz:ghost", "hi", 1_700_000_001_000)

	if got := ChannelWindow(ws.ID, ch.Name); got != 1000000 {
		t.Errorf("ChannelWindow = %d, want 1000000 -- a placeholder report must fall back to unknown, which is skipped", got)
	}
}

/*
THE POINT OF THE WHOLE CHANGE.

One channel, one checkpoint, two readers with different windows. The big one
must read the raw turns behind the checkpoint; the small one -- which is the
agent the checkpoint was sized for -- must not.
*/
func TestBigWindowAgentReadsPastTheCheckpoint(t *testing.T) {
	_, ws, ch := setupTestDB(t)
	migrateBudgetTables(t)

	// small is the channel's constraint at 128k; big has 1M.
	seedUsage(t, ws.ID, "small", "gpt-4o", 128000, 90000)
	seedUsage(t, ws.ID, "big", "gemini-3.6-flash-medium", 1000000, 90000)

	const total = 40
	for i := 0; i < total; i++ {
		src := "52hz:small"
		if i%2 == 0 {
			src = "52hz:big"
		}
		seedMessage(t, ws.ID, ch.Name, src, fmt.Sprintf("msg-%02d", i), int64(1_700_000_000_000+i*1000))
	}

	if got := ChannelWindow(ws.ID, ch.Name); got != 128000 {
		t.Fatalf("precondition: ChannelWindow = %d, want 128000", got)
	}

	result, err := CompactChannel(ws.ID, ch.Name, &CompactorConfig{
		MessageThreshold: 10, TokenThreshold: 100, KeepRecentVerbatim: 10,
	})
	if err != nil {
		t.Fatalf("compact: %v", err)
	}
	if result.Skipped {
		t.Fatalf("precondition: compaction skipped: %s", result.SkipReason)
	}

	contents := func(items []MessageItem) string {
		parts := make([]string, 0, len(items))
		for _, m := range items {
			parts = append(parts, m.Content)
		}
		return strings.Join(parts, ",")
	}

	// The constraining agent: summary plus only what came after the
	// checkpoint. This is the old behaviour and must not change.
	sumSmall, recentSmall, err := GetCompactedChannelHistoryForAgent(ws.ID, ch.Name, "small")
	if err != nil {
		t.Fatalf("history for small: %v", err)
	}
	if sumSmall == "" {
		t.Error("small lost its summary -- it cannot afford to read behind the checkpoint, so it still needs the digest")
	}
	if len(recentSmall) != 10 {
		t.Errorf("small got %d messages (%s), want the 10 kept verbatim", len(recentSmall), contents(recentSmall))
	}

	// The big agent: raw turns from before the checkpoint, and no summary,
	// because the summary now describes messages it can read itself.
	sumBig, recentBig, err := GetCompactedChannelHistoryForAgent(ws.ID, ch.Name, "big")
	if err != nil {
		t.Fatalf("history for big: %v", err)
	}
	if len(recentBig) != total {
		t.Errorf("big got %d messages, want all %d -- its 1M window should reach past the checkpoint", len(recentBig), total)
	}
	if len(recentBig) > 0 && recentBig[0].Content != "msg-00" {
		t.Errorf("big's oldest message is %q, want msg-00", recentBig[0].Content)
	}
	if sumBig != "" {
		t.Error("big kept the summary as well as the raw messages it summarises -- that spends the budget twice for the same content")
	}
}

/*
Crossing is gated on a MEASURED comparison, not on optimism.

Neither agent here has a trustworthy window, so the channel budget is unknown.
An unknown budget is not permission to read more: the reader stays clamped to
the checkpoint, which is what the code did before this change.
*/
func TestUnknownBudgetDoesNotUnlockTheCheckpoint(t *testing.T) {
	_, ws, ch := setupTestDB(t)
	migrateBudgetTables(t)

	seedUsage(t, ws.ID, "mystery", "mystery", 0, 0)

	for i := 0; i < 40; i++ {
		seedMessage(t, ws.ID, ch.Name, "52hz:mystery", fmt.Sprintf("msg-%02d", i), int64(1_700_000_000_000+i*1000))
	}
	if got := ChannelWindow(ws.ID, ch.Name); got != UnknownWindow {
		t.Fatalf("precondition: ChannelWindow = %d, want UnknownWindow", got)
	}

	result, err := CompactChannel(ws.ID, ch.Name, &CompactorConfig{
		MessageThreshold: 10, TokenThreshold: 100, KeepRecentVerbatim: 10,
	})
	if err != nil || result.Skipped {
		t.Fatalf("precondition: compact err=%v skipped=%v", err, result.Skipped)
	}

	sum, recent, err := GetCompactedChannelHistoryForAgent(ws.ID, ch.Name, "mystery")
	if err != nil {
		t.Fatalf("history: %v", err)
	}
	if sum == "" {
		t.Error("summary dropped on an unmeasured budget")
	}
	if len(recent) != 10 {
		t.Errorf("got %d messages, want the 10 kept verbatim -- an unknown budget must stay clamped", len(recent))
	}
}

/*
A FABRICATED WINDOW MUST NOT BUY A LOOK BEHIND THE CHECKPOINT.

This is the hole the first version of the per-recipient change left open. The
trust gate was applied to the shared channel budget but not to the reader's
own window -- and once crossing is decided by comparing the two, the reader's
side is load-bearing as well. `liar` reports 1,000,000 with its model field set
to its own name, exactly as `claude` and `amp` did in production; believed, it
would read 150 raw turns into a window it does not have.
*/
func TestFabricatedWindowCannotCrossTheCheckpoint(t *testing.T) {
	_, ws, ch := setupTestDB(t)
	migrateBudgetTables(t)

	seedUsage(t, ws.ID, "honest", "gpt-4o", 128000, 90000)
	seedUsage(t, ws.ID, "liar", "liar", 1000000, 0)

	const total = 40
	for i := 0; i < total; i++ {
		src := "52hz:honest"
		if i%2 == 0 {
			src = "52hz:liar"
		}
		seedMessage(t, ws.ID, ch.Name, src, fmt.Sprintf("msg-%02d", i), int64(1_700_000_000_000+i*1000))
	}
	// honest is the only trusted report, so it alone sets the budget.
	if got := ChannelWindow(ws.ID, ch.Name); got != 128000 {
		t.Fatalf("precondition: ChannelWindow = %d, want 128000", got)
	}

	result, err := CompactChannel(ws.ID, ch.Name, &CompactorConfig{
		MessageThreshold: 10, TokenThreshold: 100, KeepRecentVerbatim: 10,
	})
	if err != nil || result.Skipped {
		t.Fatalf("precondition: compact err=%v skipped=%v", err, result.Skipped)
	}

	sum, recent, err := GetCompactedChannelHistoryForAgent(ws.ID, ch.Name, "liar")
	if err != nil {
		t.Fatalf("history for liar: %v", err)
	}
	if len(recent) != 10 {
		t.Errorf("liar got %d messages, want the 10 kept verbatim -- an untrusted 1M report must not unlock the checkpoint", len(recent))
	}
	if sum == "" {
		t.Error("liar lost its summary, which means it crossed the checkpoint on a fabricated window")
	}
}
