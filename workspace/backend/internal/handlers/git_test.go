package handlers

import (
	"os"
	"path/filepath"
	"testing"
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
