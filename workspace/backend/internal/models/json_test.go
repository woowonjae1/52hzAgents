package models

import (
	"encoding/json"
	"testing"
	"time"
)

func assertJSONKeys(t *testing.T, value interface{}, requiredKeys ...string) {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal JSON: %v", err)
	}
	var decoded map[string]interface{}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal JSON: %v", err)
	}
	for _, key := range requiredKeys {
		if _, ok := decoded[key]; !ok {
			t.Errorf("missing JSON key %q in %s", key, encoded)
		}
	}
	if _, hasPascalCaseID := decoded["ID"]; hasPascalCaseID {
		t.Errorf("response must not expose PascalCase ID in %s", encoded)
	}
}

func TestWorkspaceResponseModelsUseSnakeCaseJSON(t *testing.T) {
	now := time.Now().UTC()
	assertJSONKeys(t, TodoRecord{ID: "todo-1", WorkspaceID: "workspace-1", ChannelName: "general", CreatedBy: "agent", Assignee: "agent", Content: "write tests", Status: "pending", CreatedAt: now, UpdatedAt: now}, "id", "workspace_id", "channel_name", "created_by", "created_at", "updated_at")
	assertJSONKeys(t, TimerRecord{ID: "timer-1", WorkspaceID: "workspace-1", ChannelName: "general", CreatedBy: "agent", Message: "reminder", DelaySeconds: 60, FiresAt: now, Status: "active", CreatedAt: now}, "id", "workspace_id", "channel_name", "created_by", "delay_seconds", "fires_at")
	assertJSONKeys(t, RoutineRecord{ID: "routine-1", WorkspaceID: "workspace-1", ChannelName: "general", CreatedBy: "agent", Name: "daily", Message: "report", NextFiresAt: now, Status: "active", CreatedAt: now}, "id", "workspace_id", "channel_name", "created_by", "next_fires_at")
	assertJSONKeys(t, FileRecord{ID: "file-1", WorkspaceID: "workspace-1", Filename: "report.md", ContentType: "text/markdown", Size: 12, StorageKey: "files/report.md", UploadedBy: "agent", Status: "active", CreatedAt: now}, "id", "workspace_id", "content_type", "storage_key", "uploaded_by", "created_at")
	assertJSONKeys(t, Channel{ID: "channel-1", WorkspaceID: "workspace-1", Name: "general", Status: "active", CreatedAt: now}, "id", "workspace_id", "orchestration_mode", "last_event_at", "created_at")
	assertJSONKeys(t, NotificationRecord{ID: "notification-1", WorkspaceID: "workspace-1", CreatedBy: "agent", Title: "Plan ready", Message: "Updated", Priority: "normal", Status: "active", CreatedAt: now}, "id", "workspace_id", "created_by", "is_read", "channel_name", "link_url", "created_at")
	assertJSONKeys(t, AgentRuntimeRecord{WorkspaceID: "workspace-1", AgentName: "agent", SessionID: "session", ProcessStatus: "running", HealthStatus: "healthy", UpdatedAt: now}, "workspace_id", "agent_name", "process_status", "health_status", "restart_count", "updated_at")
	assertJSONKeys(t, AgentApprovalRecord{ID: "approval-1", WorkspaceID: "workspace-1", AgentName: "agent", RequestedBy: "agent", Action: "shell.execute", Status: "pending", CreatedAt: now}, "id", "workspace_id", "agent_name", "requested_by", "resolved_by", "created_at")
}
