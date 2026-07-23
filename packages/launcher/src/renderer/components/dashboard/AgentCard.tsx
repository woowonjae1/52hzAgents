import React, { useState } from "react"
import { MessageSquare, Terminal, Power, ExternalLink, ChevronDown, ChevronUp, Cpu, Server } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "../ui/Button"
import AgentIcon from "../AgentIcon"
import { cn } from "../../lib/utils"
import type { Agent } from "../../types"

type StateKey = "running" | "idle" | "starting" | "error" | "offline"

function stateMeta(state: string): { labelKey: StateKey; bg: string; fg: string; dotClass: string } {
  if (["online", "running"].includes(state)) {
    return {
      labelKey: "running",
      bg: "rgba(16, 185, 129, 0.12)",
      fg: "#34d399",
      dotClass: "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.8)]",
    }
  }
  if (state === "idle") {
    return {
      labelKey: "idle",
      bg: "rgba(245, 158, 11, 0.12)",
      fg: "#fbbf24",
      dotClass: "bg-amber-500 animate-pulse",
    }
  }
  if (state === "starting" || state === "reconnecting") {
    return {
      labelKey: "starting",
      bg: "rgba(245, 158, 11, 0.12)",
      fg: "#fbbf24",
      dotClass: "bg-amber-500 animate-ping",
    }
  }
  if (state === "error") {
    return {
      labelKey: "error",
      bg: "rgba(244, 63, 94, 0.12)",
      fg: "#fb7185",
      dotClass: "bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.8)]",
    }
  }
  return {
    labelKey: "offline",
    bg: "rgba(255, 255, 255, 0.05)",
    fg: "#71717a",
    dotClass: "bg-zinc-600",
  }
}

interface Props {
  agent: Agent
  isPending: boolean
  todayMessages?: number
  onToggle: () => void
  onOpenChat: () => void
}

export function AgentCard({
  agent,
  isPending,
  todayMessages,
  onToggle,
  onOpenChat,
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const [showTerminal, setShowTerminal] = useState(false)
  const isRunning = ["online", "running", "idle"].includes(agent.state)
  const meta = stateMeta(agent.state)
  const isConnected = !!agent.network
  const wsName =
    (agent.networkName && agent.networkName !== agent.network
      ? agent.networkName
      : agent.network) || ""

  return (
    <div
      className={cn(
        "flex flex-col h-full rounded-2xl border transition-all duration-200 overflow-hidden relative group/card",
        isRunning
          ? "border-zinc-800/90 bg-gradient-to-b from-zinc-900/90 to-zinc-950/90 shadow-[0_4px_20px_rgba(0,0,0,0.5)] hover:border-cyan-500/50 hover:shadow-[0_0_25px_rgba(6,182,212,0.15)]"
          : "border-zinc-800/60 bg-zinc-950/40 hover:border-zinc-700/80 hover:bg-zinc-900/40",
      )}
    >
      {/* Card Header & Brand Strip */}
      <div className="p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="size-10 rounded-xl bg-zinc-900 border border-zinc-800/80 flex items-center justify-center shrink-0 shadow-inner">
              <AgentIcon type={agent.type} size={28} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-bold text-zinc-100 truncate group-hover/card:text-cyan-400 transition-colors">
                  {agent.name}
                </span>
                <span
                  className="px-2 py-0.5 rounded-full text-[10px] font-mono font-semibold flex items-center gap-1.5 shrink-0"
                  style={{ background: meta.bg, color: meta.fg }}
                >
                  <span className={cn("size-1.5 rounded-full shrink-0", meta.dotClass)} />
                  {t(`dashboard.agentCard.state.${meta.labelKey}`)}
                </span>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-zinc-500 font-mono mt-0.5">
                <span className="truncate">{agent.type}</span>
                <span>·</span>
                <span className="truncate">PID: {agent.pid || "Auto"}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Network & Channel Status Box */}
        <div className="px-3 py-2 rounded-xl bg-zinc-950/60 border border-zinc-800/50 text-[11px] flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <Server className="size-3.5 text-zinc-400 shrink-0" />
            {isConnected ? (
              <span className="text-zinc-300 truncate font-mono">
                {wsName}
              </span>
            ) : (
              <span className="text-zinc-500 font-mono">未绑定工作区</span>
            )}
          </div>
          {todayMessages !== undefined && (
            <div className="flex items-center gap-1 text-zinc-400 font-mono text-[10px] shrink-0">
              <MessageSquare className="size-3 text-cyan-400" />
              <span>{todayMessages} 条</span>
            </div>
          )}
        </div>

        {/* Action Toolbar */}
        <div className="flex items-center justify-between pt-1 gap-2">
          <div className="flex items-center gap-2 flex-1">
            <button
              onClick={onToggle}
              disabled={isPending}
              className={cn(
                "flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer border",
                isRunning
                  ? "bg-rose-500/10 border-rose-500/30 text-rose-400 hover:bg-rose-500/20"
                  : "bg-cyan-500/10 border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/20 shadow-[0_0_12px_rgba(6,182,212,0.15)]",
              )}
            >
              <Power className="size-3.5" />
              <span>{isRunning ? "停止" : "启动"}</span>
            </button>

            {agent.hasCli && (
              <button
                onClick={onOpenChat}
                className="flex items-center justify-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 transition-colors cursor-pointer"
              >
                <ExternalLink className="size-3.5" />
                <span>交互</span>
              </button>
            )}
          </div>

          <button
            onClick={() => setShowTerminal(!showTerminal)}
            className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-800 transition-colors cursor-pointer"
            title="控制台终端日志"
          >
            <Terminal className="size-4" />
          </button>
        </div>
      </div>

      {/* Embedded Terminal Inspection Drawer */}
      {showTerminal && (
        <div className="border-t border-zinc-800 bg-zinc-950 p-3 font-mono text-[10.5px] text-zinc-400 space-y-1 animate-fade-in">
          <div className="flex items-center justify-between text-[10px] text-zinc-500 pb-1.5 border-b border-zinc-900">
            <span className="flex items-center gap-1">
              <span className="size-1.5 rounded-full bg-emerald-400 inline-block" />
              <span>Runtime Process Console</span>
            </span>
            <span>{agent.type}.log</span>
          </div>
          <div className="max-h-28 overflow-y-auto space-y-1 text-zinc-300">
            <div>[system] initializing agent adapter: {agent.name}...</div>
            <div>[daemon] ws endpoint: http://localhost:8000</div>
            <div>[status] adapter status: {agent.state}</div>
          </div>
        </div>
      )}
    </div>
  )
}
