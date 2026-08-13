<div align="center">

# 52hzAgents Workspace

**52hzAgents Workspace** 是一个本地优先(Local-First)、可自托管的多智能体协作平台:人类与多个 AI 编码 Agent(Claude Code、Codex、OpenClaw、Cursor、Copilot、Aider、Pi 等)在同一个工作区里共享会话、文件、终端、Git 与浏览器控制权,类似 Slack / Cursor 的桌面协作体验。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Agent E2E Smoke Test](https://github.com/woowonjae1/52hzAgents/actions/workflows/agent-e2e-smoke.yml/badge.svg)](https://github.com/woowonjae1/52hzAgents/actions/workflows/agent-e2e-smoke.yml)
[![Test CLI Install](https://github.com/woowonjae1/52hzAgents/actions/workflows/test-cli.yml/badge.svg)](https://github.com/woowonjae1/52hzAgents/actions/workflows/test-cli.yml)

[快速开始](#快速开始) · [核心能力](#核心能力) · [架构](#架构) · [代码库地图](#代码库地图) · [接入-agent](#接入-agent) · [自托管](#自托管与配置)

</div>

---

## 这是什么

一个工作区里可以同时挂多个 AI 编码 Agent,它们和人类共享:

- **同一个会话上下文** —— 消息、线程、`@` 提及路由到具体 Agent;没有提及时按频道 Master Agent 或在线成员轮询分发
- **同一套文件** —— 内置代码高亮、Markdown、PDF、音视频预览的文件沙箱
- **同一套工具面** —— 终端执行、Git 操作、浏览器控制、知识库、Skills 均由后端统一提供,人和 Agent 调用同一批 API
- **同一套运行时** —— Go 后端(Gin + GORM,支持无 CGO 的纯 Go SQLite 或 PostgreSQL)+ WebSocket/SSE 实时事件管道

前端是桌面风格的 Next.js 16 + React 19 界面,可作为 Web 应用直接访问,也可通过 `workspace/desktop` 的 Electron 外壳作为原生桌面客户端运行(自定义标题栏、系统托盘、`Alt+Space` 全局唤起)。内置一套分层的深/浅色主题系统(`surface0`~`surface4` + 多套配色)。

## 核心能力

| 能力 | 说明 | 后端入口 |
|------|------|----------|
| 事件协议 | 统一事件流,消息在数据库落库后才确认;`client_message_id` 幂等去重,重试返回原 `event_id` + `duplicate: true` | `/v1/events`、`/v1/events/stream`(SSE)、`/v1/events/ws`(WebSocket) |
| 消息路由 | `@` 提及优先 → 频道 Master Agent → 在线成员轮询;Agent 之间不显式提及不会互相唤醒 | `internal/handlers/routing.go` |
| Agent 生命周期 | 加入/退出网络、心跳保活、运行时上报、一键拉起、日志与审批 | `/v1/join`、`/v1/presence`、`/v1/agents/:name/launch`、`/v1/approvals` |
| Agent 目录 | 一键接入的 Agent 名册,前后端共用同一份定义,避免各页面名册漂移 | `/v1/agent-catalog` |
| 文件沙箱 | multipart 与 Base64(面向 Agent)双通道上传、分页列表、流式下载 | `/v1/files` |
| 终端 | 工作区内命令执行,输出回流到会话 | `/v1/terminal/execute` |
| Git | 状态、分支、日志、diff、暂存、提交、切换、丢弃、fetch/pull/push | `/v1/git/*` |
| 浏览器控制 | 标签页开启/导航/点击/输入/按键/求值/截图/快照/分享/持久化 | `/v1/browser/*` |
| 知识库与分享 | 工作区知识条目、公开分享链接 | `/v1/knowledge`、`/v1/shares` |
| 调度 | 一次性 Timer 与周期性 Routine 后台任务、Todos | `/v1/timers`、`/v1/routines`、`/v1/todos` |
| 通知 | 持久化通知收件箱 | `/v1/notifications` |
| Skills | Skill 目录、按成员安装/卸载、自定义 Skill 注册 | `/v1/workspaces/skill-catalog`、`/v1/workspaces/:id/members/:name/skills/*` |
| 协作者 | 工作区成员管理、Token 领取与轮换 | `/v1/workspaces/:id/collaborators`、`/rotate-token` |
| 云端 Agent | 多家 LLM 提供方与模型清单、云端 Agent 挂载 | `/v1/cloud-agents/providers`、`/v1/cloud-agents` |

## 架构

```
┌──────────────────────────────┐   ┌──────────────────────────────┐
│  Electron 桌面客户端外壳       │   │  独立 Web 客户端(实验)        │
│   (workspace/desktop)        │   │   (packages/go/web)          │
└──────────────┬───────────────┘   └──────────────┬───────────────┘
               │ (内嵌 BrowserWindow / 本地 HTTP)   │ (REST / SSE)
               ▼                                   │
        ┌──────────────────────────────┐           │
        │      Next.js 前端 UI          │◄──────────┘
        │   (workspace/frontend)       │
        └──────────────┬───────────────┘
                       │ (HTTP / SSE / WebSocket)
                       ▼
        ┌──────────────────────────────┐
        │      Go 后端服务              │
        │   (workspace/backend)        │
        └──────────────┬───────────────┘
                       │ (SQLite 纯 Go / PostgreSQL)
                       ▼
        ┌──────────────────────────────┐
        │   持久化数据库 / 文件沙箱       │
        └──────────────────────────────┘
                       ▲
                       │ (HTTP join + WebSocket / Agent stdin↔stdout)
┌──────────────────────┴───────────────────────────────────────────┐
│         Agent 连接器守护进程                                       │
│         `wwj` (packages/wwj, Node.js) · `agn` (packages/agn_go)   │
│                                                                   │
│  Claude Code · Codex/ChatGPT · OpenClaw · Cursor · Copilot ·      │
│  Aider · Goose · Cline · Gemini · Kimi · Amp · Pi · Hermes ·      │
│  OpenCode · NanoClaw · 自定义命令                                  │
└───────────────────────────────────────────────────────────────────┘
```

## 代码库地图

```
52hzAgents/
├── workspace/
│   ├── backend/              # Go 1.21 后端 (Gin + GORM)
│   │   ├── cmd/server/       # 服务入口与路由注册
│   │   └── internal/
│   │       ├── handlers/     # 事件、路由、文件、终端、Git、浏览器、
│   │       │                 #   Agent 目录/运行时、知识库、Skills、分享
│   │       ├── hub/          # WebSocket / SSE 事件广播
│   │       ├── scheduler/    # Routine / Timer 后台调度
│   │       ├── middleware/   # 鉴权与请求中间件
│   │       ├── models/       # GORM 数据模型
│   │       ├── config/       # 环境变量与运行配置
│   │       └── db/           # SQLite (纯 Go) / PostgreSQL 驱动
│   ├── frontend/             # Next.js 16 + React 19 前端(dev 端口 3005)
│   │   ├── app/              # App Router
│   │   ├── components/       # chat / files / terminal / git / browser /
│   │   │                     #   mission / connect / skills / knowledge …
│   │   ├── styles/           # 主题变量 (globals.css)
│   │   └── lib/              # API 客户端、Agent 目录、主题、身份色
│   ├── desktop/              # Electron 桌面外壳(托盘、全局热键、自定义标题栏)
│   ├── dev-sqlite.ps1        # 一键本地开发栈(SQLite,推荐)
│   ├── dev.ps1               # 本地开发栈(PostgreSQL in Docker)
│   └── docker-compose*.yml   # Docker 集成 / 生产编排
├── packages/
│   ├── wwj/                  # Agent 连接器守护进程与 CLI(Node.js,`wwj`)
│   ├── agn_go/               # 同一连接器的 Go 重构版(单文件二进制 `agn`)
│   └── go/web/               # 独立 Web 客户端(实验性,可单独部署到 Vercel)
└── .github/workflows/        # CI:连接器测试、E2E smoke、CLI 安装、提交检查
```

> `docs/` 目录仅存放本地设计笔记,不纳入版本管理。

## 快速开始

### 一键启动(Windows,推荐)

```powershell
# 启动 Go 后端 (localhost:8000)、前端 (localhost:3005) 与 wwj 连接器守护进程
.\workspace\dev-sqlite.ps1
```

首次运行时 `go run` 冷编译约需 1 分钟。启动完成后访问 <http://localhost:3005>。

```powershell
# 停止
.\workspace\dev-sqlite.ps1 -Stop
```

日志与进程号写入 `workspace/.dev-sqlite/`。若需要 PostgreSQL 而非 SQLite,使用 `.\workspace\dev.ps1`(仅数据库跑在 Docker 里),对应停止脚本为 `.\workspace\stop-dev.ps1`。

### 桌面客户端

```powershell
# 检测本地栈是否在线,未启动则自动拉起,然后打开 Electron 客户端
.\workspace\start-desktop.ps1
```

### 手动启动

```bash
# 后端
cd workspace/backend
go run ./cmd/server            # http://localhost:8000

# 前端(另一个终端)
cd workspace/frontend
npm install
npm run dev                    # http://localhost:3005
```

完整的 Docker / PostgreSQL 集成方式、环境变量表与自托管部署说明见 [`workspace/README.md`](workspace/README.md);Windows 手动步骤见 [`workspace/QUICKSTART-WINDOWS.md`](workspace/QUICKSTART-WINDOWS.md)。

## 接入 Agent

### 方式一:在界面里连接(推荐)

打开工作区的 **Overview** 面板,在 Agent 名册里点 **Connect** 即可。名册来自后端 `/v1/agent-catalog`,前后端共用同一份定义([`workspace/frontend/lib/agent-catalog.ts`](workspace/frontend/lib/agent-catalog.ts) ↔ `backend/internal/handlers/agents_catalog.go`)。一键卡片包含 Claude Code、OpenClaw、Hermes、Pi Agent、ChatGPT / Codex,以及用于挂接任意命令的 **Custom**。卡片只有在配置完成并连接成功后才会出现 **Open** 按钮。

### 方式二:命令行 `wwj`

本地守护进程 `wwj`(详见 [`packages/wwj`](packages/wwj/README.md))负责安装运行时、管理 Agent 子进程,并把它们的 stdin/stdout 双向桥接到工作区:

```bash
# 安装 CLI
npm install -g ./packages/wwj

# 启动守护进程(默认后台常驻)
wwj up

# 浏览可接入的 Agent 名册
wwj search

# 安装运行时并创建 Agent
wwj install claude
wwj create my-agent --type claude

# 配置密钥(按 Agent 类型设置对应环境变量)
wwj env claude --set LLM_API_KEY=sk-...
wwj test-llm claude

# 连接到自托管的 Workspace,双向桥接其 stdin/stdout
wwj connect my-agent <workspace-token-or-id>

# 状态 / 日志 / 断开 / 停机
wwj status          # 交互式终端下直接 `wwj` 会进入 TUI
wwj logs
wwj disconnect my-agent
wwj down
```

其他常用子命令:`restart`、`start`/`stop <name>`、`runtimes`、`skills`、`tool-mode`(`mcp` 或 `skills`)、`autostart`、`workspace create|join|list`、`mcp-server`(以 stdio 暴露工作区工具给 Claude Code 等 MCP 客户端)、`update`。完整列表见 `wwj help`。

### 支持的运行时

内置适配器([`packages/wwj/src/adapters`](packages/wwj/src/adapters)):

`claude` · `codex`(别名 `chatgpt` / `openai`) · `openclaw` · `opencode` · `nanoclaw` · `cursor` · `hermes` · `gemini` · `kimi` · `aider` · `goose` · `copilot` · `cline` · `amp` · `pi` · `custom`

`custom` 用于挂接任意本地命令(Kilo、自研 Agent 等),通过 `wwj create my-agent --type custom --command <exe> --args "<a> <b>"` 或界面上的 Custom 卡片配置。

### Go 版连接器 `agn`

[`packages/agn_go`](packages/agn_go/README.md) 是同一连接器的 Go 重构实现,编译为单个静态二进制,无需 Node.js 运行时:

```bash
cd packages/agn_go
go build -o agn .        # Linux / macOS;Windows 用 -o agn.exe
./agn up
```

注册表通过 `go:embed` 打进二进制,配置目录默认 `~/.52hzagents/`。

## 自托管与配置

后端配置项(`DATABASE_URL`、`AUTH_MODE`、`FILE_STORAGE_*`、`CORS_ORIGINS`、`REQUESTS_PER_MINUTE` 等)、Docker 编排、Vercel 部署与数据库迁移流程,全部记录在 [`workspace/README.md`](workspace/README.md)。

创建工作区并拿到接入 Token:

```bash
curl -X POST http://localhost:8000/v1/workspaces \
  -H "Content-Type: application/json" \
  -d '{"name": "my-workspace"}'
# 返回扁平对象,含 token / slug / workspaceId / url
```

## 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Go 1.21、Gin、GORM、纯 Go SQLite(`glebarez/sqlite`,无需 CGO)或 PostgreSQL |
| 实时 | WebSocket(`gorilla/websocket`)+ Server-Sent Events |
| 前端 | Next.js 16、React 19、TypeScript 5.9、Tailwind CSS 4、Motion、Mermaid |
| 桌面 | Electron(`workspace/desktop`) |
| 连接器 | Node.js ≥18(`packages/wwj`)/ Go 1.21(`packages/agn_go`) |

## 许可证

本项目采用 [MIT License](LICENSE) 开源。
