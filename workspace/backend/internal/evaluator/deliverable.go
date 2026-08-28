package evaluator

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

var (
	// File path matcher in Markdown or code output: e.g. path/to/file.ext or `file.ext`
	filePathRegex = regexp.MustCompile(`(?:^|[\s"'` + "`" + `\(\[])([a-zA-Z0-9_\-\./\\]+\.[a-zA-Z0-9]{1,6})(?:$|[\s"'` + "`" + `\)\]:,\.\?])`)
	// Bullet point matcher
	bulletRegex = regexp.MustCompile(`^\s*(?:[\*\-•]|\d+\.)\s+(.+)$`)
)

// ExtractDeliverable distills a structured PipelineDeliverable from the turn's messages and workspace context.
func ExtractDeliverable(actor string, step models.PipelineStep, messages []string, dir string) *models.PipelineDeliverable {
	if len(messages) == 0 {
		return &models.PipelineDeliverable{
			Summary: fmt.Sprintf("智能体 @%s 已完成该阶段任务执行。", actor),
		}
	}

	// 1. Collect and clean all non-empty message paragraphs
	var allParagraphs []string
	var allBullets []string
	var openQuestions []string
	artifactSet := make(map[string]bool)

	for _, msg := range messages {
		lines := strings.Split(msg, "\n")
		for _, line := range lines {
			trimmed := strings.TrimSpace(line)
			if trimmed == "" {
				continue
			}

			// Extract bullet findings
			if matches := bulletRegex.FindStringSubmatch(trimmed); len(matches) > 1 {
				bulletText := strings.TrimSpace(matches[1])
				// Filter out very short noise
				if len(bulletText) >= 4 && len(bulletText) <= 300 {
					allBullets = append(allBullets, bulletText)
				}
			}

			// Extract questions / open items
			if strings.HasSuffix(trimmed, "？") || strings.HasSuffix(trimmed, "?") ||
				strings.Contains(trimmed, "建议补充") || strings.Contains(trimmed, "遗留") ||
				strings.Contains(trimmed, "TODO") || strings.Contains(trimmed, "待确认") {
				if len(trimmed) >= 6 && len(trimmed) <= 200 {
					openQuestions = append(openQuestions, trimmed)
				}
			}

			// Extract referenced file artifacts
			fileMatches := filePathRegex.FindAllStringSubmatch(trimmed, -1)
			for _, fm := range fileMatches {
				if len(fm) > 1 {
					cleanPath := strings.Trim(fm[1], `"'` + "`" + `()[]:, `)
					ext := strings.ToLower(filepath.Ext(cleanPath))
					// Exclude URLs, standard libraries, or generic extensions
					if !strings.HasPrefix(cleanPath, "http") && !strings.Contains(cleanPath, "://") {
						if isCodeOrDocExt(ext) && len(cleanPath) >= 3 && !strings.HasPrefix(cleanPath, ".") {
							artifactSet[cleanPath] = true
						}
					}
				}
			}
		}

		paragraphs := strings.Split(msg, "\n\n")
		for _, p := range paragraphs {
			pTrim := strings.TrimSpace(p)
			if pTrim != "" && !strings.HasPrefix(pTrim, "```") && len(pTrim) > 10 {
				allParagraphs = append(allParagraphs, pTrim)
			}
		}
	}

	// 2. Synthesize Deliverable Summary
	var summary string
	if len(allParagraphs) > 0 {
		// Prefer conclusion or first descriptive paragraph
		for _, p := range allParagraphs {
			if strings.Contains(p, "总结") || strings.Contains(p, "结论") || strings.Contains(p, "核心") || strings.Contains(p, "报告") {
				summary = p
				break
			}
		}
		if summary == "" {
			summary = allParagraphs[0]
		}
		// Truncate summary if too long to maintain context density
		if len([]rune(summary)) > 300 {
			summary = string([]rune(summary)[:300]) + "..."
		}
	} else {
		summary = fmt.Sprintf("智能体 @%s 已完成阶段任务: %s", actor, step.Instruction)
	}

	// 3. Deduplicate and cap Key Findings (Top 5)
	var keyFindings []string
	seenFindings := make(map[string]bool)
	for _, b := range allBullets {
		if !seenFindings[b] && len(keyFindings) < 5 {
			seenFindings[b] = true
			keyFindings = append(keyFindings, b)
		}
	}

	// 4. Artifact list (Top 8)
	var artifacts []string
	for art := range artifactSet {
		if len(artifacts) < 8 {
			artifacts = append(artifacts, art)
		}
	}

	// 5. Deduplicate and cap Open Questions (Top 3)
	var cappedQuestions []string
	seenQ := make(map[string]bool)
	for _, q := range openQuestions {
		if !seenQ[q] && len(cappedQuestions) < 3 {
			seenQ[q] = true
			cappedQuestions = append(cappedQuestions, q)
		}
	}

	// 6. Raw clean excerpt
	var rawExcerpt string
	if len(messages) > 0 {
		lastMsg := messages[len(messages)-1]
		if len([]rune(lastMsg)) > 600 {
			rawExcerpt = string([]rune(lastMsg)[:600]) + "..."
		} else {
			rawExcerpt = lastMsg
		}
	}

	return &models.PipelineDeliverable{
		Summary:       summary,
		KeyFindings:   keyFindings,
		Artifacts:     artifacts,
		OpenQuestions: cappedQuestions,
		RawExcerpt:    rawExcerpt,
	}
}

// FormatRelayPrompt constructs the high-density structured prompt delivered to the next hop.
func FormatRelayPrompt(targetAgent, prevAgent string, prevDeliverable *models.PipelineDeliverable, nextInstruction string) string {
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("@%s\n\n", targetAgent))

	if prevDeliverable != nil && prevDeliverable.Summary != "" {
		sb.WriteString(fmt.Sprintf("### 📋 Prior Stage Deliverables (from @%s)\n", prevAgent))
		sb.WriteString(fmt.Sprintf("**Summary**: %s\n\n", prevDeliverable.Summary))

		if len(prevDeliverable.KeyFindings) > 0 {
			sb.WriteString("**Key Findings & Conclusions**:\n")
			for _, kf := range prevDeliverable.KeyFindings {
				sb.WriteString(fmt.Sprintf("- %s\n", kf))
			}
			sb.WriteString("\n")
		}

		if len(prevDeliverable.Artifacts) > 0 {
			sb.WriteString(fmt.Sprintf("**Referenced Files & Artifacts**: `%s`\n\n", strings.Join(prevDeliverable.Artifacts, "`, `")))
		}

		if len(prevDeliverable.OpenQuestions) > 0 {
			sb.WriteString("**Open Questions & Focus Areas**:\n")
			for _, q := range prevDeliverable.OpenQuestions {
				sb.WriteString(fmt.Sprintf("- %s\n", q))
			}
			sb.WriteString("\n")
		}
		sb.WriteString("---\n\n")
	}

	sb.WriteString(fmt.Sprintf("**👉 Next Hop Task & Directives**:\n%s", nextInstruction))
	return sb.String()
}

func isCodeOrDocExt(ext string) bool {
	switch ext {
	case ".go", ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".java", ".c", ".cpp",
		".md", ".json", ".yaml", ".yml", ".toml", ".sql", ".sh", ".html", ".css":
		return true
	default:
		return false
	}
}
