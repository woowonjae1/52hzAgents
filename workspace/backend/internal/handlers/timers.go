// Package handlers 实现了核心业务逻辑处理器，包括工作区、通道及文件管理。
package handlers

// 导入必要的库文件处理时间和网络响应。
import (
	"fmt"      // 格式化看板任务标题。
	"log"      // 记录联动失败。
	"net/http" // 包含标准的 HTTP 常量和响应写入方法。
	"strings"  // 字符串处理。
	"time"     // 用于计算 Timer 到期触发时刻。

	"github.com/gin-gonic/gin"                                           // Gin 框架路由控制。
	"github.com/google/uuid"                                             // 生成实体 UUID 主键。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"     // 数据库操作。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models" // 表结构模型声明。
)

// CreateTimerRequest 代表创建定时消息提醒的请求体结构。
type CreateTimerRequest struct {
	Network  string  `json:"network" binding:"required"` // 工作区 ID 或 Slug (必填)
	Source   string  `json:"source" binding:"required"`  // 创建者标识 (必填)
	Channel  string  `json:"channel" binding:"required"` // 提醒发布到的会话通道名 (必填)
	ThreadID *string `json:"thread_id"`                  // 可选的具体线程 ID
	Message  string  `json:"message" binding:"required"` // 触发时发布的内容 (必填)

	// DelaySeconds 是相对延迟（秒）。这里不能标 binding:"required"：
	// 它和 FiresAt 二选一，而 required 作用在 int 上会把合法的 0 值也判成缺失。
	DelaySeconds int `json:"delay_seconds"`
	// Delay 是 delay_seconds 的别名。
	//
	// 发给 agent 的工作区提示词里，创建 timer 的 curl 示例写的是 {"delay":300}，
	// 而服务端只认 delay_seconds 且当时标了 required —— 照抄示例的 agent 拿到的
	// 一律是 400。示例已经改对了，但外面还有按旧提示词跑着的 agent，所以这个
	// 别名要留着兜底。
	Delay *int `json:"delay"`
	// FiresAt 是绝对触发时刻。
	//
	// 「今天 15:16 提醒我开会」这类请求此前没有任何工具能表达：timer 只收相对
	// 秒数，而 routine 的每日模式是天天重复、不是就这一次。于是 agent 只能用
	// 文字假装设了提醒。给定一个时刻比让模型自己做时间减法更可靠。
	FiresAt *time.Time `json:"fires_at"`
}

// timerTaskContent 生成看板上那条任务的标题。
//
// 带上触发时刻，因为看板上的一行本身不说明它什么时候会动；不带时间的
// 「提醒用户开会」和一条普通待办长得一模一样。
func timerTaskContent(message string, firesAt time.Time) string {
	text := strings.TrimSpace(message)
	if text == "" {
		text = "Scheduled reminder"
	}
	// 展示用本地时间：firesAt 存的是 UTC，直接格式化会把「16:23 提醒」写成
	// 「08:23 提醒」。桌面端的服务端和用户在同一台机器上，Local 就是用户的钟。
	return fmt.Sprintf("⏰ [%s] %s", firesAt.Local().Format("15:04"), text)
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

	// 归一化两种表达方式：绝对时刻优先，其次相对秒数（含 delay 别名）。
	//
	// 全程用 UTC。fires_at 此前存的是带 +08:00 偏移的本地时间，而调度器的到期
	// 扫描用 time.Now().UTC() 去比 —— 在 SQLite 里这是字符串比较，
	// "16:20:05+08:00" 永远大不过 "08:21:23"，于是**没有任何 timer 触发过**。
	// 周期任务不受影响，因为 ComputeNextFiresAt 返回的就是 UTC；这也是为什么
	// routine 会响而 timer 不会。
	now := time.Now().UTC()
	delaySeconds := req.DelaySeconds
	if delaySeconds == 0 && req.Delay != nil {
		delaySeconds = *req.Delay
	}

	var firesAt time.Time
	switch {
	case req.FiresAt != nil:
		firesAt = req.FiresAt.UTC()
		if !firesAt.After(now) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "fires_at must be in the future"})
			return
		}
		// 同时给出两者时，以绝对时刻为准，并回填出等效的延迟秒数，
		// 这样列表和 UI 上显示的延迟和实际触发时刻不会互相矛盾。
		delaySeconds = int(firesAt.Sub(now).Round(time.Second).Seconds())
		if delaySeconds < 1 {
			delaySeconds = 1
		}
	case delaySeconds >= 1:
		firesAt = now.Add(time.Duration(delaySeconds) * time.Second)
	default:
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "provide either fires_at (an absolute RFC3339 time) or delay_seconds (at least 1)",
		})
		return
	}
	req.DelaySeconds = delaySeconds

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
		CreatedAt:    now,
	}

	// 写入数据库。
	if err := db.DB.Create(&record).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to schedule timer"})
		return
	}

	// 联动开一条待办，让这次定时在 Tasks 看板上看得见。
	//
	// 周期任务每次触发都会建一条跟踪任务，一次性 timer 却什么都不建 —— 于是
	// 「16:11 提醒我开会」在 Tasks & Issues 的三个页面里都查不到，用户只能在
	// 会话底部那条状态栏里瞥见它。
	todo := models.TodoRecord{
		ID:          uuid.New().String(),
		WorkspaceID: workspace.ID,
		ChannelName: req.Channel,
		ThreadID:    req.ThreadID,
		CreatedBy:   "system:timer",
		Assignee:    AgentNameFromSource(req.Source),
		Content:     timerTaskContent(req.Message, firesAt),
		Status:      "pending",
		Priority:    "high",
		TimerID:     &record.ID,
		DueDate:     &firesAt,
		Position:    0,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := db.DB.Create(&todo).Error; err != nil {
		// 待办只是可见性，建不出来不该让定时本身失败。
		log.Printf("timer %s scheduled but its task could not be opened: %v", record.ID, err)
	} else {
		_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.todos.updated", req.Source, req.Channel, gin.H{
			"todos":     []models.TodoRecord{todo},
			"thread_id": req.ThreadID,
		})
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
	if !authorizeResourceOwner(c, workspace, record.CreatedBy) {
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

	// 看板上那条任务跟着一起取消。不然取消了提醒，任务还留在「待办」里等一个
	// 永远不会到来的触发。
	cancelledAt := time.Now().UTC()
	if err := db.DB.Model(&models.TodoRecord{}).
		Where("timer_id = ? AND status IN ?", record.ID, []string{"pending", "in_progress"}).
		Updates(map[string]interface{}{
			"status":       "cancelled",
			"completed_at": &cancelledAt,
			"updated_at":   cancelledAt,
		}).Error; err != nil {
		log.Printf("timer %s cancelled but its task could not be closed: %v", record.ID, err)
	}
	_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.todos.updated", record.CreatedBy, record.ChannelName, gin.H{
		"timer_id": record.ID,
		"status":   "cancelled",
	})
	if err := PublishWorkspaceStateEvent(workspace.ID, "workspace.timer.cancelled", record.CreatedBy, record.ChannelName, gin.H{"timer": record}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to publish timer update"})
		return
	}

	// 返回成功。
	c.JSON(http.StatusOK, gin.H{"success": true})
}
