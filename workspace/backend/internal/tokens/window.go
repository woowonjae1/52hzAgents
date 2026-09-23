// Package tokens holds the two token facts the server still needs: how big a
// model's window is when an agent did not say, and a rough token count for text.
//
// It replaces the old `compaction` package. That package summarised shared
// channel history on a timer and sized it to the smallest participant, but no
// agent ever read the summary: every agent keeps its own per-channel CLI
// session and compacts it itself. See agent_contexts for what is measured now.
package tokens

import (
	"strings"
	"unicode"
)

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
	case strings.Contains(m, "[1m]") || strings.Contains(m, "opus-5") || strings.Contains(m, "sonnet-5") || strings.Contains(m, "fable"):
		return 1000000
	case strings.Contains(m, "claude"):
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

// EstimateTokens calculates an approximate token count for a text string.
// It uses a fast multilingual heuristic accounting for CJK characters, English words,
// code symbols, and whitespace.
func EstimateTokens(text string) int {
	if len(text) == 0 {
		return 0
	}

	var cjkCount int
	var asciiAlphaNumCount int
	var punctuationCount int
	var whitespaceCount int

	for _, r := range text {
		switch {
		case unicode.Is(unicode.Han, r) || unicode.Is(unicode.Hiragana, r) || unicode.Is(unicode.Katakana, r) || unicode.Is(unicode.Hangul, r):
			cjkCount++
		case r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_':
			asciiAlphaNumCount++
		case unicode.IsPunct(r) || unicode.IsSymbol(r):
			punctuationCount++
		case unicode.IsSpace(r):
			whitespaceCount++
		default:
			asciiAlphaNumCount++
		}
	}

	// CJK: ~1.2 tokens per character
	// English/Alphanumeric: ~4 chars per token (or ~1 token per word)
	// Punctuation: ~1 token per symbol
	cjkTokens := float64(cjkCount) * 1.2
	asciiTokens := float64(asciiAlphaNumCount) / 3.8
	punctTokens := float64(punctuationCount) * 0.8
	spaceTokens := float64(whitespaceCount) * 0.2

	total := int(cjkTokens + asciiTokens + punctTokens + spaceTokens)
	if total < 1 && len(text) > 0 {
		return 1
	}
	return total
}
