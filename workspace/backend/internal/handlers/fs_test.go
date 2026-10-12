package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"gorm.io/gorm"
)

func TestSafeResolvePath(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "fs-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// Valid subpath
	resolved, err := safeResolvePath(tempDir, "sub/file.txt")
	if err != nil {
		t.Fatalf("unexpected error for valid path: %v", err)
	}
	expected := filepath.Join(tempDir, "sub", "file.txt")
	if resolved != expected {
		t.Errorf("expected %s, got %s", expected, resolved)
	}

	// Empty subpath
	resolved, err = safeResolvePath(tempDir, "")
	if err != nil {
		t.Fatalf("unexpected error for empty path: %v", err)
	}
	if resolved != tempDir {
		t.Errorf("expected %s, got %s", tempDir, resolved)
	}

	// Directory traversal attempt
	_, err = safeResolvePath(tempDir, "../secret.txt")
	if err == nil {
		t.Errorf("expected error for directory traversal, got nil")
	}

	_, err = safeResolvePath(tempDir, "sub/../../secret.txt")
	if err == nil {
		t.Errorf("expected error for deep directory traversal, got nil")
	}
}

func TestScanDirectory(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "scan-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	// Create test structure:
	// a.txt
	// .git/ (should be ignored)
	// node_modules/ (should be ignored)
	// src/
	//   b.go
	if err := os.WriteFile(filepath.Join(tempDir, "a.txt"), []byte("hello"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(tempDir, ".git"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tempDir, ".git", "config"), []byte("git"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(tempDir, "src"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(tempDir, "src", "b.go"), []byte("package main"), 0644); err != nil {
		t.Fatal(err)
	}

	var entries []FSEntry
	scanDirectory(tempDir, "", 1, 3, 100, &entries)

	if len(entries) != 3 { // src (dir), src/b.go (file), a.txt (file)
		t.Fatalf("expected 3 entries, got %d: %+v", len(entries), entries)
	}

	// Check that src comes first (directory), then a.txt
	if entries[0].Name != "src" || !entries[0].IsDir {
		t.Errorf("expected first entry to be directory 'src', got %+v", entries[0])
	}
}

func TestGetFSTreeAndContentEndpoints(t *testing.T) {
	gin.SetMode(gin.TestMode)
	database, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatalf("failed to open in-memory db: %v", err)
	}
	db.DB = database
	_ = db.DB.AutoMigrate(&models.Workspace{}, &models.Channel{})

	tempDir, err := os.MkdirTemp("", "endpoint-test-*")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	testFile := filepath.Join(tempDir, "sample.txt")
	testContent := "hello world from 52hzAgents"
	if err := os.WriteFile(testFile, []byte(testContent), 0644); err != nil {
		t.Fatal(err)
	}

	ws := models.Workspace{
		ID:   "ws-fs-test",
		Name: "FS Test",
		Slug: "fs-test",
	}
	db.DB.Create(&ws)

	channel := models.Channel{
		ID:          "ch-fs-test",
		WorkspaceID: ws.ID,
		Name:        "test-channel",
		WorkingDir:  &tempDir,
	}
	db.DB.Create(&channel)

	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set("workspace", &ws)
		c.Next()
	})
	router.GET("/v1/fs/tree", GetFSTree)
	router.GET("/v1/fs/content", GetFSFileContent)

	// Test GET /v1/fs/tree
	req := httptest.NewRequest(http.MethodGet, "/v1/fs/tree?channel=ch-fs-test", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", w.Code, w.Body.String())
	}

	var treeResp FSTreeResponse
	if err := json.Unmarshal(w.Body.Bytes(), &treeResp); err != nil {
		t.Fatalf("failed to parse json response: %v", err)
	}
	if len(treeResp.Entries) != 1 || treeResp.Entries[0].Name != "sample.txt" {
		t.Errorf("unexpected tree response: %+v", treeResp)
	}

	// Test GET /v1/fs/content
	reqContent := httptest.NewRequest(http.MethodGet, "/v1/fs/content?channel=ch-fs-test&path=sample.txt", nil)
	wContent := httptest.NewRecorder()
	router.ServeHTTP(wContent, reqContent)

	if wContent.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", wContent.Code, wContent.Body.String())
	}

	var contentResp FSContentResponse
	if err := json.Unmarshal(wContent.Body.Bytes(), &contentResp); err != nil {
		t.Fatalf("failed to parse content response: %v", err)
	}
	if contentResp.Content != testContent {
		t.Errorf("expected content %q, got %q", testContent, contentResp.Content)
	}
}
