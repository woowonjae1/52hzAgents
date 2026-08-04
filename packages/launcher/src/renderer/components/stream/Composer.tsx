import React from "react"
import { AtSign, Check, ChevronDown, Paperclip, Send, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import type { Attachment, WorkspaceParticipant } from "../../types"

/**
 * Message composer.
 *
 * Paseo's composer carries a provider/model/effort row; this app doesn't own
 * model selection — the daemon does, per agent — so the equivalent control here
 * picks which participant gets the @mention. Rendering a model dropdown that
 * changes nothing would be a lie about what the app can do.
 */
export default function Composer({
  participants,
  disabled,
  onSend,
  onUpload,
}: {
  participants: WorkspaceParticipant[]
  disabled?: boolean
  onSend: (content: string, attachments: Attachment[], mentions?: string[]) => Promise<void>
  onUpload: (file: File) => Promise<Attachment | null>
}): React.JSX.Element {
  const { t } = useTranslation()
  const [value, setValue] = React.useState("")
  const [attachments, setAttachments] = React.useState<Attachment[]>([])
  const [mention, setMention] = React.useState<string | null>(null)
  const [mentionOpen, setMentionOpen] = React.useState(false)
  const [sending, setSending] = React.useState(false)
  const [uploading, setUploading] = React.useState(false)
  const fileInputRef = React.useRef<HTMLInputElement | null>(null)
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null)
  const mentionRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    if (!mentionOpen) return
    const handler = (event: MouseEvent): void => {
      if (mentionRef.current && !mentionRef.current.contains(event.target as Node)) setMentionOpen(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [mentionOpen])

  // Grow with content up to ~8 lines, then scroll.
  React.useEffect(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = "auto"
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`
  }, [value])

  const submit = async (): Promise<void> => {
    const content = value.trim()
    if (!content && attachments.length === 0) return
    if (disabled || sending) return
    setSending(true)
    try {
      const body = mention && !content.includes(`@${mention}`) ? `@${mention} ${content}` : content
      await onSend(body, attachments, mention ? [mention] : undefined)
      setValue("")
      setAttachments([])
    } finally {
      setSending(false)
    }
  }

  const handleFiles = async (files: FileList | null): Promise<void> => {
    if (!files || files.length === 0) return
    setUploading(true)
    try {
      for (const file of Array.from(files)) {
        const attachment = await onUpload(file)
        if (attachment) setAttachments((prev) => [...prev, attachment])
      }
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  return (
    <div
      className="shrink-0 border-t px-3 py-2.5"
      style={{ background: "var(--surface-workspace)", borderColor: "var(--border-c)" }}
    >
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {attachments.map((attachment, index) => (
            <span
              key={attachment.fileId || `${attachment.filename}-${index}`}
              className="flex items-center gap-1.5 rounded-[var(--r-md)] border px-2 py-1 text-[11px]"
              style={{ background: "var(--surface-2)", borderColor: "var(--border-c)", color: "var(--fg-muted)" }}
            >
              <Paperclip className="size-3" />
              <span className="max-w-[160px] truncate">{attachment.filename}</span>
              <button
                type="button"
                onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== index))}
                className="grid size-3.5 place-items-center rounded-[var(--r-sm)] hover:bg-[var(--surface-3)]"
                aria-label={t("shell.removeAttachment")}
              >
                <X className="size-2.5" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div
        className="rounded-[var(--r-xl)] border focus-within:border-[var(--accent)]"
        style={{ background: "var(--surface-1)", borderColor: "var(--border-c)" }}
      >
        <textarea
          ref={textareaRef}
          value={value}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit()
            }
          }}
          rows={1}
          placeholder={disabled ? t("shell.composerDisabled") : t("shell.composerPlaceholder")}
          className="block w-full resize-none border-0 bg-transparent px-3 pt-2.5 pb-1 text-[14px] leading-relaxed outline-none"
          style={{ color: "var(--fg)" }}
        />

        <div className="flex items-center gap-1 px-2 pb-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(event) => void handleFiles(event.target.files)}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || uploading}
            title={t("shell.attach")}
            aria-label={t("shell.attach")}
            className="grid size-7 place-items-center rounded-[var(--r-md)] hover:bg-[var(--surface-2)] disabled:opacity-40"
            style={{ color: "var(--fg-muted)" }}
          >
            <Paperclip className="size-3.5" />
          </button>

          <div className="relative" ref={mentionRef}>
            <button
              type="button"
              onClick={() => setMentionOpen((v) => !v)}
              disabled={disabled || participants.length === 0}
              title={t("shell.mentionAgent")}
              className="flex h-7 items-center gap-1 rounded-[var(--r-md)] px-2 text-[12px] hover:bg-[var(--surface-2)] disabled:opacity-40"
              style={{ color: mention ? "var(--fg)" : "var(--fg-muted)" }}
            >
              <AtSign className="size-3.5" />
              <span className="max-w-[140px] truncate">{mention ?? t("shell.allAgents")}</span>
              <ChevronDown className="size-3" />
            </button>

            {mentionOpen && (
              <div
                className="absolute bottom-[calc(100%+6px)] left-0 z-50 max-h-64 w-52 overflow-y-auto rounded-[var(--r-xl)] border py-1"
                style={{
                  background: "var(--surface-2)",
                  borderColor: "var(--border-c)",
                  boxShadow: "var(--shadow-lg)",
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    setMention(null)
                    setMentionOpen(false)
                  }}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-[var(--surface-3)]"
                  style={{ color: "var(--fg)" }}
                >
                  <span className="min-w-0 flex-1 truncate">{t("shell.allAgents")}</span>
                  {mention === null && <Check className="size-3.5" style={{ color: "var(--accent-bright)" }} />}
                </button>
                {participants.map((participant) => (
                  <button
                    key={participant.agentName}
                    type="button"
                    onClick={() => {
                      setMention(participant.agentName)
                      setMentionOpen(false)
                    }}
                    className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] hover:bg-[var(--surface-3)]"
                    style={{ color: "var(--fg)" }}
                  >
                    <span className="min-w-0 flex-1 truncate">{participant.agentName}</span>
                    <span className="shrink-0 text-[11px]" style={{ color: "var(--fg-x-muted)" }}>
                      {participant.role}
                    </span>
                    {mention === participant.agentName && (
                      <Check className="size-3.5" style={{ color: "var(--accent-bright)" }} />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex-1" />

          <button
            type="button"
            onClick={() => void submit()}
            disabled={disabled || sending || (!value.trim() && attachments.length === 0)}
            title={t("shell.send")}
            aria-label={t("shell.send")}
            className="grid size-7 place-items-center rounded-[var(--r-md)] disabled:opacity-40"
            style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
          >
            <Send className="size-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
