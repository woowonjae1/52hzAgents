package handlers

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func initTestGitRepo(t *testing.T) string {
	t.Helper()
	repoDir := t.TempDir()

	// git init
	if _, err := runGit(repoDir, "init"); err != nil {
		t.Fatalf("git init failed: %v", err)
	}
	// configure user
	_, _ = runGit(repoDir, "config", "user.name", "TestUser")
	_, _ = runGit(repoDir, "config", "user.email", "test@52hz.local")

	// create initial commit so HEAD exists
	dummyFile := filepath.Join(repoDir, "README.md")
	if err := os.WriteFile(dummyFile, []byte("# Test Repo\n"), 0644); err != nil {
		t.Fatalf("failed to write dummy file: %v", err)
	}
	if _, err := runGit(repoDir, "add", "README.md"); err != nil {
		t.Fatalf("git add failed: %v", err)
	}
	if _, err := runGit(repoDir, "commit", "-m", "initial commit"); err != nil {
		t.Fatalf("git commit failed: %v", err)
	}

	return repoDir
}

func TestGitWorktreeLifecycle(t *testing.T) {
	repoDir := initTestGitRepo(t)

	// 1. Initial list should show the main worktree
	initialList, err := ListGitWorktrees(repoDir)
	if err != nil {
		t.Fatalf("ListGitWorktrees failed: %v", err)
	}
	if len(initialList) == 0 {
		t.Fatalf("Expected at least 1 main worktree, got 0")
	}

	// 2. Create worktree for Agent A (e.g. backend)
	wtDirA := filepath.Join(t.TempDir(), "wt_backend")
	branchA := "agent/task-backend"
	entryA, err := CreateGitWorktree(repoDir, wtDirA, branchA, "HEAD", true)
	if err != nil {
		t.Fatalf("CreateGitWorktree A failed: %v", err)
	}
	if entryA == nil || !strings.EqualFold(filepath.Clean(entryA.Path), filepath.Clean(wtDirA)) {
		t.Errorf("Expected worktree path %s, got %+v", wtDirA, entryA)
	}

	// Verify README.md exists in worktree A
	if _, err := os.Stat(filepath.Join(wtDirA, "README.md")); err != nil {
		t.Errorf("README.md does not exist in worktree A: %v", err)
	}

	// 3. Create worktree for Agent B (e.g. frontend) concurrently from the same repo!
	wtDirB := filepath.Join(t.TempDir(), "wt_frontend")
	branchB := "agent/task-frontend"
	entryB, err := CreateGitWorktree(repoDir, wtDirB, branchB, "HEAD", true)
	if err != nil {
		t.Fatalf("CreateGitWorktree B failed: %v", err)
	}
	if entryB == nil || !strings.EqualFold(filepath.Clean(entryB.Path), filepath.Clean(wtDirB)) {
		t.Errorf("Expected worktree path %s, got %+v", wtDirB, entryB)
	}

	// 4. Verify both worktrees are listed
	currentList, err := ListGitWorktrees(repoDir)
	if err != nil {
		t.Fatalf("ListGitWorktrees after additions failed: %v", err)
	}
	if len(currentList) < 3 {
		t.Errorf("Expected at least 3 worktrees (main + wtA + wtB), got %d", len(currentList))
	}

	// 5. Agent A writes a file in wtDirA
	if err := os.WriteFile(filepath.Join(wtDirA, "backend.go"), []byte("package main\n"), 0644); err != nil {
		t.Fatalf("Failed to write in wtDirA: %v", err)
	}

	// Verify wtDirB does NOT see backend.go (Physical Isolation)
	if _, err := os.Stat(filepath.Join(wtDirB, "backend.go")); !os.IsNotExist(err) {
		t.Errorf("Isolation breach! wtDirB should not see backend.go before merge")
	}

	// 6. Remove worktrees
	if err := RemoveGitWorktree(repoDir, wtDirA, true); err != nil {
		t.Errorf("RemoveGitWorktree A failed: %v", err)
	}
	if err := RemoveGitWorktree(repoDir, wtDirB, true); err != nil {
		t.Errorf("RemoveGitWorktree B failed: %v", err)
	}

	// 7. Prune and verify list shrank back to 1
	_ = PruneGitWorktrees(repoDir)
	finalList, err := ListGitWorktrees(repoDir)
	if err != nil {
		t.Fatalf("ListGitWorktrees final failed: %v", err)
	}
	if len(finalList) != 1 {
		t.Errorf("Expected 1 main worktree after removal, got %d", len(finalList))
	}
}

func TestGenerateAgentWorktreePath(t *testing.T) {
	wsID := "ws-12345"
	taskID := "task_abc"
	agentName := "claude"

	p := GenerateAgentWorktreePath(wsID, taskID, agentName)
	if !strings.Contains(p, "52hz_worktrees") || !strings.Contains(p, "ws-12345") || !strings.Contains(p, "task_abc_claude") {
		t.Errorf("Unexpected worktree path generated: %s", p)
	}
}
