// Package handlers 实现了核心业务逻辑处理器，包括工作区、通道及文件管理。
package handlers

// 导入所有依赖包，包含文件编码、路径计算及系统 IO 操作。
import (
	"encoding/base64" // 用于解密 Agent 提交的 Base64 格式文件内容。
	"encoding/json"   // 用于序列化上传事件消息负载。
	"errors"          // 用于构建路径校验错误。
	"fmt"             // 用于格式化拼接文件存储路径。
	"io"              // 用于流式读取上传的表单数据。
	"net/http"        // 包含标准的 HTTP 常量和响应写入方法。
	"os"              // 提供底层操作系统的文件读写及目录创建支持。
	"path/filepath"   // 跨平台进行文件路径的安全拼接。
	"strconv"         // 用于转换分页 limit 和 offset 字符串为整数。
	"strings"         // 用于判断文件扩展名。
	"time"            // 用于时间戳的获取（新增）。

	"github.com/gin-gonic/gin"                           // Gin Web 框架路由控制。
	"github.com/google/uuid"                            // 用于为新上传文件生成唯一的 UUID。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config" // 全局配置模块。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"     // 本地 GORM 数据库连接包。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/hub"    // 内存消息分发总线。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models" // 数据结构体模型。
)

// Base64UploadRequest 代表通过 Base64 数据提交文件的 JSON 请求载荷（供 Agent 客户端调用）。
type Base64UploadRequest struct {
	Filename      string  `json:"filename" binding:"required"`       // 文件名 (必选)
	ContentBase64 string  `json:"content_base64" binding:"required"` // Base64 编码的字节数据 (必选)
	ContentType   string  `json:"content_type"`                      // MIME 类型
	Network       string  `json:"network" binding:"required"`        // 工作区 ID 或 Slug (必选)
	Source        string  `json:"source"`                            // 上传源（如 openagents:agentname ）
	ChannelName   *string `json:"channel_name"`                      // 所属通道上下文
}

// saveFileLocal 将文件物理保存至本地磁盘中。
func saveFileLocal(workspaceID, fileID, filename string, data []byte) (string, error) {
	cleanFilename := filepath.Base(filepath.ToSlash(filename))
	if cleanFilename == "." || cleanFilename == "/" || cleanFilename == "\\" || cleanFilename == "" {
		cleanFilename = "unnamed_file"
	}
	storageKey := fmt.Sprintf("%s/%s/%s", workspaceID, fileID, cleanFilename)
	basePath := config.GlobalConfig.FileStoragePath
	fullPath := filepath.Join(basePath, workspaceID, fileID, cleanFilename)

	absBasePath, err1 := filepath.Abs(basePath)
	absFullPath, err2 := filepath.Abs(fullPath)
	if err1 == nil && err2 == nil {
		rel, err := filepath.Rel(absBasePath, absFullPath)
		if err != nil || strings.HasPrefix(rel, "..") || rel == ".." {
			return "", errors.New("invalid file path traversal")
		}
	}

	dir := filepath.Dir(fullPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return "", err
	}

	if err := os.WriteFile(fullPath, data, 0644); err != nil {
		return "", err
	}

	return storageKey, nil
}

// UploadFileMultipart 处理 POST /v1/files 接口，支持标准的 multipart/form-data 格式上传。
func UploadFileMultipart(c *gin.Context) {
	// 接收表单中的 file 字段。
	fileHeader, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Missing file form parameter"})
		return
	}

	// 接收表单中的 network 字段。
	network := c.PostForm("network")
	if network == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Missing network form parameter"})
		return
	}

	// 检索解析对应的工作区。
	workspace, err := resolveWorkspace(network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}

	// 验证工作区权限。
	token := c.GetHeader("X-Workspace-Token")
	if !verifyWorkspaceAccess(workspace, token) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid workspace credentials"})
		return
	}

	// 打开上传文件的多部数据流。
	fileStream, err := fileHeader.Open()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to open file stream"})
		return
	}
	defer fileStream.Close() // 方法结束时释放资源。

	// 将多部数据流全部读取为内存中的字节数组。
	fileData, err := io.ReadAll(fileStream)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to read file data"})
		return
	}

	// 限制文件上传的最大大小为 50MB (52428800 Bytes)。
	if len(fileData) > 52428800 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "File size exceeds maximum limit of 50MB"})
		return
	}

	// 生成物理存储所用 UUID。
	fileID := uuid.New().String()
	// 获取可选字段上传源，默认为 human:user。
	source := c.PostForm("source")
	if source == "" {
		source = "human:user"
	}
	// 获取可选的通道归属。
	channelName := c.PostForm("channel_name")

	// 物理保存文件。
	storageKey, err := saveFileLocal(workspace.ID, fileID, fileHeader.Filename, fileData)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to write file to local disk"})
		return
	}

	// 构建 FileRecord 数据记录。
	var chNamePtr *string
	if channelName != "" {
		chNamePtr = &channelName
	}
	contentType := fileHeader.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	record := models.FileRecord{
		ID:          fileID,
		WorkspaceID: workspace.ID,
		Filename:    fileHeader.Filename,
		ContentType: contentType,
		Size:        len(fileData),
		StorageKey:  storageKey,
		UploadedBy:  source,
		ChannelName: chNamePtr,
		Status:      "active",
		CreatedAt:   time.Now(),
	}

	// 存入数据库中。
	if err := db.DB.Create(&record).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save file meta to database"})
		return
	}

	// 构建上传成功通知事件。
	payloadData := map[string]interface{}{
		"file_id":      fileID,
		"filename":     fileHeader.Filename,
		"content_type": contentType,
		"size":         len(fileData),
	}
	payloadBytes, _ := json.Marshal(payloadData)

	eventID := uuid.New().String()
	nowUnixMs := time.Now().UnixNano() / int64(time.Millisecond)

	// 持久化上传文件事件。
	eventRec := models.EventRecord{
		ID:        eventID,
		NetworkID: workspace.ID,
		Type:      "workspace.file.uploaded",
		Source:    source,
		Target:    "core",
		Payload:   payloadBytes,
		Timestamp: nowUnixMs,
	}
	db.DB.Create(&eventRec)

	// 广播事件。
	fullEventBytes, _ := json.Marshal(gin.H{
		"id":        eventID,
		"network":   workspace.ID,
		"type":      "workspace.file.uploaded",
		"source":    source,
		"target":    "core",
		"payload":   payloadData,
		"timestamp": nowUnixMs,
	})

	hub.GlobalHub.Broadcast(hub.BroadcastMsg{
		WorkspaceID: workspace.ID,
		ChannelName: "core",
		Payload:     string(fullEventBytes),
	})

	// 返回成功 JSON。
	c.JSON(http.StatusOK, record)
}

// UploadFileBase64 处理 POST /v1/files/base64 接口，支持通过 JSON Base64 格式上传。
func UploadFileBase64(c *gin.Context) {
	var req Base64UploadRequest // 声明接收载荷。
	// 校验 JSON。
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// 检索定位对应的工作区。
	workspace, err := resolveWorkspace(req.Network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}

	// 校验鉴权。
	token := c.GetHeader("X-Workspace-Token")
	if !verifyWorkspaceAccess(workspace, token) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid workspace credentials"})
		return
	}

	// 解码 Base64 数据为原始二进制字节数组。
	fileData, err := base64.StdEncoding.DecodeString(req.ContentBase64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid base64 payload"})
		return
	}

	// 限制大小。
	if len(fileData) > 52428800 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "File size exceeds limit of 50MB"})
		return
	}

	// 生成物理存储主键。
	fileID := uuid.New().String()
	source := req.Source
	if source == "" {
		source = "human:user"
	}

	// 物理写盘。
	storageKey, err := saveFileLocal(workspace.ID, fileID, req.Filename, fileData)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to write file to local disk"})
		return
	}

	contentType := req.ContentType
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	record := models.FileRecord{
		ID:          fileID,
		WorkspaceID: workspace.ID,
		Filename:    req.Filename,
		ContentType: contentType,
		Size:        len(fileData),
		StorageKey:  storageKey,
		UploadedBy:  source,
		ChannelName: req.ChannelName,
		Status:      "active",
		CreatedAt:   time.Now(),
	}

	// 写入元数据表中。
	if err := db.DB.Create(&record).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save file meta to database"})
		return
	}

	// 组装并广播事件。
	payloadData := map[string]interface{}{
		"file_id":      fileID,
		"filename":     req.Filename,
		"content_type": contentType,
		"size":         len(fileData),
	}
	payloadBytes, _ := json.Marshal(payloadData)

	eventID := uuid.New().String()
	nowUnixMs := time.Now().UnixNano() / int64(time.Millisecond)

	eventRec := models.EventRecord{
		ID:        eventID,
		NetworkID: workspace.ID,
		Type:      "workspace.file.uploaded",
		Source:    source,
		Target:    "core",
		Payload:   payloadBytes,
		Timestamp: nowUnixMs,
	}
	db.DB.Create(&eventRec)

	fullEventBytes, _ := json.Marshal(gin.H{
		"id":        eventID,
		"network":   workspace.ID,
		"type":      "workspace.file.uploaded",
		"source":    source,
		"target":    "core",
		"payload":   payloadData,
		"timestamp": nowUnixMs,
	})

	hub.GlobalHub.Broadcast(hub.BroadcastMsg{
		WorkspaceID: workspace.ID,
		ChannelName: "core",
		Payload:     string(fullEventBytes),
	})

	// 返回成功。
	c.JSON(http.StatusOK, record)
}

// ListFiles 处理 GET /v1/files 接口，获取指定工作区下活跃文件列表（分页）。
func ListFiles(c *gin.Context) {
	network := c.Query("network") // 获取必需的工作区标识。
	if network == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "network parameter is required"})
		return
	}

	// 检索工作区。
	workspace, err := resolveWorkspace(network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}

	// 校验工作区权限。
	token := c.GetHeader("X-Workspace-Token")
	if !verifyWorkspaceAccess(workspace, token) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid workspace credentials"})
		return
	}

	// 解析分页 limit 与 offset 参数。
	limitVal := 50
	limitStr := c.Query("limit")
	if limitStr != "" {
		if l, err := strconv.Atoi(limitStr); err == nil {
			limitVal = l
		}
	}

	offsetVal := 0
	offsetStr := c.Query("offset")
	if offsetStr != "" {
		if o, err := strconv.Atoi(offsetStr); err == nil {
			offsetVal = o
		}
	}

	// 仅在显式请求 sync=true 参数时进行本地磁盘同步，保持 GET 读接口为纯只读
	if c.Query("sync") == "true" {
		syncLocalDiskFiles(workspace.ID)
	}

	// 查询活跃中的文件列表。
	var files []models.FileRecord
	db.DB.Where("workspace_id = ? AND status = ?", workspace.ID, "active").
		Limit(limitVal).
		Offset(offsetVal).
		Order("created_at desc").
		Find(&files)

	// 返回结果列表。
	c.JSON(http.StatusOK, gin.H{
		"files":  files,
		"limit":  limitVal,
		"offset": offsetVal,
	})
}

// GetFileInfo 处理 GET /v1/files/:file_id/info 接口，返回文件的详情元数据。
func GetFileInfo(c *gin.Context) {
	fileID := c.Param("file_id")
	var record models.FileRecord
	if err := db.DB.Where("id = ?", fileID).First(&record).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "File record not found"})
		return
	}
	c.JSON(http.StatusOK, record)
}

// DownloadFile 处理 GET /v1/files/:file_id 接口，流式返回物理文件给客户端进行下载与预览。
func DownloadFile(c *gin.Context) {
	fileID := c.Param("file_id")
	var record models.FileRecord
	if err := db.DB.Where("id = ?", fileID).First(&record).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "File record not found"})
		return
	}

	// 如果文件已被删除，返回 410 Gone。
	if record.Status == "deleted" {
		c.JSON(http.StatusGone, gin.H{"error": "File has been deleted"})
		return
	}

	// 拼接绝对路径。
	basePath := config.GlobalConfig.FileStoragePath
	fullPath := filepath.Join(basePath, record.StorageKey)

	// 检查该物理文件在本地磁盘中是否存在。
	if _, err := os.Stat(fullPath); os.IsNotExist(err) {
		c.JSON(http.StatusNotFound, gin.H{"error": "Physical file not found on disk"})
		return
	}

	// 设置 Content-Type 响应头
	if record.ContentType != "" && record.ContentType != "application/octet-stream" {
		c.Header("Content-Type", record.ContentType)
	}
	http.ServeFile(c.Writer, c.Request, fullPath)
}

// DeleteFile 处理 DELETE /v1/files/:file_id 接口，逻辑删除文件元数据并清除物理文件。
func DeleteFile(c *gin.Context) {
	workspace, ok := requestWorkspace(c)
	if !ok {
		return
	}
	fileID := c.Param("file_id") // 获取路由入参。

	// 查询获取数据库记录 (带 workspace_id 隔离)
	var record models.FileRecord
	if err := db.DB.Where("id = ? AND workspace_id = ?", fileID, workspace.ID).First(&record).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "File record not found in this workspace"})
		return
	}

	if !authorizeResourceOwner(c, workspace, record.UploadedBy) {
		return
	}

	// 更新状态为已删除。
	if err := db.DB.Model(&record).Update("status", "deleted").Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update file status"})
		return
	}

	// 异步或同步删除本地的物理文件以释放空间。
	basePath := config.GlobalConfig.FileStoragePath
	fullPath := filepath.Join(basePath, record.StorageKey)
	_ = os.Remove(fullPath) // 删除物理文件，若删除失败（如已被手动清理）则静默跳过。

	// 返回成功。
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// diskSyncUploader marks rows created by the disk scan. It is deliberately
// distinct from any agent address: the retired chat-scraping importer also wrote
// "openagents:agent", which made its fabricated rows indistinguishable from
// files an agent genuinely wrote, leaving no safe way to clean one up.
const diskSyncUploader = "system:disk-sync"

// syncLocalDiskFiles 自动扫描工作区存储路径及 Agent 工作目录下的磁盘文件，将 Agent 生成的文件（如 青羊区到金牛区路线.md）自动注册到数据库
func syncLocalDiskFiles(workspaceID string) {
	basePath := config.GlobalConfig.FileStoragePath
	wsDir := filepath.Join(basePath, workspaceID)

	// Only sync this workspace's own storage directory. Never scan external
	// developer/repo paths — doing so pollutes the workspace file list with
	// unrelated repo files (READMEs, scripts, etc.) and is machine-specific.
	entries, err := os.ReadDir(wsDir)
	if err != nil {
		return
	}

	for _, entry := range entries {
		if entry.IsDir() {
			// One level down: files an agent wrote into a sub-folder.
			subDir := filepath.Join(wsDir, entry.Name())
			subEntries, err := os.ReadDir(subDir)
			if err != nil {
				continue
			}
			for _, sub := range subEntries {
				if sub.IsDir() {
					continue
				}
				info, err := sub.Info()
				if err != nil {
					continue
				}
				storageKey := fmt.Sprintf("%s/%s/%s", workspaceID, entry.Name(), sub.Name())
				var count int64
				db.DB.Model(&models.FileRecord{}).Where("storage_key = ?", storageKey).Count(&count)
				if count == 0 {
					db.DB.Create(&models.FileRecord{
						ID:          uuid.New().String(),
						WorkspaceID: workspaceID,
						Filename:    filepath.ToSlash(filepath.Join(entry.Name(), sub.Name())),
						ContentType: "application/octet-stream",
						Size:        int(info.Size()),
						StorageKey:  storageKey,
						UploadedBy:  diskSyncUploader,
						ChannelName: nil,
						Status:      "active",
						CreatedAt:   info.ModTime(),
					})
				}
			}
			continue
		}

		// Top-level file dropped into the workspace directory.
		name := entry.Name()
		info, err := entry.Info()
		if err != nil {
			continue
		}
		var count int64
		db.DB.Model(&models.FileRecord{}).Where("workspace_id = ? AND filename = ?", workspaceID, name).Count(&count)
		if count == 0 {
			lower := strings.ToLower(name)
			storageKey := fmt.Sprintf("%s/%s", workspaceID, name)
			cType := "application/octet-stream"
			if strings.HasSuffix(lower, ".md") || strings.HasSuffix(lower, ".txt") {
				cType = "text/markdown; charset=utf-8"
			}
			db.DB.Create(&models.FileRecord{
				ID:          uuid.New().String(),
				WorkspaceID: workspaceID,
				Filename:    name,
				ContentType: cType,
				Size:        int(info.Size()),
				StorageKey:  storageKey,
				UploadedBy:  "openagents:agent",
				ChannelName: nil,
				Status:      "active",
				CreatedAt:   info.ModTime(),
			})
		}
	}
}
