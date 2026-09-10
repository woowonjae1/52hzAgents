package compaction

import (
	"strings"
	"testing"
)

/*
TestModelContextWindow USED TO LIVE HERE AND IT ASSERTED THE BUG.

Its table encoded the three fabricated entries as expectations --
claude-3-7-sonnet => 1000000 (Claude 3.7 is 200k; no 1M variant exists),
antigravity-deepmind => 1000000 (antigravity is an agent, not a model), and
unknown-model => 128000 (the invented denominator behind the wrong dashboard
percentages). A test that pins a wrong value is worse than no test: it makes
correcting the value look like a regression.

The corrected coverage is TestModelContextWindowCorrectsTheFabricatedEntries
and TestModelContextWindowReturnsUnknownRatherThanGuessing in budget_test.go,
alongside the channel-budget tests that the old DB-coupled design made
impossible to write at all.
*/

func TestDeterministicSummaryHandoffsAndFiles(t *testing.T) {
	messages := []MessageItem{
		{
			EventID: "ev-1",
			Source:  "human:user",
			Content: "Please refactor the token accounting system and ensure tests pass.",
		},
		{
			EventID: "ev-2",
			Source:  "openagents:architect-agent",
			Content: "I have analyzed the system. We agreed to implement cumulative token tracking in models.go.\nRouting to @codex-agent to write unit tests in internal/compaction/adaptive_test.go.",
		},
		{
			EventID: "ev-3",
			Source:  "openagents:codex-agent",
			Content: "Created internal/compaction/adaptive_test.go.\nRan go test ./internal/compaction/... and all tests passed.\nTodo: update frontend token dashboard.",
		},
	}

	summary := GenerateDeterministicSummary("", messages)

	if !strings.Contains(summary, "Goals & Objectives") {
		t.Errorf("Expected summary to contain Goals section, got: %s", summary)
	}
	if !strings.Contains(summary, "codex-agent") {
		t.Errorf("Expected summary to mention codex-agent handoff, got: %s", summary)
	}
	if !strings.Contains(summary, "adaptive_test.go") {
		t.Errorf("Expected summary to preserve adaptive_test.go file reference, got: %s", summary)
	}
	if !strings.Contains(summary, "Pending Tasks") {
		t.Errorf("Expected summary to contain Pending Tasks, got: %s", summary)
	}
}
