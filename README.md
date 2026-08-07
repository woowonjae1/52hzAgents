# 52Hz Agent Platform

**52Hz Agent Platform** 是一个本地优先（Local-First）、高效可自托管的多智能体协作平台：人类与多个 AI 编码 Agent（OpenClaw、Pi、Claude Code、Cursor 等）在同一个工作区里共享会话、任务看板、文件沙箱与浏览器控制权。

---

## ⚡ 核心架构

```text
 ┌───────────────────────────────┐
 │      Next.js 前端 UI          │
 │   (workspace/frontend)        │
 └─────────────┬─────────────────┘
                │ (HTTP / SSE / WebSocket)
                ▼
 ┌───────────────────────────────┐
 │      Go 后端服务               │
 │   (workspace/backend)         │
 └─────────────┬─────────────────┘
                │ (SQLite WAL 驱动 / GORM)
                ▼
 ┌───────────────────────────────┐
 │      持久化数据库 / 文件沙箱     │
 └───────────────────────────────┘
                ▲
                │ (REST / Realtime Event Engine)
 ┌──────────────┴───────────────────────────────────────────────────┐
 │                  Agent 连接器守护进程 (`wwj`)                     │
 │                     (packages/wwj)                              │
 │                                                                  │
 │              OpenClaw · Pi · Claude Code · Cursor · Codex        │
 └──────────────────────────────────────────────────────────────────┘
```

---

## 📂 代码库地图

```text
52hzAgents/
├── workspace/
│   ├── backend/              # Go 后端 (Gin + GORM + SQLite)
│   │   ├── cmd/server/       # 服务入口 (server.exe)
│   │   └── internal/
│   │       ├── handlers/     # RESTful 路由、Todos、文件、Agent 目录与运行时
│   │       ├── hub/          # SSE 消息与实时事件广播总线
│   │       └── db/           # SQLite 高性能数据引擎
│   └── frontend/             # Next.js 极速前端 UI
│       ├── app/              # App Router 页面
│       └── components/       # 聊天视图、Agent 站台、Task 任务看板、设置面板
└── packages/
    └── wwj/                  # Agent 连接器守护进程与 CLI (`wwj`)
        └── src/adapters/     # 各 Agent CLI 直连适配器 (OpenClaw, Pi, Claude 等)
```

---

## 🚀 快速开始

在 Windows 环境下运行一键启动脚本即可：

```powershell
# 启动 Go 后端 (localhost:8000)、前端 UI (localhost:3005) 与 Agent Connector Daemon
.\workspace\dev-sqlite.ps1

# 停止全部服务：
.\workspace\dev-sqlite.ps1 -Stop
```

启动完成后，直接在浏览器中访问：**[http://localhost:3005](http://localhost:3005)**

---

## 🤖 接入 Agent

通过本地守护进程连接或管理 Agent：

```bash
# 启动守护进程
node packages/wwj/bin/agent-connector.js up --endpoint http://localhost:8000

# 查看守护进程状态
node packages/wwj/bin/agent-connector.js status

# 停止守护进程
node packages/wwj/bin/agent-connector.js down
```

---

## 📄 许可证

本项目采用 [MIT License](LICENSE) 授权。
