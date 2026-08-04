import React from "react"
import { cn } from "../../lib/utils"

/**
 * Session / agent status dot.
 *
 * Paseo keeps this one off its normalized status scale on purpose — the dot is
 * supposed to shout, so it uses the raw palette values rather than the muted
 * tier every dense list row shares.
 */
export type ShellStatus = "working" | "online" | "idle" | "error" | "offline"

const COLOR: Record<ShellStatus, string> = {
  working: "#f59e0b",
  online: "#22c55e",
  idle: "#71717a",
  error: "#ef4444",
  offline: "#52525b",
}

export default function StatusDot({
  status,
  size = 7,
  className,
  title,
}: {
  status: ShellStatus
  size?: number
  className?: string
  title?: string
}): React.JSX.Element {
  return (
    <span
      title={title}
      aria-label={title ?? status}
      className={cn("inline-block shrink-0 rounded-full", status === "working" && "animate-[pulse-dot_1.5s_infinite]", className)}
      style={{ width: size, height: size, background: COLOR[status] }}
    />
  )
}
