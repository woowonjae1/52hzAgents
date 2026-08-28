package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"gorm.io/gorm"
)

func TestChunkMarkdownDocument(t *testing.T) {
	category := "api"
	desc := "API guidelines"
	entry := &models.KnowledgeEntry{
		ID:          "entry-1",
		Slug:        "api-guidelines",
		Title:       "API Design Guidelines",
		Category:    &category,
		Description: &desc,
	}

	doc := `# API Design Guidelines

This is an introduction to the workspace API design.

## Authentication

We use Bearer JWT tokens for all API requests.

### Token Expiration

Access tokens expire after 2 hours. Refresh tokens are valid for 30 days.

## Error Handling

All errors return a JSON envelope with code and message.

` + "```go\n" +
		"// Code block with comments and # hash symbols that should not be headings\n" +
		"type ErrorResponse struct {\n" +
		"    Code string `json:\"code\"`\n" +
		"}\n" +
		"```\n"

	chunks := ChunkMarkdownDocument(entry, doc)

	if len(chunks) < 4 {
		t.Fatalf("expected at least 4 chunks, got %d", len(chunks))
	}

	// Verify Section hierarchy for Token Expiration chunk
	var foundTokenExpiration bool
	for _, c := range chunks {
		if strings.Contains(c.Section, "Token Expiration") {
			foundTokenExpiration = true
			if !strings.Contains(c.Content, "Access tokens expire after 2 hours") {
				t.Errorf("chunk content missing expected text: %s", c.Content)
			}
			if len(c.SectionPath) < 3 {
				t.Errorf("expected breadcrumb path >= 3, got: %v", c.SectionPath)
			}
			break
		}
	}
	if !foundTokenExpiration {
		t.Errorf("did not find Token Expiration chunk with section hierarchy")
	}

	// Verify code block is preserved inside error handling chunk
	var foundCodeBlock bool
	for _, c := range chunks {
		if strings.Contains(c.Content, "type ErrorResponse struct") {
			foundCodeBlock = true
			break
		}
	}
	if !foundCodeBlock {
		t.Errorf("code block was not preserved in chunk")
	}
}

func TestKnowledgeSearchAPI(t *testing.T) {
	gin.SetMode(gin.TestMode)

	// Setup pure Go memory DB
	database, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:%s?mode=memory&cache=shared", uuid.NewString())), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	db.DB = database
	_ = db.DB.AutoMigrate(&models.Workspace{}, &models.WorkspaceMember{}, &models.Channel{}, &models.ChannelMember{}, &models.KnowledgeEntry{}, &models.EventRecord{})

	token := "token"
	workspace := models.Workspace{ID: uuid.NewString(), Name: "knowledge-test", PasswordHash: &token, Status: "active"}
	if err := db.DB.Create(&workspace).Error; err != nil {
		t.Fatal(err)
	}

	tmpDir, err := os.MkdirTemp("", "52hz-knowledge-test-*")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(tmpDir)

	config.GlobalConfig = &config.Config{
		FileStoragePath: tmpDir,
	}

	// Create physical file
	storageKey := "knowledge/jwt-spec.md"
	fullPath := filepath.Join(tmpDir, storageKey)
	_ = os.MkdirAll(filepath.Dir(fullPath), 0755)

	content := `# Security and Authentication Specification

## Overview
This document specifies how authentication works across all microservices.

## JWT Token Lifecycle
Access tokens are signed using RS256 algorithm.
The JWT access token expires after exactly 120 minutes (2 hours).
Refresh tokens are stored in Redis with a 30-day TTL.

## Password Policy
Passwords must contain at least 12 characters with mixed case and digits.
`
	if err := os.WriteFile(fullPath, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	cat := "api"
	size := len(content)
	entry := models.KnowledgeEntry{
		ID:          uuid.NewString(),
		WorkspaceID: workspace.ID,
		Slug:        "security-jwt-spec",
		Title:       "Security and Authentication Specification",
		Category:    &cat,
		StorageKey:  &storageKey,
		ContentSize: &size,
		CreatedBy:   "test-user",
		Status:      "active",
		CreatedAt:   time.Now(),
		UpdatedAt:   time.Now(),
	}
	if err := db.DB.Create(&entry).Error; err != nil {
		t.Fatal(err)
	}

	router := gin.New()
	v1 := router.Group("/v1")
	{
		v1.GET("/knowledge", ListKnowledge)
		v1.GET("/knowledge/search", SearchKnowledge)
		v1.POST("/knowledge/search", SearchKnowledge)
	}

	// 1. Test ListKnowledge with q filter
	t.Run("ListKnowledge with query", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/v1/knowledge?network="+workspace.ID+"&q=jwt", nil)
		req.Header.Set("X-Workspace-Token", "token")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", w.Code)
		}

		var resp struct {
			Entries []map[string]interface{} `json:"entries"`
			Total   int                      `json:"total"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatal(err)
		}
		if resp.Total != 1 || len(resp.Entries) != 1 {
			t.Fatalf("expected 1 entry for q=jwt, got %d", resp.Total)
		}
	})

	// 2. Test SearchKnowledge endpoint (Semantic / Chunk Search)
	t.Run("SearchKnowledge finds JWT Token Lifecycle chunk", func(t *testing.T) {
		req, _ := http.NewRequest("GET", "/v1/knowledge/search?network="+workspace.ID+"&q=JWT+access+token+expires", nil)
		req.Header.Set("X-Workspace-Token", "token")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)

		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", w.Code)
		}

		var resp KnowledgeSearchResponse
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatal(err)
		}

		if resp.TotalMatches == 0 || len(resp.Results) == 0 {
			t.Fatalf("expected search matches, got 0")
		}

		topResult := resp.Results[0]
		if topResult.Slug != "security-jwt-spec" {
			t.Errorf("topResult.Slug = %s, want security-jwt-spec", topResult.Slug)
		}
		if !strings.Contains(topResult.Section, "JWT Token Lifecycle") {
			t.Errorf("topResult.Section = %s, expected to contain JWT Token Lifecycle", topResult.Section)
		}
		if !strings.Contains(topResult.Snippet, "120 minutes") {
			t.Errorf("topResult.Snippet does not contain expected text: %s", topResult.Snippet)
		}
		if topResult.Score < 0.3 {
			t.Errorf("expected high score for exact terms, got %f", topResult.Score)
		}
	})
}
