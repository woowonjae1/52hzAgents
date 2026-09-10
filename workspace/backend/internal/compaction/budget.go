package compaction

import (
	"strings"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

/*
CONTEXT BUDGETING — the arithmetic, separated from the database.

`ResolveChannelAdaptiveCompactorConfig` used to do three things in one function:
read the channel's participants out of GORM, guess each one's context window
from its model string, and turn that into thresholds. Because the whole thing
needed a live DB it had no unit test, and that is how its central bug survived
to production: it computed `minWindow` across the participants -- carefully,
in two branches -- and then never read it. The threshold came from `maxWindow`.

The consequence was not subtle. A channel holding Gemini (1M) and DeepSeek
(128k) produced a threshold of 150k, which is larger than DeepSeek's ENTIRE
window: the small model could never trigger compaction and simply overflowed,
while the feature reported itself as adaptive.

So the arithmetic lives here, as pure functions over plain numbers, and the
GORM lookup stays in compactor.go. Everything below is unit-tested in
budget_test.go.
*/

// AgentBudget is one participant's capacity, as known rather than as guessed.
type AgentBudget struct {
	AgentName string
	// Window is the agent's context window in tokens. Zero means UNKNOWN --
	// see UnknownWindow below for why that is not the same as "the default".
	Window int
	// Reported is true when Window came from the agent itself (its CLI told
	// us) rather than from the static model table. Only reported windows are
	// trustworthy enough to raise a budget; a guessed one may only lower it.
	Reported bool
}

/*
UnknownWindow is what an unrecognised model gets, and it is deliberately NOT
the old `default: 128000`.

Defaulting an unknown agent to 128k invents a capability. The old code went
further: when an agent had not reported a model it passed the AGENT NAME to the
model table -- and agent names are user-chosen ("worker-1", "rfc-bot"), so they
matched nothing and every such agent silently became 128k. That is the direct
cause of the wrong numbers on the dashboard: a made-up denominator.

Zero means "we do not know". Callers must decide what to do about that
explicitly, and the UI must show it as unknown rather than as a percentage of
a number nobody measured.
*/
const UnknownWindow = 0

/*
Reserve is what CANNOT be spent on history: the system prompt, the tool
schemas, and room for the model's own reply.

The old model was `window * 0.20` clamped to [16000, 150000], which has two
problems. The percentage is arbitrary -- the change log describing this feature
says 25% while the code says 20%, which is what happens to a number that was
never derived from anything. And the clamps collapse the range: at 32k and 64k
both windows land on 16000 (which is 50% of a 32k window, so the clamp
overrides the safety margin it was meant to enforce), while 1M and 2M both land
on 150000. Six distinct windows produced four distinct thresholds.

Subtraction has no such failure. Reserve scales with the window because a
bigger window implies bigger tool payloads and longer replies, but it is
floored so a small window still keeps room to answer at all.
*/
func Reserve(window int) int {
	r := window / 4
	if r < 8000 {
		r = 8000
	}
	if r > 64000 {
		r = 64000
	}
	if r > window {
		// A window smaller than the floor: keep a token of headroom rather
		// than returning a negative budget below.
		r = window / 2
	}
	return r
}

// safetyFactor leaves headroom for the gap between our estimate of the next
// prompt and its true size. It is applied to the post-reserve budget, not to
// the raw window, so it compounds with Reserve rather than replacing it.
const safetyFactor = 0.8

/*
ChannelBudget picks the window that the channel's compaction must respect.

THIS IS THE MINIMUM, NOT THE MAXIMUM -- the inversion the old code got wrong.
A shared history is only safe if the SMALLEST participant can hold it; sizing
to the largest guarantees the smallest overflows.

That is also the honest limit of a single shared threshold, and the reason
this returns the constraint rather than pretending it is free: sizing down to
the minimum means a 1M model in a channel with a 128k model is billed for a
1M window and allowed to use 128k of it. The real fix is to render history
per recipient rather than compact it once for everyone; until then, correct
and small beats incorrect and large.

Unknown windows (zero) are skipped rather than treated as a floor -- an agent
that has not told us its size must not be able to drag the whole channel down
to a number we invented for it. If NOTHING is known, the caller gets
UnknownWindow back and decides.
*/
func ChannelBudget(budgets []AgentBudget) int {
	min := 0
	for _, b := range budgets {
		if b.Window <= 0 {
			continue
		}
		if min == 0 || b.Window < min {
			min = b.Window
		}
	}
	return min
}

/*
ResolveConfig turns participant capacities into compaction thresholds.

`window` is the channel budget from ChannelBudget; UnknownWindow is accepted
and falls back to the conservative default rather than to a guess.
*/
func ResolveConfig(window, participantCount int) *CompactorConfig {
	if participantCount < 1 {
		participantCount = 1
	}

	tokenThreshold := DefaultCompactorConfig().TokenThreshold
	if window > 0 {
		usable := window - Reserve(window)
		tokenThreshold = int(float64(usable) * safetyFactor)
		if tokenThreshold < 4000 {
			// Anything under this cannot hold a useful conversation at all;
			// compacting harder will not save it, so stop pretending.
			tokenThreshold = 4000
		}
	}

	// More participants means more turns before any single one has said
	// enough to be worth summarising, so the MESSAGE threshold scales with
	// the channel's width. The token threshold above already covers depth.
	msgThreshold := 30 + participantCount*10
	if msgThreshold > 100 {
		msgThreshold = 100
	}

	keepVerbatim := participantCount * 8
	if keepVerbatim < 15 {
		keepVerbatim = 15
	}
	if keepVerbatim > 50 {
		keepVerbatim = 50
	}

	return &CompactorConfig{
		MessageThreshold:   msgThreshold,
		TokenThreshold:     tokenThreshold,
		KeepRecentVerbatim: keepVerbatim,
	}
}

/*
ModelContextWindow is now a FALLBACK, not the primary source.

A hardcoded substring table of model capabilities rots by construction, and
this one already had: it claimed Claude 3.7 Sonnet has a 1M window (it has
200k, and no 1M variant exists), that any "gemini-2" has 2M (2.0 has 1M; 2M is
1.5 Pro), and it had an entry for "antigravity", which is an agent, not a
model. Each wrong entry inflates a denominator, which is what made the health
percentages wrong.

The trustworthy source is the agent reporting its own ContextWindowSize -- the
CLI knows what it is running. This table only answers when nothing was
reported, and it now returns UnknownWindow rather than inventing 128k.
*/
func ModelContextWindow(model string) int {
	m := strings.ToLower(strings.TrimSpace(model))
	if m == "" {
		return UnknownWindow
	}
	switch {
	case strings.Contains(m, "gemini-1.5-pro"):
		return 2000000
	case strings.Contains(m, "gemini"):
		return 1000000
	case strings.Contains(m, "claude"):
		// Every generally available Claude model is 200k. The 1M variants are
		// opt-in betas on specific models; when one is in use the agent
		// reports it, and a reported window overrides this table.
		return 200000
	case strings.Contains(m, "gpt-4o"), strings.Contains(m, "gpt-4.1"),
		strings.Contains(m, "gpt-5"), strings.Contains(m, "codex"):
		return 128000
	case strings.Contains(m, "deepseek"):
		return 128000
	case strings.Contains(m, "qwen"), strings.Contains(m, "llama"):
		return 64000
	case strings.Contains(m, "mistral"), strings.Contains(m, "ollama"):
		return 32768
	default:
		// NOT 128000. See UnknownWindow.
		return UnknownWindow
	}
}

/*
ChannelWindow exposes the channel's real budget to callers that need to SHOW
it, rather than making them reconstruct it.

The token-stats handler used to derive the window back out of the threshold:

	minWindow := cfg.TokenThreshold * 4 // inverse of 0.25 safety margin

Three things were wrong with that. The comment said 0.25 while the code that
produced the threshold used 0.20, so the inverse was wrong from the start. The
threshold is now a subtraction rather than a percentage, so no single
multiplier inverts it at all. And most of all, the real number was already
computed a line earlier and thrown away -- the handler had the answer and
reconstructed an approximation of it instead. That reconstructed value is what
the context-health panel showed the user as "context capacity".
*/
func ChannelWindow(workspaceID, channelName string) int {
	rawName := strings.TrimPrefix(channelName, "channel/")
	return ChannelBudget(agentBudgetsForChannel(workspaceID, rawName))
}

/*
ChannelLoad reports the MEASURED size of the largest recent prompt among the
channel's participants, and whether anything was actually measured.

This is what "how full is the context" means: the biggest prompt any agent
most recently sent. It is reported by the agents themselves on every turn. The
alternative the handler used -- summing a character heuristic over the last
100 message bodies -- misses tool payloads (usually the bulk of a prompt),
saturates at 100 messages, and is an estimate standing in for a measurement
that was already arriving.
*/
func ChannelLoad(workspaceID, channelName string) (tokens int, measured bool) {
	rawName := strings.TrimPrefix(channelName, "channel/")
	for _, b := range agentBudgetsForChannel(workspaceID, rawName) {
		if db.DB == nil {
			break
		}
		var usage models.AgentUsageRecord
		if err := db.DB.Where("workspace_id = ? AND agent_name = ?", workspaceID, b.AgentName).First(&usage).Error; err != nil {
			continue
		}
		if usage.LastPromptTokens > 0 && int(usage.LastPromptTokens) > tokens {
			tokens = int(usage.LastPromptTokens)
			measured = true
		}
	}
	return tokens, measured
}
