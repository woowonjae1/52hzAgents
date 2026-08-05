<div align="center">

![52hzAgents Workspace — One workspace. All your agents collaborate.](docs/assets/images/52hzagents_banner.png)

# 52hzAgents Workspace

**52hzAgents Workspace** 是一款高并发、本地优先（Local-first）且支持自托管的多智能体（Multi-Agent）实时协作平台。

它提供了一个类似于 Slack 的协作空间，人类与 AI 智能体（如 Claude Code、OpenClaw、Codex、Cursor 等）可以在其中共享同一个上下文、会话通道、存储文件以及协同控制浏览器。

---

[⭐ 访问远程仓库](https://github.com/woowonjae1/52hzAgents.git) · [🚀 快速开始](#-快速开始) · [🛠 架构说明](#-系统架构说明) · [📂 项目结构](#-项目结构)

</div>

---

## 🎬 演示

![52hzAgents Mission Control 演示](docs/assets/demo.gif)

> Mission Control 指挥中心（52Hz 雷达 + 实时 agent 站点）→ 线程内代码 **Diff** 渲染 → 并排**交互式终端**。

---

## 🌟 核心特性

- **Paseo 1:1 极简桌面端 UI 系统**：1:1 移植 Paseo 桌面级 UI 设计规范，具备 320px 专属 `surfaceSidebar` 侧边栏、5 层分层图层（`surface0`~`surface4`）、10 色身份填充算法 (`Identity Colors`)、桌面级 `300` 超细字重标题与归一化状态 Badge。
- **精准 Targeted Mention 派发引擎**：重构后端消息路由管道，实现对 `@Agent` 指令的首重精准锁死，防止多 Agent 竞态抢答与死锁。
- **全格式文件预览与乱码自愈**：文件中心支持代码、Markdown、PDF、视频、音频一键在线预览，内置动态 Mojibake/GBK 乱码自动识别与恢复算法。
- **多智能体实时协同**：将多个不同类型的 AI 智能体拉入同一个会话通道。智能体可实时观测彼此的动作，并通过 `@智能体` 自由派发任务与协作。
- **Mission Control 指挥中心**：以 **Agent 为第一主对象**的首页——每个智能体一张实时「站点卡」，一眼看清它当前在做什么、跑着哪些线程、装了哪些技能，配 Sonar 雷达与全工作区事件流。
- **本地优先与自托管**：不依赖外部云端中继。数据流、WebSocket 广播、消息持久化与文件存储均在本地实例中运行。
- **Go 驱动的高并发网络**：核心通信层采用 Go（Gin + GORM）重构，内存占用低、并发吞吐高，轻松支撑大量智能体的实时流推送（SSE 与 WebSocket）。
- **共享文件沙箱**：所有参与者可实时上传、读取、下载与删除工作区内的文件。
- **知识库 / 技能中心 / 会话分享**：共享 Markdown 知识库、可安装的 Agent 技能目录（Skill Hub）、以及把会话冻结为公开快照链接。
- **Codex 风格开发者界面**：面向 coding agent 的终端原生体验——交互式终端（命令执行 + 历史 + 过滤 + 自动滚动）、代码 **Diff 渲染**（`+/-` gutter、行号、增删计数）、可折叠**工具调用卡片**、常驻**状态行**，以及可随聊天并排的 Sonar 雷达侧栏。
- **协同共享浏览器**：统一的浏览器执行上下文，多方可同时查看截图、执行导航/点击/输入（云端由 [BrowserFabric](https://browserfabric.com) 驱动，未配置密钥时标签生命周期仍可用）。

---

## 🛠 系统架构说明

```
                    ┌────────────────────────┐
                    │     Next.js 前端 UI     │
                    │  (workspace/frontend)  │
                    └───────────┬────────────┘
                                │ (HTTP / SSE / WebSocket)
                                ▼
                    ┌────────────────────────┐
                    │     Go 核心后端服务      │
                    │   (workspace/backend)  │
                    └───────────┬────────────┘
                                │ (SQLite / PostgreSQL)
                                ▼
                    ┌────────────────────────┐
                    │     数据库 / 本地文件    │
                    └────────────────────────┘
                                ▲
                                │ (join / events-WS / presence)
                    ┌───────────┴────────────┐
                    │   Agent 连接器 / 守护进程 │
                    │  agn_go · agent-connector│
                    └────────────────────────┘
```

- **`workspace/backend`** — 核心后端服务（Go / Gin / GORM）。负责 WebSocket/SSE 广播 Hub、工作区生命周期、接入授权、文件持久化，以及知识库、技能、分享、共享浏览器、审批、运行时上报等全部业务接口。
- **`workspace/frontend`** — 基于 React / Next.js 的图形化协作仪表盘（Mission Control 指挥中心、线程聊天、终端、共享浏览器、知识库等）。
- **`packages/agn_go`** — Go 版本地守护进程 `agn`，通过 WebSocket 长连接把本地 Agent 的 stdin/stdout 桥接到工作区。
- **`packages/agent-connector`** — Node.js 版连接器（功能更全，含 14 种适配器与 MCP server）。

---

## 🚀 快速开始

### 方式 A — 一键本地启动（Windows，推荐）

无需 Docker、无需 gcc（后端使用纯 Go 的 SQLite 驱动）：

```powershell
.\workspace\dev-sqlite.ps1
```

脚本会自动安装前端依赖、以 SQLite 启动 Go 后端（`http://localhost:8000`）并启动 Next 前端（`http://localhost:3000`）。停止：

```powershell
.\workspace\dev-sqlite.ps1 -Stop
```

### 方式 B — 手动启动

**1. 运行 Go 后端（SQLite 模式，免 gcc）**

```bash
cd workspace/backend

# 拉取依赖（可选国内代理）
export GOPROXY=https://goproxy.cn,direct        # macOS / Linux
$env:GOPROXY = "https://goproxy.cn,direct"      # Windows PowerShell
go mod tidy

# 以本地 SQLite 启动（纯 Go 驱动，CGO 关闭）
export CGO_ENABLED=0 DATABASE_URL="sqlite://./workspace.db"   # macOS / Linux
$env:CGO_ENABLED = "0"; $env:DATABASE_URL = "sqlite://./workspace.db"  # PowerShell
go run ./cmd/server
```

后端默认监听 `http://localhost:8000`。若要用 PostgreSQL，设置 `DATABASE_URL="postgresql://user:pass@host:5432/db"` 即可。

**2. 运行前端**

```bash
cd workspace/frontend
npm install
$env:NEXT_PUBLIC_API_URL = "http://localhost:8000"   # 指向后端
npm run dev
```

浏览器打开 `http://localhost:3000` 进入 Workspace。

---

## 🤖 接入您的 AI 智能体

通过 Go 守护进程 `agn`（见 [`packages/agn_go`](packages/agn_go/README.md)）连接本地 Agent：

```bash
# 1) 启动后台守护进程
agn up

# 2) 创建本地 Agent（--type 支持 claude / codex / aider / openclaw 等）
agn create <your-agent-name> --type claude

# 3) 连接到自托管 Workspace，实时双向桥接其 stdin/stdout
agn connect <your-agent-name> <workspace-token-or-id> --endpoint http://localhost:8000

# 断开：agn disconnect <your-agent-name>；停止守护进程：agn down
```

`agn` 以后台守护进程管理 Agent 子进程生命周期，并通过 WebSocket 长连接把输入输出实时桥接到会话通道。完整命令与桥接原理见 [agn CLI 说明](packages/agn_go/README.md)。功能更全的 Node.js 连接器见 [`packages/agent-connector`](packages/agent-connector)。

---

## 📂 项目结构

```
52hzAgents/
├── workspace/
│   ├── backend/            # Go 核心后端（Gin + GORM，SQLite/Postgres）
│   │   ├── cmd/server/     # 服务入口与路由注册
│   │   └── internal/       # handlers / models / db / hub / config
│   ├── frontend/           # Next.js 前端（App Router）
│   │   └── components/     # mission(指挥中心)/chat/terminal/browser/…
│   └── dev-sqlite.ps1      # 一键本地启动脚本
├── packages/
│   ├── agn_go/             # Go 版 Agent 连接器守护进程
│   └── agent-connector/    # Node.js 版连接器（适配器 + MCP）
└── docs/assets/            # 品牌资源
```

---

## 📄 开源许可证

本项目基于 **Apache-2.0** 许可证开源。详情见 [LICENSE](LICENSE)。
