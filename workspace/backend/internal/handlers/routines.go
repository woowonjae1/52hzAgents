// Package handlers 实现了核心业务逻辑处理器，包括工作区、通道及文件管理。
package handlers

// 导入必要的系统和第三方包进行 JSON 解码、数据存储及时间计算。
import (
	"encoding/json" // 用于序列化结构体数据。
	"fmt"           // 用于格式化通道名称。
	"log"           // 记录调度联动失败。
	"net/http"      // 包含标准的 HTTP 常量和响应写入方法。
	"strconv"       // 解析短号序号。
	"strings"       // 字符串操作
	"time"          // 用于计算 Routine 的触发时间。

	"github.com/gin-gonic/gin"                                           // Gin 框架路由控制。
	"github.com/google/uuid"                                             // 生成 UUID。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"     // 数据库操作。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/hub"    // 全局事件广播。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models" // 表结构模型声明。
	"gorm.io/gorm"                                                       // 原子自增表达式。
)

// CreateRoutineRequest 代表创建循环定时任务的请求数据载荷。
type CreateRoutineRequest struct {
	Network         string  `json:"network" binding:"required"` // 工作区 ID 或 Slug (必填)
	Source          string  `json:"source" binding:"required"`  // 来源 Agent (必填)
	Name            string  `json:"name" binding:"required"`    // 周期任务别名 (必填)
	Message         string  `json:"message" binding:"required"` // 触发时向通道发布的消息文本 (必填)
	Context         string  `json:"context"`                    // 定时任务执行的背景上下文
	Hour            *int    `json:"hour"`                       // 时 (0-23)
	Minute          *int    `json:"minute"`                     // 分 (0-59)
	Days            []int   `json:"days"`                       // 周期生效星期天数组 (0=周一, 6=周日)
	IntervalMinutes *int    `json:"interval_minutes"`           // 间隔分钟数（与每日定时互斥）
	Timezone        string  `json:"timezone"`                   // IANA 时区名（如 Asia/Shanghai），缺省 UTC
	ThreadID        *string `json:"thread_id"`                  // 可选的指定会话线程 ID
}

// UpdateRoutineRequest 代表编辑既有周期任务的请求数据载荷。
// 所有字段均为可选：只有显式提供的字段会被写入。
type UpdateRoutineRequest struct {
	Name            *string `json:"name"`
	Message         *string `json:"message"`
	Context         *string `json:"context"`
	Hour            *int    `json:"hour"`
	Minute          *int    `json:"minute"`
	Days            *[]int  `json:"days"`
	IntervalMinutes *int    `json:"interval_minutes"`
	Timezone        *string `json:"timezone"`
	// ScheduleMode 明确声明本次编辑要切换到哪种模式（daily | interval）。
	// 单靠上面的指针无法区分「不改」与「清空另一模式」，日程编辑必须能做后者。
	ScheduleMode *string `json:"schedule_mode"`
}

// resolveLocation 将存储的时区名解析为 *time.Location。
// 未知或空的时区退回 UTC，绝不返回 nil：调度器每 5 秒读一次这个值，
// 一条坏数据不能让整个循环 panic。
func resolveLocation(timezone string) *time.Location {
	tz := strings.TrimSpace(timezone)
	if tz == "" || strings.EqualFold(tz, "UTC") {
		return time.UTC
	}
	loc, err := time.LoadLocation(tz)
	if err != nil || loc == nil {
		return time.UTC
	}
	return loc
}

// ComputeNextFiresAt 接收当前参数并计算下一次周期触发的具体时刻（返回 UTC 时刻）。
//
// 每日模式下的时/分是「用户所在时区的墙上时间」，而不是 UTC：一条 "每天 09:00"
// 的日程在夏令时切换前后都应当落在当地早上九点。因此候选点在 timezone 里构造，
// 再转回 UTC 存库；星期判定同样按当地日期计算。
func ComputeNextFiresAt(hour, minute *int, days []int, intervalMinutes *int, timezone string) time.Time {
	loc := resolveLocation(timezone)
	now := time.Now().In(loc)

	// 如果设置了间隔分钟模式，下一次触发时间为当前时间加上间隔分钟。时区无关。
	if intervalMinutes != nil && *intervalMinutes > 0 {
		return now.Add(time.Duration(*intervalMinutes) * time.Minute).UTC()
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

	// 构造候选的触发时间候选点（当地墙上时间）。
	candidate := time.Date(now.Year(), now.Month(), now.Day(), h, m, 0, 0, loc)

	// 如果未指定生效星期，默认每天运行：
	if len(days) == 0 {
		// 若计算出的今天候选时间已过，下一次触发为明天。
		if !candidate.After(now) {
			return nextLocalDay(candidate, 1, h, m, loc).UTC()
		}
		return candidate.UTC()
	}

	// 如果指定了星期周期：
	// 往后寻找接下来 7 天内符合星期条件的第一个候选点。
	for offset := 0; offset < 8; offset++ {
		testDate := nextLocalDay(candidate, offset, h, m, loc)
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
			if !testDate.After(now) {
				continue // 今天候选时间已过，继续往后一天。
			}
			return testDate.UTC()
		}
	}

	return nextLocalDay(candidate, 1, h, m, loc).UTC() // 兜底返回明天。
}

// nextLocalDay 在 base 之后偏移 offset 个「日历天」，并把时/分重新钉回 h:m。
// AddDate 之后重建 time.Date 是必要的一步：跨夏令时边界时 AddDate 会保留
// 绝对偏移量，直接使用会让 09:00 的日程漂移到 08:00 或 10:00。
func nextLocalDay(base time.Time, offset, h, m int, loc *time.Location) time.Time {
	shifted := base.AddDate(0, 0, offset)
	return time.Date(shifted.Year(), shifted.Month(), shifted.Day(), h, m, 0, 0, loc)
}

// nextRoutineFire 从一条记录直接算出它的下一次触发时刻。
func nextRoutineFire(r *models.RoutineRecord) time.Time {
	var days []int
	if len(r.ScheduleDays) > 0 {
		_ = json.Unmarshal(r.ScheduleDays, &days)
	}
	return ComputeNextFiresAt(r.ScheduleHour, r.ScheduleMinute, days, r.ScheduleIntervalMinutes, r.Timezone)
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

// allocateRoutineShortID 返回工作区内下一个未被占用的 RTN-xxx 短号。
//
// 原实现用 COUNT(*)+1 命名，两条并发创建会拿到同一个短号，而短号是用户在
// UI 和运行记录里唯一称呼一条日程的方式。这里改为解析已有短号的最大序号，
// 并在真的撞号时继续往后找，代价是一次索引扫描。
func allocateRoutineShortID(workspaceID string) string {
	var existing []string
	db.DB.Model(&models.RoutineRecord{}).
		Where("workspace_id = ?", workspaceID).
		Pluck("short_id", &existing)

	taken := make(map[string]bool, len(existing))
	maxSeq := 0
	for _, id := range existing {
		taken[id] = true
		if !strings.HasPrefix(id, "RTN-") {
			continue
		}
		if seq, err := strconv.Atoi(strings.TrimPrefix(id, "RTN-")); err == nil && seq > maxSeq {
			maxSeq = seq
		}
	}

	for seq := maxSeq + 1; ; seq++ {
		candidate := fmt.Sprintf("RTN-%03d", seq)
		if !taken[candidate] {
			return candidate
		}
	}
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
	if !authorizeWorkspace(c, workspace) {
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
	if isInterval && (*req.IntervalMinutes < 1 || *req.IntervalMinutes > 44640) {
		c.JSON(http.StatusBadRequest, gin.H{"error": "interval_minutes must be between 1 and 44640"})
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
	for _, d := range req.Days {
		if d < 0 || d > 6 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "days must contain values 0-6 (0=Monday)"})
			return
		}
	}

	// 时区校验：一个打错的时区名会静默退回 UTC，把日程整体挪走几个小时，
	// 所以创建时就把它拒掉，而不是等用户发现任务在半夜跑。
	timezone := strings.TrimSpace(req.Timezone)
	if timezone == "" {
		timezone = "UTC"
	} else if _, err := time.LoadLocation(timezone); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("unknown timezone %q", timezone)})
		return
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
	nextFire := ComputeNextFiresAt(req.Hour, req.Minute, req.Days, req.IntervalMinutes, timezone)
	routineID := uuid.New().String() // 生成周期任务主键。

	// 计算全局短号编号 (如 RTN-001)。
	shortID := allocateRoutineShortID(workspace.ID)

	// 序列化生效星期数组准备存入。
	daysBytes, _ := json.Marshal(req.Days)

	// 组装 RoutineRecord 对象。
	record := models.RoutineRecord{
		ID:                      routineID,
		ShortID:                 shortID,
		WorkspaceID:             workspace.ID,
		ChannelName:             chName,
		ThreadID:                req.ThreadID,
		CreatedBy:               targetAgent,
		Name:                    req.Name,
		Message:                 req.Message,
		Context:                 &req.Context,
		ScheduleHour:            req.Hour,
		ScheduleMinute:          req.Minute,
		ScheduleDays:            daysBytes,
		ScheduleIntervalMinutes: req.IntervalMinutes,
		Timezone:                timezone,
		NextFiresAt:             nextFire,
		RunCount:                0,
		LastRunStatus:           "scheduled",
		Status:                  "active", // 设置为活跃。
		CreatedAt:               time.Now(),
	}

	// 持久化记录。
	if err := db.DB.Create(&record).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create routine"})
		return
	}
	if err := PublishWorkspaceStateEvent(workspace.ID, "workspace.routine.created", req.Source, chName, gin.H{"routine": record}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to publish routine update"})
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
	if !authorizeWorkspace(c, workspace) {
		return
	}

	// 筛选条件：包含 active 和 paused 状态
	query := db.DB.Where("workspace_id = ? AND status != ?", workspace.ID, "cancelled")

	// 按创建 Agent 过滤。
	source := c.Query("source")
	if source != "" {
		query = query.Where("created_by = ?", getAgentNameFromSource(source))
	}

	var routines []models.RoutineRecord            // 声明列表容器。
	query.Order("created_at DESC").Find(&routines) // 执行检索。

	// 返回列表。
	c.JSON(http.StatusOK, gin.H{"routines": routines})
}

// ToggleRoutine 处理 PATCH /v1/routines/:routine_id/toggle 切换活跃/暂停状态
func ToggleRoutine(c *gin.Context) {
	routineID := c.Param("routine_id")

	var record models.RoutineRecord
	if err := db.DB.Where("id = ?", routineID).First(&record).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Routine record not found"})
		return
	}

	workspace, err := resolveWorkspace(record.WorkspaceID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Workspace not found"})
		return
	}
	if !authorizeResourceOwner(c, workspace, record.CreatedBy) {
		return
	}

	nextStatus := "paused"
	if record.Status == "paused" {
		nextStatus = "active"
		// 重新计算下次触发时间
		record.NextFiresAt = nextRoutineFire(&record)
	}
	record.Status = nextStatus

	if err := db.DB.Model(&models.RoutineRecord{}).Where("id = ?", record.ID).Updates(map[string]interface{}{
		"status":        record.Status,
		"next_fires_at": record.NextFiresAt,
	}).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update routine status"})
		return
	}

	_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.routine.updated", record.CreatedBy, record.ChannelName, gin.H{"routine": record})
	c.JSON(http.StatusOK, record)
}

// UpdateRoutine 处理 PATCH /v1/routines/:routine_id，就地编辑一条日程。
//
// 在此之前改一条日程的唯一办法是删掉重建，那会丢掉它的短号、运行计数和
// 全部历史运行记录 —— 对一条"每天九点的巡检"来说，这些正是它的价值所在。
func UpdateRoutine(c *gin.Context) {
	routineID := c.Param("routine_id")

	var record models.RoutineRecord
	if err := db.DB.Where("id = ?", routineID).First(&record).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Routine record not found"})
		return
	}

	workspace, err := resolveWorkspace(record.WorkspaceID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Workspace not found"})
		return
	}
	if !authorizeResourceOwner(c, workspace, record.CreatedBy) {
		return
	}

	var req UpdateRoutineRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	updates := map[string]interface{}{}

	if req.Name != nil {
		name := strings.TrimSpace(*req.Name)
		if name == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "name cannot be empty"})
			return
		}
		record.Name = name
		updates["name"] = name
	}
	if req.Message != nil {
		message := strings.TrimSpace(*req.Message)
		if message == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "message cannot be empty"})
			return
		}
		record.Message = message
		updates["message"] = message
	}
	if req.Context != nil {
		ctx := *req.Context
		record.Context = &ctx
		updates["context"] = ctx
	}
	if req.Timezone != nil {
		tz := strings.TrimSpace(*req.Timezone)
		if tz == "" {
			tz = "UTC"
		} else if _, err := time.LoadLocation(tz); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("unknown timezone %q", tz)})
			return
		}
		record.Timezone = tz
		updates["timezone"] = tz
	}

	// 日程本身的改动要成套生效：切到 interval 就必须清掉时/分/星期，
	// 切回 daily 就必须清掉 interval，否则两种模式会同时留在库里，
	// 而 ComputeNextFiresAt 永远优先 interval —— 用户会看到自己刚设的时间被忽略。
	mode := ""
	if req.ScheduleMode != nil {
		mode = strings.ToLower(strings.TrimSpace(*req.ScheduleMode))
	} else if req.IntervalMinutes != nil {
		mode = "interval"
	} else if req.Hour != nil || req.Minute != nil || req.Days != nil {
		mode = "daily"
	}

	switch mode {
	case "interval":
		if req.IntervalMinutes == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "interval_minutes is required in interval mode"})
			return
		}
		if *req.IntervalMinutes < 1 || *req.IntervalMinutes > 44640 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "interval_minutes must be between 1 and 44640"})
			return
		}
		interval := *req.IntervalMinutes
		record.ScheduleIntervalMinutes = &interval
		record.ScheduleHour = nil
		record.ScheduleMinute = nil
		record.ScheduleDays = []byte("[]")
		updates["schedule_interval_minutes"] = interval
		updates["schedule_hour"] = nil
		updates["schedule_minute"] = nil
		updates["schedule_days"] = record.ScheduleDays
	case "daily":
		hour := 0
		if req.Hour != nil {
			hour = *req.Hour
		} else if record.ScheduleHour != nil {
			hour = *record.ScheduleHour
		}
		minute := 0
		if req.Minute != nil {
			minute = *req.Minute
		} else if record.ScheduleMinute != nil {
			minute = *record.ScheduleMinute
		}
		if hour < 0 || hour > 23 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "hour must be 0-23"})
			return
		}
		if minute < 0 || minute > 59 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "minute must be 0-59"})
			return
		}

		days := []int{}
		if req.Days != nil {
			days = *req.Days
		} else if len(record.ScheduleDays) > 0 {
			_ = json.Unmarshal(record.ScheduleDays, &days)
		}
		for _, d := range days {
			if d < 0 || d > 6 {
				c.JSON(http.StatusBadRequest, gin.H{"error": "days must contain values 0-6 (0=Monday)"})
				return
			}
		}
		daysBytes, _ := json.Marshal(days)

		record.ScheduleHour = &hour
		record.ScheduleMinute = &minute
		record.ScheduleDays = daysBytes
		record.ScheduleIntervalMinutes = nil
		updates["schedule_hour"] = hour
		updates["schedule_minute"] = minute
		updates["schedule_days"] = daysBytes
		updates["schedule_interval_minutes"] = nil
	}

	if len(updates) == 0 {
		c.JSON(http.StatusOK, record)
		return
	}

	// 任何触碰到日程或时区的编辑都要重排下一次触发，否则改动要等到下个
	// 旧周期跑完才生效。
	if mode != "" || req.Timezone != nil {
		record.NextFiresAt = nextRoutineFire(&record)
		updates["next_fires_at"] = record.NextFiresAt
	}

	if err := db.DB.Model(&models.RoutineRecord{}).Where("id = ?", record.ID).Updates(updates).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update routine"})
		return
	}

	_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.routine.updated", record.CreatedBy, record.ChannelName, gin.H{"routine": record})
	c.JSON(http.StatusOK, record)
}

// TriggerRoutineNow 处理 POST /v1/routines/:routine_id/run 手动立即触发一次
func TriggerRoutineNow(c *gin.Context) {
	routineID := c.Param("routine_id")

	var record models.RoutineRecord
	if err := db.DB.Where("id = ?", routineID).First(&record).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Routine record not found"})
		return
	}

	workspace, err := resolveWorkspace(record.WorkspaceID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Workspace not found"})
		return
	}
	if !authorizeResourceOwner(c, workspace, record.CreatedBy) {
		return
	}
	if record.Status == "cancelled" {
		c.JSON(http.StatusConflict, gin.H{"error": "This routine has been cancelled and can no longer be run"})
		return
	}

	var member models.WorkspaceMember
	if err := db.DB.Where("workspace_id = ? AND agent_name = ?", workspace.ID, record.CreatedBy).First(&member).Error; err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("智能体 @%s 不是该工作区成员", record.CreatedBy)})
		return
	}

	if err := ExecuteRoutineTrigger(&record, true); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"success": true, "routine": record})
}

// ListRoutineRuns 处理 GET /v1/routine-runs 查询历史执行实例
func ListRoutineRuns(c *gin.Context) {
	network := c.Query("network")
	if network == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "network parameter is required"})
		return
	}

	workspace, err := resolveWorkspace(network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Workspace not found"})
		return
	}
	if !authorizeWorkspace(c, workspace) {
		return
	}

	query := db.DB.Where("workspace_id = ?", workspace.ID)
	routineID := c.Query("routine_id")
	if routineID != "" {
		query = query.Where("routine_id = ?", routineID)
	}

	var runs []models.RoutineRunRecord
	query.Order("started_at DESC").Limit(100).Find(&runs)
	c.JSON(http.StatusOK, gin.H{"runs": runs})
}

// ExecuteRoutineTrigger 执行一次特定的 Routine 触发流（自动轮询与手动触发共用）。
// 自动触发时下一次触发时刻由本函数负责推进；调度器已经抢占过 tick 的场合请用
// ExecuteRoutineTriggerWithNext 传入它算好的时刻，避免同一周期被推进两次。
func ExecuteRoutineTrigger(r *models.RoutineRecord, isManual bool) error {
	return ExecuteRoutineTriggerWithNext(r, isManual, nil)
}

// ExecuteRoutineTriggerWithNext 是 ExecuteRoutineTrigger 的完整形态。
// nextFire 非空时直接采用该时刻（调度器抢占 tick 时已写入库的值）。
func ExecuteRoutineTriggerWithNext(r *models.RoutineRecord, isManual bool, nextFire *time.Time) error {
	now := time.Now().UTC()
	shortID := r.ShortID
	if shortID == "" {
		shortID = fmt.Sprintf("RTN-%s", r.ID[:6])
	}

	// 运行序号必须在数据库里自增再读回来。此前它由内存中的 r.RunCount+1 得出，
	// 而 runID 同时是 routine_runs 的主键：一次手动触发和一次到期触发挨在一起，
	// 两边都算出同一个 #n，第二条运行记录直接插入失败 —— 那次运行就在历史里消失了。
	runNumber := r.RunCount + 1
	if err := db.DB.Model(&models.RoutineRecord{}).
		Where("id = ?", r.ID).
		UpdateColumn("run_count", gorm.Expr("run_count + 1")).Error; err == nil {
		var fresh models.RoutineRecord
		if err := db.DB.Select("run_count").Where("id = ?", r.ID).First(&fresh).Error; err == nil && fresh.RunCount > 0 {
			runNumber = fresh.RunCount
		}
	}
	// The run's primary key must be globally unique, not merely unique within
	// this routine. Short ids are numbered per workspace, so "RTN-001.#1" is
	// produced by the first run of the first routine of *every* workspace — the
	// second workspace's insert then collided on the primary key and its run
	// simply never appeared. The readable identity lives in RoutineShortID and
	// RunNumber, which is what the UI renders.
	runID := uuid.New().String()
	runLabel := fmt.Sprintf("%s.#%d", shortID, runNumber)

	// 计算下一次触发时刻。
	resolvedNext := now
	if nextFire != nil {
		resolvedNext = *nextFire
	} else {
		resolvedNext = nextRoutineFire(r)
	}

	// 更新 RoutineRecord（run_count 已在上面原子自增，不要在这里重复写）。
	updates := map[string]interface{}{
		"last_run_id":     runID,
		"last_run_status": "running",
		"last_run_error":  nil,
		"last_fired_at":   now,
	}
	if !isManual && nextFire == nil {
		updates["next_fires_at"] = resolvedNext
	}
	db.DB.Model(&models.RoutineRecord{}).Where("id = ?", r.ID).Updates(updates)

	// 记录 RoutineRunRecord
	runRec := models.RoutineRunRecord{
		ID:             runID,
		RoutineID:      r.ID,
		RoutineShortID: shortID,
		WorkspaceID:    r.WorkspaceID,
		RunNumber:      runNumber,
		ChannelName:    r.ChannelName,
		ThreadID:       r.ThreadID,
		AgentName:      r.CreatedBy,
		RoutineName:    r.Name,
		TriggerMessage: r.Message,
		Status:         "running",
		StartedAt:      now,
	}
	if err := db.DB.Create(&runRec).Error; err != nil {
		// Swallowing this hid the collision above for as long as it existed.
		log.Printf("routine %s run %s could not be recorded: %v", r.ID, runLabel, err)
	}

	// 联动生成一条活跃 Task 进 todos 表，在 Tasks & Issues 中实时显示。
	todoRec := models.TodoRecord{
		ID:          uuid.New().String(),
		WorkspaceID: r.WorkspaceID,
		ChannelName: r.ChannelName,
		ThreadID:    r.ThreadID,
		CreatedBy:   "system:routine",
		Assignee:    r.CreatedBy,
		Content:     fmt.Sprintf("⏰ [%s] %s (Run #%d)", r.Name, r.Message, runNumber),
		Status:      "in_progress",
		Priority:    "high",
		RoutineID:   &r.ID,
		RunID:       &runID,
		Position:    0,
		CreatedAt:   now,
		UpdatedAt:   now,
	}
	if err := db.DB.Create(&todoRec).Error; err != nil {
		log.Printf("routine %s run %s could not open its tracking task: %v", r.ID, runLabel, err)
	}

	// 拼接周期背景上下文和触发消息
	content := fmt.Sprintf("Routine \"%s\" (%s) fired: %s", r.Name, shortID, r.Message)
	if r.Context != nil && *r.Context != "" {
		content = fmt.Sprintf("**Routine Context for \"%s\" (%s)**\n\n%s\n\n---\n\n%s", r.Name, shortID, *r.Context, content)
	}

	eventID := uuid.New().String()
	nowUnixMs := time.Now().UnixNano() / int64(time.Millisecond)

	payloadData := map[string]interface{}{
		"content":      content,
		"message_type": "chat",
		"routine_id":   r.ID,
		"run_id":       runID,
	}
	payloadBytes, _ := json.Marshal(payloadData)

	metadataData := map[string]interface{}{
		"target_agents": []string{r.CreatedBy},
		"routine_id":    r.ID,
		"run_id":        runID,
		"short_id":      shortID,
	}
	metadataBytes, _ := json.Marshal(metadataData)

	eventRec := models.EventRecord{
		ID:         eventID,
		NetworkID:  r.WorkspaceID,
		Type:       "workspace.message.posted",
		Source:     "system:routine",
		Target:     "channel/" + r.ChannelName,
		Payload:    payloadBytes,
		Metadata:   metadataBytes,
		Timestamp:  nowUnixMs,
		Visibility: "channel",
	}
	db.DB.Create(&eventRec)

	// 广播消息至通道
	fullEventBytes, _ := json.Marshal(gin.H{
		"id":        eventID,
		"network":   r.WorkspaceID,
		"type":      "workspace.message.posted",
		"source":    "system:routine",
		"target":    "channel/" + r.ChannelName,
		"payload":   payloadData,
		"metadata":  metadataData,
		"timestamp": nowUnixMs,
	})
	if hub.GlobalHub != nil {
		hub.GlobalHub.Broadcast(hub.BroadcastMsg{
			WorkspaceID: r.WorkspaceID,
			ChannelName: "channel/" + r.ChannelName,
			Payload:     string(fullEventBytes),
		})
	}

	// 广播状态更新给前端（Tasks & Issues 界面无感实时刷新）
	r.RunCount = runNumber
	r.LastRunID = &runID
	r.LastRunStatus = "running"
	r.LastRunError = nil
	r.LastFiredAt = &now
	if !isManual {
		r.NextFiresAt = resolvedNext
	}
	_ = PublishWorkspaceStateEvent(r.WorkspaceID, "workspace.routine.triggered", "system:routine", r.ChannelName, gin.H{
		"routine": r,
		"run":     runRec,
		"todo":    todoRec,
	})
	_ = PublishWorkspaceStateEvent(r.WorkspaceID, "workspace.todos.updated", "system:routine", r.ChannelName, gin.H{
		"todo": todoRec,
	})

	return nil
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
	workspace, err := resolveWorkspace(record.WorkspaceID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Workspace not found"})
		return
	}
	if !authorizeResourceOwner(c, workspace, record.CreatedBy) {
		return
	}
	if err := db.DB.Model(&record).Update("status", "cancelled").Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to cancel routine"})
		return
	}
	record.Status = "cancelled"

	// 同步清理取消当前 Routine 下仍处于 running / in_progress 的在途运行与待办
	cancelledAt := time.Now().UTC()
	cancelReason := "周期任务已被用户删除取消"
	db.DB.Model(&models.RoutineRunRecord{}).
		Where("routine_id = ? AND status = ?", record.ID, "running").
		Updates(map[string]interface{}{
			"status":       "failed",
			"error":        &cancelReason,
			"completed_at": &cancelledAt,
		})
	db.DB.Model(&models.TodoRecord{}).
		Where("routine_id = ? AND status = ?", record.ID, "in_progress").
		Updates(map[string]interface{}{
			"status":       "cancelled",
			"error":        &cancelReason,
			"completed_at": &cancelledAt,
			"updated_at":   cancelledAt,
		})
	_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.todos.updated", record.CreatedBy, record.ChannelName, gin.H{
		"routine_id": record.ID,
		"status":     "cancelled",
	})

	if err := PublishWorkspaceStateEvent(workspace.ID, "workspace.routine.cancelled", record.CreatedBy, record.ChannelName, gin.H{"routine": record}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to publish routine update"})
		return
	}

	// 返回成功。
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// closeFiredTimerTasks marks this agent's fired one-off timer tasks as done.
//
// Scoped to the agent that just spoke, for the same reason routine runs are:
// another agent talking in the channel is not evidence that this agent finished
// its reminder.
func closeFiredTimerTasks(workspaceID, channelName, agentName string, at time.Time) {
	var tasks []models.TodoRecord
	if err := db.DB.
		Where("workspace_id = ? AND channel_name = ? AND assignee = ? AND status = ? AND timer_id IS NOT NULL",
			workspaceID, channelName, agentName, "in_progress").
		Find(&tasks).Error; err != nil || len(tasks) == 0 {
		return
	}

	for _, task := range tasks {
		if err := db.DB.Model(&models.TodoRecord{}).Where("id = ?", task.ID).Updates(map[string]interface{}{
			"status":       "completed",
			"completed_at": &at,
			"updated_at":   at,
		}).Error; err != nil {
			log.Printf("timer task %s could not be closed: %v", task.ID, err)
			continue
		}
		_ = PublishWorkspaceStateEvent(workspaceID, "workspace.todos.updated", "52hz:"+agentName, channelName, gin.H{
			"todo_id": task.ID,
			"status":  "completed",
		})
	}
}

// CompleteRoutineRunIfApplicable checks if an incoming agent message completes a
// running routine execution, and closes any fired one-off timer task the same
// agent was carrying out.
//
// Only a reply from the routine's own agent closes its run. Anything else that
// lands in the channel — the system:routine trigger itself, a second agent
// chiming in, a human comment — used to mark every open run in the channel
// completed, so a run could be "finished" before its agent had said a word.
func CompleteRoutineRunIfApplicable(workspaceID string, target string, source string) {
	if db.DB == nil {
		return
	}
	chName := strings.TrimPrefix(target, "channel/")
	replier := agentNameFromSource(source)
	// System-originated posts (the trigger message itself) never complete a run.
	if replier == "" || strings.HasPrefix(source, "system:") {
		return
	}

	now := time.Now()

	// 先收掉这个 agent 名下已触发的一次性定时任务。
	//
	// 周期任务有 run 记录可以对上，一次性 timer 只有看板上那条任务。timer 到期
	// 会把它推进到 in_progress，然后就一直停在那里 —— agent 干完活回话了，任务
	// 却永远显示"进行中"。
	closeFiredTimerTasks(workspaceID, chName, replier, now)

	var runningRuns []models.RoutineRunRecord
	if err := db.DB.Where("status = ? AND workspace_id = ? AND channel_name = ? AND agent_name = ?",
		"running", workspaceID, chName, replier).Find(&runningRuns).Error; err != nil || len(runningRuns) == 0 {
		return
	}
	for _, run := range runningRuns {
		db.DB.Model(&models.RoutineRunRecord{}).Where("id = ?", run.ID).Updates(map[string]interface{}{
			"status":       "completed",
			"completed_at": &now,
		})
		db.DB.Model(&models.RoutineRecord{}).Where("id = ?", run.RoutineID).Updates(map[string]interface{}{
			"last_run_status": "completed",
		})
		if err := db.DB.Model(&models.TodoRecord{}).Where("run_id = ?", run.ID).Updates(map[string]interface{}{
			"status":       "completed",
			"completed_at": &now,
		}).Error; err != nil {
			log.Printf("routine run %s completed but its tracking task could not be closed: %v", run.ID, err)
		}

		_ = PublishWorkspaceStateEvent(workspaceID, "workspace.routine.completed", source, run.ChannelName, gin.H{
			"run_id":       run.ID,
			"routine_id":   run.RoutineID,
			"routine_name": run.RoutineName,
			"routine": gin.H{
				"id":   run.RoutineID,
				"name": run.RoutineName,
			},
			"status": "completed",
		})
		_ = PublishWorkspaceStateEvent(workspaceID, "workspace.todos.updated", source, run.ChannelName, gin.H{
			"run_id": run.ID,
			"status": "completed",
		})
	}
}

// StopActiveRoutineRunsAndTasks 在用户主动停止智能体或会话时，将关联的进行中 Routine 和待办置为已停止/取消。
func StopActiveRoutineRunsAndTasks(workspaceID, agentName, channelName string) {
	if db.DB == nil {
		return
	}
	now := time.Now().UTC()
	stopReason := "用户手动停止了执行"

	// 1. 查找并取消处于 running 状态的 RoutineRunRecord
	runQuery := db.DB.Model(&models.RoutineRunRecord{}).Where("workspace_id = ? AND status = ?", workspaceID, "running")
	if agentName != "" {
		runQuery = runQuery.Where("agent_name = ?", agentName)
	}
	if channelName != "" {
		runQuery = runQuery.Where("channel_name = ?", channelName)
	}
	var affectedRuns []models.RoutineRunRecord
	runQuery.Find(&affectedRuns)

	for _, run := range affectedRuns {
		db.DB.Model(&models.RoutineRunRecord{}).Where("id = ?", run.ID).Updates(map[string]interface{}{
			"status":       "failed",
			"error":        &stopReason,
			"completed_at": &now,
		})
		db.DB.Model(&models.RoutineRecord{}).Where("id = ?", run.RoutineID).Updates(map[string]interface{}{
			"last_run_status": "failed",
			"last_run_error":  &stopReason,
		})
		_ = PublishWorkspaceStateEvent(workspaceID, "workspace.routine.failed", "system:user_stop", run.ChannelName, gin.H{
			"run_id":       run.ID,
			"routine_id":   run.RoutineID,
			"routine_name": run.RoutineName,
			"channel_name": run.ChannelName,
			"status":       "failed",
			"error":        stopReason,
		})
	}

	// 2. 查找并取消处于 in_progress 状态的 TodoRecord
	todoQuery := db.DB.Model(&models.TodoRecord{}).Where("workspace_id = ? AND status = ?", workspaceID, "in_progress")
	if agentName != "" {
		todoQuery = todoQuery.Where("assignee = ?", agentName)
	}
	if channelName != "" {
		todoQuery = todoQuery.Where("channel_name = ?", channelName)
	}
	var affectedTodos []models.TodoRecord
	todoQuery.Find(&affectedTodos)

	for _, todo := range affectedTodos {
		db.DB.Model(&models.TodoRecord{}).Where("id = ?", todo.ID).Updates(map[string]interface{}{
			"status":       "cancelled",
			"error":        &stopReason,
			"completed_at": &now,
			"updated_at":   now,
		})
		_ = PublishWorkspaceStateEvent(workspaceID, "workspace.todos.updated", "system:user_stop", todo.ChannelName, gin.H{
			"todo_id": todo.ID,
			"run_id":  todo.RunID,
			"status":  "cancelled",
			"error":   stopReason,
		})
	}
}
