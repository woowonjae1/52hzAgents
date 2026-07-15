// Package handlers 实现了核心业务逻辑处理器，包括工作区、通道及文件管理。
package handlers

// 导入必要的系统和第三方包进行 JSON 解码、数据存储及时间计算。
import (
	"encoding/json" // 用于序列化结构体数据。
	"fmt"           // 用于格式化通道名称。
	"net/http"      // 包含标准的 HTTP 常量和响应写入方法。
	"time"          // 用于计算 Routine 的触发时间。

	"github.com/gin-gonic/gin"                           // Gin 框架路由控制。
	"github.com/google/uuid"                            // 生成 UUID。
	"github.com/woowonjae1/52hzAgents/workspace/backend_go/internal/db"     // 数据库操作。
	"github.com/woowonjae1/52hzAgents/workspace/backend_go/internal/models" // 表结构模型声明。
)

// CreateRoutineRequest 代表创建循环定时任务的请求数据载荷。
type CreateRoutineRequest struct {
	Network         string  `json:"network" binding:"required"`          // 工作区 ID 或 Slug (必填)
	Source          string  `json:"source" binding:"required"`           // 来源 Agent (必填)
	Name            string  `json:"name" binding:"required"`             // 周期任务别名 (必填)
	Message         string  `json:"message" binding:"required"`          // 触发时向通道发布的消息文本 (必填)
	Context         string  `json:"context"`                             // 定时任务执行的背景上下文
	Hour            *int    `json:"hour"`                                // 时 (0-23)
	Minute          *int    `json:"minute"`                              // 分 (0-59)
	Days            []int   `json:"days"`                                // 周期生效星期天数组 (0=周一, 6=周日)
	IntervalMinutes *int    `json:"interval_minutes"`                    // 间隔分钟数（与每日定时互斥）
	ThreadID        *string `json:"thread_id"`                           // 可选的指定会话线程 ID
}

// ComputeNextFiresAt 接收当前参数并计算下一次周期触发的具体时刻。
func ComputeNextFiresAt(hour, minute *int, days []int, intervalMinutes *int) time.Time {
	now := time.Now().UTC() // 获取当前的 UTC 时刻进行统一计算。

	// 如果设置了间隔分钟模式，下一次触发时间为当前时间加上间隔分钟。
	if intervalMinutes != nil && *intervalMinutes > 0 {
		return now.Add(time.Duration(*intervalMinutes) * time.Minute)
	}

	// 否则为每日定时模式。
	h := 0
	if hour != nil {
		h = *hour
	}
	m := 0
	if minute != nil {
		m = *minute
	}

	// 构造候选的触发时间候选点。
	candidate := time.Date(now.Year(), now.Month(), now.Day(), h, m, 0, 0, time.UTC)

	// 如果未指定生效星期，默认每天运行：
	if len(days) == 0 {
		// 若计算出的今天候选时间已过，下一次触发为明天。
		if candidate.Before(now) || candidate.Equal(now) {
			return candidate.AddDate(0, 0, 1)
		}
		return candidate
	}

	// 如果指定了星期周期：
	// 往后寻找接下来 7 天内符合星期条件的第一个候选点。
	for offset := 0; offset < 8; offset++ {
		testDate := candidate.AddDate(0, 0, offset)
		// 计算测试候选点的星期。Go 的 Weekday() 中 0=周日，1=周一，... 6=周六。
		// 需要转换为我们模型所用的规范：0=周一，... 6=周日。
		wd := int(testDate.Weekday()) - 1
		if wd < 0 {
			wd = 6 // 周日映射。
		}

		// 检查该星期是否在生效星期数组中。
		match := false
		for _, d := range days {
			if d == wd {
				match = true
				break
			}
		}

		// 如果匹配，且该候选时间在当前时间之后，则为最终计算所得时间。
		if match {
			if offset == 0 && (testDate.Before(now) || testDate.Equal(now)) {
				continue // 今天候选时间已过，继续往后一天。
			}
			return testDate
		}
	}

	return candidate.AddDate(0, 0, 1) // 兜底返回明天。
}

// getOrCreateRoutineChannel 获取或创建 Agent 专属的定时任务消息信道。
func getOrCreateRoutineChannel(workspaceID, agentName string) (string, error) {
	channelName := fmt.Sprintf("routines:%s", agentName) // 通道命名前缀。
	var ch models.Channel
	// 试图查询通道是否存在。
	err := db.DB.Where("workspace_id = ? AND name = ?", workspaceID, channelName).First(&ch).Error
	if err == nil {
		return ch.Name, nil // 若存在直接返回。
	}

	// 否则新建通道。
	chID := uuid.New().String()
	now := time.Now()
	newCh := models.Channel{
		ID:                chID,
		WorkspaceID:       workspaceID,
		Name:              channelName,
		Title:             &agentName,
		MasterAgent:       &agentName,
		CreatedBy:         &agentName,
		OrchestrationMode: "dynamic",
		Status:            "active",
		CreatedAt:         now,
	}

	if err := db.DB.Create(&newCh).Error; err != nil {
		return "", err
	}

	// 自动加入通道成员关系。
	chMember := models.ChannelMember{
		ChannelID: chID,
		AgentName: agentName,
	}
	db.DB.Create(&chMember)

	return channelName, nil
}

// CreateRoutine 处理 POST /v1/routines 接口，创建新周期重复提醒任务。
func CreateRoutine(c *gin.Context) {
	var req CreateRoutineRequest // 声明接收载荷。
	// 解析 JSON。
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// 检索解析工作区。
	workspace, err := resolveWorkspace(req.Network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}

	// 校验工作区权限。
	token := c.GetHeader("X-Workspace-Token")
	if !verifyWorkspaceAccess(workspace, token) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid credentials"})
		return
	}

	// 校验互斥的触发时间配置。
	isInterval := req.IntervalMinutes != nil
	isDaily := req.Hour != nil || req.Minute != nil
	if isInterval && isDaily {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Specify either interval_minutes OR hour/minute, not both"})
		return
	}
	if !isInterval && !isDaily {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Specify either interval_minutes OR hour/minute"})
		return
	}

	// 验证时间合理性。
	if isInterval && *req.IntervalMinutes < 1 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "interval_minutes must be at least 1"})
		return
	}
	if isDaily {
		if req.Hour == nil || req.Minute == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "hour and minute are both required in daily mode"})
			return
		}
		if *req.Hour < 0 || *req.Hour > 23 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "hour must be 0-23"})
			return
		}
		if *req.Minute < 0 || *req.Minute > 59 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "minute must be 0-59"})
			return
		}
	}

	// 解析出纯粹的 Agent 名称。
	targetAgent := getAgentNameFromSource(req.Source)

	// 验证该 Agent 确实为该工作区成员。
	var count int64
	db.DB.Model(&models.WorkspaceMember{}).Where("workspace_id = ? AND agent_name = ?", workspace.ID, targetAgent).Count(&count)
	if count == 0 {
		c.JSON(http.StatusForbidden, gin.H{"error": fmt.Sprintf("source '%s' is not a member of this workspace", req.Source)})
		return
	}

	// 创建或定位该 Agent 专属的定时任务通道。
	chName, err := getOrCreateRoutineChannel(workspace.ID, targetAgent)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create routine channel"})
		return
	}

	// 计算首次运行的具体触发时间点。
	nextFire := ComputeNextFiresAt(req.Hour, req.Minute, req.Days, req.IntervalMinutes)
	routineID := uuid.New().String() // 生成周期任务主键。

	// 序列化生效星期数组准备存入。
	daysBytes, _ := json.Marshal(req.Days)

	// 组装 RoutineRecord 对象。
	record := models.RoutineRecord{
		ID:                       routineID,
		WorkspaceID:              workspace.ID,
		ChannelName:              chName,
		ThreadID:                 req.ThreadID,
		CreatedBy:                targetAgent,
		Name:                     req.Name,
		Message:                  req.Message,
		Context:                  &req.Context,
		ScheduleHour:             req.Hour,
		ScheduleMinute:           req.Minute,
		ScheduleDays:             daysBytes,
		ScheduleIntervalMinutes: req.IntervalMinutes,
		NextFiresAt:              nextFire,
		Status:                   "active", // 设置为活跃。
		CreatedAt:                time.Now(),
	}

	// 持久化记录。
	if err := db.DB.Create(&record).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create routine"})
		return
	}

	// 返回成功。
	c.JSON(http.StatusOK, record)
}

// ListRoutines 处理 GET /v1/routines 接口，查询指定工作区下的周期定时任务。
func ListRoutines(c *gin.Context) {
	network := c.Query("network") // 获取必需的工作区标识。
	if network == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "network parameter is required"})
		return
	}

	// 检索解析工作区。
	workspace, err := resolveWorkspace(network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}

	// 校验工作区权限。
	token := c.GetHeader("X-Workspace-Token")
	if !verifyWorkspaceAccess(workspace, token) {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid credentials"})
		return
	}

	// 筛选条件。
	query := db.DB.Where("workspace_id = ? AND status = ?", workspace.ID, "active")

	// 按创建 Agent 过滤。
	source := c.Query("source")
	if source != "" {
		query = query.Where("created_by = ?", getAgentNameFromSource(source))
	}

	var routines []models.RoutineRecord // 声明列表容器。
	query.Find(&routines)               // 执行检索。

	// 返回列表。
	c.JSON(http.StatusOK, gin.H{"routines": routines})
}

// DeleteRoutine 处理 DELETE /v1/routines/:routine_id 接口，取消特定的周期定时任务。
func DeleteRoutine(c *gin.Context) {
	routineID := c.Param("routine_id") // 获取路由标识参数。

	// 锁定记录。
	var record models.RoutineRecord
	if err := db.DB.Where("id = ?", routineID).First(&record).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Routine record not found"})
		return
	}

	// 将状态更新为已取消 (cancelled)。
	if err := db.DB.Model(&record).Update("status", "cancelled").Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to cancel routine"})
		return
	}

	// 返回成功。
	c.JSON(http.StatusOK, gin.H{"success": true})
}
