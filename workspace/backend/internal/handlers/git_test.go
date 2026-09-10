package handlers

import (
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

func TestSanitizeGitFilePath(t *testing.T) {
	tempDir := t.TempDir()

	// Test valid paths
	validPaths := []string{
		"foo.ts",
		"src/foo.ts",
		"src/nested/bar.go",
	}
	for _, p := range validPaths {
		clean, err := sanitizeGitFilePath(tempDir, p)
		if err != nil {
			t.Errorf("Expected path %q to be valid, got error: %v", p, err)
		}
		if clean == "" {
			t.Errorf("Expected non-empty clean path for %q", p)
		}
	}

	// Test invalid / malicious paths (Path Traversal & Flag Injection)
	invalidPaths := []string{
		"../../etc/passwd",
		"../foo.ts",
		"src/../../outside.ts",
		"-f",
		"--exec=calc.exe",
		os.Getenv("SystemRoot") + "\\System32\\cmd.exe",
	}
	for _, p := range invalidPaths {
		_, err := sanitizeGitFilePath(tempDir, p)
		if err == nil {
			t.Errorf("Expected path %q to be rejected, but it was accepted", p)
		}
	}
}

func TestFindGitRepoRoot(t *testing.T) {
	root, found := findGitRepoRoot()
	if !found {
		t.Fatalf("Expected to find git repository root, but found=false")
	}
	if _, err := os.Stat(filepath.Join(root, ".git")); err != nil {
		t.Fatalf("Root %q does not contain .git folder: %v", root, err)
	}
}

func TestGetGitDiffHandler(t *testing.T) {
	gin.SetMode(gin.TestMode)
	dir := initTestRepo(t)

	// Modify two separate files
	writeRepoFile(t, dir, "app.go", "package main\n\nfunc main() { println(\"modified app\") }\n")
	writeRepoFile(t, dir, "util.go", "package main\n\nfunc helper() { println(\"modified util\") }\n")

	// Setup in-memory sqlite for handler
	setupTurnDB(t)

	ws := models.Workspace{
		ID:   "ws-diff-test",
		Slug: "diff-test-ws",
		Name: "Diff Test Workspace",
	}
	db.DB.Create(&ws)

	workingDir := dir
	ch := models.Channel{
		ID:          "ch-diff-test",
		WorkspaceID: ws.ID,
		Name:        "general",
		WorkingDir:  &workingDir,
	}
	db.DB.Create(&ch)

	router := gin.New()
	router.GET("/v1/git/diff", GetGitDiff)

	// 1. Test query with 'file=app.go'
	req1 := httptest.NewRequest("GET", "/v1/git/diff?network="+ws.ID+"&channel="+ch.ID+"&file=app.go", nil)
	w1 := httptest.NewRecorder()
	router.ServeHTTP(w1, req1)
	if w1.Code != 200 {
		t.Fatalf("expected 200 OK for file=app.go, got %d: %s", w1.Code, w1.Body.String())
	}
	var resp1 map[string]interface{}
	_ = json.Unmarshal(w1.Body.Bytes(), &resp1)
	diff1, _ := resp1["diff"].(string)
	if !strings.Contains(diff1, "modified app") || strings.Contains(diff1, "modified util") {
		t.Fatalf("expected diff1 to contain only app.go changes, got:\n%s", diff1)
	}

	// 2. Test query with 'path=util.go' (verifying backwards compatibility bug fix)
	req2 := httptest.NewRequest("GET", "/v1/git/diff?network="+ws.ID+"&channel="+ch.ID+"&path=util.go", nil)
	w2 := httptest.NewRecorder()
	router.ServeHTTP(w2, req2)
	if w2.Code != 200 {
		t.Fatalf("expected 200 OK for path=util.go, got %d: %s", w2.Code, w2.Body.String())
	}
	var resp2 map[string]interface{}
	_ = json.Unmarshal(w2.Body.Bytes(), &resp2)
	diff2, _ := resp2["diff"].(string)
	if !strings.Contains(diff2, "modified util") || strings.Contains(diff2, "modified app") {
		t.Fatalf("expected diff2 to contain only util.go changes, got:\n%s", diff2)
	}

	// 3. Test query with turn_id
	turn := models.AgentTurnChange{
		ID:          "turn-diff-test-1",
		WorkspaceID: ws.ID,
		ChannelID:   ch.ID,
		ChannelName: ch.Name,
		AgentName:   "claude",
		TaskID:      "task-1",
		WorkingDir:  dir,
		BaseCommit:  "HEAD",
		Status:      "closed",
	}
	db.DB.Create(&turn)

	req3 := httptest.NewRequest("GET", "/v1/git/diff?network="+ws.ID+"&channel="+ch.ID+"&turn_id="+turn.ID+"&file=app.go", nil)
	w3 := httptest.NewRecorder()
	router.ServeHTTP(w3, req3)
	if w3.Code != 200 {
		t.Fatalf("expected 200 OK for turn_id, got %d: %s", w3.Code, w3.Body.String())
	}
	var resp3 map[string]interface{}
	_ = json.Unmarshal(w3.Body.Bytes(), &resp3)
	if resp3["turn_id"] != turn.ID {
		t.Fatalf("expected turn_id %s in response, got %v", turn.ID, resp3["turn_id"])
	}
}
