package handlers

// Knowledge base endpoints — shared markdown documents for the workspace.
//
//	POST   /v1/knowledge                  Create a knowledge entry
//	GET    /v1/knowledge                  List knowledge entries
//	GET    /v1/knowledge/:entry_id        Read entry with content
//	GET    /v1/knowledge/by-slug/:slug    Read entry by slug
//	PUT    /v1/knowledge/:entry_id        Update entry
//	DELETE /v1/knowledge/:entry_id        Soft-delete entry
//
// Entry content is stored on the shared file store (the same backend used by
// /v1/files); only metadata and a storage key live in the database. This mirrors
// the original Python implementation so existing clients see an identical
// contract.

import (
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

// knowledgeMaxContentSize caps a single entry's markdown body at 1 MB, matching
// the original limit.
const knowledgeMaxContentSize = 1 * 1024 * 1024

var (
	knowledgeSlugStrip     = regexp.MustCompile(`[^\w\s-]`)
	knowledgeSlugSeparator = regexp.MustCompile(`[\s_]+`)
)

type createKnowledgeRequest struct {
	Network     string  `json:"network" binding:"required"`
	Title       string  `json:"title" binding:"required"`
	Content     string  `json:"content"`
	Description *string `json:"description"`
	Category    *string `json:"category"`
	Source      string  `json:"source"`
}

type updateKnowledgeRequest struct {
	Network     string  `json:"network" binding:"required"`
	Title       *string `json:"title"`
	Content     *string `json:"content"`
	Description *string `json:"description"`
	Category    *string `json:"category"`
	Source      string  `json:"source"`
}

func knowledgeSlugify(title string) string {
	slug := knowledgeSlugStrip.ReplaceAllString(strings.ToLower(title), "")
	slug = knowledgeSlugSeparator.ReplaceAllString(slug, "-")
	slug = strings.Trim(slug, "-")
	if len(slug) > 80 {
		slug = slug[:80]
	}
	if slug == "" {
		return "untitled"
	}
	return slug
}

// knowledgeUniqueSlug returns a slug unique among active entries in the
// workspace, appending -2, -3, … on collision.
func knowledgeUniqueSlug(workspaceID, baseSlug, excludeID string) string {
	slug := baseSlug
	suffix := 1
	for {
		query := db.DB.Model(&models.KnowledgeEntry{}).
			Where("workspace_id = ? AND slug = ? AND status = ?", workspaceID, slug, "active")
		if excludeID != "" {
			query = query.Where("id != ?", excludeID)
		}
		var count int64
		query.Count(&count)
		if count == 0 {
			return slug
		}
		suffix++
		slug = baseSlug + "-" + strconv.Itoa(suffix)
	}
}

// knowledgeCategories is the closed set the UI can filter by. An unrecognised
// value is stored as NULL rather than kept, because a category no tab matches
// would hide the entry from every filter except "All" with nothing to explain it.
var knowledgeCategories = map[string]bool{
	"rules": true, "architecture": true, "api": true, "docs": true,
}

func normalizeKnowledgeCategory(in *string) *string {
	if in == nil {
		return nil
	}
	v := strings.ToLower(strings.TrimSpace(*in))
	if v == "" || !knowledgeCategories[v] {
		return nil
	}
	return &v
}

func serializeKnowledge(entry *models.KnowledgeEntry) gin.H {
	return gin.H{
		"id":           entry.ID,
		"slug":         entry.Slug,
		"title":        entry.Title,
		"description":  entry.Description,
		"category":     entry.Category,
		"content_size": entry.ContentSize,
		"storage_key":  entry.StorageKey,
		"created_by":   entry.CreatedBy,
		"updated_by":   entry.UpdatedBy,
		"status":       entry.Status,
		"created_at":   entry.CreatedAt,
		"updated_at":   entry.UpdatedAt,
	}
}

// readKnowledgeContent loads an entry's markdown body from the file store. A
// missing physical file degrades to empty content rather than an error, so a
// half-migrated store never breaks reads.
func readKnowledgeContent(storageKey *string) string {
	if storageKey == nil || *storageKey == "" {
		return ""
	}
	fullPath := filepath.Join(config.GlobalConfig.FileStoragePath, *storageKey)
	data, err := os.ReadFile(fullPath)
	if err != nil {
		return ""
	}
	return string(data)
}

// CreateKnowledge handles POST /v1/knowledge.
func CreateKnowledge(c *gin.Context) {
	var req createKnowledgeRequest
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

	contentBytes := []byte(req.Content)
	if len(contentBytes) > knowledgeMaxContentSize {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Content too large (max 1024KB)"})
		return
	}

	source := req.Source
	if source == "" {
		source = "human:user"
	}

	baseSlug := knowledgeSlugify(req.Title)
	slug := knowledgeUniqueSlug(workspace.ID, baseSlug, "")
	entryID := uuid.NewString()

	storageKey, err := saveFileLocal(workspace.ID, entryID, slug+".md", contentBytes)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to store knowledge content"})
		return
	}
	contentSize := len(contentBytes)
	now := time.Now()
	entry := models.KnowledgeEntry{
		ID:          entryID,
		WorkspaceID: workspace.ID,
		Slug:        slug,
		Title:       req.Title,
		Description: req.Description,
		Category:    normalizeKnowledgeCategory(req.Category),
		StorageKey:  &storageKey,
		ContentSize: &contentSize,
		CreatedBy:   source,
		Status:      "active",
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := db.DB.Create(&entry).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create knowledge entry"})
		return
	}

	_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.knowledge.created", source, "", gin.H{
		"entry_id": entryID, "slug": slug, "title": req.Title,
	})

	result := serializeKnowledge(&entry)
	result["content"] = req.Content
	c.JSON(http.StatusOK, result)
}

// ListKnowledge handles GET /v1/knowledge.
func ListKnowledge(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	status := c.DefaultQuery("status", "active")
	limit, err := strconv.Atoi(c.DefaultQuery("limit", "100"))
	if err != nil || limit < 1 || limit > 500 {
		limit = 100
	}
	offset, err := strconv.Atoi(c.DefaultQuery("offset", "0"))
	if err != nil || offset < 0 {
		offset = 0
	}
	category := c.Query("category")
	q := strings.TrimSpace(c.Query("q"))
	if q == "" {
		q = strings.TrimSpace(c.Query("query"))
	}

	query := db.DB.Where("workspace_id = ?", workspace.ID)
	if status != "" {
		query = query.Where("status = ?", status)
	}
	if category != "" && category != "all" {
		normalizedCat := normalizeKnowledgeCategory(&category)
		if normalizedCat != nil {
			query = query.Where("category = ?", *normalizedCat)
		}
	}
	if q != "" {
		qWildcard := "%" + q + "%"
		query = query.Where("title LIKE ? OR slug LIKE ? OR description LIKE ?", qWildcard, qWildcard, qWildcard)
	}

	var entries []models.KnowledgeEntry
	if err := query.Order("updated_at desc").Limit(limit).Offset(offset).Find(&entries).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to list knowledge entries"})
		return
	}

	statusForCount := status
	if statusForCount == "" {
		statusForCount = "active"
	}
	countQuery := db.DB.Model(&models.KnowledgeEntry{}).
		Where("workspace_id = ? AND status = ?", workspace.ID, statusForCount)
	if category != "" && category != "all" {
		normalizedCat := normalizeKnowledgeCategory(&category)
		if normalizedCat != nil {
			countQuery = countQuery.Where("category = ?", *normalizedCat)
		}
	}
	if q != "" {
		qWildcard := "%" + q + "%"
		countQuery = countQuery.Where("title LIKE ? OR slug LIKE ? OR description LIKE ?", qWildcard, qWildcard, qWildcard)
	}
	var total int64
	countQuery.Count(&total)

	items := make([]gin.H, 0, len(entries))
	for i := range entries {
		items = append(items, serializeKnowledge(&entries[i]))
	}
	c.JSON(http.StatusOK, gin.H{"entries": items, "total": total})
}

// GetKnowledge handles GET /v1/knowledge/:entry_id.
func GetKnowledge(c *gin.Context) {
	var entry models.KnowledgeEntry
	if err := db.DB.Where("id = ?", c.Param("entry_id")).First(&entry).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Knowledge entry not found"})
		return
	}
	workspace, err := resolveWorkspace(entry.WorkspaceID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Workspace not found"})
		return
	}
	if !authorizeWorkspace(c, workspace) {
		return
	}
	result := serializeKnowledge(&entry)
	result["content"] = readKnowledgeContent(entry.StorageKey)
	c.JSON(http.StatusOK, result)
}

// GetKnowledgeBySlug handles GET /v1/knowledge/by-slug/:slug.
func GetKnowledgeBySlug(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	var entry models.KnowledgeEntry
	if err := db.DB.Where("workspace_id = ? AND slug = ? AND status = ?", workspace.ID, c.Param("slug"), "active").
		First(&entry).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Knowledge entry not found"})
		return
	}
	result := serializeKnowledge(&entry)
	result["content"] = readKnowledgeContent(entry.StorageKey)
	c.JSON(http.StatusOK, result)
}

// UpdateKnowledge handles PUT /v1/knowledge/:entry_id.
func UpdateKnowledge(c *gin.Context) {
	var req updateKnowledgeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	var entry models.KnowledgeEntry
	if err := db.DB.Where("id = ? AND status = ?", c.Param("entry_id"), "active").First(&entry).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Knowledge entry not found"})
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

	source := req.Source
	if source == "" {
		source = "human:user"
	}

	if req.Title != nil && *req.Title != entry.Title {
		entry.Slug = knowledgeUniqueSlug(workspace.ID, knowledgeSlugify(*req.Title), entry.ID)
		entry.Title = *req.Title
	}
	if req.Description != nil {
		entry.Description = req.Description
	}
	if req.Category != nil {
		// An empty string clears the choice and hands classification back to the
		// client's heuristic; that is different from omitting the field, which
		// leaves whatever was there alone.
		entry.Category = normalizeKnowledgeCategory(req.Category)
	}
	if req.Content != nil {
		contentBytes := []byte(*req.Content)
		if len(contentBytes) > knowledgeMaxContentSize {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Content too large (max 1024KB)"})
			return
		}
		if entry.StorageKey != nil && *entry.StorageKey != "" {
			_ = os.Remove(filepath.Join(config.GlobalConfig.FileStoragePath, *entry.StorageKey))
		}
		storageKey, err := saveFileLocal(workspace.ID, entry.ID, entry.Slug+".md", contentBytes)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to store knowledge content"})
			return
		}
		contentSize := len(contentBytes)
		entry.StorageKey = &storageKey
		entry.ContentSize = &contentSize
	}
	entry.UpdatedBy = &source
	entry.UpdatedAt = time.Now()

	if err := db.DB.Save(&entry).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update knowledge entry"})
		return
	}

	_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.knowledge.updated", source, "", gin.H{
		"entry_id": entry.ID, "slug": entry.Slug, "title": entry.Title,
	})

	result := serializeKnowledge(&entry)
	if req.Content != nil {
		result["content"] = *req.Content
	}
	c.JSON(http.StatusOK, result)
}

// DeleteKnowledge handles DELETE /v1/knowledge/:entry_id (soft delete).
func DeleteKnowledge(c *gin.Context) {
	var entry models.KnowledgeEntry
	if err := db.DB.Where("id = ? AND status = ?", c.Param("entry_id"), "active").First(&entry).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Knowledge entry not found"})
		return
	}
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	if !authorizeResourceOwner(c, workspace, entry.CreatedBy) {
		return
	}
	if err := db.DB.Model(&entry).Updates(map[string]interface{}{
		"status": "deleted", "updated_at": time.Now(),
	}).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete knowledge entry"})
		return
	}
	_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.knowledge.deleted", "human:user", "", gin.H{
		"entry_id": entry.ID, "slug": entry.Slug,
	})
	c.JSON(http.StatusOK, gin.H{"id": entry.ID, "status": "deleted"})
}
