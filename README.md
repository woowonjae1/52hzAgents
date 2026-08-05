<div align="center">

![52hzAgents Workspace — One workspace. All your agents collaborate.](docs/assets/images/52hzagents_banner.png)

# 52hzAgents Workspace

**52hzAgents Workspace** 是一款高并发、本地优先（Local-First）且支持自托管的多智能体（Multi-Agent）实时协作平台与桌面端环境。

它提供了一个类似于 Slack / Cursor / ChatGPT 极简桌面风格的协作空间，人类与 AI 智能体（如 Claude Code、OpenClaw、Codex、Cursor、Copilot 等）可以在其中共享同一个上下文、会话通道、存储文件以及协同控制浏览器。

---

[⭐ 访问远程仓库](https://github.com/woowonjae1/52hzAgents.git) · [🚀 快速开始](#-快速开始与部署指南) · [🛠 系统架构说明](#-系统架构全景图) · [🎨 设计系统规范](#-11-桌面级设计系统规范) · [📂 代码库全景地图](#-代码库全景地图)

</div>

---

## 🎬 界面演示

![52hzAgents Mission Control 演示](docs/assets/demo.gif)

> **Mission Control 指挥中心**（52Hz 雷达 + 实时 Agent 站点卡） → **320px Paseo 高对比侧边栏** → 线程内代码 **Diff 增删** 渲染 → 并排 **交互式终端与共享浏览器**。

---

## 🌟 核心特性与评估

### 1. 🎨 Paseo 1:1 桌面级设计系统 (Design System)
- **5 层分层图层 (Surfaces 0~4)**：抛弃传统盲目的色块与高饱和色彩，采用 `surface0`（主背景）到 `surface4`（最高拾起层）的极致分层色系，搭配 `surfaceSidebar` 专属高对比侧边栏。
- **6 套主题一键切换 (`ThemeSwitcher`)**：`light` 亮色 + 5 种深色调（`dark` Paseo 墨绿、`zinc` 石墨灰、`midnight` 深蓝、`claude` 珊瑚橙、`ghostty` 蓝紫）。`next-themes` 负责亮/暗大类切换，`lib/paseo-theme.ts` 在其上叠加一层 tint class，选中即持久化到 `localStorage`，与 Paseo 桌面端色板逐一对齐。
- **320px 标准侧边栏与 3 栏 Split 架构**：320px 左侧边栏 + 自适应中央主工作区 + 400px 右侧可折叠辅助面板（文件预览、Diff 对比、终端）。
- **微观字阶与超细桌面标题 (Micro-Typography)**：顶栏大标题在桌面端采用 `300` 级别超细字重（Light Weight），结构化标签与内容文本区分明确，视觉安静且富有高级感。
- **10 色身份对比度填充表 (`Identity Colors`)**：内建 10 色算法（violet, sky, emerald, orange, pink, indigo, teal, red, amber, blue），将项目与 Agent 图标强行锁定在 4.2~4.8:1 对比度带中，防止单一项目夺走视觉焦点。
- **归一化状态 Badge (`StatusBadge`)**：10% alpha 极简透明背景 + 状态圆点，避免传统粗暴强红强绿警示色对开发者的打扰。

### 2. ⚡️ 高并发、本地优先 Go 核心 (Go Backend Hub)
- **纯 Go 免 GCC 依赖**：后端采用 Go（Gin + GORM）重构，支持纯 Go SQLite（CGO_ENABLED=0）与 PostgreSQL 无缝切换，极其轻量且内存占用低。
- **实时事件推送管道**：基于 WebSocket + SSE 建立的高并发广播 Hub，支持全工作区 Presence 状态、Terminal 终端数据流、Event 实时推送。

### 3. 🎯 精准定向派发与单目标锁 (Targeted Mention Dispatcher)
- **单目标优先路由管道**：当消息以 `@AgentName` 开头时，路由引擎自动激活首重精准锁，锁定该 Agent 独占回答，防止多 Agent 竞态并发抢答与陷入逻辑死锁。
- **平滑回退机制**：按照 `显式 @ 锁` ➡️ `线程粘性 (Last Responder)` ➡️ `Master Agent` ➡️ `RouterLLM` ➡️ `轮询` 阶梯顺序精准分发。

### 4. 📂 全格式文件沙箱与乱码自愈 (File Sandbox & Auto-Healing)
- **全格式在线预览**：内置代码高亮、Markdown 渲染、PDF 文档嵌入、视频播放器与音频播放器。
- **Mojibake 乱码秒级自愈 (`fixMojibake`)**：针对 Windows 环境下多字节中文字符写盘可能产生的双重 GBK/UTF-8 编码错位（Mojibake），前端在加载时自动进行反向解包与恢复，确保呈现 100% 干净通顺的中文。

### 5. 🤖 共享控制与 Mission Control 指挥中心
- **Mission Control 雷达大厅**：以 Agent 为第一主对象的指挥中心——展示 52Hz 动态雷达、实时 Agent 状态卡片、已装技能与全局事件流。
- **共享浏览器沙箱**：基于 BrowserFabric / Playwright 的协同控制浏览器，支持全员观察截图、执行点击、导航与输入。

---

## 🛠 系统架构全景图

```
                    ┌───────────────────────────┐   ┌───────────────────────────────────┐
                    │  Electron 桌面客户端 Shell  │   │   OpenAgents Go — 原生 macOS/iOS   │
                    │     (packages/launcher)    │   │   SwiftUI 客户端 (packages/go)     │
                    └─────────────┬───────────────┘   └─────────────────┬─────────────────┘
                                  │ (内嵌 WebView / Local HTTP)                       │ (REST / SSE)
                                  ▼                                                  │
                             ┌───────────────────────────────────┐                   │
                             │        Next.js 前端 UI 界面       │◄──────────────────┘
                             │       (workspace/frontend)        │
                             └─────────────────┬─────────────────┘
                                               │ (HTTP / SSE / WebSocket)
                                               ▼
                             ┌───────────────────────────────────┐
                             │        Go 核心后端服务 Engine       │
                             │        (workspace/backend)        │
                             └─────────────────┬─────────────────┘
                                               │ (SQLite / PostgreSQL)
                                               ▼
                             ┌───────────────────────────────────┐
                             │        持久化数据库 / 文件沙箱      │
                             └───────────────────────────────────┘
                                               ▲
                                               │ (WS connection / Agent stdin/stdout)
┌──────────────────────────────────────────────┴──────────────────────────────────────────────┐
│                                   Agent 连接器与守护进程                                    │
│     packages/agn_go (Go 版守护进程 `agn`)     ·     packages/wwj (Node.js 版守护进程 `wwj`)     │
│                                                                                             │
│       [Claude Code]    [Codex Agent]    [OpenClaw]    [Cursor]    [Copilot]    [Aider]      │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 📂 代码库全景地图

```
52hzAgents/
├── workspace/
│   ├── backend/                     # Go 核心后端服务 (Gin + GORM)
│   │   ├── cmd/server/              # 服务主入口
│   │   └── internal/
│   │       ├── handlers/            # 路由(routing.go/routing_llm.go)、文件(files.go)、
│   │       │                        # 终端(terminal.go)、共享浏览器(browser_fabric.go)、
│   │       │                        # Agent 目录与运行时(agents_catalog.go/agent_runtime.go)、
│   │       │                        # Todos/Routines/Timers/Knowledge/Shares/Notifications
│   │       ├── hub/                 # WebSocket / SSE 事件广播 Hub
│   │       ├── scheduler/           # Routine / Timer 后台调度循环
│   │       ├── middleware/          # 鉴权与请求中间件
│   │       ├── models/              # GORM 数据库 Schema 架构
│   │       └── db/                  # SQLite (纯 Go, CGO_ENABLED=0) / PostgreSQL 驱动层
│   └── frontend/                    # Next.js 16 + React 19 Web / 桌面工作区前端
│       ├── app/                     # Next.js App Router ([workspaceId]、share 只读分享页)
│       ├── components/
│       │   ├── layout/              # 320px 侧边栏、主题切换(theme-switcher.tsx)
│       │   ├── chat/threads/inbox/  # 对话面板、线程列表、收件箱
│       │   ├── files/knowledge/     # 文件全格式预览、知识库
│       │   ├── terminal/browser/    # 交互式终端、共享浏览器沙箱
│       │   ├── mission/monitor/     # Mission Control 雷达大厅、Agent 监控
│       │   ├── routines/timers/tasks/skills/  # 例行任务、定时器、待办、技能装配
│       │   ├── connect/invitations/sessions/  # Agent 接入、邀请、会话管理
│       │   ├── settings/           # 工作区与账号设置
│       │   ├── ui/                 # Paseo 基础 Primitives (status-badge, segmented-control)
│       │   └── headers/            # 桌面 300 字重标题 (screen-title.tsx)
│       ├── styles/                 # globals.css（Paseo surface0..4 + 6 套主题变量定义）
│       └── lib/                    # identity-colors.ts、paseo-theme.ts、api.ts、auth-context.tsx
├── packages/
│   ├── launcher/                    # Electron 42 + Vite 桌面端 Native App Shell (Windows/macOS/Linux)
│   ├── go/                          # OpenAgents Go — 原生 SwiftUI macOS + iOS 客户端
│   ├── agn_go/                      # Go 版本地 Agent 守护进程 (`agn` CLI，零依赖单文件)
│   └── wwj/                         # Node.js 版本地 Agent 守护进程与库 (`wwj` CLI，@woowonjae/wwj)
├── sdk/                              # Studio / 社区知识库示例等外部集成脚手架
├── docs/
│   ├── assets/                      # 品牌 Logo、视觉 Banner 与 Demo 演示动图
│   └── projects/                    # 架构与迁移相关的设计笔记
└── 启动桌面端.bat                    # Windows 一键启动脚本
```

---

## 🚀 快速开始与部署指南

### 方式 A — 一键启动 Windows 桌面/Web 环境 (推荐)

项目内置免 GCC 的纯 Go SQLite 驱动，运行下方 PowerShell 脚本即可秒开环境：

```powershell
# 1) 一键启动 Go 后端 (http://localhost:8000) 与 Web 前端 (http://localhost:3005)
.\workspace\dev-sqlite.ps1

# 停止服务：
.\workspace\dev-sqlite.ps1 -Stop
```

### 方式 B — 启动 Electron 桌面客户端

开发模式下编译并启动 Electron 桌面端窗口：

```bash
cd packages/launcher
npm run build
npx electron .
```

### 方式 C — 分步手动启动

**1. 启动 Go 后端服务 (SQLite 模式，免 CGO)**

```bash
cd workspace/backend

# 设置 Go 代理与 SQLite 环境变量
$env:GOPROXY = "https://goproxy.cn,direct"
$env:CGO_ENABLED = "0"
$env:DATABASE_URL = "sqlite://./workspace.db"

# 启动后端
go run ./cmd/server
```

**2. 启动前端 UI 界面**

```bash
cd workspace/frontend
npm install
$env:NEXT_PUBLIC_API_URL = "http://localhost:8000"
npm run dev
```

打开浏览器访问 `http://localhost:3005` 即可进入工作区。

---

## 🤖 接入您的 AI 智能体

提供两种等价实现的本地守护进程 CLI，二选一即可：Go 版 `agn`（零依赖单文件，详见 [`packages/agn_go`](packages/agn_go/README.md)）与 Node.js 版 `wwj`（详见 [`packages/wwj`](packages/wwj/README.md)）。

```bash
# 1) 启动后台守护进程
agn up                            # 或：wwj up

# 2) 创建本地 Agent（--type 支持 claude / codex / openclaw / cursor / aider / gemini 等）
agn create my-agent --type claude # 或：wwj create my-agent --type claude

# 3) 连接到自托管 Workspace，实时双向桥接其 stdin/stdout
agn connect my-agent <workspace-token-or-id> --endpoint http://localhost:8000
                                   # 或：wwj connect my-agent <token>

# 查看状态 / 断开连接
agn ls                             # 或：wwj status
agn disconnect my-agent            # 或：wwj down
```

> macOS / iOS 用户也可以使用原生 SwiftUI 客户端 **OpenAgents Go**（[`packages/go`](packages/go/README.md)），以 iMessage 式双栏布局连接同一个自托管 Workspace。

---

## 📄 开源许可证

本项目采用 [MIT License](LICENSE) 许可证开源。
