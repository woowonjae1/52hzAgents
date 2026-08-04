import React from "react"
import { ExternalLink, MessageSquare, Power, Server } from "lucide-react"
import { useTranslation } from "react-i18next"
import AgentIcon from "../AgentIcon"
import { cn } from "../../lib/utils"
import type { Agent } from "../../types"

type StateKey = "running" | "idle" | "starting" | "error" | "offline"

/**
 * State chip colors come from the normalized status tier, not the raw palette:
 * this chip repeats on every card in the grid, so full saturation would make the
 * grid itself the loudest thing on screen.
 */
function stateMeta(state: string): { labelKey: StateKey; color: string; pulse: boolean } {
  if (["online", "running"].includes(state)) {
    return { labelKey: "running", color: "var(--status-muted-success)", pulse: false }
  }
  if (state === "idle") {
    return { labelKey: "idle", color: "var(--status-muted-warning)", pulse: false }
  }
  if (state === "starting" || state === "reconnecting") {
    return { labelKey: "starting", color: "var(--status-muted-warning)", pulse: true }
  }
  if (state === "error") {
    return { labelKey: "error", color: "var(--status-muted-danger)", pulse: false }
  }
  return { labelKey: "offline", color: "var(--fg-x-muted)", pulse: false }
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
  const isRunning = ["online", "running", "idle"].includes(agent.state)
  const meta = stateMeta(agent.state)
  const isConnected = !!agent.network
  const wsName =
    (agent.networkName && agent.networkName !== agent.network ? agent.networkName : agent.network) || ""

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-(--r-xl) border border-(--border-c) bg-(--surface-1) transition-colors duration-150 hover:border-(--border-accent)">
      <div className="flex flex-col gap-3 p-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-(--r-lg) bg-(--surface-2)">
            <AgentIcon type={agent.type} size={22} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[14px] font-medium text-(--fg)">{agent.name}</span>
              <span
                className="flex shrink-0 items-center gap-1.5 text-[11px]"
                style={{ color: meta.color }}
              >
                <span
                  className={cn("size-1.5 shrink-0 rounded-full", meta.pulse && "animate-[pulse-dot_1.5s_infinite]")}
                  style={{ background: meta.color }}
                />
                {t(`dashboard.agentCard.state.${meta.labelKey}`)}
              </span>
            </div>
            <div className="mt-0.5 truncate text-[11px] text-(--fg-x-muted)">{agent.type}</div>
          </div>
        </div>

        {/* Workspace binding + real traffic. */}
        <div className="flex items-center justify-between rounded-(--r-lg) border border-(--border-c) bg-(--surface-0) px-2.5 py-1.5 text-[12px]">
          <div className="flex min-w-0 items-center gap-1.5">
            <Server className="size-3.5 shrink-0 text-(--fg-x-muted)" />
            <span className={cn("truncate", isConnected ? "text-(--fg-muted)" : "text-(--fg-x-muted)")}>
              {isConnected ? wsName : "未绑定工作区"}
            </span>
          </div>
          {todayMessages !== undefined && (
            <div className="flex shrink-0 items-center gap-1 text-(--fg-x-muted)">
              <MessageSquare className="size-3" />
              <span className="tabular-nums">{todayMessages}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onToggle}
            disabled={isPending}
            className={cn(
              "flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-(--r-lg) border px-3 py-1.5 text-[13px] transition-colors",
              "disabled:cursor-not-allowed disabled:opacity-40",
              isRunning
                ? "border-(--border-c) text-(--destructive) hover:border-(--destructive)"
                : "border-transparent bg-(--accent) text-(--accent-fg) hover:brightness-110",
            )}
          >
            <Power className="size-3.5" />
            <span>{isRunning ? "停止" : "启动"}</span>
          </button>

          {agent.hasCli && (
            <button
              onClick={onOpenChat}
              className="flex cursor-pointer items-center justify-center gap-1.5 rounded-(--r-lg) border border-(--border-c) px-3 py-1.5 text-[13px] text-(--fg) transition-colors hover:bg-(--surface-2)"
            >
              <ExternalLink className="size-3.5" />
              <span>交互</span>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
