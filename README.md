<div align="center">

![52hzAgents Workspace](docs/assets/images/52hzagents_banner.png)

# 52hzAgents Workspace

**52hzAgents Workspace** 是一个本地优先(Local-First)、可自托管的多智能体协作平台:人类与多个 AI 编码 Agent(Claude Code、Codex、OpenClaw、Cursor、Copilot、Pi 等)在同一个工作区里共享会话、文件与浏览器控制权,类似 Slack / Cursor 的桌面协作体验。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/woowonjae1/52hzAgents/actions/workflows/test-e2e.yml/badge.svg)](https://github.com/woowonjae1/52hzAgents/actions/workflows/test-e2e.yml)

[快速开始](#快速开始) · [架构](#架构) · [代码库地图](#代码库地图) · [接入 Agent](#接入-agent)

</div>

---

## 演示

![52hzAgents 界面演示](docs/assets/demo.gif)

Mission Control 概览面板 → 侧边栏 → 线程内代码 diff 渲染 → 交互式终端。

## 这是什么

一个工作区里可以同时挂多个 AI 编码 Agent,它们和人类共享:

- **同一个会话上下文** —— 消息、线程、@ 提及路由到具体 Agent 或按线程粘性/轮询分发
- **同一套文件** —— 内置代码高亮、Markdown、PDF、音视频预览的文件沙箱
- **同一套运行时** —— Go 后端(Gin + GORM,支持无 CGO 的纯 Go SQLite 或 PostgreSQL)+ WebSocket/SSE 实时事件管道

前端是桌面风格的 Next.js 界面(可作为 Web 应用或通过 Electron/SwiftUI 打包为桌面客户端),内置一套分层的深/浅色主题系统(`surface0`~`surface4` + 6 套配色)。

## 架构

```
┌───────────────────────────┐   ┌────────────────────────────────┐
│ Electron 桌面客户端 Shell   │   │  原生 macOS/iOS SwiftUI 客户端  │
│   (packages/launcher)      │   │  SwiftUI 客户端 (packages/go)   │
└─────────────┬───────────────┘   └────────────────┬────────────────┘
              │ (内嵌 WebView / 本地 HTTP)                    │ (REST / SSE)
              ▼                                              │
        ┌───────────────────────────────┐                    │
        │      Next.js 前端 UI          │◄───────────────────┘
        │   (workspace/frontend)        │
        └─────────────┬─────────────────┘
                       │ (HTTP / SSE / WebSocket)
                       ▼
        ┌───────────────────────────────┐
        │      Go 后端服务               │
        │   (workspace/backend)         │
        └─────────────┬─────────────────┘
                       │ (SQLite / PostgreSQL)
                       ▼
        ┌───────────────────────────────┐
        │      持久化数据库 / 文件沙箱     │
        └───────────────────────────────┘
                       ▲
                       │ (WebSocket / Agent stdin↔stdout)
┌──────────────────────┴──────────────────────────────────────────┐
│                  Agent 连接器守护进程 `wwj`                       │
│                     (packages/wwj)                              │
│                                                                   │
│  Claude Code · Codex · OpenClaw · Cursor · Copilot · Aider · Pi  │
└───────────────────────────────────────────────────────────────────┘
```

## 代码库地图

```
52hzAgents/
├── workspace/
│   ├── backend/              # Go 后端 (Gin + GORM)
│   │   ├── cmd/server/       # 服务入口
│   │   └── internal/
│   │       ├── handlers/     # 路由、文件、终端、Agent 目录与运行时
│   │       ├── hub/          # WebSocket / SSE 事件广播
│   │       ├── scheduler/    # Routine / Timer 后台调度
│   │       ├── middleware/   # 鉴权与请求中间件
│   │       ├── models/       # GORM 数据模型
│   │       └── db/           # SQLite (纯 Go) / PostgreSQL 驱动
│   └── frontend/             # Next.js + React 前端
│       ├── app/              # App Router
│       ├── components/       # 聊天、文件、终端、浏览器、Mission Control 等模块
│       ├── styles/           # 主题变量 (globals.css)
│       └── lib/              # API 客户端、主题、身份色等工具
├── packages/
│   ├── wwj/                  # Agent 连接器守护进程与 CLI (`wwj`)
│   ├── launcher/             # Electron 桌面端 App Shell (内置捆绑 wwj)
│   └── go/                   # 原生 SwiftUI macOS/iOS 客户端
├── sdk/                       # Studio / 集成脚手架
└── docs/                      # 品牌素材与架构设计笔记
```

## 快速开始

```powershell
# Windows:一条命令启动 Go 后端 (localhost:8000) 与前端 (localhost:3005)
.\workspace\dev-sqlite.ps1

# 停止:
.\workspace\dev-sqlite.ps1 -Stop
```

完整的手动启动步骤、Docker/PostgreSQL 集成方式、环境变量与自托管部署说明见 [`workspace/README.md`](workspace/README.md)。

## 接入 Agent

通过本地守护进程 `wwj`(详见 [`packages/wwj`](packages/wwj/README.md),Electron 客户端内已捆绑同一份实现)接入本地 Agent:

```bash
# 安装 CLI
npm install -g ./packages/wwj

# 启动守护进程
wwj up

# 创建 Agent(--type 支持 claude / codex / openclaw / cursor / aider / gemini / pi 等)
wwj create my-agent --type claude

# 配置密钥(按 Agent 类型设置对应环境变量)
wwj env claude --set LLM_API_KEY=sk-...

# 连接到自托管的 Workspace,双向桥接其 stdin/stdout
wwj connect my-agent <workspace-token-or-id>

# 状态 / 日志 / 断开
wwj status
wwj logs
wwj down
```

macOS / iOS 用户也可以使用原生 SwiftUI 客户端 [`packages/go`](packages/go/README.md) 连接同一个自托管 Workspace。

## 许可证

本项目采用 [MIT License](LICENSE) 开源。
