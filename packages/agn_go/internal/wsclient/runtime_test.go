package wsclient

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestBridgeReportsRuntimeAndLogWithCurrentSession(t *testing.T) {
	requests := make(chan map[string]interface{}, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Workspace-Token") != "token" {
			t.Errorf("workspace token was not forwarded")
		}
		if r.URL.Path != "/v1/workspaces/workspace/agents/coder/runtime" && r.URL.Path != "/v1/workspaces/workspace/agents/coder/logs" {
			t.Errorf("unexpected endpoint: %s", r.URL.Path)
		}
		var body map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode report body: %v", err)
		}
		requests <- body
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	bridge := &Bridge{Endpoint: server.URL, Token: "token", AgentName: "coder", networkID: "workspace", sessionID: "session"}
	pid := 1234
	if err := bridge.ReportRuntime("running", "healthy", &pid, 2, ""); err != nil {
		t.Fatalf("ReportRuntime: %v", err)
	}
	if err := bridge.SendLog("error", "agent stderr"); err != nil {
		t.Fatalf("SendLog: %v", err)
	}

	runtime := <-requests
	if runtime["session_id"] != "session" || runtime["process_status"] != "running" || runtime["health_status"] != "healthy" {
		t.Fatalf("unexpected runtime report: %#v", runtime)
	}
	log := <-requests
	if log["session_id"] != "session" || log["level"] != "error" || log["message"] != "agent stderr" {
		t.Fatalf("unexpected log report: %#v", log)
	}
}
