# agn — 52hzAgents Agent Connector (Go Edition)

`agn` 是 `packages/agent-connector`（Node.js 版）的 Go 语言重构实现。它是一个**零依赖、极速启动**的本地守护进程与命令行客户端，负责在本机管理 AI 智能体子进程的生命周期，并把它们实时桥接到 52hzAgents Workspace 后端。

编译产物为单个静态可执行文件（`agn` / `agn.exe`），无需 Node.js 运行时即可分发运行。

---

## ✨ 主要特性

- **后台守护进程**：`agn up` 以脱离控制台的方式在后台常驻，通过本地文件指令通道接收控制信令。
- **智能体进程生命周期管理**：创建、启动、停止、重启子进程，含崩溃自动重启与指数退避。
- **工作区实时双向桥接**（阶段三）：通过 HTTP `join` 握手 + WebSocket 长连接，把 Agent 的 **stdin/stdout** 实时桥接到 Workspace 会话通道，并周期上报在线心跳。
- **内嵌注册表**：`registry.json` 通过 `go:embed` 打包进二进制，内置主流 Agent 运行时（claude、codex、aider、cursor、gemini、openclaw 等）的启动配置。
- **本地配置目录**：默认使用 `~/.52hzagents/`，并自动平滑迁移旧的 `~/.openagents/` 目录。

---

## 🚀 构建

```bash
cd packages/agn_go
go build -o agn .        # Linux / macOS
go build -o agn.exe .    # Windows
```

依赖：Go 1.21+、`github.com/gorilla/websocket`（阶段三引入，用于 WebSocket 桥接）。

---

## 📖 命令一览

| 命令 | 说明 |
|------|------|
| `agn up [--foreground]` | 启动守护进程（默认后台派生；`--foreground` 前台阻塞运行） |
| `agn down` | 停止守护进程并释放资源 |
| `agn status` | 查看守护进程与各 Agent 的实时状态 |
| `agn list` | 列出配置中已注册的 Agent |
| `agn create <name> [--type T]` | 创建一个新 Agent（`--type` 默认 `openclaw`） |
| `agn remove <name>` | 移除一个 Agent |
| `agn start <name>` | 启动指定 Agent 子进程 |
| `agn stop <name>` | 停止指定 Agent 子进程 |
| `agn restart <name>` | 重启指定 Agent 子进程 |
| `agn connect <name> <token> [选项]` | **将 Agent 连接到工作区并建立双向桥接** |
| `agn disconnect <name>` | 断开 Agent 的工作区连接（子进程仍本地运行） |
| `agn version` | 显示版本 |
| `agn help` | 显示帮助 |

### `connect` 选项

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `--endpoint <url>` | Workspace 后端基准地址 | `http://localhost:8000` |
| `--network <id\|slug>` | 工作区 ID 或 Slug（省略时后端按 token 反查） | 空 |
| `--channel <name>` | 桥接投递/订阅的会话通道名 | `general` |

---

## 🔌 典型用法

```bash
# 1) 启动后台守护进程
agn up

# 2) 创建一个 Claude 类型的本地 Agent
agn create coder --type claude

# 3) 把它连接到自托管工作区（双向桥接其 stdin/stdout）
agn connect coder <workspace-token> --endpoint http://localhost:8000 --channel general

# 4) 查看状态 / 日志
agn status
#    桥接活动记录在 ~/.52hzagents/daemon.log

# 5) 断开与退出
agn disconnect coder
agn down
```

---

## 🌉 桥接工作原理（阶段三）

`agn connect` 触发守护进程为该 Agent 建立一个 `wsclient.Bridge` 会话：

1. **握手** —— `POST /v1/join`，取得 `network_id` 与 `session_id`。
2. **长连接** —— 升级建立到 `GET /v1/events/ws?network=&token=` 的 WebSocket 双向通道。
3. **下行**（Workspace → Agent）—— 订阅 `workspace.message.posted` 事件，过滤掉本 Agent 自身发出的消息（防回声），把消息正文逐行写入 Agent 的 **stdin**。
4. **上行**（Agent → Workspace）—— 把 Agent 的每行 **stdout** 输出封装为 `workspace.message.posted` 事件（`source: openagents:<name>`、`target: channel/<channel>`），经 WebSocket 上行投递。
5. **保活** —— 每 20 秒 `POST /v1/workspaces/<id>/presence` 上报在线心跳。
6. **离线** —— 断桥或进程退出时 `POST /v1/leave` 上报离线。

守护进程重启（`agn up`）后，会自动为配置中已绑定工作区的 Agent 重新建立桥接。

> **说明**：当前桥接为逐行透传（一行 stdout = 一条消息）。针对不同 Agent 运行时结构化输出的解析（对应 Node 版 `src/adapters/*`）为后续增强项。

---

## 🗂 目录结构

```
packages/agn_go/
├── main.go                      # CLI 入口与子命令路由
├── registry.json                # 内嵌 Agent 运行时注册表
└── internal/
    ├── config/                  # 本地配置 (~/.52hzagents/config.json) 读写
    ├── daemon/                  # 后台守护进程与子进程生命周期管理
    ├── registry/               # 注册表加载 (go:embed)
    └── wsclient/                # WebSocket 双向桥接客户端（阶段三）
```

---

## 🧭 重构阶段

- [x] **阶段一**：CLI 脚手架与后台守护进程管理（`up`/`down`/`status`/`version`）
- [x] **阶段二**：智能体管理与进程生命周期（`create`/`remove`/`list`/`start`/`stop`/`restart`）
- [x] **阶段三**：Workspace 客户端与实时 Stdin/Stdout 双向桥接（`connect`/`disconnect`）
- [ ] **阶段四**：依赖环境与 Agent 运行时自动安装器（`install`/`runtimes`/`env`）
