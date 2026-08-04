import React from "react"
import { cn } from "../../lib/utils"

/**
 * The `+466 −124` footnote beside a title.
 *
 * Deliberately NOT the saturated diff colors: those belong inside a diff view
 * where the color *is* the signal and has to survive being scanned line by
 * line. Here the stat reads as one of several muted signals in a row, so it
 * uses the muted status tier, which sits at roughly --fg-muted's weight.
 */
export default function DiffStat({
  additions,
  deletions,
  className,
}: {
  additions: number
  deletions: number
  className?: string
}): React.JSX.Element | null {
  if (!additions && !deletions) return null
  return (
    <span
      className={cn("shrink-0 font-mono tabular-nums", className)}
      style={{ fontSize: "var(--text-xs)" }}
    >
      {additions > 0 && <span style={{ color: "var(--status-muted-success)" }}>+{additions}</span>}
      {additions > 0 && deletions > 0 && <span className="opacity-40"> </span>}
      {deletions > 0 && <span style={{ color: "var(--status-muted-danger)" }}>&minus;{deletions}</span>}
    </span>
  )
}
