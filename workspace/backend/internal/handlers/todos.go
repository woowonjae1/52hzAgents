// Package handlers 实现了核心业务逻辑处理器，包括工作区、通道及文件管理。
package handlers

// 导入所需的包，用于 JSON 转换、事件分发以及数据库操作。
import (
	"bytes"
	"encoding/json" // 用于解析请求体及序列化通知负载。
	"fmt"           // 用于格式化字符串拼接（新增）。
	"io"
	"net/http" // 包含标准的 HTTP 常量和响应写入方法。
	"strings"  // 提供辅助字符串处理函数。
	"time"     // 记录更新时刻。
	"unicode/utf8"

	"github.com/gin-gonic/gin"                                           // Gin 框架路由控制。
	"github.com/google/uuid"                                             // 为新增实体分配随机 UUID。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"     // 数据库操作。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/hub"    // 事件广播总线。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/models" // 数据结构体模型。
	"golang.org/x/text/encoding/simplifiedchinese"
	"golang.org/x/text/transform"
)

func toUTF8String(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return ""
	}
	if utf8.ValidString(s) && !strings.Contains(s, "\ufffd") {
		return s
	}
	r := transform.NewReader(bytes.NewReader([]byte(s)), simplifiedchinese.GBK.NewDecoder())
	decoded, err := io.ReadAll(r)
	if err == nil && utf8.Valid(decoded) && len(decoded) > 0 {
		return strings.TrimSpace(string(decoded))
	}
	return strings.ReplaceAll(s, "\ufffd", "")
}

// PutTodoItem 代表单个代办事项项的参数。
type PutTodoItem struct {
	Content  string `json:"content" binding:"required"` // 代办具体描述内容 (必填)
	Status   string `json:"status" binding:"required"`  // 状态: pending | in_progress | completed | cancelled (必填)
	Assignee string `json:"assignee"`                   // 负责人
	// Priority 此前不在载荷里：前端的优先级选择器一直在发送它，服务端一直在
	// 丢弃它，于是每次保存都把整张列表的优先级重置成 none。
	Priority string     `json:"priority"`
	DueDate  *time.Time `json:"due_date"` // 可选截止时间
}

// validTodoStatuses / validTodoPriorities 是服务端唯一的真值来源。
var validTodoStatuses = map[string]bool{
	"pending":     true,
	"in_progress": true,
	"completed":   true,
	"cancelled":   true,
}

var validTodoPriorities = map[string]bool{
	"none":   true,
	"low":    true,
	"medium": true,
	"high":   true,
	"urgent": true,
}

// isTerminalTodoStatus reports whether a status closes the task.
func isTerminalTodoStatus(status string) bool {
	return status == "completed" || status == "cancelled"
}

// PutTodosRequest 代表批量修改 Todos 列表的请求载荷。
type PutTodosRequest struct {
	Network  string        `json:"network" binding:"required"` // 工作区标识 (必填)
	Source   string        `json:"source" binding:"required"`  // 请求来源（智能体或人，如 openagents:claude） (必填)
	Channel  string        `json:"channel"`                    // 所属会话通道名称
	ThreadID *string       `json:"thread_id"`                  // 可选的具体线程 ID
	Todos    []PutTodoItem `json:"todos"`                      // 待覆盖保存的代办项列表
}

// getAgentNameFromSource 解析源路径获取纯粹的 Agent 名称。
//
// 这里曾经只剥离 openagents: 前缀。前端发出的地址其实是 52hz:<name>，于是
// CreateRoutine 拿着 "52hz:claude" 去查工作区成员，一条都匹配不上，"New
// Schedule" 永远返回 403。地址前缀只有一份规范定义（routing.go 的
// agentNameFromSource），这里直接复用它，不要再各写一遍。
func getAgentNameFromSource(source string) string {
	return agentNameFromSource(source)
}

// AgentNameFromSource 是地址前缀剥离的导出入口，供 scheduler 等包使用。
//
// 这个前缀 bug 已经出现过三次（创建 routine 的成员校验、todo 归属、以及
// timer 到期时的投递目标），每次都是有人又手写了一遍「只去掉 openagents:」。
// 需要剥前缀就调这个，不要再复制一份。
func AgentNameFromSource(source string) string {
	return agentNameFromSource(source)
}

// PutTodos 处理 PUT /v1/todos 接口，替换调用端在特定通道下的全部 Todos 并广播协同消息。
func PutTodos(c *gin.Context) {
	var req PutTodosRequest // 声明接收载荷。
	bodyBytes, err := c.GetRawData()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// If raw bytes sent by Windows curl.exe are GBK encoded, decode to UTF-8 first
	if !utf8.Valid(bodyBytes) {
		r := transform.NewReader(bytes.NewReader(bodyBytes), simplifiedchinese.GBK.NewDecoder())
		if decoded, err := io.ReadAll(r); err == nil && utf8.Valid(decoded) {
			bodyBytes = decoded
		}
	}

	if err := json.Unmarshal(bodyBytes, &req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// 检索解析工作区。
	workspace, err := resolveWorkspace(req.Network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}

	// 验证 Token。
	if !authorizeWorkspace(c, workspace) {
		return
	}
	for i, item := range req.Todos {
		if !validTodoStatuses[item.Status] {
			c.JSON(http.StatusBadRequest, gin.H{"error": "todo status must be pending, in_progress, completed, or cancelled"})
			return
		}
		if item.Priority == "" {
			req.Todos[i].Priority = "none"
		} else if !validTodoPriorities[item.Priority] {
			c.JSON(http.StatusBadRequest, gin.H{"error": "todo priority must be none, low, medium, high, or urgent"})
			return
		}
		req.Todos[i].Content = toUTF8String(item.Content)
		req.Todos[i].Assignee = toUTF8String(item.Assignee)
	}

	// 初始化通道默认值。
	channelName := req.Channel
	if channelName == "" {
		channelName = "general"
	}

	// 解析创建者 Agent 名字。
	agentName := getAgentNameFromSource(req.Source)

	// 开启事务处理，确保原有记录删除与新纪录插入的数据原子性。
	tx := db.DB.Begin()

	// PUT 是「整表替换」语义，但替换范围必须收在调用方自己的清单上。
	//
	// 这里原本按 workspace + channel 删除全部记录，而调用方（前端和 SDK 里的
	// agent）只会上传属于自己的那一段。结果是：任何一次勾选状态的保存，都会连
	// 带删掉同一频道里其他 agent 的待办、以及 system:routine 为每次定时执行
	// 建立的跟踪任务 —— 定时任务的运行记录就这样凭空消失。
	deleteQuery := tx.Where("workspace_id = ? AND channel_name = ? AND created_by = ?",
		workspace.ID, channelName, req.Source)
	if req.ThreadID != nil && *req.ThreadID != "" {
		deleteQuery = deleteQuery.Where("thread_id = ?", *req.ThreadID)
	}

	// 执行删除以进行全量替换。
	if err := deleteQuery.Delete(&models.TodoRecord{}).Error; err != nil {
		tx.Rollback() // 异常则回滚。
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to reset old todos"})
		return
	}

	records := make([]models.TodoRecord, 0) // 声明集合以保存入库的完整记录。

	// 遍历上传的代办项，构造记录实体。
	for i, item := range req.Todos {
		assignee := item.Assignee
		if assignee == "" {
			assignee = agentName // 默认指派给创建人。
		}

		todoID := uuid.New().String() // 生成主键。
		now := time.Now()

		var completedAt *time.Time
		if isTerminalTodoStatus(item.Status) {
			completedAt = &now
		}

		rec := models.TodoRecord{
			ID:          todoID,
			WorkspaceID: workspace.ID,
			ChannelName: channelName,
			ThreadID:    req.ThreadID,
			CreatedBy:   req.Source,
			Assignee:    assignee,
			Content:     item.Content,
			Status:      item.Status,
			Priority:    item.Priority,
			DueDate:     item.DueDate,
			CompletedAt: completedAt,
			Position:    i, // 依次赋予当前的排序索引。
			CreatedAt:   now,
			UpdatedAt:   now,
		}

		// 执行单条数据保存。
		if err := tx.Create(&rec).Error; err != nil {
			tx.Rollback() // 回滚事务。
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save new todo"})
			return
		}
		records = append(records, rec) // 追加到响应缓存中。
	}

	// 提交事务。
	if err := tx.Commit().Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to save todos"})
		return
	}

	// 构建以发布消息形式同步任务面板到讨论区的汇总文本。
	var contentBuilder strings.Builder
	// 拼接标题行。
	contentBuilder.WriteString(fmt.Sprintf("**To-dos updated by %s:**\n", agentName))

	// 循环每个任务条目拼接状态符号。
	for _, r := range records {
		var icon string
		if r.Status == "completed" {
			icon = "✅"
		} else if r.Status == "in_progress" {
			icon = "🔄"
		} else {
			icon = "⬜"
		}
		contentBuilder.WriteString(fmt.Sprintf("%s %s (assigned to @%s)\n", icon, r.Content, r.Assignee))
	}

	// 组织事件 Payload 信息。
	eventID := uuid.New().String()
	nowUnixMs := time.Now().UnixNano() / int64(time.Millisecond)

	payloadData := map[string]interface{}{
		"content":      contentBuilder.String(),
		"message_type": "todos",
		"todos":        records,
	}
	payloadBytes, _ := json.Marshal(payloadData)

	// 写入 workspace.message.posted 事件以便前端可以直接在对话面板中同步。
	eventRec := models.EventRecord{
		ID:        eventID,
		NetworkID: workspace.ID,
		Type:      "workspace.message.posted",
		Source:    req.Source,
		Target:    "channel/" + channelName,
		Payload:   payloadBytes,
		Timestamp: nowUnixMs,
	}
	db.DB.Create(&eventRec)

	// 推送至全局 Hub 中继进行广播。
	fullEventBytes, _ := json.Marshal(gin.H{
		"id":        eventID,
		"network":   workspace.ID,
		"type":      "workspace.message.posted",
		"source":    req.Source,
		"target":    "channel/" + channelName,
		"payload":   payloadData,
		"timestamp": nowUnixMs,
	})

	if hub.GlobalHub != nil {
		hub.GlobalHub.Broadcast(hub.BroadcastMsg{
			WorkspaceID: workspace.ID,
			ChannelName: "channel/" + channelName,
			Payload:     string(fullEventBytes),
		})
	}
	if err := PublishWorkspaceStateEvent(workspace.ID, "workspace.todos.updated", req.Source, channelName, gin.H{"todos": records, "thread_id": req.ThreadID}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to publish todo update"})
		return
	}

	// 返回成功。
	c.JSON(http.StatusOK, gin.H{"todos": records})
}

// CreateTodoRequest 代表新增单条代办项的载荷。
type CreateTodoRequest struct {
	Network  string     `json:"network" binding:"required"`
	Source   string     `json:"source" binding:"required"`
	Channel  string     `json:"channel"`
	ThreadID *string    `json:"thread_id"`
	Content  string     `json:"content" binding:"required"`
	Status   string     `json:"status"`
	Priority string     `json:"priority"`
	Assignee string     `json:"assignee"`
	DueDate  *time.Time `json:"due_date"`
}

// CreateTodo 处理 POST /v1/todos，追加一条代办项。
//
// 新建一条任务此前只能走「整表替换」的 PUT：把本来源的全部任务重新写一遍，
// 顺带换掉每一行的 ID 和创建时间。追加就该是追加。
func CreateTodo(c *gin.Context) {
	var req CreateTodoRequest
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

	content := toUTF8String(req.Content)
	if content == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "content cannot be empty"})
		return
	}

	status := req.Status
	if status == "" {
		status = "pending"
	}
	if !validTodoStatuses[status] {
		c.JSON(http.StatusBadRequest, gin.H{"error": "todo status must be pending, in_progress, completed, or cancelled"})
		return
	}
	priority := req.Priority
	if priority == "" {
		priority = "none"
	}
	if !validTodoPriorities[priority] {
		c.JSON(http.StatusBadRequest, gin.H{"error": "todo priority must be none, low, medium, high, or urgent"})
		return
	}

	channelName := req.Channel
	if channelName == "" {
		channelName = "general"
	}
	agentName := getAgentNameFromSource(req.Source)
	assignee := toUTF8String(req.Assignee)
	if assignee == "" {
		assignee = agentName
	}

	// 追加到本来源在该频道清单的末尾。
	var maxPosition *int
	db.DB.Model(&models.TodoRecord{}).
		Where("workspace_id = ? AND channel_name = ? AND created_by = ?", workspace.ID, channelName, req.Source).
		Select("MAX(position)").Scan(&maxPosition)
	position := 0
	if maxPosition != nil {
		position = *maxPosition + 1
	}

	now := time.Now()
	var completedAt *time.Time
	if isTerminalTodoStatus(status) {
		completedAt = &now
	}

	record := models.TodoRecord{
		ID:          uuid.New().String(),
		WorkspaceID: workspace.ID,
		ChannelName: channelName,
		ThreadID:    req.ThreadID,
		CreatedBy:   req.Source,
		Assignee:    assignee,
		Content:     content,
		Status:      status,
		Priority:    priority,
		DueDate:     req.DueDate,
		CompletedAt: completedAt,
		Position:    position,
		CreatedAt:   now,
		UpdatedAt:   now,
	}

	if err := db.DB.Create(&record).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create todo"})
		return
	}

	_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.todos.updated", req.Source, channelName, gin.H{
		"todos":     []models.TodoRecord{record},
		"thread_id": req.ThreadID,
	})
	c.JSON(http.StatusOK, record)
}

// PatchTodoRequest 代表单条代办项的局部更新载荷。所有字段可选。
type PatchTodoRequest struct {
	Network  string     `json:"network"`
	Content  *string    `json:"content"`
	Status   *string    `json:"status"`
	Priority *string    `json:"priority"`
	Assignee *string    `json:"assignee"`
	Position *int       `json:"position"`
	DueDate  *time.Time `json:"due_date"`
	ClearDue bool       `json:"clear_due_date"`
}

// PatchTodo 处理 PATCH /v1/todos/:todo_id，只更新一条代办项。
//
// 在此之前，勾一下状态或换一次优先级都要把整个清单 PUT 回去（先删后建）：
// 一次点击产生一轮删除加 N 次插入，所有 ID 全部换新，任何并发的 agent 写入
// 都会被覆盖。局部更新是任务面板的正常做法，也让乐观更新真正可行。
func PatchTodo(c *gin.Context) {
	todoID := c.Param("todo_id")

	var record models.TodoRecord
	if err := db.DB.Where("id = ?", todoID).First(&record).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Todo not found"})
		return
	}

	workspace, err := resolveWorkspace(record.WorkspaceID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}
	if !authorizeWorkspace(c, workspace) {
		return
	}

	var req PatchTodoRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	now := time.Now()
	updates := map[string]interface{}{"updated_at": now}

	if req.Content != nil {
		content := toUTF8String(*req.Content)
		if content == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "content cannot be empty"})
			return
		}
		record.Content = content
		updates["content"] = content
	}
	if req.Status != nil {
		if !validTodoStatuses[*req.Status] {
			c.JSON(http.StatusBadRequest, gin.H{"error": "todo status must be pending, in_progress, completed, or cancelled"})
			return
		}
		record.Status = *req.Status
		updates["status"] = *req.Status
		// 关闭时打上完成时间；重新打开时把它清掉，否则一条被复活的任务会带着
		// 上一次的完成时间，任何按完成时间做的统计都会失真。
		if isTerminalTodoStatus(*req.Status) {
			record.CompletedAt = &now
			updates["completed_at"] = &now
		} else {
			record.CompletedAt = nil
			updates["completed_at"] = nil
		}
	}
	if req.Priority != nil {
		priority := *req.Priority
		if priority == "" {
			priority = "none"
		}
		if !validTodoPriorities[priority] {
			c.JSON(http.StatusBadRequest, gin.H{"error": "todo priority must be none, low, medium, high, or urgent"})
			return
		}
		record.Priority = priority
		updates["priority"] = priority
	}
	if req.Assignee != nil {
		assignee := toUTF8String(*req.Assignee)
		record.Assignee = assignee
		updates["assignee"] = assignee
	}
	if req.Position != nil {
		record.Position = *req.Position
		updates["position"] = *req.Position
	}
	if req.ClearDue {
		record.DueDate = nil
		updates["due_date"] = nil
	} else if req.DueDate != nil {
		record.DueDate = req.DueDate
		updates["due_date"] = req.DueDate
	}

	record.UpdatedAt = now
	if err := db.DB.Model(&models.TodoRecord{}).Where("id = ?", record.ID).Updates(updates).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to update todo"})
		return
	}

	_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.todos.updated", record.CreatedBy, record.ChannelName, gin.H{
		"todos":     []models.TodoRecord{record},
		"thread_id": record.ThreadID,
	})
	c.JSON(http.StatusOK, record)
}

// DeleteTodo 处理 DELETE /v1/todos/:todo_id，删除单条代办项。
func DeleteTodo(c *gin.Context) {
	todoID := c.Param("todo_id")

	var record models.TodoRecord
	if err := db.DB.Where("id = ?", todoID).First(&record).Error; err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Todo not found"})
		return
	}

	workspace, err := resolveWorkspace(record.WorkspaceID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}
	if !authorizeWorkspace(c, workspace) {
		return
	}

	if err := db.DB.Where("id = ?", record.ID).Delete(&models.TodoRecord{}).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to delete todo"})
		return
	}

	_ = PublishWorkspaceStateEvent(workspace.ID, "workspace.todos.deleted", record.CreatedBy, record.ChannelName, gin.H{
		"todo_id":   record.ID,
		"thread_id": record.ThreadID,
	})
	c.JSON(http.StatusOK, gin.H{"success": true})
}

// GetTodos 处理 GET /v1/todos 接口，查询指定范围下的代办项。
func GetTodos(c *gin.Context) {
	network := c.Query("network") // 获取必需的工作区标识。
	if network == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "network parameter is required"})
		return
	}

	// 锁定匹配的工作区。
	workspace, err := resolveWorkspace(network)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "Network not found"})
		return
	}

	// 权限验证。
	if !authorizeWorkspace(c, workspace) {
		return
	}

	// 设定初始查询过滤器。
	query := db.DB.Where("workspace_id = ?", workspace.ID)

	// 可选的通道过滤器。
	channel := c.Query("channel")
	if channel != "" {
		query = query.Where("channel_name = ?", channel)
	}

	// 可选的线程过滤器。
	threadID := c.Query("thread_id")
	if threadID != "" {
		query = query.Where("thread_id = ?", threadID)
	}

	// 可选的负责人过滤。
	agent := c.Query("agent")
	if agent != "" {
		query = query.Where("assignee LIKE ?", "%"+agent+"%")
	} else {
		// 如果未指定 all=true，默认只返回当前请求发送者自身的 Todos。
		allVal := c.Query("all")
		source := c.Query("source")
		if allVal != "true" && source != "" {
			query = query.Where("created_by = ?", source)
		}
	}

	// 可选的状态过滤（逗号分隔，如 status=pending,in_progress）。
	if statusParam := c.Query("status"); statusParam != "" {
		wanted := make([]string, 0, 4)
		for _, s := range strings.Split(statusParam, ",") {
			s = strings.TrimSpace(s)
			if validTodoStatuses[s] {
				wanted = append(wanted, s)
			}
		}
		if len(wanted) == 0 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "status must be a comma-separated list of pending, in_progress, completed, cancelled"})
			return
		}
		query = query.Where("status IN ?", wanted)
	}

	// 按顺序检索活跃的任务记录。position 会重复（每个来源各有一套序号），
	// 所以补上 created_at 作为决胜键，否则同一份数据两次请求的顺序可能不同，
	// 列表会无缘无故地跳动。
	var todos []models.TodoRecord
	query.Order("created_by, position, created_at").Find(&todos)

	// 返回响应。
	c.JSON(http.StatusOK, gin.H{"todos": todos})
}
