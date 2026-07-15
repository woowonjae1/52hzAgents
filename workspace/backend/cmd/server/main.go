package main // 声明 main 主包。

// 引入所需标准库，以及 Gin 框架和内部编写的配置、数据库、事件处理器、广播 Hub 以及后台调度器。
import (
	"fmt" // 用于进行格式化拼接生成监听地址字符串。
	"log" // 用于输出后台服务的启动和错误日志。
	"net/http" // 包含标准 HTTP 状态码定义。

	"github.com/gin-gonic/gin" // Gin Web 核心路由与上下文。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/config" // 环境变量加载包。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/db" // 数据库初始化与 GORM 控制包。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/handlers" // 路由处理器实现包。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/hub" // 消息广播 Hub 中继包。
	"github.com/woowonjae1/52hzAgents/workspace/backend/internal/scheduler" // 后台定时与周期任务调度包（新增）。
)

func main() { // 服务程序运行主入口函数。
	log.Println("Initializing 52hzAgents Workspace Server (Go Edition)...") // 打印初始化提示日志。

	// Load configuration
	config.LoadConfig() // 调用并加载所有的环境变量配置。
	log.Printf("Configuration loaded: Host=%s, Port=%d, AuthMode=%s", // 打印已加载的配置项。
		config.GlobalConfig.Host, // 监听 Host。
		config.GlobalConfig.Port, // 监听 Port。
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

	// Core API routes
	v1 := router.Group("/v1") // 注册 v1 API 版本的路由组。
	{ // 路由组定义作用域。
		v1.GET("/health", func(c *gin.Context) { // 注册服务健康状况接口。
			c.JSON(http.StatusOK, gin.H{ // 正常返回 200 OK 并列出当前的属性状态。
				"status":      "ok", // 状态正常。
				"service":     "52hzagents-workspace-backend", // 服务名标识。
				"auth_mode":   config.GlobalConfig.AuthMode, // 当前鉴权模式。
				"db_dialect":  db.DB.Dialector.Name(), // 当前数据库驱动类型。
			}) // 渲染返回。
		}) // 结束健康状况路由。

		// 注册实时事件接口路由组：
		v1.POST("/events", handlers.SendEvent) // 客户端或 Agent 提交新事件的接口。
		v1.GET("/events/stream", handlers.StreamEventsSSE) // 建立 SSE 单向实时数据推送的接口。
		v1.GET("/events/ws", handlers.StreamEventsWS) // 建立 WebSocket 双向实时数据流通道的接口。

		// 注册工作区管理接口：
		v1.POST("/workspaces", handlers.CreateWorkspace) // 新建工作区接口。
		v1.GET("/workspaces/:workspace_id", handlers.GetWorkspace) // 获取指定工作区详情。
		v1.DELETE("/workspaces/:workspace_id", handlers.DeleteWorkspace) // 软删除工作区。
		v1.PATCH("/workspaces/:workspace_id/channels/:channel_name", handlers.PatchChannel) // 修改会话通道属性。
		v1.GET("/workspaces/:workspace_id/channels/:channel_name", handlers.GetChannel) // 获取单通道详情。

		// 注册 Agent 节点接入网络接口：
		v1.POST("/join", handlers.JoinNetwork) // Agent 登入工作区网络接口。
		v1.POST("/leave", handlers.LeaveNetwork) // Agent 退出工作区网络接口。
		v1.POST("/workspaces/:workspace_id/presence", handlers.UpdatePresence) // Agent 定时在线心跳保活接口。

		// 注册共享文件管理接口：
		v1.POST("/files", handlers.UploadFileMultipart) // multipart/form-data 文件上传。
		v1.POST("/files/base64", handlers.UploadFileBase64) // Base64 JSON 格式文件上传（面向 Agent）。
		v1.GET("/files", handlers.ListFiles) // 列出工作区内的文件列表（分页）。
		v1.GET("/files/:file_id/info", handlers.GetFileInfo) // 获取单一文件元数据信息。
		v1.GET("/files/:file_id", handlers.DownloadFile) // 物理文件流式下载读取接口。
		v1.DELETE("/files/:file_id", handlers.DeleteFile) // 逻辑删除文件及其物理存储。

		// 注册规划辅助接口 (Todos/Timers/Routines) —— 新增：
		v1.PUT("/todos", handlers.PutTodos) // 批量保存并重排序代办事项。
		v1.GET("/todos", handlers.GetTodos) // 查询指定过滤条件下的代办项。

		v1.POST("/timers", handlers.CreateTimer) // 创建单次定时消息提醒计时器。
		v1.GET("/timers", handlers.ListTimers) // 列出活跃状态的计时器。
		v1.DELETE("/timers/:timer_id", handlers.DeleteTimer) // 取消定时提醒。

		v1.POST("/routines", handlers.CreateRoutine) // 创建周期性循环执行任务。
		v1.GET("/routines", handlers.ListRoutines) // 列出活跃中的循环任务。
		v1.DELETE("/routines/:routine_id", handlers.DeleteRoutine) // 撤销或取消周期任务。
	} // 结束路由组作用域。

	// Legacy /health endpoint matching the health checks
	router.GET("/api/health", func(c *gin.Context) { // 兼容旧有的 /api/health 查询路由。
		c.JSON(http.StatusOK, gin.H{ // 返回正常 200。
			"status": "ok", // 回复状态。
		}) // 渲染。
	}) // 结束。

	address := fmt.Sprintf("%s:%d", config.GlobalConfig.Host, config.GlobalConfig.Port) // 格式化拼接生成服务监听地址。
	log.Printf("Starting server on %s", address) // 打印准备开始监听的日志。
	if err := router.Run(address); err != nil { // 启动 HTTP 服务开始接收请求。
		log.Fatalf("Server failed to run: %v", err) // 如果运行失败，强制崩溃退出并打印日志。
	} // 结束运行校验。
} // 结束 main 函数。
