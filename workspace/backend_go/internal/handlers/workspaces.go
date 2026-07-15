// Package handlers 实现了核心业务逻辑处理器，包括工作区、通道及文件管理。
package handlers

// 导入必要的系统和第三方依赖包。
import (
	"crypto/sha256" // 用于加密计算工作区的密码哈希。
	"encoding/hex"  // 用于将 SHA256 哈希字节数组转换为十六进制字符串。
	"net/http"      // 包含标准的 HTTP 常量和响应写入方法。
	"time"          // 用于时间戳的捕获。

	"github.com/gin-gonic/gin"                           // Gin 路由框架上下文及路由控制。
	"github.com/google/uuid"                            // 用于生成主键及唯一 ID。
	"github.com/woowonjae1/52hzAgents/workspace/backend_go/internal/db"     // 数据库操作全局连接。
	"github.com/woowonjae1/52hzAgents/workspace/backend_go/internal/models" // 表结构结构体声明。
)

// CreateWorkspaceRequest 代表创建工作区的请求数据。
type CreateWorkspaceRequest struct {
	Name     string `json:"name" binding:"required"` // 工作区显示名称 (必填)
	Slug     string `json:"slug"`                    // 唯一简短访问标识 (选填)
	Password string `json:"password"`                // 访问密码 (选填，空表示公开工作区)
}

// CreateWorkspace 处理 POST /v1/workspaces 接口，创建新工作区并预置默认通道。
func CreateWorkspace(c *gin.Context) {
	var req CreateWorkspaceRequest // 声明接收数据的请求体对象。
	// 绑定并验证 JSON，验证失败直接返回 400 错误。
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// 准备保存的数据对象。
	wsID := uuid.New().String() // 生成工作区的唯一 UUID。
	slugVal := req.Slug         // 临时存储 Slug 变量。
	if slugVal == "" {
		slugVal = uuid.New().String() // 若 Slug 为空，随机生成 UUID 作为 Slug。
	}

	// 校验 Slug 的唯一性。
	var count int64
	db.DB.Model(&models.Workspace{}).Where("slug = ?", slugVal).Count(&count)
	if count > 0 {
		c.JSON(http.StatusConflict, gin.H{"error": "Slug already exists"})
		return
	}

	// 计算密码哈希。
	var pwdHash *string // 声明哈希指针。
	if req.Password != "" {
		hash := sha256.Sum256([]byte(req.Password))            // 执行 SHA256 加密。
		hashStr := hex.EncodeToString(hash[:])                 // 转换为 16 进制字符串。
		pwdHash = &hashStr                                     // 指针赋值。
	}

	// 构建 Workspace 数据库实体记录。
	now := time.Now()
	workspace := models.Workspace{
		ID:             wsID,
		Name:           req.Name,
		Slug:           slugVal,
		PasswordHash:   pwdHash,
		Status:         "active",
		CreatedAt:      now,
		LastActivityAt: now,
	}

	// 将工作区记录保存到数据库中。如果写入失败，返回 500 错误。
	if err := db.DB.Create(&workspace).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create workspace"})
		return
	}

	// 创建默认的 general 通道，以供 Agent 登入后能直接协作。
	chID := uuid.New().String() // 生成通道主键。
	defaultChannel := models.Channel{
		ID:                 chID,
		WorkspaceID:        wsID,
		Name:               "general",
		Title:              &req.Name,
		OrchestrationMode:  "dynamic",
		Status:             "active",
		CreatedAt:          now,
	}

	// 将默认通道持久化到数据库中。
	if err := db.DB.Create(&defaultChannel).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to initialize default channel"})
		return
	}

	// 返回 201 状态码，返回创建成功的详情数据。
	c.JSON(http.StatusCreated, gin.H{
		"id":         wsID,
		"name":       workspace.Name,
		"slug":       workspace.Slug,
		"status":     workspace.Status,
		"created_at": workspace.CreatedAt,
	})
}

// GetWorkspace 处理 GET /v1/workspaces/:workspace_id 接口，检索工作区并装载成员、通道数据。
func GetWorkspace(c *gin.Context) {
	wsID := c.Param("workspace_id") // 获取路由占位参数。

	// 根据 ID 查询工作区信息。
	var ws models.Workspace
	if err := db.DB.Where("id = ? OR slug = ?", wsID, wsID).First(&ws).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Workspace not found"})
		return
	}

	// 并发查询该工作区下的活跃通道列表。
	var channels []models.Channel
	db.DB.Where("workspace_id = ? AND status != ?", ws.ID, "deleted").Find(&channels)

	// 查询当前工作区注册的 Agent 成员列表。
	var members []models.WorkspaceMember
	db.DB.Where("workspace_id = ?", ws.ID).Find(&members)

	// 查询外部协作人列表。
	var collaborators []models.WorkspaceCollaborator
	db.DB.Where("workspace_id = ?", ws.ID).Find(&collaborators)

	// 组装最终结果渲染返回。
	c.JSON(http.StatusOK, gin.H{
		"id":             ws.ID,
		"name":           ws.Name,
		"slug":           ws.Slug,
		"status":         ws.Status,
		"created_at":     ws.CreatedAt,
		"channels":       channels,
		"members":        members,
		"collaborators":  collaborators,
	})
}

// DeleteWorkspace 处理 DELETE /v1/workspaces/:workspace_id 接口，将工作区状态标记为删除。
func DeleteWorkspace(c *gin.Context) {
	wsID := c.Param("workspace_id") // 获取路由标识。

	// 根据 ID 或 Slug 锁定工作区。
	var ws models.Workspace
	if err := db.DB.Where("id = ? OR slug = ?", wsID, wsID).First(&ws).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Workspace not found"})
		return
	}

	// 执行软删除，更新状态为 deleted。
	if err := db.DB.Model(&ws).Update("status", "deleted").Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to mark workspace as deleted"})
		return
	}

	// 渲染返回成功。
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// EditChannelRequest 定义更新会话通道的请求格式。
type EditChannelRequest struct {
	Title                    *string `json:"title"`                     // 新标题
	Status                   *string `json:"status"`                    // 状态: active | archived | deleted
	Starred                  *bool   `json:"starred"`                   // 是否星标
	OrchestrationMode        *string `json:"orchestration_mode"`        // 编排模式: dynamic | master | workflow
	OrchestrationInstruction *string `json:"orchestration_instruction"` // 编排指令内容
}

// PatchChannel 处理 PATCH /v1/workspaces/:workspace_id/channels/:channel_name 路由，更新通道配置。
func PatchChannel(c *gin.Context) {
	wsID := c.Param("workspace_id")    // 工作区标识。
	chName := c.Param("channel_name")  // 通道显示名（如 general 或是 session-xxx ）。

	// 锁定所属工作区，确认安全。
	workspace, err := resolveWorkspace(wsID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}

	// 锁定待修改的通道记录。
	var ch models.Channel
	if err := db.DB.Where("workspace_id = ? AND name = ?", workspace.ID, chName).First(&ch).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Channel not found"})
		return
	}

	// 绑定修改内容 JSON。
	var req EditChannelRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// 对有非空传值的字段进行合并覆盖更新。
	if req.Title != nil {
		ch.Title = req.Title
		ch.TitleManuallySet = true
	}
	if req.Status != nil {
		ch.Status = *req.Status
	}
	if req.Starred != nil {
		ch.Starred = *req.Starred
	}
	if req.OrchestrationMode != nil {
		ch.OrchestrationMode = *req.OrchestrationMode
	}
	if req.OrchestrationInstruction != nil {
		ch.OrchestrationInstruction = req.OrchestrationInstruction
	}

	// 保存数据库修改。
	if err := db.DB.Save(&ch).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update channel"})
		return
	}

	// 返回更新后的通道结构。
	c.JSON(http.StatusOK, ch)
}

// GetChannel 处理 GET /v1/workspaces/:workspace_id/channels/:channel_name 路由，获取单一通道详情。
func GetChannel(c *gin.Context) {
	wsID := c.Param("workspace_id")   // 获取工作区参数。
	chName := c.Param("channel_name") // 获取通道名称。

	// 寻找对应工作区。
	workspace, err := resolveWorkspace(wsID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}

	// 寻找具体通道。
	var ch models.Channel
	if err := db.DB.Where("workspace_id = ? AND name = ?", workspace.ID, chName).First(&ch).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Channel not found"})
		return
	}

	// 渲染输出通道结构详情。
	c.JSON(http.StatusOK, ch)
}
