package main // 声明 main 主包。

// 引入所需标准库，以及 Gin 框架和内部编写的配置、数据库、事件处理器和广播 Hub。
import (
	"fmt" // 用于进行格式化拼接生成监听地址字符串。
	"log" // 用于输出后台服务的启动和错误日志。
	"net/http" // 包含标准 HTTP 状态码定义。

	"github.com/gin-gonic/gin" // Gin Web 核心路由与上下文。
	"github.com/woowonjae1/52hzAgents/workspace/backend_go/internal/config" // 环境变量加载包。
	"github.com/woowonjae1/52hzAgents/workspace/backend_go/internal/db" // 数据库初始化与 GORM 控制包。
	"github.com/woowonjae1/52hzAgents/workspace/backend_go/internal/handlers" // 路由处理器实现包（新增）。
	"github.com/woowonjae1/52hzAgents/workspace/backend_go/internal/hub" // 消息广播 Hub 中继包（新增）。
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
	hub.InitHub() // 新增：初始化并运行高并发的实时消息分发 Hub 中心。

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
		v1.POST("/events", handlers.SendEvent) // 新增：客户端或 Agent 提交新事件的接口。
		v1.GET("/events/stream", handlers.StreamEventsSSE) // 新增：建立 SSE 单向实时数据推送的接口。
		v1.GET("/events/ws", handlers.StreamEventsWS) // 新增：建立 WebSocket 双向实时数据流通道的接口。
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
