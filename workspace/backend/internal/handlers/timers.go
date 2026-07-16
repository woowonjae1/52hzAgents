// Package handlers 实现了核心业务逻辑处理器，包括工作区、通道及文件管理。
package handlers

// 导入必要的库文件处理时间和网络响应。
import (
	"net/http" // 包含标准的 HTTP 常量和响应写入方法。
	"time"     // 用于计算 Timer 到期触发时刻。

	"github.com/gin-gonic/gin"                                           // Gin 框架路由控制。
	"github.com/google/uuid"                                             // 生成实体 UUID 主键。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"     // 数据库操作。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models" // 表结构模型声明。
)

// CreateTimerRequest 代表创建定时消息提醒的请求体结构。
type CreateTimerRequest struct {
	Network      string  `json:"network" binding:"required"`       // 工作区 ID 或 Slug (必填)
	Source       string  `json:"source" binding:"required"`        // 创建者标识 (必填)
	Channel      string  `json:"channel" binding:"required"`       // 提醒发布到的会话通道名 (必填)
	ThreadID     *string `json:"thread_id"`                        // 可选的具体线程 ID
	Message      string  `json:"message" binding:"required"`       // 触发时发布的内容 (必填)
	DelaySeconds int     `json:"delay_seconds" binding:"required"` // 延迟触发时间（秒） (必填)
}

// CreateTimer 处理 POST /v1/timers 接口，新建定时提醒任务。
func CreateTimer(c *gin.Context) {
	var req CreateTimerRequest // 声明接收载荷。
	// 绑定并验证。
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// 检索解析对应的工作区。
	workspace, err := resolveWorkspace(req.Network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}

	// 校验工作区权限。
	if !authorizeWorkspace(c, workspace) {
		return
	}

	// 限制最低延迟秒数不小于 1 秒。
	if req.DelaySeconds < 1 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "delay_seconds must be at least 1"})
		return
	}

	// 计算具体的到期触发时刻（当前时间加上设定的延迟秒数）。
	firesAt := time.Now().Add(time.Duration(req.DelaySeconds) * time.Second)
	timerID := uuid.New().String() // 生成定时器主键。

	// 组装 TimerRecord 记录实体。
	record := models.TimerRecord{
		ID:           timerID,
		WorkspaceID:  workspace.ID,
		ChannelName:  req.Channel,
		ThreadID:     req.ThreadID,
		CreatedBy:    req.Source,
		Message:      req.Message,
		DelaySeconds: req.DelaySeconds,
		FiresAt:      firesAt,
		Status:       "active", // 设定初始状态为活跃。
		CreatedAt:    time.Now(),
	}

	// 写入数据库。
	if err := db.DB.Create(&record).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to schedule timer"})
		return
	}
	if err := PublishWorkspaceStateEvent(workspace.ID, "workspace.timer.created", req.Source, req.Channel, gin.H{"timer": record}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to publish timer update"})
		return
	}

	// 返回成功。
	c.JSON(http.StatusOK, record)
}

// ListTimers 处理 GET /v1/timers 接口，列出当前活跃的所有定时提醒。
func ListTimers(c *gin.Context) {
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

	// 验证工作区权限。
	if !authorizeWorkspace(c, workspace) {
		return
	}

	// 设定初始查询过滤器，获取属于当前工作区且仍为活跃状态的计时器。
	query := db.DB.Where("workspace_id = ? AND status = ?", workspace.ID, "active")

	// 可选的通道过滤器。
	channel := c.Query("channel")
	if channel != "" {
		query = query.Where("channel_name = ?", channel)
	}

	// 可选的创建人过滤。
	source := c.Query("source")
	if source != "" {
		query = query.Where("created_by = ?", source)
	}

	var timers []models.TimerRecord // 声明集合。
	query.Find(&timers)             // 执行检索。

	// 返回列表。
	c.JSON(http.StatusOK, gin.H{"timers": timers})
}

// DeleteTimer 处理 DELETE /v1/timers/:timer_id 接口，取消指定的定时提醒。
func DeleteTimer(c *gin.Context) {
	timerID := c.Param("timer_id") // 获取路由标识。

	// 锁定匹配的定时提醒对象。
	var record models.TimerRecord
	if err := db.DB.Where("id = ?", timerID).First(&record).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Timer record not found"})
		return
	}

	// 如果定时器已经是取消或触发完毕，直接返回。
	workspace, err := resolveWorkspace(record.WorkspaceID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Workspace not found"})
		return
	}
	if !authorizeWorkspace(c, workspace) {
		return
	}
	if record.Status == "cancelled" {
		c.JSON(http.StatusOK, gin.H{"success": true})
		return
	}

	// 标记修改其状态为已取消 (cancelled)。
	if err := db.DB.Model(&record).Update("status", "cancelled").Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to cancel timer"})
		return
	}
	record.Status = "cancelled"
	if err := PublishWorkspaceStateEvent(workspace.ID, "workspace.timer.cancelled", record.CreatedBy, record.ChannelName, gin.H{"timer": record}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to publish timer update"})
		return
	}

	// 返回成功。
	c.JSON(http.StatusOK, gin.H{"success": true})
}
