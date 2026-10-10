package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

func setupWorkflowTestRouter(t *testing.T) (*gin.Engine, models.Workspace, models.Channel) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	database, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:%s?mode=memory&cache=shared", uuid.NewString())), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	db.DB = database
	_ = database.AutoMigrate(
		&models.Workspace{},
		&models.Channel{},
		&models.SavedWorkflow{},
		&models.ChannelPipeline{},
	)

	ws := models.Workspace{ID: uuid.NewString(), Name: "wf-ws"}
	database.Create(&ws)
	ch := models.Channel{ID: uuid.NewString(), WorkspaceID: ws.ID, Name: "general"}
	database.Create(&ch)

	r := gin.New()
	v1 := r.Group("/v1")
	v1.GET("/workspaces/:workspace_id/workflows", ListSavedWorkflows)
	v1.POST("/workspaces/:workspace_id/workflows", SaveWorkflow)
	v1.DELETE("/workspaces/:workspace_id/workflows/:id", DeleteSavedWorkflow)
	v1.POST("/workspaces/:workspace_id/workflows/:id/run", RunSavedWorkflow)
	return r, ws, ch
}

func TestSavedWorkflowsCRUDAndRun(t *testing.T) {
	r, ws, ch := setupWorkflowTestRouter(t)

	// 1. Create a workflow
	reqBody := SavedWorkflowRequest{
		Name:        "feature-relay",
		Description: "Coder then Reviewer",
		Steps: []models.PipelineStep{
			{Agent: "alice", Instruction: "write tests"},
			{Agent: "bob", Instruction: "review tests"},
		},
	}
	payload, _ := json.Marshal(reqBody)
	w := httptest.NewRecorder()
	req, _ := http.NewRequest(http.MethodPost, fmt.Sprintf("/v1/workspaces/%s/workflows", ws.ID), bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("expected 201 Created, got %d: %s", w.Code, w.Body.String())
	}

	var created models.SavedWorkflow
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil {
		t.Fatalf("failed to decode created workflow: %v", err)
	}
	if created.Name != "feature-relay" {
		t.Fatalf("expected name feature-relay, got %s", created.Name)
	}

	// 2. List workflows
	w = httptest.NewRecorder()
	req, _ = http.NewRequest(http.MethodGet, fmt.Sprintf("/v1/workspaces/%s/workflows", ws.ID), nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", w.Code)
	}
	var listResp struct {
		Workflows []struct {
			ID    string                `json:"id"`
			Name  string                `json:"name"`
			Steps []models.PipelineStep `json:"steps"`
		} `json:"workflows"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &listResp)
	if len(listResp.Workflows) != 1 || listResp.Workflows[0].Name != "feature-relay" {
		t.Fatalf("expected 1 workflow, got %+v", listResp.Workflows)
	}
	if len(listResp.Workflows[0].Steps) != 2 {
		t.Fatalf("expected 2 steps, got %d", len(listResp.Workflows[0].Steps))
	}

	// 3. Run the workflow
	runBody, _ := json.Marshal(SavedWorkflowRunRequest{
		Channel: ch.Name,
		Source:  "test-runner",
	})
	w = httptest.NewRecorder()
	req, _ = http.NewRequest(http.MethodPost, fmt.Sprintf("/v1/workspaces/%s/workflows/%s/run", ws.ID, created.ID), bytes.NewReader(runBody))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 OK on run, got %d: %s", w.Code, w.Body.String())
	}

	// Check pipeline was created in DB
	var active models.ChannelPipeline
	if err := db.DB.Where("channel_id = ? AND status = ?", ch.ID, "running").First(&active).Error; err != nil {
		t.Fatalf("expected active pipeline in DB: %v", err)
	}
	if active.StartedBy != "test-runner" {
		t.Fatalf("expected started by test-runner, got %s", active.StartedBy)
	}

	// 4. Delete the workflow
	w = httptest.NewRecorder()
	req, _ = http.NewRequest(http.MethodDelete, fmt.Sprintf("/v1/workspaces/%s/workflows/%s", ws.ID, created.ID), nil)
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 OK on delete, got %d", w.Code)
	}
}
