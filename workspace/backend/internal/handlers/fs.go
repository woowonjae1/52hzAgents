package handlers

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models"
)

// Default ignored directories and filenames to avoid noise and perf issues.
var defaultIgnoredNames = map[string]bool{
	".git":         true,
	"node_modules": true,
	".next":        true,
	"dist":         true,
	"build":        true,
	"out":          true,
	".cache":       true,
	"__pycache__":  true,
	".venv":        true,
	"venv":         true,
	".idea":        true,
	".vscode":      true,
	".turbo":       true,
	"coverage":     true,
	".DS_Store":    true,
	"Thumbs.db":    true,
}

// FSEntry represents a file or directory item in the project file explorer tree.
type FSEntry struct {
	Name    string `json:"name"`
	Path    string `json:"path"` // Relative to workingDir (using forward slashes)
	IsDir   bool   `json:"is_dir"`
	Size    int64  `json:"size"`
	ModTime string `json:"mod_time"`
}

// FSTreeResponse is the response payload for GET /v1/fs/tree.
type FSTreeResponse struct {
	Root    string    `json:"root"`
	Path    string    `json:"path"`
	Entries []FSEntry `json:"entries"`
}

// FSContentResponse is the response payload for GET /v1/fs/content.
type FSContentResponse struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	ModTime  string `json:"mod_time"`
	IsBinary bool   `json:"is_binary"`
	Content  string `json:"content"`
	MimeType string `json:"mime_type"`
}

// resolveWorkingDirForFS securely determines the active project working directory.
func resolveWorkingDirForFS(c *gin.Context) (string, bool) {
	// 1. Channel / Session query parameter (most secure: bound in database)
	if channelRef := strings.TrimSpace(c.Query("channel")); channelRef != "" {
		var channel models.Channel
		query := db.DB.Where("id = ? OR name = ?", channelRef, channelRef)
		if network := strings.TrimSpace(c.Query("network")); network != "" {
			query = query.Where("workspace_id = ?", network)
		}
		if err := query.First(&channel).Error; err == nil && channel.WorkingDir != nil {
			dir := strings.TrimSpace(*channel.WorkingDir)
			if dir != "" {
				if stat, err := os.Stat(dir); err == nil && stat.IsDir() {
					return dir, true
				}
			}
		}
	}

	// 2. Direct dir query param (validated on filesystem)
	if dirParam := strings.TrimSpace(c.Query("dir")); dirParam != "" {
		if stat, err := os.Stat(dirParam); err == nil && stat.IsDir() {
			return dirParam, true
		}
	}

	c.JSON(http.StatusBadRequest, gin.H{"error": "No valid working directory found for this session"})
	return "", false
}

// safeResolvePath validates and resolves a subpath inside baseDir, preventing directory traversal.
func safeResolvePath(baseDir, userPath string) (string, error) {
	cleanPath := filepath.Clean(filepath.ToSlash(userPath))
	if cleanPath == "." || cleanPath == "" {
		cleanPath = ""
	} else if cleanPath == ".." || strings.HasPrefix(cleanPath, "../") {
		return "", errors.New("invalid path traversal")
	}

	target := filepath.Join(baseDir, cleanPath)
	absBase, err1 := filepath.Abs(baseDir)
	absTarget, err2 := filepath.Abs(target)
	if err1 != nil || err2 != nil {
		return "", errors.New("cannot resolve absolute path")
	}

	rel, err := filepath.Rel(absBase, absTarget)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", errors.New("access outside working directory denied")
	}

	return absTarget, nil
}

// scanDirectory recursively or flatly scans a directory up to maxDepth and maxEntries.
func scanDirectory(baseDir, currentRel string, currentDepth, maxDepth, maxEntries int, entries *[]FSEntry) {
	if len(*entries) >= maxEntries || currentDepth > maxDepth {
		return
	}

	fullPath := filepath.Join(baseDir, currentRel)
	dirEntries, err := os.ReadDir(fullPath)
	if err != nil {
		return
	}

	// Sort: folders first, then files alphabetically
	sort.Slice(dirEntries, func(i, j int) bool {
		if dirEntries[i].IsDir() != dirEntries[j].IsDir() {
			return dirEntries[i].IsDir()
		}
		return strings.ToLower(dirEntries[i].Name()) < strings.ToLower(dirEntries[j].Name())
	})

	for _, d := range dirEntries {
		if len(*entries) >= maxEntries {
			break
		}

		name := d.Name()
		if defaultIgnoredNames[name] {
			continue
		}

		relChild := filepath.ToSlash(filepath.Join(currentRel, name))
		info, err := d.Info()
		if err != nil {
			continue
		}

		isDir := d.IsDir()
		entry := FSEntry{
			Name:    name,
			Path:    relChild,
			IsDir:   isDir,
			Size:    info.Size(),
			ModTime: info.ModTime().Format(time.RFC3339),
		}
		*entries = append(*entries, entry)

		if isDir && currentDepth < maxDepth {
			scanDirectory(baseDir, relChild, currentDepth+1, maxDepth, maxEntries, entries)
		}
	}
}

// GetFSTree handles GET /v1/fs/tree.
func GetFSTree(c *gin.Context) {
	baseDir, ok := resolveWorkingDirForFS(c)
	if !ok {
		return
	}

	subpath := strings.TrimSpace(c.Query("subpath"))
	targetPath, err := safeResolvePath(baseDir, subpath)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	stat, err := os.Stat(targetPath)
	if err != nil {
		if os.IsNotExist(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "Directory not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if !stat.IsDir() {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Path is not a directory"})
		return
	}

	depth := 3 // default depth to recursively fetch top 3 levels
	if depthStr := c.Query("depth"); depthStr != "" {
		if d, err := strconv.Atoi(depthStr); err == nil && d >= 1 && d <= 5 {
			depth = d
		}
	}

	maxEntries := 1000
	if limitStr := c.Query("limit"); limitStr != "" {
		if l, err := strconv.Atoi(limitStr); err == nil && l > 0 && l <= 5000 {
			maxEntries = l
		}
	}

	entries := make([]FSEntry, 0, 100)
	scanDirectory(baseDir, filepath.ToSlash(subpath), 1, depth, maxEntries, &entries)

	c.JSON(http.StatusOK, FSTreeResponse{
		Root:    filepath.ToSlash(baseDir),
		Path:    filepath.ToSlash(subpath),
		Entries: entries,
	})
}

const maxReadBytes = 10 << 20 // 10 MB limit for file content

// isBinaryContent inspects byte slice for NULL bytes or non-printable controls.
func isBinaryContent(data []byte) bool {
	checkLen := len(data)
	if checkLen > 512 {
		checkLen = 512
	}
	for i := 0; i < checkLen; i++ {
		if data[i] == 0 {
			return true
		}
	}
	return false
}

// GetFSFileContent handles GET /v1/fs/content.
func GetFSFileContent(c *gin.Context) {
	baseDir, ok := resolveWorkingDirForFS(c)
	if !ok {
		return
	}

	userPath := strings.TrimSpace(c.Query("path"))
	if userPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Missing required path query parameter"})
		return
	}

	targetPath, err := safeResolvePath(baseDir, userPath)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	stat, err := os.Stat(targetPath)
	if err != nil {
		if os.IsNotExist(err) {
			c.JSON(http.StatusNotFound, gin.H{"error": "File not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	if stat.IsDir() {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Path is a directory, not a file"})
		return
	}

	if stat.Size() > maxReadBytes {
		c.JSON(http.StatusRequestEntityTooLarge, gin.H{
			"error": fmt.Sprintf("File size (%d bytes) exceeds maximum preview limit of 10MB", stat.Size()),
		})
		return
	}

	data, err := os.ReadFile(targetPath)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	mimeType := http.DetectContentType(data)
	isBinary := isBinaryContent(data)

	var contentStr string
	if isBinary {
		contentStr = base64.StdEncoding.EncodeToString(data)
	} else {
		contentStr = string(data)
	}

	c.JSON(http.StatusOK, FSContentResponse{
		Path:     filepath.ToSlash(userPath),
		Name:     filepath.Base(targetPath),
		Size:     stat.Size(),
		ModTime:  stat.ModTime().Format(time.RFC3339),
		IsBinary: isBinary,
		Content:  contentStr,
		MimeType: mimeType,
	})
}
