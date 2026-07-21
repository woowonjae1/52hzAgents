package handlers

// Shared browser endpoints — open, navigate, interact with, and persist browser
// tabs that every workspace participant can watch and drive together.
//
//	POST   /v1/browser/tabs                       Open a tab
//	GET    /v1/browser/tabs                        List active tabs
//	GET    /v1/browser/tabs/:tab_id                Tab info (?validate reconnects)
//	POST   /v1/browser/tabs/:tab_id/navigate       Navigate to URL
//	POST   /v1/browser/tabs/:tab_id/reconnect      Recreate an expired session
//	POST   /v1/browser/tabs/:tab_id/click          Click a selector
//	POST   /v1/browser/tabs/:tab_id/type           Type into a selector
//	POST   /v1/browser/tabs/:tab_id/press_key      Press a key
//	POST   /v1/browser/tabs/:tab_id/evaluate       Evaluate JavaScript
//	GET    /v1/browser/tabs/:tab_id/screenshot     PNG screenshot
//	GET    /v1/browser/tabs/:tab_id/snapshot       Accessibility/text snapshot
//	POST   /v1/browser/tabs/:tab_id/share          Share with an agent
//	POST   /v1/browser/tabs/:tab_id/persist        Save session as a persistent context
//	POST   /v1/browser/tabs/:tab_id/unpersist      Revert to a temporal tab
//	DELETE /v1/browser/tabs/:tab_id                Close a tab
//	GET    /v1/browser/contexts                     List persistent contexts
//	DELETE /v1/browser/contexts/:context_id         Delete a persistent context
//	GET    /v1/browser/usage                        Usage summary
//
// Live automation is delegated to BrowserFabric (see browser_fabric.go). The DB
// tab/context lifecycle works with or without a configured backend; automation
// endpoints return a clear error when no backend key is set.

import (
	"encoding/json"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

const browserBackendUnavailable = "Browser backend not configured (set BROWSERFABRIC_API_KEY)"

func decodeStringArray(raw []byte) []string {
	out := []string{}
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &out)
	}
	if out == nil {
		out = []string{}
	}
	return out
}

func tabToDict(tab *models.BrowserTab, contextName string) gin.H {
	d := gin.H{
		"id":             tab.ID,
		"url":            tab.URL,
		"title":          tab.Title,
		"status":         tab.Status,
		"created_by":     tab.CreatedBy,
		"shared_with":    decodeStringArray(tab.SharedWith),
		"created_at":     tab.CreatedAt,
		"last_active_at": tab.LastActiveAt,
	}
	if tab.LiveURL != nil && *tab.LiveURL != "" {
		d["live_url"] = *tab.LiveURL
	}
	if tab.SessionID != nil && *tab.SessionID != "" {
		d["session_id"] = *tab.SessionID
	}
	if tab.ContextID != nil && *tab.ContextID != "" {
		d["context_id"] = *tab.ContextID
		d["persistent"] = true
		if contextName != "" {
			d["context_name"] = contextName
		}
	} else {
		d["persistent"] = false
	}
	return d
}

func contextToDict(ctx *models.BrowserContext) gin.H {
	return gin.H{
		"id":           ctx.ID,
		"name":         ctx.Name,
		"domain":       ctx.Domain,
		"status":       ctx.Status,
		"created_by":   ctx.CreatedBy,
		"shared_with":  decodeStringArray(ctx.SharedWith),
		"created_at":   ctx.CreatedAt,
		"last_used_at": ctx.LastUsedAt,
	}
}

// browserTabForID loads an active tab, resolves its workspace, and authorizes.
func browserTabForID(c *gin.Context) (*models.BrowserTab, *models.Workspace, bool) {
	var tab models.BrowserTab
	if err := db.DB.Where("id = ?", c.Param("tab_id")).First(&tab).Error; err != nil || tab.Status != "active" {
		c.JSON(http.StatusNotFound, gin.H{"error": "Tab not found"})
		return nil, nil, false
	}
	workspace, err := resolveWorkspace(tab.WorkspaceID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return nil, nil, false
	}
	if !authorizeWorkspace(c, workspace) {
		return nil, nil, false
	}
	return &tab, workspace, true
}

func touchTab(tab *models.BrowserTab) { tab.LastActiveAt = time.Now() }

// ensureBrowserConnected makes sure a tab has a live BrowserFabric session,
// reconnecting or recreating as needed, and syncs the live URL/title back onto
// the row. It returns the resolved key and whether a backend is available.
func ensureBrowserConnected(tab *models.BrowserTab, workspace *models.Workspace) (string, bool) {
	key := resolveBFKey(workspace)
	if key == "" {
		return "", false
	}
	if tab.SessionID != nil && *tab.SessionID != "" {
		if url, title, err := bfGetPageInfo(key, *tab.SessionID); err == nil {
			syncTabPage(tab, url, title)
			return key, true
		}
		// Session is dead — drop it and fall through to recreate.
		bfCloseSession(key, *tab.SessionID)
		tab.SessionID = nil
		tab.LiveURL = nil
	}
	bbContextID := resolveBBContextID(tab)
	startURL := tab.URL
	if startURL == "" {
		startURL = "about:blank"
	}
	sessionID, shareURL, err := bfCreateSession(key, bbContextID)
	if err != nil {
		return key, false
	}
	if startURL != "about:blank" {
		bfNavigate(key, sessionID, startURL)
	}
	tab.SessionID = &sessionID
	if shareURL != "" {
		tab.LiveURL = &shareURL
	}
	if url, title, err := bfGetPageInfo(key, sessionID); err == nil {
		syncTabPage(tab, url, title)
	}
	touchTab(tab)
	db.DB.Save(tab)
	return key, true
}

func syncTabPage(tab *models.BrowserTab, pageURL, pageTitle string) {
	changed := false
	if pageURL != "" && pageURL != tab.URL {
		tab.URL = pageURL
		changed = true
	}
	if pageTitle != "" && (tab.Title == nil || *tab.Title != pageTitle) {
		tab.Title = &pageTitle
		changed = true
	}
	if changed {
		touchTab(tab)
		db.DB.Save(tab)
	}
}

// resolveBBContextID returns the BrowserFabric context id backing a tab's
// persistent context, if any.
func resolveBBContextID(tab *models.BrowserTab) string {
	if tab.ContextID == nil || *tab.ContextID == "" {
		return ""
	}
	var ctx models.BrowserContext
	if db.DB.Where("id = ? AND status = ?", *tab.ContextID, "active").First(&ctx).Error != nil {
		return ""
	}
	if ctx.BbContextID != nil {
		return *ctx.BbContextID
	}
	return ""
}

type openTabRequest struct {
	URL       string `json:"url"`
	Network   string `json:"network" binding:"required"`
	Source    string `json:"source"`
	ContextID string `json:"context_id"`
}

// OpenBrowserTab handles POST /v1/browser/tabs.
func OpenBrowserTab(c *gin.Context) {
	var req openTabRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	workspace, err := resolveWorkspace(req.Network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}
	if !authorizeWorkspace(c, workspace) {
		return
	}
	startURL := req.URL
	if startURL == "" {
		startURL = "about:blank"
	}
	source := req.Source
	if source == "" {
		source = "human:user"
	}

	var contextRecord *models.BrowserContext
	if req.ContextID != "" {
		var ctx models.BrowserContext
		if db.DB.Where("id = ? AND workspace_id = ? AND status = ?", req.ContextID, workspace.ID, "active").
			First(&ctx).Error != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "Browser context not found"})
			return
		}
		contextRecord = &ctx
		var existing models.BrowserTab
		if db.DB.Where("context_id = ? AND workspace_id = ? AND status = ?", req.ContextID, workspace.ID, "active").
			First(&existing).Error == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "A tab for persistent context '" + ctx.Name + "' is already open (tab " + existing.ID + ")"})
			return
		}
	}

	tabID := uuid.NewString()
	sharedWith, _ := json.Marshal([]string{})
	tab := models.BrowserTab{
		ID:           tabID,
		WorkspaceID:  workspace.ID,
		URL:          startURL,
		CreatedBy:    source,
		SharedWith:   sharedWith,
		Status:       "active",
		CreatedAt:    time.Now(),
		LastActiveAt: time.Now(),
	}
	if req.ContextID != "" {
		tab.ContextID = &req.ContextID
	}

	// Best-effort live session; a tab is still created if no backend is set.
	if key := resolveBFKey(workspace); key != "" {
		bbContextID := ""
		if contextRecord != nil && contextRecord.BbContextID != nil {
			bbContextID = *contextRecord.BbContextID
		}
		if sessionID, shareURL, err := bfCreateSession(key, bbContextID); err == nil {
			tab.SessionID = &sessionID
			if shareURL != "" {
				tab.LiveURL = &shareURL
			}
			if startURL != "about:blank" {
				bfNavigate(key, sessionID, startURL)
			}
			if url, title, err := bfGetPageInfo(key, sessionID); err == nil {
				if url != "" {
					tab.URL = url
				}
				if title != "" {
					tab.Title = &title
				}
			}
		}
	}

	if err := db.DB.Create(&tab).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to open browser tab"})
		return
	}
	if contextRecord != nil {
		db.DB.Model(contextRecord).Update("last_used_at", time.Now())
	}

	usage := models.BrowserUsage{
		ID:          uuid.NewString(),
		WorkspaceID: workspace.ID,
		TabID:       tabID,
		SessionID:   tab.SessionID,
		OpenedBy:    source,
		StartedAt:   time.Now(),
	}
	db.DB.Create(&usage)

	_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.browser.tab.opened", source, "", gin.H{
		"tab_id": tabID, "url": tab.URL,
	})
	c.JSON(http.StatusOK, tabToDict(&tab, ""))
}

// ListBrowserTabs handles GET /v1/browser/tabs.
func ListBrowserTabs(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	status := c.DefaultQuery("status", "active")
	var tabs []models.BrowserTab
	db.DB.Where("workspace_id = ? AND status = ?", workspace.ID, status).
		Order("last_active_at desc").Find(&tabs)

	contextNames := map[string]string{}
	contextIDs := []string{}
	for i := range tabs {
		if tabs[i].ContextID != nil && *tabs[i].ContextID != "" {
			contextIDs = append(contextIDs, *tabs[i].ContextID)
		}
	}
	if len(contextIDs) > 0 {
		var contexts []models.BrowserContext
		db.DB.Where("id IN ?", contextIDs).Find(&contexts)
		for i := range contexts {
			contextNames[contexts[i].ID] = contexts[i].Name
		}
	}

	items := make([]gin.H, 0, len(tabs))
	for i := range tabs {
		name := ""
		if tabs[i].ContextID != nil {
			name = contextNames[*tabs[i].ContextID]
		}
		items = append(items, tabToDict(&tabs[i], name))
	}
	c.JSON(http.StatusOK, gin.H{"tabs": items, "total": len(tabs)})
}

// GetBrowserTab handles GET /v1/browser/tabs/:tab_id.
func GetBrowserTab(c *gin.Context) {
	tab, workspace, ok := browserTabForID(c)
	if !ok {
		return
	}
	if validate, _ := strconv.ParseBool(c.DefaultQuery("validate", "false")); validate {
		ensureBrowserConnected(tab, workspace)
	}
	c.JSON(http.StatusOK, tabToDict(tab, ""))
}

type navigateRequest struct {
	URL string `json:"url" binding:"required"`
}

// NavigateBrowserTab handles POST /v1/browser/tabs/:tab_id/navigate.
func NavigateBrowserTab(c *gin.Context) {
	tab, workspace, ok := browserTabForID(c)
	if !ok {
		return
	}
	var req navigateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	key, connected := ensureBrowserConnected(tab, workspace)
	if !connected {
		c.JSON(http.StatusBadRequest, gin.H{"error": browserBackendUnavailable})
		return
	}
	bfNavigate(key, *tab.SessionID, req.URL)
	if url, title, err := bfGetPageInfo(key, *tab.SessionID); err == nil {
		if url != "" {
			tab.URL = url
		}
		if title != "" {
			tab.Title = &title
		}
	} else {
		tab.URL = req.URL
	}
	touchTab(tab)
	db.DB.Save(tab)
	_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.browser.tab.navigated", "system", "", gin.H{
		"tab_id": tab.ID, "url": tab.URL, "title": tab.Title,
	})
	c.JSON(http.StatusOK, tabToDict(tab, ""))
}

// ReconnectBrowserTab handles POST /v1/browser/tabs/:tab_id/reconnect.
func ReconnectBrowserTab(c *gin.Context) {
	tab, workspace, ok := browserTabForID(c)
	if !ok {
		return
	}
	key := resolveBFKey(workspace)
	if key == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": browserBackendUnavailable})
		return
	}
	if tab.SessionID != nil {
		bfCloseSession(key, *tab.SessionID)
	}
	bbContextID := resolveBBContextID(tab)
	startURL := tab.URL
	if startURL == "" {
		startURL = "about:blank"
	}
	sessionID, shareURL, err := bfCreateSession(key, bbContextID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to reconnect browser tab"})
		return
	}
	if startURL != "about:blank" {
		bfNavigate(key, sessionID, startURL)
	}
	tab.SessionID = &sessionID
	if shareURL != "" {
		tab.LiveURL = &shareURL
	}
	if url, title, err := bfGetPageInfo(key, sessionID); err == nil {
		if url != "" {
			tab.URL = url
		}
		if title != "" {
			tab.Title = &title
		}
	}
	touchTab(tab)
	db.DB.Save(tab)
	c.JSON(http.StatusOK, tabToDict(tab, ""))
}

type selectorRequest struct {
	Selector string `json:"selector" binding:"required"`
}

// ClickBrowserTab handles POST /v1/browser/tabs/:tab_id/click.
func ClickBrowserTab(c *gin.Context) {
	tab, workspace, ok := browserTabForID(c)
	if !ok {
		return
	}
	var req selectorRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	key, connected := ensureBrowserConnected(tab, workspace)
	if !connected {
		c.JSON(http.StatusBadRequest, gin.H{"error": browserBackendUnavailable})
		return
	}
	if err := bfClick(key, *tab.SessionID, req.Selector); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Click failed"})
		return
	}
	if url, title, err := bfGetPageInfo(key, *tab.SessionID); err == nil {
		syncTabPage(tab, url, title)
	}
	touchTab(tab)
	db.DB.Save(tab)
	c.JSON(http.StatusOK, gin.H{"tab_id": tab.ID, "clicked": req.Selector, "url": tab.URL})
}

type typeRequest struct {
	Selector string `json:"selector" binding:"required"`
	Text     string `json:"text"`
	Append   bool   `json:"append"`
}

// TypeBrowserTab handles POST /v1/browser/tabs/:tab_id/type.
func TypeBrowserTab(c *gin.Context) {
	tab, workspace, ok := browserTabForID(c)
	if !ok {
		return
	}
	var req typeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	key, connected := ensureBrowserConnected(tab, workspace)
	if !connected {
		c.JSON(http.StatusBadRequest, gin.H{"error": browserBackendUnavailable})
		return
	}
	if err := bfType(key, *tab.SessionID, req.Selector, req.Text); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Type failed"})
		return
	}
	touchTab(tab)
	db.DB.Save(tab)
	c.JSON(http.StatusOK, gin.H{"tab_id": tab.ID, "typed": req.Selector})
}

type pressKeyRequest struct {
	Key string `json:"key" binding:"required"`
}

// PressKeyBrowserTab handles POST /v1/browser/tabs/:tab_id/press_key.
func PressKeyBrowserTab(c *gin.Context) {
	tab, workspace, ok := browserTabForID(c)
	if !ok {
		return
	}
	var req pressKeyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	key, connected := ensureBrowserConnected(tab, workspace)
	if !connected {
		c.JSON(http.StatusBadRequest, gin.H{"error": browserBackendUnavailable})
		return
	}
	if err := bfPressKey(key, *tab.SessionID, req.Key); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Press key failed"})
		return
	}
	touchTab(tab)
	db.DB.Save(tab)
	c.JSON(http.StatusOK, gin.H{"tab_id": tab.ID, "pressed": req.Key})
}

type evaluateRequest struct {
	Expression string `json:"expression" binding:"required"`
}

// EvaluateBrowserTab handles POST /v1/browser/tabs/:tab_id/evaluate.
func EvaluateBrowserTab(c *gin.Context) {
	tab, workspace, ok := browserTabForID(c)
	if !ok {
		return
	}
	var req evaluateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	key, connected := ensureBrowserConnected(tab, workspace)
	if !connected {
		c.JSON(http.StatusBadRequest, gin.H{"error": browserBackendUnavailable})
		return
	}
	result, err := bfEvaluate(key, *tab.SessionID, req.Expression)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Evaluate failed"})
		return
	}
	touchTab(tab)
	db.DB.Save(tab)
	c.JSON(http.StatusOK, gin.H{"tab_id": tab.ID, "result": result})
}

// ScreenshotBrowserTab handles GET /v1/browser/tabs/:tab_id/screenshot.
func ScreenshotBrowserTab(c *gin.Context) {
	tab, workspace, ok := browserTabForID(c)
	if !ok {
		return
	}
	key, connected := ensureBrowserConnected(tab, workspace)
	if !connected {
		c.JSON(http.StatusBadRequest, gin.H{"error": browserBackendUnavailable})
		return
	}
	data, err := bfScreenshot(key, *tab.SessionID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Screenshot failed"})
		return
	}
	if url, title, err := bfGetPageInfo(key, *tab.SessionID); err == nil {
		syncTabPage(tab, url, title)
	}
	c.Header("Cache-Control", "no-cache, no-store")
	c.Data(http.StatusOK, "image/png", data)
}

// SnapshotBrowserTab handles GET /v1/browser/tabs/:tab_id/snapshot.
func SnapshotBrowserTab(c *gin.Context) {
	tab, workspace, ok := browserTabForID(c)
	if !ok {
		return
	}
	key, connected := ensureBrowserConnected(tab, workspace)
	if !connected {
		c.JSON(http.StatusBadRequest, gin.H{"error": browserBackendUnavailable})
		return
	}
	tree, err := bfSnapshot(key, *tab.SessionID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Snapshot failed"})
		return
	}
	c.Data(http.StatusOK, "text/plain; charset=utf-8", []byte(tree))
}

type shareTabRequest struct {
	AgentName string `json:"agent_name" binding:"required"`
}

// ShareBrowserTab handles POST /v1/browser/tabs/:tab_id/share.
func ShareBrowserTab(c *gin.Context) {
	tab, _, ok := browserTabForID(c)
	if !ok {
		return
	}
	var req shareTabRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	shared := decodeStringArray(tab.SharedWith)
	found := false
	for _, name := range shared {
		if name == req.AgentName {
			found = true
			break
		}
	}
	if !found {
		shared = append(shared, req.AgentName)
		sharedBytes, _ := json.Marshal(shared)
		tab.SharedWith = sharedBytes
		db.DB.Model(tab).Update("shared_with", sharedBytes)
	}
	c.JSON(http.StatusOK, tabToDict(tab, ""))
}

type persistTabRequest struct {
	Name string `json:"name" binding:"required"`
}

// PersistBrowserTab handles POST /v1/browser/tabs/:tab_id/persist.
func PersistBrowserTab(c *gin.Context) {
	tab, workspace, ok := browserTabForID(c)
	if !ok {
		return
	}
	var req persistTabRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if tab.ContextID != nil && *tab.ContextID != "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Tab is already persistent"})
		return
	}
	var existing models.BrowserContext
	if db.DB.Where("workspace_id = ? AND name = ? AND status = ?", workspace.ID, req.Name, "active").
		First(&existing).Error == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "A persistent context named '" + req.Name + "' already exists"})
		return
	}

	var domain *string
	if parsed, err := url.Parse(tab.URL); err == nil && parsed.Hostname() != "" {
		host := parsed.Hostname()
		domain = &host
	}

	var bbContextID *string
	if key := resolveBFKey(workspace); key != "" {
		if _, connected := ensureBrowserConnected(tab, workspace); connected && tab.SessionID != nil {
			if id, err := bfSaveContext(key, *tab.SessionID); err == nil && id != "" {
				bbContextID = &id
			}
			// Swap to a context-bound session so future opens restore state.
			currentURL := tab.URL
			bfCloseSession(key, *tab.SessionID)
			bbID := ""
			if bbContextID != nil {
				bbID = *bbContextID
			}
			if sessionID, shareURL, err := bfCreateSession(key, bbID); err == nil {
				tab.SessionID = &sessionID
				if shareURL != "" {
					tab.LiveURL = &shareURL
				}
				if currentURL != "about:blank" && currentURL != "" {
					bfNavigate(key, sessionID, currentURL)
				}
				if u, t, err := bfGetPageInfo(key, sessionID); err == nil {
					if u != "" {
						tab.URL = u
					}
					if t != "" {
						tab.Title = &t
					}
				}
			}
		}
	}

	context := models.BrowserContext{
		ID:          uuid.NewString(),
		WorkspaceID: workspace.ID,
		Name:        req.Name,
		BbContextID: bbContextID,
		Domain:      domain,
		Status:      "active",
		CreatedBy:   tab.CreatedBy,
		SharedWith:  tab.SharedWith,
		CreatedAt:   time.Now(),
		LastUsedAt:  time.Now(),
	}
	if err := db.DB.Create(&context).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create persistent context"})
		return
	}
	tab.ContextID = &context.ID
	touchTab(tab)
	db.DB.Save(tab)

	_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.browser.context.created", tab.CreatedBy, "", gin.H{
		"context_id": context.ID, "name": req.Name, "tab_id": tab.ID, "domain": domain,
	})
	c.JSON(http.StatusOK, gin.H{"tab": tabToDict(tab, context.Name), "context": contextToDict(&context)})
}

// UnpersistBrowserTab handles POST /v1/browser/tabs/:tab_id/unpersist.
func UnpersistBrowserTab(c *gin.Context) {
	tab, workspace, ok := browserTabForID(c)
	if !ok {
		return
	}
	if tab.ContextID == nil || *tab.ContextID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Tab is not persistent"})
		return
	}
	var ctx models.BrowserContext
	var ctxName *string
	if db.DB.Where("id = ?", *tab.ContextID).First(&ctx).Error == nil {
		if ctx.BbContextID != nil {
			bfDeleteContext(resolveBFKey(workspace), *ctx.BbContextID)
		}
		db.DB.Model(&ctx).Update("status", "deleted")
		ctxName = &ctx.Name
	}
	tab.ContextID = nil
	touchTab(tab)
	db.DB.Save(tab)
	_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.browser.context.deleted", "system", "", gin.H{
		"tab_id": tab.ID, "context_name": ctxName,
	})
	c.JSON(http.StatusOK, tabToDict(tab, ""))
}

// ListBrowserContexts handles GET /v1/browser/contexts.
func ListBrowserContexts(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	status := c.DefaultQuery("status", "active")
	var contexts []models.BrowserContext
	db.DB.Where("workspace_id = ? AND status = ?", workspace.ID, status).
		Order("last_used_at desc").Find(&contexts)
	items := make([]gin.H, 0, len(contexts))
	for i := range contexts {
		items = append(items, contextToDict(&contexts[i]))
	}
	c.JSON(http.StatusOK, gin.H{"contexts": items, "total": len(contexts)})
}

// DeleteBrowserContext handles DELETE /v1/browser/contexts/:context_id.
func DeleteBrowserContext(c *gin.Context) {
	var ctx models.BrowserContext
	if err := db.DB.Where("id = ?", c.Param("context_id")).First(&ctx).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Context not found"})
		return
	}
	workspace, err := resolveWorkspace(ctx.WorkspaceID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}
	if !authorizeWorkspace(c, workspace) {
		return
	}
	if ctx.BbContextID != nil {
		bfDeleteContext(resolveBFKey(workspace), *ctx.BbContextID)
	}
	db.DB.Model(&models.BrowserTab{}).Where("context_id = ?", ctx.ID).Update("context_id", nil)
	db.DB.Model(&ctx).Update("status", "deleted")
	_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.browser.context.deleted", "system", "", gin.H{
		"context_id": ctx.ID, "name": ctx.Name,
	})
	c.JSON(http.StatusOK, gin.H{"id": ctx.ID, "status": "deleted"})
}

// CloseBrowserTab handles DELETE /v1/browser/tabs/:tab_id.
func CloseBrowserTab(c *gin.Context) {
	tab, workspace, ok := browserTabForID(c)
	if !ok {
		return
	}
	db.DB.Model(tab).Update("status", "closed")

	// Finalize the open usage record.
	var usage models.BrowserUsage
	if db.DB.Where("tab_id = ? AND ended_at IS NULL", tab.ID).First(&usage).Error == nil {
		now := time.Now()
		duration := int(now.Sub(usage.StartedAt).Seconds())
		db.DB.Model(&usage).Updates(map[string]interface{}{"ended_at": now, "duration_seconds": duration})
	}

	isPersistent := tab.ContextID != nil && *tab.ContextID != ""
	if tab.SessionID != nil {
		bfCloseSession(resolveBFKey(workspace), *tab.SessionID)
	}

	payload := gin.H{"tab_id": tab.ID}
	if isPersistent {
		payload["context_id"] = *tab.ContextID
		payload["persistent"] = true
	}
	_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.browser.tab.closed", "system", "", payload)
	c.JSON(http.StatusOK, gin.H{"id": tab.ID, "status": "closed", "context_preserved": isPersistent})
}

// BrowserUsage handles GET /v1/browser/usage.
func BrowserUsage(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	days, err := strconv.Atoi(c.DefaultQuery("days", "30"))
	if err != nil || days < 1 {
		days = 30
	}
	cutoff := time.Now().AddDate(0, 0, -days)

	type usageRow struct {
		OpenedBy     string
		Sessions     int64
		TotalSeconds int64
	}
	var rows []usageRow
	db.DB.Model(&models.BrowserUsage{}).
		Select("opened_by, COUNT(id) as sessions, COALESCE(SUM(duration_seconds), 0) as total_seconds").
		Where("workspace_id = ? AND started_at >= ?", workspace.ID, cutoff).
		Group("opened_by").Order("total_seconds desc").Scan(&rows)

	var activeCount int64
	db.DB.Model(&models.BrowserUsage{}).
		Where("workspace_id = ? AND ended_at IS NULL", workspace.ID).Count(&activeCount)

	breakdown := make([]gin.H, 0, len(rows))
	totalSeconds := int64(0)
	for _, row := range rows {
		totalSeconds += row.TotalSeconds
		breakdown = append(breakdown, gin.H{
			"opened_by": row.OpenedBy, "sessions": row.Sessions,
			"total_seconds": row.TotalSeconds,
			"total_minutes": round1(float64(row.TotalSeconds) / 60),
			"total_hours":   round2(float64(row.TotalSeconds) / 3600),
		})
	}

	totalHours := round2(float64(totalSeconds) / 3600)
	freeHours := 100.0
	billableHours := math.Max(0, totalHours-freeHours)
	c.JSON(http.StatusOK, gin.H{
		"period_days":          days,
		"active_sessions":      activeCount,
		"total_seconds":        totalSeconds,
		"total_minutes":        round1(float64(totalSeconds) / 60),
		"total_hours":          totalHours,
		"free_hours_remaining": round2(math.Max(0, freeHours-totalHours)),
		"billable_hours":       billableHours,
		"estimated_cost_usd":   round2(billableHours * 0.12),
		"breakdown":            breakdown,
	})
}

func round1(v float64) float64 { return math.Round(v*10) / 10 }
func round2(v float64) float64 { return math.Round(v*100) / 100 }
