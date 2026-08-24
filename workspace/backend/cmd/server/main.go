package main // 声明 main 主包。

// 引入所需标准库，以及 Gin 框架和内部编写的配置、数据库、事件处理器、广播 Hub 以及后台调度器。
import (
	"fmt"           // 用于进行格式化拼接生成监听地址字符串。
	"log"           // 用于输出后台服务的启动和错误日志。
	"net/http"      // 包含标准 HTTP 状态码定义。
	"os"            // 文件系统操作与路径探测
	"path/filepath" // 文件路径处理
	"strings"       // 字符串前缀判断

	"github.com/gin-gonic/gin"                                             // Gin Web 核心路由与上下文。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config"   // 环境变量加载包。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db"       // 数据库初始化与 GORM 控制包。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/handlers" // 路由处理器实现包。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/hub"      // 消息广播 Hub 中继包。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/middleware"
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/scheduler" // 后台定时与周期任务调度包（新增）。
)

func main() { // 服务程序运行主入口函数。
	log.Println("Initializing 52hzAgents Workspace Server (Go Edition)...") // 打印初始化提示日志。

	// Load configuration
	config.LoadConfig()                                               // 调用并加载所有的环境变量配置。
	log.Printf("Configuration loaded: Host=%s, Port=%d, AuthMode=%s", // 打印已加载的配置项。
		config.GlobalConfig.Host,     // 监听 Host。
		config.GlobalConfig.Port,     // 监听 Port。
		config.GlobalConfig.AuthMode, // 鉴权模式。
	)

	// Initialize Database (SQLite/Postgres) and run migrations
	db.InitDB() // 执行数据库建立连接并自动映射表结构。

	// Initialize Event Hub
	hub.InitHub() // 初始化并运行高并发的实时消息分发 Hub 中心。

	// Start Background Scheduler
	scheduler.StartScheduler() // 新增：启动后台任务调度协程，用于触发到期的 Timers 及 Routines 周期任务。

	// Initialize Gin router
	router := gin.Default() // 使用默认日志与恢复中间件初始化 Gin。
	router.Use(middleware.RateLimit(config.GlobalConfig.RequestsPerMinute))
	router.Use(middleware.AuditMutations())
	router.Use(func(c *gin.Context) {
		origin := c.GetHeader("Origin")
		if origin != "" && config.GlobalConfig.IsAllowedOrigin(origin) {
			c.Header("Access-Control-Allow-Origin", origin)
			c.Header("Vary", "Origin")
			c.Header("Access-Control-Allow-Credentials", "true")
			c.Header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Workspace-Token")
			c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		}
		if c.Request.Method == http.MethodOptions {
			if origin != "" && !config.GlobalConfig.IsAllowedOrigin(origin) {
				c.AbortWithStatus(http.StatusForbidden)
				return
			}
			c.AbortWithStatus(http.StatusNoContent)
			return
		}
		c.Next()
	})

	// Core API routes
	v1 := router.Group("/v1") // 注册 v1 API 版本的路由组。
	{                         // 路由组定义作用域。
		v1.GET("/health", func(c *gin.Context) { // 注册服务健康状况接口。
			c.JSON(http.StatusOK, gin.H{ // 正常返回 200 OK 并列出当前的属性状态。
				"status":     "ok",                           // 状态正常。
				"service":    "52hzagents-workspace-backend", // 服务名标识。
				"auth_mode":  config.GlobalConfig.AuthMode,   // 当前鉴权模式。
				"db_dialect": db.DB.Dialector.Name(),         // 当前数据库驱动类型。
			}) // 渲染返回。
		}) // 结束健康状况路由。

		// 注册实时事件接口路由组：
		v1.POST("/events", handlers.SendEvent) // 客户端或 Agent 提交新事件的接口。
		v1.GET("/events", handlers.ListEvents)
		v1.GET("/events/latest-per-channel", handlers.LatestEventsPerChannel)
		v1.GET("/events/stream", handlers.StreamEventsSSE) // 建立 SSE 单向实时数据推送的接口。
		v1.GET("/events/ws", handlers.StreamEventsWS)      // 建立 WebSocket 双向实时数据流通道的接口。

		// 注册工作区管理接口：
		v1.POST("/workspaces", handlers.CreateWorkspace) // 新建工作区接口。
		v1.POST("/ws", handlers.CreateWorkspace)
		v1.GET("/workspaces", handlers.ListWorkspaces)
		v1.GET("/ws", handlers.ListWorkspaces)
		v1.POST("/token/resolve", handlers.ResolveToken)
		v1.GET("/workspaces/:workspace_id", handlers.GetWorkspace) // 获取指定工作区详情。
		v1.PATCH("/workspaces/:workspace_id", handlers.UpdateWorkspace)
		v1.DELETE("/workspaces/:workspace_id", handlers.DeleteWorkspace)                    // 软删除工作区。
		v1.PATCH("/workspaces/:workspace_id/channels/:channel_name", handlers.PatchChannel) // 修改会话通道属性。
		v1.GET("/workspaces/:workspace_id/channels/:channel_name", handlers.GetChannel)     // 获取单通道详情。
		v1.POST("/workspaces/:workspace_id/channels/:channel_name/compact", handlers.CompactChannelHandler)          // 触发频道上下文压缩
		v1.GET("/workspaces/:workspace_id/channels/:channel_name/summary", handlers.GetChannelSummaryHandler)        // 查询频道最新历史摘要
		v1.GET("/workspaces/:workspace_id/channels/:channel_name/history/compacted", handlers.GetCompactedHistoryHandler) // 获取压缩摘要+近期对话
		v1.GET("/workspaces/:workspace_id/policy/exec", handlers.GetWorkspaceExecPolicy)     // 获取命令执行安全策略
		v1.PUT("/workspaces/:workspace_id/policy/exec", handlers.UpdateWorkspaceExecPolicy)  // 更新命令执行安全策略

		// 注册 Agent 节点接入网络接口：
		v1.POST("/join", handlers.JoinNetwork)                                 // Agent 登入工作区网络接口。
		v1.POST("/leave", handlers.LeaveNetwork)                               // Agent 退出工作区网络接口。
		v1.POST("/workspaces/:workspace_id/presence", handlers.UpdatePresence) // Agent 定时在线心跳保活接口。
		v1.GET("/discover", handlers.DiscoverNetwork)
		v1.GET("/profile", handlers.NetworkProfile)
		v1.POST("/agents/:agent_name/launch", handlers.LaunchAgent)

		// 注册共享文件管理接口：
		v1.POST("/files", handlers.UploadFileMultipart)      // multipart/form-data 文件上传。
		v1.POST("/files/base64", handlers.UploadFileBase64)  // Base64 JSON 格式文件上传（面向 Agent）。
		v1.GET("/files", handlers.ListFiles)                 // 列出工作区内的文件列表（分页）。
		v1.GET("/files/:file_id/info", handlers.GetFileInfo) // 获取单一文件元数据信息。
		v1.GET("/files/:file_id", handlers.DownloadFile)     // 物理文件流式下载读取接口。
		v1.DELETE("/files/:file_id", handlers.DeleteFile)    // 逻辑删除文件及其物理存储。

		// 注册规划辅助接口 (Todos/Timers/Routines) —— 新增：
		v1.PUT("/todos", handlers.PutTodos) // 批量保存并重排序代办事项。
		v1.GET("/todos", handlers.GetTodos) // 查询指定过滤条件下的代办项。

		v1.POST("/timers", handlers.CreateTimer)             // 创建单次定时消息提醒计时器。
		v1.GET("/timers", handlers.ListTimers)               // 列出活跃状态的计时器。
		v1.DELETE("/timers/:timer_id", handlers.DeleteTimer) // 取消定时提醒。

		v1.POST("/routines", handlers.CreateRoutine)               // 创建周期性循环执行任务。
		v1.GET("/routines", handlers.ListRoutines)                 // 列出活跃中的循环任务。
		v1.DELETE("/routines/:routine_id", handlers.DeleteRoutine) // 撤销或取消周期任务。
		v1.POST("/notifications", handlers.CreateNotification)
		v1.GET("/notifications", handlers.ListNotifications)
		v1.PATCH("/notifications/read-all", handlers.MarkAllNotificationsRead)
		v1.PATCH("/notifications/:notification_id/read", handlers.MarkNotificationRead)
		v1.DELETE("/notifications/:notification_id", handlers.DismissNotification)
		v1.POST("/workspaces/:workspace_id/agents/:agent_name/runtime", handlers.ReportAgentRuntime)
		v1.GET("/workspaces/:workspace_id/agents/:agent_name/runtime", handlers.GetAgentRuntime)
		v1.GET("/workspaces/:workspace_id/agents/runtime", handlers.ListAgentRuntimes)
		v1.POST("/workspaces/:workspace_id/agents/:agent_name/usage", handlers.ReportAgentUsage)
		v1.GET("/workspaces/:workspace_id/agents/:agent_name/usage", handlers.GetAgentUsage)
		v1.POST("/workspaces/:workspace_id/agents/:agent_name/logs", handlers.CreateAgentLog)
		v1.GET("/workspaces/:workspace_id/agents/:agent_name/logs", handlers.ListAgentLogs)
		v1.POST("/approvals", handlers.CreateAgentApproval)
		v1.GET("/approvals", handlers.ListAgentApprovals)
		v1.PATCH("/approvals/:approval_id", handlers.ResolveAgentApproval)

		// Agent Catalog & Cloud Agents
		v1.GET("/agent-catalog", handlers.GetAgentCatalog)
		v1.POST("/agents", handlers.CreateAgent)
		v1.GET("/cloud-agents/providers", handlers.GetCloudAgentProviders)
		v1.GET("/cloud-agents", handlers.ListCloudAgents)
		v1.POST("/cloud-agents", handlers.AddCloudAgent)
		v1.PATCH("/cloud-agents/:agent_name", handlers.UpdateCloudAgent)
		v1.DELETE("/cloud-agents/:agent_name", handlers.RemoveCloudAgent)

		// 知识库（共享 Markdown 文档）：
		v1.POST("/knowledge", handlers.CreateKnowledge)
		v1.GET("/knowledge", handlers.ListKnowledge)
		v1.GET("/knowledge/by-slug/:slug", handlers.GetKnowledgeBySlug)
		v1.GET("/knowledge/:entry_id", handlers.GetKnowledge)
		v1.PUT("/knowledge/:entry_id", handlers.UpdateKnowledge)
		v1.DELETE("/knowledge/:entry_id", handlers.DeleteKnowledge)

		// 会话分享（公开快照）：
		v1.POST("/shares", handlers.CreateShare)
		v1.GET("/shares", handlers.ListShares)
		v1.GET("/shares/public/:share_token", handlers.GetPublicShare)
		v1.DELETE("/shares/:share_id", handlers.DeleteShare)

		// 协作者与成员管理：
		v1.GET("/workspaces/:workspace_id/collaborators", handlers.ListCollaborators)
		v1.POST("/workspaces/:workspace_id/collaborators", handlers.AddCollaborator)
		v1.DELETE("/workspaces/:workspace_id/collaborators/:email", handlers.RemoveCollaborator)
		v1.PATCH("/workspaces/:workspace_id/members/:agent_name", handlers.UpdateMember)
		v1.DELETE("/workspaces/:workspace_id/members/:agent_name", handlers.RemoveMember)
		v1.POST("/workspaces/:workspace_id/members/:agent_name/generate-description", handlers.GenerateMemberDescription)

		// 技能系统（Skill Hub）：
		v1.GET("/workspaces/skill-catalog", handlers.GetSkillCatalog)
		v1.POST("/workspaces/:workspace_id/members/:agent_name/skills/install", handlers.InstallSkill)
		v1.POST("/workspaces/:workspace_id/members/:agent_name/skills/status", handlers.ReportSkillStatus)
		v1.POST("/workspaces/:workspace_id/members/:agent_name/skills/uninstall", handlers.UninstallSkill)
		v1.GET("/workspaces/:workspace_id/skills/custom", handlers.ListCustomSkills)
		v1.POST("/workspaces/:workspace_id/skills/custom", handlers.RegisterCustomSkill)

		// 协同共享浏览器：
		v1.POST("/browser/tabs", handlers.OpenBrowserTab)
		v1.GET("/browser/tabs", handlers.ListBrowserTabs)
		v1.GET("/browser/tabs/:tab_id", handlers.GetBrowserTab)
		v1.POST("/browser/tabs/:tab_id/navigate", handlers.NavigateBrowserTab)
		v1.POST("/browser/tabs/:tab_id/reconnect", handlers.ReconnectBrowserTab)
		v1.POST("/browser/tabs/:tab_id/click", handlers.ClickBrowserTab)
		v1.POST("/browser/tabs/:tab_id/type", handlers.TypeBrowserTab)
		v1.POST("/browser/tabs/:tab_id/press_key", handlers.PressKeyBrowserTab)
		v1.POST("/browser/tabs/:tab_id/evaluate", handlers.EvaluateBrowserTab)
		v1.GET("/browser/tabs/:tab_id/screenshot", handlers.ScreenshotBrowserTab)
		v1.GET("/browser/tabs/:tab_id/snapshot", handlers.SnapshotBrowserTab)
		v1.POST("/browser/tabs/:tab_id/share", handlers.ShareBrowserTab)
		v1.POST("/browser/tabs/:tab_id/persist", handlers.PersistBrowserTab)
		v1.POST("/browser/tabs/:tab_id/unpersist", handlers.UnpersistBrowserTab)
		v1.DELETE("/browser/tabs/:tab_id", handlers.CloseBrowserTab)
		v1.GET("/browser/contexts", handlers.ListBrowserContexts)
		v1.DELETE("/browser/contexts/:context_id", handlers.DeleteBrowserContext)
		v1.GET("/browser/usage", handlers.BrowserUsage)

		// Real Terminal Shell Command Execution:
		v1.POST("/terminal/execute", handlers.ExecuteTerminalCommand)

		// Git 版本控制接口：
		v1.GET("/git/status", handlers.GetGitStatus)
		v1.GET("/git/branches", handlers.ListGitBranches)
		v1.GET("/git/log", handlers.GetGitLog)
		v1.GET("/git/diff", handlers.GetGitDiff)
		v1.POST("/git/stage", handlers.StageGitFiles)
		v1.POST("/git/unstage", handlers.UnstageGitFiles)
		v1.POST("/git/commit", handlers.CreateGitCommit)
		v1.POST("/git/checkout", handlers.CheckoutGitBranch)
		v1.POST("/git/discard", handlers.DiscardGitChanges)
		v1.POST("/git/fetch", handlers.FetchGitRemote)
		v1.POST("/git/pull", handlers.PullGitRemote)
		v1.POST("/git/push", handlers.PushGitRemote)
		// Which files did this agent touch during this task:
		v1.GET("/git/turn-changes", handlers.ListTurnChanges)
		v1.POST("/git/turn-rollback", handlers.RollbackTurnChanges)

		// Multi-Agent Pipeline Status & Control:
		v1.GET("/channels/:channel_id/pipeline", handlers.GetChannelPipeline)
		v1.POST("/channels/:channel_id/pipeline/halt", handlers.HaltChannelPipeline)

		// 补充：输入指示、DM 会话、心跳、成员移除、认领与令牌轮换：
		v1.POST("/composing", handlers.ComposingSignal)
		v1.GET("/events/conversations", handlers.ListConversations)
		v1.POST("/heartbeat", handlers.HeartbeatAgent)
		v1.POST("/remove", handlers.RemoveAgentFromNetwork)
		v1.POST("/workspaces/:workspace_id/claim", handlers.ClaimWorkspace)
		v1.POST("/workspaces/:workspace_id/rotate-token", handlers.RotateWorkspaceToken)
	} // 结束路由组作用域。

	// Legacy /health endpoint matching the health checks
	router.GET("/api/health", func(c *gin.Context) { // 兼容旧有的 /api/health 查询路由。
		c.JSON(http.StatusOK, gin.H{ // 返回正常 200。
			"status": "ok", // 回复状态。
		}) // 渲染。
	}) // 结束。

	// Static frontend serving (for standalone single-binary / desktop mode)
	staticPaths := []string{
		os.Getenv("FRONTEND_STATIC_PATH"),
		"./public",
		"./frontend_out",
		"../frontend/out",
		"../../frontend/out",
	}
	var staticDir string
	for _, p := range staticPaths {
		if p != "" {
			if stat, err := os.Stat(p); err == nil && stat.IsDir() {
				staticDir = p
				break
			}
		}
	}
	if staticDir != "" {
		log.Printf("Serving static frontend assets from %s", staticDir)
		router.NoRoute(func(c *gin.Context) {
			reqPath := c.Request.URL.Path
			if strings.HasPrefix(reqPath, "/v1/") || strings.HasPrefix(reqPath, "/api/") {
				c.JSON(http.StatusNotFound, gin.H{"error": "API route not found"})
				return
			}
			filePath := filepath.Join(staticDir, filepath.Clean(reqPath))
			if stat, err := os.Stat(filePath); err == nil && !stat.IsDir() {
				c.File(filePath)
				return
			}
			// Check if HTML file matching route exists (Next.js export)
			htmlPath := filePath + ".html"
			if stat, err := os.Stat(htmlPath); err == nil && !stat.IsDir() {
				c.File(htmlPath)
				return
			}
			// Fallback to index.html for client-side routing
			c.File(filepath.Join(staticDir, "index.html"))
		})
	}

	address := fmt.Sprintf("%s:%d", config.GlobalConfig.Host, config.GlobalConfig.Port) // 格式化拼接生成服务监听地址。
	log.Printf("Starting server on %s", address)                                        // 打印准备开始监听的日志。
	if err := router.Run(address); err != nil {                                         // 启动 HTTP 服务开始接收请求。
		log.Fatalf("Server failed to run: %v", err) // 如果运行失败，强制崩溃退出并打印日志。
	} // 结束运行校验。
} // 结束 main 函数。
