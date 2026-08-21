package compaction

import (
	"unicode"
)

// MessageItem represents a normalized chat message for compaction processing.
type MessageItem struct {
	EventID   string `json:"event_id"`
	Source    string `json:"source"`
	Target    string `json:"target"`
	Content   string `json:"content"`
	Type      string `json:"type"` // e.g. "chat", "command", "system"
	Timestamp int64  `json:"timestamp"`
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

// EstimateMessagesTokens calculates the aggregate estimated tokens for a slice of messages.
func EstimateMessagesTokens(messages []MessageItem) int {
	total := 0
	for _, m := range messages {
		// Include sender envelope overhead (~4 tokens per message frame)
		total += 4
		total += EstimateTokens(m.Source)
		total += EstimateTokens(m.Content)
	}
	return total
}
