package handlers

import (
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode"

	"github.com/gin-gonic/gin"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

type KnowledgeSearchResult struct {
	ChunkID     string   `json:"chunk_id"`
	EntryID     string   `json:"entry_id"`
	Slug        string   `json:"slug"`
	Title       string   `json:"title"`
	Category    string   `json:"category"`
	Section     string   `json:"section"`
	SectionPath []string `json:"section_path"`
	Snippet     string   `json:"snippet"`
	CharCount   int      `json:"char_count"`
	Score       float64  `json:"score"`
}

type KnowledgeSearchResponse struct {
	Query        string                  `json:"query"`
	TotalMatches int                     `json:"total_matches"`
	Results      []KnowledgeSearchResult `json:"results"`
}

type searchKnowledgeBody struct {
	Network   string   `json:"network"`
	Query     string   `json:"query"`
	Category  *string  `json:"category"`
	Limit     *int     `json:"limit"`
	Threshold *float64 `json:"threshold"`
}

var (
	termSplitRegex = regexp.MustCompile(`[a-zA-Z0-9_#-]+|[\p{Han}]`)
)

// tokenizeText splits text into searchable keyword tokens and Han characters.
func tokenizeText(text string) []string {
	text = strings.ToLower(text)
	matches := termSplitRegex.FindAllString(text, -1)
	if len(matches) == 0 {
		return nil
	}

	var tokens []string
	seen := make(map[string]bool)

	for i := 0; i < len(matches); i++ {
		t := strings.TrimSpace(matches[i])
		if t == "" {
			continue
		}
		if !seen[t] {
			seen[t] = true
			tokens = append(tokens, t)
		}

		// Also add 2-grams for consecutive Chinese characters to boost phrase matching
		if i+1 < len(matches) {
			r1 := []rune(matches[i])
			r2 := []rune(matches[i+1])
			if len(r1) == 1 && len(r2) == 1 && unicode.Is(unicode.Han, r1[0]) && unicode.Is(unicode.Han, r2[0]) {
				bi := string(r1[0]) + string(r2[0])
				if !seen[bi] {
					seen[bi] = true
					tokens = append(tokens, bi)
				}
			}
		}
	}
	return tokens
}

// scoreChunk evaluates relevance of a KnowledgeChunk against query tokens and exact phrase.
func scoreChunk(chunk KnowledgeChunk, queryTerms []string, rawQuery string) float64 {
	if len(queryTerms) == 0 {
		return 0.0
	}

	rawQueryLower := strings.ToLower(strings.TrimSpace(rawQuery))
	titleLower := strings.ToLower(chunk.Title)
	slugLower := strings.ToLower(chunk.Slug)
	sectionLower := strings.ToLower(chunk.Section)
	contentLower := strings.ToLower(chunk.Content)

	score := 0.0
	matchedTermsCount := 0

	for _, term := range queryTerms {
		termScore := 0.0

		// Title & Slug Match
		if strings.Contains(titleLower, term) || strings.Contains(slugLower, term) {
			termScore += 3.0
		}

		// Section Header Match
		if strings.Contains(sectionLower, term) {
			termScore += 2.0
		}

		// Content Term Frequency Match
		count := strings.Count(contentLower, term)
		if count > 0 {
			// Sub-linear term frequency (log-scaled)
			tf := 1.0 + math.Log(float64(count))
			termScore += tf * 1.0
		}

		if termScore > 0 {
			matchedTermsCount++
			score += termScore
		}
	}

	if matchedTermsCount == 0 {
		return 0.0
	}

	// Term coverage ratio bonus (reward matching all terms vs matching just one)
	termCoverage := float64(matchedTermsCount) / float64(len(queryTerms))
	score = score * (0.5 + 0.5*termCoverage)

	// Exact query substring bonus
	if len(rawQueryLower) >= 3 {
		if strings.Contains(titleLower, rawQueryLower) {
			score += 4.0
		} else if strings.Contains(sectionLower, rawQueryLower) {
			score += 3.0
		} else if strings.Contains(contentLower, rawQueryLower) {
			score += 2.0
		}
	}

	// Normalize score with sigmoid-like dampening to [0, 1] range
	// score of 3.0 maps to ~0.5, score of 10.0 maps to ~0.9
	normalizedScore := 1.0 - math.Exp(-score/4.0)

	return math.Round(normalizedScore*100) / 100
}

// SearchKnowledge handles GET /v1/knowledge/search and POST /v1/knowledge/search.
func SearchKnowledge(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}

	var reqQuery, reqCategory string
	limit := 5
	threshold := 0.15

	if c.Request.Method == http.MethodPost {
		var body searchKnowledgeBody
		if err := c.ShouldBindJSON(&body); err == nil {
			reqQuery = body.Query
			if body.Category != nil {
				reqCategory = *body.Category
			}
			if body.Limit != nil && *body.Limit > 0 {
				limit = *body.Limit
			}
			if body.Threshold != nil && *body.Threshold >= 0 {
				threshold = *body.Threshold
			}
		}
	}

	if reqQuery == "" {
		reqQuery = c.Query("q")
		if reqQuery == "" {
			reqQuery = c.Query("query")
		}
	}
	if reqCategory == "" {
		reqCategory = c.Query("category")
	}
	if qLimit := c.Query("limit"); qLimit != "" {
		if l, err := strconv.Atoi(qLimit); err == nil && l > 0 {
			limit = l
		}
	}
	if qTopK := c.Query("top_k"); qTopK != "" {
		if l, err := strconv.Atoi(qTopK); err == nil && l > 0 {
			limit = l
		}
	}
	if qThreshold := c.Query("threshold"); qThreshold != "" {
		if t, err := strconv.ParseFloat(qThreshold, 64); err == nil && t >= 0 {
			threshold = t
		}
	}

	if limit > 20 {
		limit = 20
	}

	reqQuery = strings.TrimSpace(reqQuery)
	if reqQuery == "" {
		c.JSON(http.StatusOK, KnowledgeSearchResponse{
			Query:        "",
			TotalMatches: 0,
			Results:      []KnowledgeSearchResult{},
		})
		return
	}

	// Fetch active knowledge entries in this workspace
	query := db.DB.Where("workspace_id = ? AND status = ?", workspace.ID, "active")
	if reqCategory != "" && reqCategory != "all" {
		normalizedCat := normalizeKnowledgeCategory(&reqCategory)
		if normalizedCat != nil {
			query = query.Where("category = ?", *normalizedCat)
		}
	}

	var entries []models.KnowledgeEntry
	if err := query.Order("updated_at desc").Find(&entries).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to query knowledge entries"})
		return
	}

	queryTerms := tokenizeText(reqQuery)
	if len(queryTerms) == 0 {
		c.JSON(http.StatusOK, KnowledgeSearchResponse{
			Query:        reqQuery,
			TotalMatches: 0,
			Results:      []KnowledgeSearchResult{},
		})
		return
	}

	var results []KnowledgeSearchResult

	for _, entry := range entries {
		content := readKnowledgeContent(entry.StorageKey)
		chunks := ChunkMarkdownDocument(&entry, content)

		for _, chunk := range chunks {
			score := scoreChunk(chunk, queryTerms, reqQuery)
			if score >= threshold {
				snippet := chunk.Content
				if len(snippet) > 800 {
					snippet = snippet[:800] + "..."
				}

				results = append(results, KnowledgeSearchResult{
					ChunkID:     chunk.ChunkID,
					EntryID:     chunk.EntryID,
					Slug:        chunk.Slug,
					Title:       chunk.Title,
					Category:    chunk.Category,
					Section:     chunk.Section,
					SectionPath: chunk.SectionPath,
					Snippet:     snippet,
					CharCount:   chunk.CharCount,
					Score:       score,
				})
			}
		}
	}

	// Sort descending by score, then by char count
	sort.Slice(results, func(i, j int) bool {
		if results[i].Score != results[j].Score {
			return results[i].Score > results[j].Score
		}
		return results[i].CharCount < results[j].CharCount
	})

	totalMatches := len(results)
	if len(results) > limit {
		results = results[:limit]
	}

	c.JSON(http.StatusOK, KnowledgeSearchResponse{
		Query:        reqQuery,
		TotalMatches: totalMatches,
		Results:      results,
	})
}
