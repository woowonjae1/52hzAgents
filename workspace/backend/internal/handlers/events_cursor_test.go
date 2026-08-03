package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	// The pure-Go driver, matching internal/db. The cgo driver the other handler
	// tests use is unavailable without a C toolchain, which makes those tests skip
	// silently; this one has to actually run.
	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"gorm.io/gorm"
)

// eventCursorTestRouter builds an in-memory workspace whose event log is
// deliberately degenerate: every record shares one timestamp. That is the shape
// that used to break the after-cursor, and it is cheap to reproduce in practice
// (an agent emitting several status events inside a single millisecond).
func eventCursorTestRouter(t *testing.T, sameMillisecond int) (*gin.Engine, models.Workspace, string, []string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	database, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:%s?mode=memory&cache=shared", uuid.NewString())), &gorm.Config{})
	if err != nil {
		if strings.Contains(err.Error(), "requires cgo") {
			t.Skip("SQLite integration test requires CGO_ENABLED=1")
		}
		t.Fatalf("open test database: %v", err)
	}
	if err := database.AutoMigrate(&models.Workspace{}, &models.EventRecord{}); err != nil {
		t.Fatalf("migrate test database: %v", err)
	}
	db.DB = database

	token := "event-cursor-token"
	hash := hashWorkspaceToken(token)
	workspace := models.Workspace{ID: uuid.NewString(), Name: "Event cursor test", PasswordHash: &hash}
	if err := database.Create(&workspace).Error; err != nil {
		t.Fatalf("create workspace: %v", err)
	}

	const timestamp = int64(1_700_000_000_000)
	ids := make([]string, 0, sameMillisecond)
	for i := 0; i < sameMillisecond; i++ {
		record := models.EventRecord{
			ID:         uuid.NewString(),
			NetworkID:  workspace.ID,
			Type:       "workspace.message",
			Source:     "openagents:tester",
			Target:     "channel/general",
			Payload:    []byte(fmt.Sprintf(`{"content":"event-%d"}`, i)),
			Metadata:   []byte(`{}`),
			Timestamp:  timestamp,
			Visibility: "channel",
		}
		if err := database.Create(&record).Error; err != nil {
			t.Fatalf("create event %d: %v", i, err)
		}
		ids = append(ids, record.ID)
	}

	router := gin.New()
	router.GET("/v1/events", ListEvents)
	return router, workspace, token, ids
}

type eventListResponse struct {
	Events []struct {
		ID      string            `json:"id"`
		Payload map[string]string `json:"payload"`
	} `json:"events"`
	HasMore  bool   `json:"has_more"`
	OldestID string `json:"oldest_id"`
	NewestID string `json:"newest_id"`
}

func listEvents(t *testing.T, router http.Handler, token, query string) eventListResponse {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/v1/events?"+query, nil)
	request.Header.Set("X-Workspace-Token", token)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("list events = %d, body = %s", response.Code, response.Body.String())
	}
	var decoded eventListResponse
	if err := json.Unmarshal(response.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("decode list response: %v", err)
	}
	return decoded
}

// Paging through events that all share a timestamp must visit each event exactly
// once. Before the (timestamp, id) ordering and cursor tiebreak this dropped
// every record the database did not happen to emit first.
func TestListEventsCursorDoesNotSkipSameMillisecondEvents(t *testing.T) {
	const total = 7
	router, workspace, token, ids := eventCursorTestRouter(t, total)
	expected := make(map[string]bool, len(ids))
	for _, id := range ids {
		expected[id] = false
	}

	seen := make([]string, 0, total)
	cursor := ""
	for page := 0; page < total+2; page++ {
		query := fmt.Sprintf("network=%s&limit=2", workspace.ID)
		if cursor != "" {
			query += "&after=" + cursor
		}
		result := listEvents(t, router, token, query)
		if len(result.Events) == 0 {
			break
		}
		for _, event := range result.Events {
			already, known := expected[event.ID]
			if !known {
				t.Fatalf("page %d returned unknown event %s", page, event.ID)
			}
			if already {
				t.Fatalf("page %d returned event %s twice", page, event.ID)
			}
			expected[event.ID] = true
			seen = append(seen, event.ID)
		}
		cursor = result.NewestID
		if !result.HasMore {
			break
		}
	}

	if len(seen) != total {
		missing := make([]string, 0)
		for id, found := range expected {
			if !found {
				missing = append(missing, id)
			}
		}
		t.Fatalf("paged %d/%d events; skipped %v", len(seen), total, missing)
	}
}

// sort=desc must not swap the cursor bounds: oldest_id is the oldest row in the
// page regardless of the order the rows were serialized in.
func TestListEventsDescendingCursorBoundsAreNotInverted(t *testing.T) {
	const total = 5
	router, workspace, token, _ := eventCursorTestRouter(t, total)

	asc := listEvents(t, router, token, fmt.Sprintf("network=%s&limit=%d", workspace.ID, total))
	desc := listEvents(t, router, token, fmt.Sprintf("network=%s&limit=%d&sort=desc", workspace.ID, total))

	if len(asc.Events) != total || len(desc.Events) != total {
		t.Fatalf("asc=%d desc=%d events, want %d each", len(asc.Events), len(desc.Events), total)
	}
	if desc.Events[0].ID != asc.Events[total-1].ID {
		t.Fatalf("desc page does not start at the newest event: %s vs %s", desc.Events[0].ID, asc.Events[total-1].ID)
	}
	if desc.OldestID != asc.OldestID {
		t.Fatalf("desc oldest_id = %s, want %s", desc.OldestID, asc.OldestID)
	}
	if desc.NewestID != asc.NewestID {
		t.Fatalf("desc newest_id = %s, want %s", desc.NewestID, asc.NewestID)
	}
}
