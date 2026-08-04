import React from "react"
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  FolderOpen,
  Globe,
  ListTodo,
  Network,
  Terminal,
  Wrench,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import type { ToolCall } from "../../types"

const CATEGORY_ICON: Record<NonNullable<ToolCall["category"]>, React.ComponentType<{ className?: string }>> = {
  workspace: Network,
  files: FolderOpen,
  browser: Globe,
  tunnel: Network,
  todos: ListTodo,
  timers: Clock,
  terminal: Terminal,
  other: Wrench,
}

/** The one field worth showing on a collapsed row, mirroring Paseo's summary. */
function summarize(args: unknown): string {
  if (args === null || args === undefined) return ""
  if (typeof args === "string") return args
  if (typeof args !== "object") return String(args)
  const record = args as Record<string, unknown>
  for (const key of ["command", "cmd", "script", "query", "url", "path", "file_path", "filename", "content"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  try {
    return JSON.stringify(args)
  } catch {
    return ""
  }
}

function formatJson(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/**
 * One tool invocation, collapsed to a single line.
 *
 * Paseo's stream leans on this shape heavily: a run of ten shell calls should
 * scan as ten lines of a transcript, not ten cards. Rows are therefore flush —
 * no border, no background — with the surface only appearing when expanded.
 */
export default function ToolCallRow({ call }: { call: ToolCall }): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = React.useState(false)
  const Icon = CATEGORY_ICON[call.category ?? "other"]
  const summary = summarize(call.args)
  const argsText = formatJson(call.args)
  const resultText = formatJson(call.result)
  const hasDetails = Boolean(argsText || resultText)
  const failed = call.status === "error"

  return (
    <div className="min-w-0">
      <button
        type="button"
        onClick={() => hasDetails && setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-[var(--r-md)] py-[3px] pl-1 pr-2 text-left hover:bg-[var(--surface-2)]"
        style={{ cursor: hasDetails ? "pointer" : "default" }}
      >
        <span className="grid size-3.5 shrink-0 place-items-center" style={{ color: "var(--fg-x-muted)" }}>
          {hasDetails ? (
            open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />
          ) : null}
        </span>
        <span
          className="shrink-0"
          style={{ color: failed ? "var(--status-danger)" : "var(--fg-muted)" }}
        >
          {failed ? <AlertCircle className="size-3.5" /> : <Icon className="size-3.5" />}
        </span>
        <span
          className="shrink-0 text-[13px] font-medium"
          style={{ color: failed ? "var(--status-danger)" : "var(--fg)" }}
        >
          {call.name}
        </span>
        {summary && (
          <span
            className="min-w-0 flex-1 truncate font-mono"
            style={{ fontSize: "var(--text-code)", color: "var(--fg-muted)" }}
          >
            {summary}
          </span>
        )}
        {call.status === "pending" && (
          <span
            className="shrink-0 animate-[pulse-dot_1.5s_infinite] text-[11px]"
            style={{ color: "var(--status-warning)" }}
          >
            {t("chat.toolCall.running")}
          </span>
        )}
        {typeof call.durationMs === "number" && call.status !== "pending" && (
          <span className="shrink-0 text-[11px] tabular-nums" style={{ color: "var(--fg-x-muted)" }}>
            {call.durationMs}ms
          </span>
        )}
      </button>

      {open && hasDetails && (
        <div
          className="ml-6 mt-1 mb-1.5 space-y-2 rounded-[var(--r-lg)] border p-2"
          style={{ background: "var(--surface-1)", borderColor: "var(--border-c)" }}
        >
          {argsText && (
            <div>
              <div
                className="mb-1 text-[10px] font-semibold uppercase tracking-wider"
                style={{ color: "var(--fg-x-muted)" }}
              >
                {t("chat.toolCall.args")}
              </div>
              <pre
                className="m-0 max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-[var(--r-md)] px-2 py-1.5 font-mono"
                style={{ background: "var(--surface-2)", fontSize: "var(--text-code)", color: "var(--fg-muted)" }}
              >
                {argsText}
              </pre>
            </div>
          )}
          {resultText && (
            <div>
              <div
                className="mb-1 text-[10px] font-semibold uppercase tracking-wider"
                style={{ color: "var(--fg-x-muted)" }}
              >
                {t("chat.toolCall.result")}
              </div>
              <pre
                className="m-0 max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-[var(--r-md)] px-2 py-1.5 font-mono"
                style={{
                  background: "var(--surface-2)",
                  fontSize: "var(--text-code)",
                  color: failed ? "var(--status-danger)" : "var(--fg-muted)",
                }}
              >
                {resultText}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
