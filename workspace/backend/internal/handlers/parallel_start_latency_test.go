package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

/*
	A parallel batch must not hold its own message behind SQLite's write lock.

	Measured in the live run: every "@a ... @b ..." message in a parallel
	thread took 12.3-12.8s to POST, and the lanes started ~16s after send.
	~11s of that was one INSERT: startParallelBatch published its state event
	through db.DB while it ran inside the routing transaction, which already
	held SQLite's only write lock. A second connection's write does not fail
	fast -- it waits out busy_timeout (10s), fails with SQLITE_BUSY, and only
	then does the transaction commit and the agents get the message. Presence
	heartbeats from every agent 500'd in the same window, and the state event
	itself was lost.

	This test uses the real database setup (db.InitDB: a file, WAL,
	busy_timeout 10000, a connection pool) because an in-memory shared-cache
	database fails a conflicting write immediately and hides the stall.
*/

func TestParallelBatchMessageIsNotHeldBehindItsOwnWriteLock(t *testing.T) {
	repo := newRepo(t)
	dbPath := filepath.Join(t.TempDir(), "latency.db")
	prevCfg := config.GlobalConfig
	config.GlobalConfig = &config.Config{DatabaseURL: "sqlite://" + filepath.ToSlash(dbPath), AgentTimeoutSeconds: 60}
	t.Cleanup(func() { config.GlobalConfig = prevCfg })
	db.InitDB()
	t.Cleanup(func() {
		if sqlDB, err := db.DB.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	token := "latency-token"
	hash := hashWorkspaceToken(token)
	ws := models.Workspace{ID: uuid.NewString(), Name: "latency", Slug: uuid.NewString(), PasswordHash: &hash, Status: "active"}
	if err := db.DB.Create(&ws).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(GetAgentWorktreeRoot(ws.ID)) })
	ch := models.Channel{ID: uuid.NewString(), WorkspaceID: ws.ID, Name: "general",
		OrchestrationMode: "parallel", Status: "active", WorkingDir: &repo}
	if err := db.DB.Create(&ch).Error; err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for _, name := range []string{"alpha", "beta"} {
		session := name + "-session"
		if err := db.DB.Create(&models.WorkspaceMember{WorkspaceID: ws.ID, AgentName: name,
			Status: "online", LastHeartbeat: &now, SessionID: &session}).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.DB.Create(&models.ChannelMember{ChannelID: ch.ID, AgentName: name}).Error; err != nil {
			t.Fatal(err)
		}
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/v1/events", SendEvent)
	body, _ := json.Marshal(map[string]interface{}{
		"network": ws.ID, "type": "workspace.message.posted", "source": "human:user", "target": "channel/general",
		"payload": map[string]interface{}{"content": "@alpha write a.txt @beta write b.txt", "message_type": "chat"},
		"metadata": map[string]interface{}{"mention_segments": []interface{}{
			map[string]interface{}{"agent": "alpha", "instruction": "write a.txt"},
			map[string]interface{}{"agent": "beta", "instruction": "write b.txt"},
		}},
	})
	req := httptest.NewRequest(http.MethodPost, "/v1/events", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Workspace-Token", token)
	w := httptest.NewRecorder()

	started := time.Now()
	r.ServeHTTP(w, req)
	elapsed := time.Since(started)
	t.Logf("POST /v1/events for a 2-lane worktree batch took %s", elapsed)

	if w.Code != http.StatusOK {
		t.Fatalf("POST /v1/events = %d: %s", w.Code, w.Body.String())
	}
	var resp struct {
		Metadata map[string]interface{} `json:"metadata"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	pb, _ := resp.Metadata["parallel_batch"].(map[string]interface{})
	if pb == nil || pb["isolation"] != "worktree" {
		t.Fatalf("no worktree batch was started: %v", resp.Metadata["parallel_batch"])
	}
	// Creating two worktrees costs well under a second; busy_timeout is 10s.
	// Anything near the latter means a write is queued behind the transaction.
	if elapsed > 5*time.Second {
		t.Fatalf("the batch message took %s to commit -- a write inside the routing transaction is waiting on its lock", elapsed)
	}
	var stateEvents int64
	db.DB.Model(&models.EventRecord{}).Where("network_id = ? AND type = ?", ws.ID, "workspace.parallel.batch").Count(&stateEvents)
	if stateEvents != 1 {
		t.Fatalf("want the batch-started state event recorded once, got %d", stateEvents)
	}
}
