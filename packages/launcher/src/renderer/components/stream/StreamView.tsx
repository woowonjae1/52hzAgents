import React from "react"
import { ArrowDown, Paperclip } from "lucide-react"
import { useTranslation } from "react-i18next"
import { cn } from "../../lib/utils"
import type { ChatMessage } from "../../types"
import Markdown from "../chat/Markdown"
import ToolCallRow from "./ToolCallRow"

function formatTime(iso?: string): string {
  if (!iso) return ""
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  } catch {
    return ""
  }
}

/** Distance from the bottom that still counts as "following the stream". */
const STICKY_THRESHOLD_PX = 80

function MessageBlock({
  message,
  showHeader,
  isPending,
  onDownload,
}: {
  message: ChatMessage
  showHeader: boolean
  isPending?: boolean
  onDownload?: (fileId: string, filename: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const isHuman = message.senderType === "human"
  const isSystem = message.senderType === "system"

  return (
    <div className={cn("min-w-0", isPending && "opacity-60")}>
      {/* Agents get a name row; the user's own turns don't — the bubble on the
          right already says who wrote them. */}
      {showHeader && !isSystem && !isHuman && (
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[12px] font-semibold" style={{ color: "var(--fg)" }}>
            {message.senderName}
          </span>
          {(message.metadata as { agentType?: string } | undefined)?.agentType && (
            <span className="text-[11px]" style={{ color: "var(--fg-x-muted)" }}>
              {(message.metadata as { agentType?: string }).agentType}
            </span>
          )}
          <span className="text-[11px] tabular-nums" style={{ color: "var(--fg-x-muted)" }}>
            {formatTime(message.createdAt)}
          </span>
        </div>
      )}

      {isSystem ? (
        message.content ? (
          <p className="m-0 text-[12px] italic" style={{ color: "var(--fg-x-muted)" }}>
            {message.content}
          </p>
        ) : null
      ) : isHuman ? (
        message.content ? (
          <div className="flex justify-end">
            <div
              className="max-w-[78%] whitespace-pre-wrap rounded-[var(--r-2xl)] px-3.5 py-2 text-[14px]"
              style={{ background: "var(--surface-2)", color: "var(--fg)" }}
            >
              {message.content}
            </div>
          </div>
        ) : null
      ) : (
        message.content && <Markdown source={message.content} />
      )}

      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="mt-1">
          {message.toolCalls.map((call) => (
            <ToolCallRow key={call.id} call={call} />
          ))}
        </div>
      )}

      {message.attachments && message.attachments.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {message.attachments.map((attachment, index) => (
            <button
              type="button"
              key={attachment.fileId || `${attachment.filename}-${index}`}
              onClick={() =>
                onDownload && attachment.fileId && onDownload(attachment.fileId, attachment.filename || "file")
              }
              className="flex items-center gap-1.5 rounded-[var(--r-md)] border px-2 py-1 text-[11px]"
              style={{ background: "var(--surface-2)", borderColor: "var(--border-c)", color: "var(--fg-muted)" }}
            >
              <Paperclip className="size-3" />
              <span className="max-w-[180px] truncate">{attachment.filename || attachment.fileId}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The agent transcript.
 *
 * Spacing follows Paseo's rule set rather than a uniform gap: consecutive tool
 * rows sit flush (they're one action sequence), a message following tool output
 * gets a small gap, and everything else gets the full 16px. Uniform spacing is
 * what makes a long tool run look like unrelated noise.
 */
export default function StreamView({
  messages,
  pending,
  thinking,
  loading,
  emptyHint,
  onDownload,
}: {
  messages: ChatMessage[]
  pending: ChatMessage[]
  thinking: string[]
  loading: boolean
  emptyHint?: string
  onDownload?: (fileId: string, filename: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const [stuckToBottom, setStuckToBottom] = React.useState(true)

  const items = React.useMemo(() => [...messages, ...pending], [messages, pending])

  const handleScroll = (): void => {
    const element = scrollRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    setStuckToBottom(distance <= STICKY_THRESHOLD_PX)
  }

  const scrollToBottom = React.useCallback((behavior: ScrollBehavior = "auto") => {
    const element = scrollRef.current
    if (!element) return
    element.scrollTo({ top: element.scrollHeight, behavior })
  }, [])

  React.useEffect(() => {
    if (stuckToBottom) scrollToBottom()
    // Re-anchoring on item count (not on every render) keeps expanding a tool
    // call from yanking the viewport back to the bottom.
  }, [items.length, thinking.length, stuckToBottom, scrollToBottom])

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto px-4 py-4"
        style={{ background: "var(--surface-workspace)" }}
      >
        {loading && items.length === 0 && (
          <p className="py-8 text-center text-[13px]" style={{ color: "var(--fg-x-muted)" }}>
            {t("shell.loading")}
          </p>
        )}

        {!loading && items.length === 0 && (
          <p className="py-10 text-center text-[13px]" style={{ color: "var(--fg-x-muted)" }}>
            {emptyHint ?? t("shell.emptySession")}
          </p>
        )}

        {items.map((message, index) => {
          const previous = index > 0 ? items[index - 1] : null
          const sameSender =
            previous !== null &&
            previous.senderName === message.senderName &&
            previous.senderType === message.senderType
          const previousHadTools = Boolean(previous?.toolCalls && previous.toolCalls.length > 0)
          const gap = previous === null ? 0 : sameSender && previousHadTools ? 4 : sameSender ? 8 : 16
          return (
            <div key={message.messageId || `${message.senderName}-${index}`} style={{ marginTop: gap }}>
              <MessageBlock
                message={message}
                showHeader={!sameSender}
                isPending={pending.includes(message)}
                onDownload={onDownload}
              />
            </div>
          )
        })}

        {thinking.length > 0 && (
          <div className="mt-4 flex items-center gap-2">
            <span
              className="size-1.5 animate-[pulse-dot_1.2s_infinite] rounded-full"
              style={{ background: "var(--status-warning)" }}
            />
            <span className="text-[12px]" style={{ color: "var(--fg-muted)" }}>
              {t("shell.thinking", { agents: thinking.join(", ") })}
            </span>
          </div>
        )}
      </div>

      {!stuckToBottom && (
        <button
          type="button"
          onClick={() => {
            setStuckToBottom(true)
            scrollToBottom("smooth")
          }}
          title={t("shell.jumpToLatest")}
          className="absolute bottom-3 right-4 grid size-8 place-items-center rounded-full border"
          style={{
            background: "var(--surface-2)",
            borderColor: "var(--border-c)",
            color: "var(--fg-muted)",
            boxShadow: "var(--shadow-md)",
          }}
        >
          <ArrowDown className="size-4" />
        </button>
      )}
    </div>
  )
}
