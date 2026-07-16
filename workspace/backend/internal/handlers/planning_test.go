package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

// planningTestRouter creates an isolated database and exposes the planning
// endpoints exactly as the server registers them. The tests exercise request
// validation, workspace-token checks, persistence, and cancellation together.
func planningTestRouter(t *testing.T) (*gin.Engine, models.Workspace, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	database, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:%s?mode=memory&cache=shared", uuid.NewString())), &gorm.Config{})
	if err != nil {
		if strings.Contains(err.Error(), "requires cgo") {
			t.Skip("SQLite integration test requires CGO_ENABLED=1")
		}
		t.Fatalf("open test database: %v", err)
	}
	if err := database.AutoMigrate(
		&models.Workspace{}, &models.WorkspaceMember{}, &models.Channel{}, &models.ChannelMember{},
		&models.EventRecord{}, &models.TodoRecord{}, &models.TimerRecord{}, &models.RoutineRecord{},
	); err != nil {
		t.Fatalf("migrate test database: %v", err)
	}
	db.DB = database

	token := "planning-token"
	hash := hashWorkspaceToken(token)
	workspace := models.Workspace{ID: uuid.NewString(), Name: "Planning test", PasswordHash: &hash}
	if err := database.Create(&workspace).Error; err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	if err := database.Create(&models.WorkspaceMember{WorkspaceID: workspace.ID, AgentName: "planner"}).Error; err != nil {
		t.Fatalf("create workspace member: %v", err)
	}

	router := gin.New()
	router.PUT("/v1/todos", PutTodos)
	router.GET("/v1/todos", GetTodos)
	router.POST("/v1/timers", CreateTimer)
	router.GET("/v1/timers", ListTimers)
	router.DELETE("/v1/timers/:timer_id", DeleteTimer)
	router.POST("/v1/routines", CreateRoutine)
	router.GET("/v1/routines", ListRoutines)
	router.DELETE("/v1/routines/:routine_id", DeleteRoutine)
	return router, workspace, token
}

func planningRequest(t *testing.T, router http.Handler, method, target, token string, body interface{}) *httptest.ResponseRecorder {
	t.Helper()
	var content []byte
	if body != nil {
		var err error
		content, err = json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal request body: %v", err)
		}
	}
	request := httptest.NewRequest(method, target, bytes.NewReader(content))
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("X-Workspace-Token", token)
	}
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func TestTodosReplaceAndListWithWorkspaceAuthorization(t *testing.T) {
	router, workspace, token := planningTestRouter(t)
	body := gin.H{
		"network": workspace.ID, "source": "openagents:planner", "channel": "general",
		"todos": []gin.H{
			{"content": "Design API", "status": "in_progress"},
			{"content": "Write tests", "status": "pending", "assignee": "reviewer"},
		},
	}

	if response := planningRequest(t, router, http.MethodPut, "/v1/todos", "", body); response.Code != http.StatusUnauthorized {
		t.Fatalf("put without token = %d, want %d", response.Code, http.StatusUnauthorized)
	}
	if response := planningRequest(t, router, http.MethodPut, "/v1/todos", token, body); response.Code != http.StatusOK {
		t.Fatalf("put todos = %d, body = %s", response.Code, response.Body.String())
	}

	response := planningRequest(t, router, http.MethodGet, "/v1/todos?network="+workspace.ID+"&all=true", token, nil)
	var listed struct {
		Todos []models.TodoRecord `json:"todos"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &listed) != nil {
		t.Fatalf("list todos = %d, body = %s", response.Code, response.Body.String())
	}
	if len(listed.Todos) != 2 || listed.Todos[0].Status != "in_progress" || listed.Todos[1].Assignee != "reviewer" {
		t.Fatalf("unexpected todos: %+v", listed.Todos)
	}

	body["todos"] = []gin.H{{"content": "Only remaining task", "status": "pending"}}
	if response = planningRequest(t, router, http.MethodPut, "/v1/todos", token, body); response.Code != http.StatusOK {
		t.Fatalf("replace todos = %d, body = %s", response.Code, response.Body.String())
	}
	response = planningRequest(t, router, http.MethodGet, "/v1/todos?network="+workspace.ID+"&all=true", token, nil)
	if err := json.Unmarshal(response.Body.Bytes(), &listed); err != nil {
		t.Fatalf("decode replaced todos: %v", err)
	}
	if len(listed.Todos) != 1 || listed.Todos[0].Content != "Only remaining task" {
		t.Fatalf("todos were not replaced: %+v", listed.Todos)
	}
}

func TestTimerLifecycleAndWorkspaceScopedCancellation(t *testing.T) {
	router, workspace, token := planningTestRouter(t)
	validBody := gin.H{
		"network": workspace.ID, "source": "openagents:planner", "channel": "general",
		"message": "Check the deployment", "delay_seconds": 60,
	}
	invalidBody := gin.H{
		"network": workspace.ID, "source": "openagents:planner", "channel": "general",
		"message": "Invalid", "delay_seconds": 0,
	}
	if response := planningRequest(t, router, http.MethodPost, "/v1/timers", token, invalidBody); response.Code != http.StatusBadRequest {
		t.Fatalf("invalid timer = %d, want %d", response.Code, http.StatusBadRequest)
	}

	response := planningRequest(t, router, http.MethodPost, "/v1/timers", token, validBody)
	if response.Code != http.StatusOK {
		t.Fatalf("create timer = %d, body = %s", response.Code, response.Body.String())
	}
	var timer models.TimerRecord
	if err := json.Unmarshal(response.Body.Bytes(), &timer); err != nil {
		t.Fatalf("decode timer: %v", err)
	}
	if timer.ID == "" || timer.Status != "active" || timer.FiresAt.IsZero() {
		t.Fatalf("unexpected created timer: %+v", timer)
	}

	response = planningRequest(t, router, http.MethodGet, "/v1/timers?network="+workspace.ID+"&channel=general", token, nil)
	var listed struct {
		Timers []models.TimerRecord `json:"timers"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &listed) != nil || len(listed.Timers) != 1 {
		t.Fatalf("list timers = %d, body = %s", response.Code, response.Body.String())
	}

	otherToken := "other-planning-token"
	otherHash := hashWorkspaceToken(otherToken)
	if err := db.DB.Create(&models.Workspace{ID: uuid.NewString(), Name: "Other", PasswordHash: &otherHash}).Error; err != nil {
		t.Fatalf("create other workspace: %v", err)
	}
	if response = planningRequest(t, router, http.MethodDelete, "/v1/timers/"+timer.ID, otherToken, nil); response.Code != http.StatusUnauthorized {
		t.Fatalf("cancel with other token = %d, want %d", response.Code, http.StatusUnauthorized)
	}
	if response = planningRequest(t, router, http.MethodDelete, "/v1/timers/"+timer.ID, token, nil); response.Code != http.StatusOK {
		t.Fatalf("cancel timer = %d, body = %s", response.Code, response.Body.String())
	}
	response = planningRequest(t, router, http.MethodGet, "/v1/timers?network="+workspace.ID, token, nil)
	if err := json.Unmarshal(response.Body.Bytes(), &listed); err != nil || len(listed.Timers) != 0 {
		t.Fatalf("cancelled timer remained active: %s", response.Body.String())
	}
}

func TestRoutineLifecycleValidationAndWorkspaceScopedCancellation(t *testing.T) {
	router, workspace, token := planningTestRouter(t)
	base := gin.H{
		"network": workspace.ID, "source": "openagents:planner", "name": "Daily briefing", "message": "Summarise progress",
	}
	if response := planningRequest(t, router, http.MethodPost, "/v1/routines", token, base); response.Code != http.StatusBadRequest {
		t.Fatalf("routine without schedule = %d, want %d", response.Code, http.StatusBadRequest)
	}
	base["interval_minutes"] = 30
	response := planningRequest(t, router, http.MethodPost, "/v1/routines", token, base)
	if response.Code != http.StatusOK {
		t.Fatalf("create routine = %d, body = %s", response.Code, response.Body.String())
	}
	var routine models.RoutineRecord
	if err := json.Unmarshal(response.Body.Bytes(), &routine); err != nil {
		t.Fatalf("decode routine: %v", err)
	}
	if routine.ID == "" || routine.ChannelName != "routines:planner" || routine.Status != "active" {
		t.Fatalf("unexpected created routine: %+v", routine)
	}

	response = planningRequest(t, router, http.MethodGet, "/v1/routines?network="+workspace.ID+"&source=openagents:planner", token, nil)
	var listed struct {
		Routines []models.RoutineRecord `json:"routines"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &listed) != nil || len(listed.Routines) != 1 {
		t.Fatalf("list routines = %d, body = %s", response.Code, response.Body.String())
	}

	otherToken := "other-routine-token"
	otherHash := hashWorkspaceToken(otherToken)
	if err := db.DB.Create(&models.Workspace{ID: uuid.NewString(), Name: "Other", PasswordHash: &otherHash}).Error; err != nil {
		t.Fatalf("create other workspace: %v", err)
	}
	if response = planningRequest(t, router, http.MethodDelete, "/v1/routines/"+routine.ID, otherToken, nil); response.Code != http.StatusUnauthorized {
		t.Fatalf("cancel with other token = %d, want %d", response.Code, http.StatusUnauthorized)
	}
	if response = planningRequest(t, router, http.MethodDelete, "/v1/routines/"+routine.ID, token, nil); response.Code != http.StatusOK {
		t.Fatalf("cancel routine = %d, body = %s", response.Code, response.Body.String())
	}
	response = planningRequest(t, router, http.MethodGet, "/v1/routines?network="+workspace.ID, token, nil)
	if err := json.Unmarshal(response.Body.Bytes(), &listed); err != nil || len(listed.Routines) != 0 {
		t.Fatalf("cancelled routine remained active: %s", response.Body.String())
	}
}
