package compaction

import (
	"strings"
	"testing"
)

func TestModelContextWindow(t *testing.T) {
	cases := []struct {
		model    string
		expected int
	}{
		{"gemini-1.5-pro", 1000000},
		{"antigravity-deepmind", 1000000},
		{"claude-3-7-sonnet", 200000},
		{"gpt-4o", 128000},
		{"codex-o3", 128000},
		{"deepseek-r1", 64000},
		{"qwen-2.5-coder", 32768},
		{"llama-3.3-70b", 32768},
		{"local-mistral-7b", 16384},
		{"unknown-model", 64000},
	}

	for _, tc := range cases {
		got := ModelContextWindow(tc.model)
		if got != tc.expected {
			t.Errorf("ModelContextWindow(%s) = %d; want %d", tc.model, got, tc.expected)
		}
	}
}

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
