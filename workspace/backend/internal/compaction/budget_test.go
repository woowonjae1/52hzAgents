package compaction

import "testing"

/*
THE TEST THAT WAS MISSING.

`ResolveChannelAdaptiveCompactorConfig` had zero coverage because it needed a
live database, and that is precisely why its central bug shipped: it computed
the minimum window across the channel's participants and then sized the
threshold from the MAXIMUM. Extracting the arithmetic into budget.go is what
makes this testable at all, so the first case below is the inversion itself.
*/

func TestChannelBudgetTakesTheSmallestParticipant(t *testing.T) {
	// The exact shape that used to break: one large model and one small one.
	// Sizing to Gemini would hand the channel a budget larger than DeepSeek's
	// whole window, so DeepSeek could never compact and would simply overflow.
	budgets := []AgentBudget{
		{AgentName: "gemini-agent", Window: 1000000, Reported: true},
		{AgentName: "deepseek-agent", Window: 128000, Reported: true},
	}
	if got := ChannelBudget(budgets); got != 128000 {
		t.Fatalf("ChannelBudget = %d; want 128000 (the SMALLEST participant, not the largest)", got)
	}
}

func TestChannelBudgetSkipsUnknownWindows(t *testing.T) {
	// An agent that never reported its size must not drag the channel down to
	// a number we invented for it -- but it must not raise it either.
	budgets := []AgentBudget{
		{AgentName: "known", Window: 200000, Reported: true},
		{AgentName: "mystery", Window: UnknownWindow},
	}
	if got := ChannelBudget(budgets); got != 200000 {
		t.Fatalf("ChannelBudget = %d; want 200000 (unknown participants are skipped)", got)
	}
	if got := ChannelBudget([]AgentBudget{{AgentName: "mystery"}}); got != UnknownWindow {
		t.Fatalf("ChannelBudget = %d; want UnknownWindow when nothing is known", got)
	}
	if got := ChannelBudget(nil); got != UnknownWindow {
		t.Fatalf("ChannelBudget(nil) = %d; want UnknownWindow", got)
	}
}

func TestResolveConfigIsMonotonicInTheWindow(t *testing.T) {
	/*
		The old percentage-and-clamp model was not monotonic in practice: the
		[16000, 150000] clamps meant 32k and 64k produced the SAME threshold,
		and so did 1M and 2M. Six windows, four thresholds. A bigger window
		must buy strictly more history, or "adaptive" means nothing at the
		ends of the range -- which is where the mixed channels live.
	*/
	windows := []int{32768, 64000, 128000, 200000, 1000000, 2000000}
	var prev int
	for _, w := range windows {
		cfg := ResolveConfig(w, 2)
		if cfg.TokenThreshold <= prev {
			t.Errorf("window %d gave threshold %d, not greater than the previous %d", w, cfg.TokenThreshold, prev)
		}
		prev = cfg.TokenThreshold
	}
}

func TestResolveConfigNeverExceedsTheWindow(t *testing.T) {
	// The failure that started all this: a threshold larger than the window it
	// is supposed to protect can never fire before an overflow.
	for _, w := range []int{16000, 32768, 64000, 128000, 200000, 1000000} {
		cfg := ResolveConfig(w, 3)
		if cfg.TokenThreshold >= w {
			t.Errorf("window %d: threshold %d must leave room for the reply", w, cfg.TokenThreshold)
		}
		if cfg.TokenThreshold+Reserve(w) > w {
			t.Errorf("window %d: threshold %d + reserve %d overflows", w, cfg.TokenThreshold, Reserve(w))
		}
	}
}

func TestResolveConfigFallsBackWhenTheWindowIsUnknown(t *testing.T) {
	cfg := ResolveConfig(UnknownWindow, 1)
	if cfg.TokenThreshold != DefaultCompactorConfig().TokenThreshold {
		t.Errorf("unknown window should use the conservative default, got %d", cfg.TokenThreshold)
	}
}

func TestModelContextWindowReturnsUnknownRatherThanGuessing(t *testing.T) {
	/*
		Agent names are user-chosen. The old code passed the AGENT NAME to this
		table when no model had been reported, and since no name matched, every
		such agent silently became 128000 -- a denominator nobody measured,
		rendered to the user as a percentage.
	*/
	for _, name := range []string{"worker-1", "rfc-bot", "", "小助手"} {
		if got := ModelContextWindow(name); got != UnknownWindow {
			t.Errorf("ModelContextWindow(%q) = %d; want UnknownWindow", name, got)
		}
	}
}

func TestModelContextWindowCorrectsTheFabricatedEntries(t *testing.T) {
	// Regression guards for the three entries that were factually wrong.
	if got := ModelContextWindow("claude-3-7-sonnet"); got != 200000 {
		t.Errorf("claude-3-7 = %d; want 200000 (the 1M entry was fabricated)", got)
	}
	if got := ModelContextWindow("gemini-2.0-flash"); got != 1000000 {
		t.Errorf("gemini-2.0 = %d; want 1000000 (2M is 1.5 Pro, not 2.0)", got)
	}
	if got := ModelContextWindow("antigravity"); got != UnknownWindow {
		t.Errorf("antigravity = %d; want UnknownWindow -- it is an agent, not a model", got)
	}
}
