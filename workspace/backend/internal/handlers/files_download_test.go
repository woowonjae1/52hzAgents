package handlers

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/glebarez/sqlite"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
	"gorm.io/gorm"
)

func setupFileDownloadTest(t *testing.T) (*gin.Engine, models.Workspace, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)

	database, err := gorm.Open(sqlite.Open(fmt.Sprintf("file:%s?mode=memory&cache=shared", uuid.NewString())), &gorm.Config{})
	if err != nil {
		t.Fatalf("open in-memory db: %v", err)
	}
	if err := database.AutoMigrate(&models.Workspace{}, &models.FileRecord{}); err != nil {
		t.Fatalf("auto-migrate db: %v", err)
	}
	db.DB = database

	token := "file-test-token"
	hash := hashWorkspaceToken(token)
	ws := models.Workspace{
		ID:           uuid.NewString(),
		Slug:         uuid.NewString(),
		Name:         "File Test WS",
		PasswordHash: &hash,
		Status:       "active",
	}
	if err := db.DB.Create(&ws).Error; err != nil {
		t.Fatalf("create workspace: %v", err)
	}

	tempDir := t.TempDir()
	config.GlobalConfig = &config.Config{
		FileStoragePath: tempDir,
	}

	router := gin.New()
	router.GET("/v1/files/:file_id", DownloadFile)
	return router, ws, token
}

func TestFileDownloadAndPreviewHeaders(t *testing.T) {
	router, ws, token := setupFileDownloadTest(t)

	// Create dummy files on disk
	htmlStorageKey := "test_page.html"
	htmlFullPath := filepath.Join(config.GlobalConfig.FileStoragePath, htmlStorageKey)
	if err := os.WriteFile(htmlFullPath, []byte("<html><body>Hello</body></html>"), 0644); err != nil {
		t.Fatal(err)
	}

	htmlRecord := models.FileRecord{
		ID:          uuid.NewString(),
		WorkspaceID: ws.ID,
		Filename:    "index.html",
		StorageKey:  htmlStorageKey,
		ContentType: "text/html",
		Size:        30,
	}
	db.DB.Create(&htmlRecord)

	pdfStorageKey := "test_doc.pdf"
	pdfFullPath := filepath.Join(config.GlobalConfig.FileStoragePath, pdfStorageKey)
	if err := os.WriteFile(pdfFullPath, []byte("%PDF-1.4 dummy pdf"), 0644); err != nil {
		t.Fatal(err)
	}

	pdfRecord := models.FileRecord{
		ID:          uuid.NewString(),
		WorkspaceID: ws.ID,
		Filename:    "document.pdf",
		StorageKey:  pdfStorageKey,
		ContentType: "application/pdf",
		Size:        20,
	}
	db.DB.Create(&pdfRecord)

	// 1. Explicit download parameter -> attachment header
	req := httptest.NewRequest(http.MethodGet, fmt.Sprintf("/v1/files/%s?download=true&network=%s&token=%s", htmlRecord.ID, ws.ID, token), nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	disp := w.Header().Get("Content-Disposition")
	if !strings.HasPrefix(disp, "attachment") {
		t.Fatalf("expected attachment disposition for download=true, got: %s", disp)
	}
	if nosniff := w.Header().Get("X-Content-Type-Options"); nosniff != "nosniff" {
		t.Fatalf("expected nosniff header, got: %s", nosniff)
	}

	// 2. Inline preview for HTML -> inline disposition and sandbox CSP
	req = httptest.NewRequest(http.MethodGet, fmt.Sprintf("/v1/files/%s?inline=true&network=%s&token=%s", htmlRecord.ID, ws.ID, token), nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	disp = w.Header().Get("Content-Disposition")
	if !strings.HasPrefix(disp, "inline") {
		t.Fatalf("expected inline disposition for inline=true, got: %s", disp)
	}
	csp := w.Header().Get("Content-Security-Policy")
	if csp != "sandbox" {
		t.Fatalf("expected CSP sandbox for inline HTML, got: %s", csp)
	}

	// 3. Inline preview for PDF -> inline disposition, no sandbox CSP
	req = httptest.NewRequest(http.MethodGet, fmt.Sprintf("/v1/files/%s?inline=true&network=%s&token=%s", pdfRecord.ID, ws.ID, token), nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	disp = w.Header().Get("Content-Disposition")
	if !strings.HasPrefix(disp, "inline") {
		t.Fatalf("expected inline disposition for inline PDF, got: %s", disp)
	}
	if csp := w.Header().Get("Content-Security-Policy"); csp != "" {
		t.Fatalf("expected no CSP sandbox for PDF, got: %s", csp)
	}

	// 4. Default without parameters for HTML -> attachment (protection against direct execution)
	req = httptest.NewRequest(http.MethodGet, fmt.Sprintf("/v1/files/%s?network=%s&token=%s", htmlRecord.ID, ws.ID, token), nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	disp = w.Header().Get("Content-Disposition")
	if !strings.HasPrefix(disp, "attachment") {
		t.Fatalf("expected default attachment disposition for HTML without params, got: %s", disp)
	}

	// 5. Default without parameters for safe media (PDF) -> inline
	req = httptest.NewRequest(http.MethodGet, fmt.Sprintf("/v1/files/%s?network=%s&token=%s", pdfRecord.ID, ws.ID, token), nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	disp = w.Header().Get("Content-Disposition")
	if !strings.HasPrefix(disp, "inline") {
		t.Fatalf("expected default inline disposition for PDF without params, got: %s", disp)
	}
}
