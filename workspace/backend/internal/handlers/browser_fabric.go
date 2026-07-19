package handlers

// BrowserFabric REST client — the cloud backend that actually drives shared
// browser sessions. Session identifiers and live-view URLs are persisted on the
// BrowserTab row (not held in memory), so the Go server stays stateless and a
// restart never orphans a live session.
//
// Configuration (environment, matching the original Python service):
//
//	BROWSERFABRIC_API_KEY          global fallback key
//	BROWSERFABRIC_URL              base URL (default https://api.browserfabric.com)
//	BROWSERFABRIC_PROVISION_SECRET enables free-tier per-workspace key provisioning
//
// A workspace may also store a per-workspace key in settings["browserfabric_api_key"],
// which takes priority over the global env key.

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

func bfBaseURL() string {
	if url := strings.TrimRight(os.Getenv("BROWSERFABRIC_URL"), "/"); url != "" {
		return url
	}
	return "https://api.browserfabric.com"
}

func bfGlobalKey() string { return strings.TrimSpace(os.Getenv("BROWSERFABRIC_API_KEY")) }

// resolveBFKey returns the BrowserFabric key for a workspace: the per-workspace
// key in settings first, then the global env key. Auto-provisioning is attempted
// only when a provision secret is configured and no key exists yet.
func resolveBFKey(workspace *models.Workspace) string {
	settings := decodeJSONMap(workspace.Settings)
	if key, ok := settings["browserfabric_api_key"].(string); ok && key != "" {
		return key
	}
	if key := bfGlobalKey(); key != "" {
		return key
	}
	if secret := strings.TrimSpace(os.Getenv("BROWSERFABRIC_PROVISION_SECRET")); secret != "" {
		if key := bfProvisionWorkspaceKey(workspace.ID, secret); key != "" {
			settings["browserfabric_api_key"] = key
			if settingsBytes, err := json.Marshal(settings); err == nil {
				db.DB.Model(workspace).Update("settings", settingsBytes)
			}
			return key
		}
	}
	return ""
}

func bfProvisionWorkspaceKey(workspaceID, secret string) string {
	body, _ := json.Marshal(map[string]string{"workspace_id": workspaceID, "secret": secret})
	req, err := http.NewRequest(http.MethodPost, bfBaseURL()+"/api/v1/auth/provision-workspace", bytes.NewReader(body))
	if err != nil {
		return ""
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ""
	}
	var parsed struct {
		APIKey string `json:"api_key"`
	}
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 16*1024))
	_ = json.Unmarshal(data, &parsed)
	return parsed.APIKey
}

// bfCall invokes a BrowserFabric browseruse tool. The generic envelope is
// {tool_name, arguments?, session_id?} with a Bearer key; the response is
// {success, result, error}.
func bfCall(key, toolName string, arguments map[string]interface{}, sessionID string) (map[string]interface{}, error) {
	payload := map[string]interface{}{"tool_name": toolName}
	if len(arguments) > 0 {
		payload["arguments"] = arguments
	}
	if sessionID != "" {
		payload["session_id"] = sessionID
	}
	body, _ := json.Marshal(payload)
	req, err := http.NewRequest(http.MethodPost, bfBaseURL()+"/api/v1/services/browseruse/call", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+key)
	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("browser fabric request failed: %s", resp.Status)
	}
	var parsed map[string]interface{}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return nil, err
	}
	if success, _ := parsed["success"].(bool); !success {
		errMsg, _ := parsed["error"].(string)
		if errMsg == "" {
			errMsg = "unknown"
		}
		return nil, fmt.Errorf("browser fabric error: %s", errMsg)
	}
	return parsed, nil
}

// bfResult extracts the nested "result" object from a bfCall response.
func bfResult(resp map[string]interface{}) map[string]interface{} {
	if result, ok := resp["result"].(map[string]interface{}); ok {
		return result
	}
	return map[string]interface{}{}
}

// bfCreateSession opens a new remote session, optionally bound to a persistent
// context, returning its session id and live-view share URL.
func bfCreateSession(key, contextID string) (sessionID, shareURL string, err error) {
	args := map[string]interface{}{"headless": true}
	if contextID != "" {
		args["context_id"] = contextID
		args["persist"] = true
	}
	resp, err := bfCall(key, "create_session", args, "")
	if err != nil {
		return "", "", err
	}
	result := bfResult(resp)
	sessionID, _ = result["session_id"].(string)
	shareURL, _ = result["share_url"].(string)
	return sessionID, shareURL, nil
}

// bfGetPageInfo returns the live {url, title} for a session.
func bfGetPageInfo(key, sessionID string) (url, title string, err error) {
	resp, err := bfCall(key, "get_page_info", nil, sessionID)
	if err != nil {
		return "", "", err
	}
	result := bfResult(resp)
	url, _ = result["url"].(string)
	title, _ = result["title"].(string)
	return url, title, nil
}

func bfNavigate(key, sessionID, url string) {
	_, _ = bfCall(key, "navigate", map[string]interface{}{"url": url, "wait_until": "domcontentloaded"}, sessionID)
}

func bfClick(key, sessionID, selector string) error {
	_, err := bfCall(key, "click_element", map[string]interface{}{"selector": selector}, sessionID)
	return err
}

func bfType(key, sessionID, selector, text string) error {
	_, err := bfCall(key, "type_text", map[string]interface{}{"selector": selector, "text": text}, sessionID)
	return err
}

func bfPressKey(key, sessionID, pressed string) error {
	_, err := bfCall(key, "press_key", map[string]interface{}{"key": pressed}, sessionID)
	return err
}

func bfEvaluate(key, sessionID, expression string) (interface{}, error) {
	resp, err := bfCall(key, "evaluate_js", map[string]interface{}{"expression": expression}, sessionID)
	if err != nil {
		return nil, err
	}
	return bfResult(resp)["result"], nil
}

func bfScreenshot(key, sessionID string) ([]byte, error) {
	resp, err := bfCall(key, "take_screenshot", map[string]interface{}{"full_page": false}, sessionID)
	if err != nil {
		return nil, err
	}
	b64, _ := bfResult(resp)["screenshot"].(string)
	if idx := strings.Index(b64, ","); strings.HasPrefix(b64, "data:") && idx >= 0 {
		b64 = b64[idx+1:]
	}
	return base64.StdEncoding.DecodeString(b64)
}

func bfSnapshot(key, sessionID string) (string, error) {
	resp, err := bfCall(key, "snapshot", nil, sessionID)
	if err != nil {
		return "", err
	}
	snapshot, _ := bfResult(resp)["snapshot"].(string)
	if snapshot == "" {
		snapshot = "(empty page)"
	}
	return snapshot, nil
}

func bfCloseSession(key, sessionID string) {
	if sessionID == "" {
		return
	}
	_, _ = bfCall(key, "close_session", nil, sessionID)
}

// bfSaveContext captures the session's cookies/localStorage into a persistent
// context and returns its id.
func bfSaveContext(key, sessionID string) (string, error) {
	name := "persist-" + sessionID
	if len(sessionID) > 8 {
		name = "persist-" + sessionID[:8]
	}
	resp, err := bfCall(key, "save_context", map[string]interface{}{"context_name": name}, sessionID)
	if err != nil {
		return "", err
	}
	contextID, _ := bfResult(resp)["context_id"].(string)
	return contextID, nil
}

func bfDeleteContext(key, bbContextID string) {
	if key == "" || bbContextID == "" {
		return
	}
	req, err := http.NewRequest(http.MethodDelete, bfBaseURL()+"/api/v1/contexts/"+bbContextID, nil)
	if err != nil {
		return
	}
	req.Header.Set("Authorization", "Bearer "+key)
	client := &http.Client{Timeout: 10 * time.Second}
	if resp, err := client.Do(req); err == nil {
		resp.Body.Close()
	}
}
