package handlers

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

// KnowledgeChunk represents a semantic slice of a markdown knowledge entry.
type KnowledgeChunk struct {
	ChunkID      string   `json:"chunk_id"`
	EntryID      string   `json:"entry_id"`
	Slug         string   `json:"slug"`
	Title        string   `json:"title"`
	Category     string   `json:"category"`
	SectionPath  []string `json:"section_path"`
	Section      string   `json:"section"`
	HeadingLevel int      `json:"heading_level"`
	Content      string   `json:"content"`
	CharCount    int      `json:"char_count"`
}

var (
	headingRegex = regexp.MustCompile(`^(#{1,6})\s+(.+)$`)
)

type headingNode struct {
	Level int
	Title string
}

// ChunkMarkdownDocument parses a markdown text into hierarchical, searchable chunks.
func ChunkMarkdownDocument(entry *models.KnowledgeEntry, content string) []KnowledgeChunk {
	if entry == nil {
		return nil
	}

	content = strings.TrimSpace(content)
	if content == "" {
		category := ""
		if entry.Category != nil {
			category = *entry.Category
		}
		desc := ""
		if entry.Description != nil {
			desc = *entry.Description
		}
		return []KnowledgeChunk{
			{
				ChunkID:      entry.Slug + "#0",
				EntryID:      entry.ID,
				Slug:         entry.Slug,
				Title:        entry.Title,
				Category:     category,
				SectionPath:  []string{entry.Title},
				Section:      entry.Title,
				HeadingLevel: 1,
				Content:      desc,
				CharCount:    len(desc),
			},
		}
	}

	lines := strings.Split(content, "\n")
	var chunks []KnowledgeChunk

	var headingStack []headingNode
	var currentLines []string
	currentLevel := 1
	inCodeBlock := false
	chunkIdx := 0

	category := ""
	if entry.Category != nil {
		category = *entry.Category
	}

	flushChunk := func() {
		text := strings.TrimSpace(strings.Join(currentLines, "\n"))
		if text == "" {
			currentLines = nil
			return
		}

		path := make([]string, 0, len(headingStack)+1)
		for _, h := range headingStack {
			path = append(path, h.Title)
		}
		if len(path) == 0 {
			path = []string{entry.Title}
		}

		sectionStr := strings.Join(path, " > ")

		// If section content is especially long (> 1500 chars), split into sub-chunks by paragraph
		if len(text) > 1500 {
			subParagraphs := strings.Split(text, "\n\n")
			var subBuf []string
			subLen := 0

			for _, p := range subParagraphs {
				pTrimmed := strings.TrimSpace(p)
				if pTrimmed == "" {
					continue
				}
				if subLen > 0 && subLen+len(pTrimmed) > 1200 {
					subContent := strings.Join(subBuf, "\n\n")
					chunks = append(chunks, KnowledgeChunk{
						ChunkID:      fmt.Sprintf("%s#%d", entry.Slug, chunkIdx),
						EntryID:      entry.ID,
						Slug:         entry.Slug,
						Title:        entry.Title,
						Category:     category,
						SectionPath:  path,
						Section:      sectionStr,
						HeadingLevel: currentLevel,
						Content:      subContent,
						CharCount:    len(subContent),
					})
					chunkIdx++
					subBuf = []string{pTrimmed}
					subLen = len(pTrimmed)
				} else {
					subBuf = append(subBuf, pTrimmed)
					subLen += len(pTrimmed) + 2
				}
			}

			if len(subBuf) > 0 {
				subContent := strings.Join(subBuf, "\n\n")
				chunks = append(chunks, KnowledgeChunk{
					ChunkID:      fmt.Sprintf("%s#%d", entry.Slug, chunkIdx),
					EntryID:      entry.ID,
					Slug:         entry.Slug,
					Title:        entry.Title,
					Category:     category,
					SectionPath:  path,
					Section:      sectionStr,
					HeadingLevel: currentLevel,
					Content:      subContent,
					CharCount:    len(subContent),
				})
				chunkIdx++
			}
		} else {
			chunks = append(chunks, KnowledgeChunk{
				ChunkID:      fmt.Sprintf("%s#%d", entry.Slug, chunkIdx),
				EntryID:      entry.ID,
				Slug:         entry.Slug,
				Title:        entry.Title,
				Category:     category,
				SectionPath:  path,
				Section:      sectionStr,
				HeadingLevel: currentLevel,
				Content:      text,
				CharCount:    len(text),
			})
			chunkIdx++
		}

		currentLines = nil
	}

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)

		// Code block toggle (``` or ~~~)
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			inCodeBlock = !inCodeBlock
			currentLines = append(currentLines, line)
			continue
		}

		if inCodeBlock {
			currentLines = append(currentLines, line)
			continue
		}

		// Markdown heading outside code blocks
		if m := headingRegex.FindStringSubmatch(trimmed); len(m) == 3 {
			level := len(m[1])
			headingText := strings.TrimSpace(m[2])

			flushChunk()

			// Adjust heading hierarchy stack
			for len(headingStack) > 0 && headingStack[len(headingStack)-1].Level >= level {
				headingStack = headingStack[:len(headingStack)-1]
			}
			headingStack = append(headingStack, headingNode{
				Level: level,
				Title: headingText,
			})
			currentLevel = level
			continue
		}

		currentLines = append(currentLines, line)
	}

	flushChunk()

	if len(chunks) == 0 {
		chunks = append(chunks, KnowledgeChunk{
			ChunkID:      entry.Slug + "#0",
			EntryID:      entry.ID,
			Slug:         entry.Slug,
			Title:        entry.Title,
			Category:     category,
			SectionPath:  []string{entry.Title},
			Section:      entry.Title,
			HeadingLevel: 1,
			Content:      content,
			CharCount:    len(content),
		})
	}

	return chunks
}
