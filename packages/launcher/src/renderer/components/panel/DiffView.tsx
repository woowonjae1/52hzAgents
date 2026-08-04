import React from "react"
import type { GitDiffHunk, GitDiffLine } from "../../types"

/**
 * Unified diff renderer.
 *
 * Uses the saturated diff colors, not the muted status tier: inside a diff the
 * color *is* the signal and has to survive being scanned line by line. The row
 * tint is a low-alpha mix of the same hue so the text stays legible on it.
 */
const ROW_STYLE: Record<GitDiffLine["type"], React.CSSProperties> = {
  add: {
    background: "color-mix(in srgb, var(--diff-add) 12%, transparent)",
    color: "var(--fg)",
  },
  del: {
    background: "color-mix(in srgb, var(--diff-del) 12%, transparent)",
    color: "var(--fg)",
  },
  context: { color: "var(--fg-muted)" },
  hunk: { color: "var(--fg-x-muted)" },
  meta: { color: "var(--fg-x-muted)" },
}

const MARKER: Record<GitDiffLine["type"], string> = {
  add: "+",
  del: "-",
  context: " ",
  hunk: "@",
  meta: "\\",
}

function Gutter({ value }: { value: number | null }): React.JSX.Element {
  return (
    <span
      className="w-9 shrink-0 select-none pr-2 text-right tabular-nums"
      style={{ color: "var(--fg-x-muted)" }}
    >
      {value ?? ""}
    </span>
  )
}

export default function DiffView({ hunks }: { hunks: GitDiffHunk[] }): React.JSX.Element {
  return (
    <div
      className="overflow-x-auto font-mono"
      style={{ fontSize: "var(--text-code)", lineHeight: "var(--lh-diff)" }}
    >
      {hunks.map((hunk, hunkIndex) => (
        <div key={hunkIndex}>
          <div
            className="flex items-center gap-2 px-2 py-0.5"
            style={{ background: "var(--surface-2)", color: "var(--fg-x-muted)" }}
          >
            <span className="tabular-nums">
              @@ {hunk.lines[0]?.oldNumber ?? 0},{hunk.lines.filter((l) => l.type !== "add").length} +
              {hunk.lines.find((l) => l.newNumber !== null)?.newNumber ?? 0},
              {hunk.lines.filter((l) => l.type !== "del").length} @@
            </span>
            {hunk.header && <span className="truncate">{hunk.header}</span>}
          </div>
          {hunk.lines.map((line, lineIndex) => (
            <div
              key={`${hunkIndex}-${lineIndex}`}
              className="flex min-w-0 whitespace-pre px-2"
              style={ROW_STYLE[line.type]}
            >
              <Gutter value={line.oldNumber} />
              <Gutter value={line.newNumber} />
              <span
                className="w-3 shrink-0 select-none"
                style={{
                  color:
                    line.type === "add"
                      ? "var(--diff-add)"
                      : line.type === "del"
                        ? "var(--diff-del)"
                        : "var(--fg-x-muted)",
                }}
              >
                {MARKER[line.type]}
              </span>
              <span className="min-w-0">{line.content || " "}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
