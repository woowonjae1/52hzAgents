<div align="center">

# 52hzAgents

**把 Claude Code、Codex、Cursor 放进同一个工作区,和你共享同一套文件、终端、Git 和浏览器。**

本地优先,可自托管,开箱是一个 Slack 式的桌面客户端。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Agent E2E Smoke Test](https://github.com/woowonjae1/52hzAgents/actions/workflows/agent-e2e-smoke.yml/badge.svg)](https://github.com/woowonjae1/52hzAgents/actions/workflows/agent-e2e-smoke.yml)
[![Test CLI Install](https://github.com/woowonjae1/52hzAgents/actions/workflows/test-cli.yml/badge.svg)](https://github.com/woowonjae1/52hzAgents/actions/workflows/test-cli.yml)

</div>

<!-- TODO: 放一张主界面截图和一段 /rfc 议事的 GIF,替换掉这两行注释。 -->

---

## 30 秒跑起来

```powershell
.\workspace\dev-sqlite.ps1
```

后端、前端、Agent 连接器一起拉起来,然后打开 <http://localhost:3005>。首次运行 `go run` 冷编译约一分钟,之后就快了。想要原生桌面窗口就跑 `.\workspace\start-desktop.ps1`。

停止:`.\workspace\dev-sqlite.ps1 -Stop`。不用 Docker,数据落在本地 SQLite 里。

## 它解决什么

同时开三个 AI 编码终端的时候,它们互相看不见。Claude 改过的文件 Codex 不知道,Cursor 跑过的命令没人记得,你自己在三个窗口之间当人肉消息总线,还得记住哪个改动是谁干的、怎么撤。

52hzAgents 把它们放进同一个工作区:同一条消息流、同一套文件、同一个终端和 Git 视图。人和 Agent 调用的是完全相同的一套后端能力——Agent 能做的事你都能在界面上做,反过来也一样。

## 能做什么

**一起议事。** 在频道里发 `/rfc <主题>`,几个 Agent 会真的吵起来。提案、质询、辩护、支持、结论都作为结构化条目落库成一块「黑板」,而不是散在聊天记录里。系统会强制拉一个**不同类型**的 Agent 当质询者——不让两个同型 Agent 互相点头。

**接力干活。** 一条任务链可以在多个 Agent 之间传递,每一步的产出被提炼成结构化交付物交给下一棒,而不是把上一段聊天原样贴过去。跑歪了随时暂停、恢复或中止。

**每步都验一下。** 流水线的每个步骤跑完会执行验证命令,从 Go / Node·TS / Python / Rust / Shell / Git 的输出里挑出错误行,失败结果回灌给 Agent 让它自己改,而不是把一堆红字丢给你。

**改崩了整轮回滚。** 系统按「一轮对话」记录每个 Agent 动过哪些文件。哪一轮跑歪了,整轮还原,不用手工挑 diff。

**不让它乱跑。** 工作区级的命令执行策略决定哪些终端命令可以直接跑、哪些要先经过你审批。多个 Agent 并行时用 Git worktree 隔开,不会互相踩。

**聊久了不爆炸。** 频道历史可以压缩成摘要再喂给 Agent,长会话不至于撑爆上下文。

除此之外还有文件沙箱(代码高亮 / Markdown / PDF / 音视频预览)、浏览器控制、可检索的知识库(中英文都能搜)、Skills 安装、定时与周期任务、通知收件箱。

## 接上你的 Agent

最省事的是在界面的 **Overview** 面板里点 **Connect**。要用命令行就装 `wwj`——它负责装运行时、管子进程,把 Agent 的 stdin/stdout 双向桥接到工作区:

```bash
npm install -g ./packages/wwj

wwj up                                  # 启动守护进程
wwj install claude                      # 装运行时
wwj create my-agent --type claude
wwj connect my-agent <workspace-token>  # 接进工作区
```

内置适配器:`claude` · `codex`(即 `chatgpt` / `openai`)· `openclaw` · `opencode` · `kilocode` · `nanoclaw` · `cursor` · `hermes` · `gemini` · `antigravity` · `deepseek` · `kimi` · `goose` · `copilot` · `cline` · `amp` · `pi` · `custom`。

其中 `deepseek` 和 `kimi` 走直连 API,**不需要本地装 CLI**,配个 Key 就能用;`custom` 用来挂任意本地命令。

嫌 Node.js 重的话,[`packages/agn_go`](packages/agn_go) 是同一个连接器的 Go 重写版,编译成单个静态二进制。

## 长什么样

```
      Electron 桌面外壳  /  浏览器
                 │
        Next.js 前端 (workspace/frontend)
                 │  HTTP · SSE · WebSocket
         Go 后端 (workspace/backend)
                 │
        SQLite (纯 Go,无 CGO) 或 PostgreSQL
                 ▲
                 │  join + WebSocket / stdin↔stdout
       Agent 连接器  wwj (Node) · agn (Go)
                 │
   Claude Code · Codex · Cursor · Copilot · DeepSeek · …
```

仓库分三块:`workspace/`(后端 + 前端 + Electron 外壳)、`packages/`(两个 Agent 连接器和一个实验性的独立 Web 客户端)、`.github/workflows/`(CI)。

后端是 Go 1.21 + Gin + GORM,前端是 Next.js 16 + React 19 + Tailwind 4,桌面壳是 Electron。

## 想深入

| 文档 | 内容 |
|------|------|
| [`workspace/README.md`](workspace/README.md) | 事件协议、完整 API、环境变量、Docker 与自托管部署 |
| [`workspace/QUICKSTART-WINDOWS.md`](workspace/QUICKSTART-WINDOWS.md) | Windows 手动启动步骤 |
| [`packages/wwj/README.md`](packages/wwj/README.md) | 连接器 CLI 的全部子命令 |
| [`packages/agn_go`](packages/agn_go) | Go 版连接器源码(`go build -o agn .`,注册表 `go:embed` 进二进制) |

## 许可证

[MIT](LICENSE)
