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
	Status   string `json:"status" binding:"required"`  // 状态: pending | in_progress | completed (必填)
	Assignee string `json:"assignee"`                   // 负责人
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
func getAgentNameFromSource(source string) string {
	// 如果是以 openagents: 起头，则将其剥离。
	if strings.HasPrefix(source, "openagents:") {
		return strings.TrimPrefix(source, "openagents:")
	}
	return source // 否则直接返回原串。
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
		if item.Status != "pending" && item.Status != "in_progress" && item.Status != "completed" && item.Status != "cancelled" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "todo status must be pending, in_progress, completed, or cancelled"})
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

	// 开启事务处理，确保原有记录删除与新纪录插入的数据原子性。
	tx := db.DB.Begin()

	// 构造删除语句。
	deleteQuery := tx.Where("workspace_id = ? AND channel_name = ? AND created_by = ?", workspace.ID, channelName, req.Source)
	if req.ThreadID != nil && *req.ThreadID != "" {
		deleteQuery = deleteQuery.Where("thread_id = ?", *req.ThreadID)
	}

	// 执行删除以进行全量替换。
	if err := deleteQuery.Delete(&models.TodoRecord{}).Error; err != nil {
		tx.Rollback() // 异常则回滚。
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to reset old todos"})
		return
	}

	// 解析创建者 Agent 名字。
	agentName := getAgentNameFromSource(req.Source)
	records := make([]models.TodoRecord, 0) // 声明集合以保存入库的完整记录。

	// 遍历上传的代办项，构造记录实体。
	for i, item := range req.Todos {
		assignee := item.Assignee
		if assignee == "" {
			assignee = agentName // 默认指派给创建人。
		}

		todoID := uuid.New().String() // 生成主键。
		now := time.Now()

		rec := models.TodoRecord{
			ID:          todoID,
			WorkspaceID: workspace.ID,
			ChannelName: channelName,
			ThreadID:    req.ThreadID,
			CreatedBy:   req.Source,
			Assignee:    assignee,
			Content:     item.Content,
			Status:      item.Status,
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

	hub.GlobalHub.Broadcast(hub.BroadcastMsg{
		WorkspaceID: workspace.ID,
		ChannelName: "channel/" + channelName,
		Payload:     string(fullEventBytes),
	})
	if err := PublishWorkspaceStateEvent(workspace.ID, "workspace.todos.updated", req.Source, channelName, gin.H{"todos": records, "thread_id": req.ThreadID}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to publish todo update"})
		return
	}

	// 返回成功。
	c.JSON(http.StatusOK, gin.H{"todos": records})
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

	// 按顺序检索活跃的任务记录。
	var todos []models.TodoRecord
	query.Order("created_by, position").Find(&todos)

	// 返回响应。
	c.JSON(http.StatusOK, gin.H{"todos": todos})
}
