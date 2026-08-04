import * as React from "react"
import { cn } from "../../lib/utils"
import type { AgentState } from "../../types"

interface StatusDotProps {
  state: AgentState | string
  className?: string
}

export function statusClass(state: string): "online" | "starting" | "offline" {
  if (["online", "running", "idle"].includes(state)) return "online"
  if (["starting", "reconnecting"].includes(state)) return "starting"
  return "offline"
}

export function displayState(state: string): string {
  if (state === "idle") return "running"
  return state || "stopped"
}

export default function StatusDot({ state, className }: StatusDotProps): React.JSX.Element {
  const s = statusClass(state)
  return (
    <span
      className={cn(
        "inline-block w-[7px] h-[7px] rounded-full shrink-0",
        s === "online"   && "bg-(--status-success)",
        s === "starting" && "bg-(--status-warning) animate-[pulse-dot_1.5s_infinite]",
        s === "offline"  && "bg-(--fg-x-muted)",
        className,
      )}
    />
  )
}
