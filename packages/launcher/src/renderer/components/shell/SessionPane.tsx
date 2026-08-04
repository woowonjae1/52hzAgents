import React from "react"
import { Trash2, Users } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useSessionStream } from "../../hooks/useSessionStream"
import type { ToastType } from "../../hooks/useToast"
import { useShellStore, type ShellTab } from "../../store/shell"
import { channelKey, useChatStore } from "../../store/chat"
import StreamView from "../stream/StreamView"
import Composer from "../stream/Composer"
import { ConfirmDialog } from "../ui/ConfirmDialog"
import StatusDot from "./StatusDot"

/** Center pane for one open session: header, transcript, composer. */
export default function SessionPane({
  tab,
  showToast,
  onSessionDeleted,
}: {
  tab: ShellTab
  showToast: (msg: string, type?: ToastType) => void
  onSessionDeleted: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const workspaceId = tab.workspaceId ?? ""
  const channelName = tab.channelName ?? ""
  const closeTab = useShellStore((s) => s.closeTab)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)

  const { messages, pending, thinking, participants, loading, send, upload, download } = useSessionStream({
    workspaceId,
    channelName,
    showToast,
  })

  const performDelete = async (): Promise<void> => {
    setDeleting(true)
    try {
      await window.api.sessionDelete(workspaceId, channelName)
      useChatStore.getState().clearMessages(channelKey(workspaceId, channelName))
      closeTab(tab.id)
      onSessionDeleted()
    } catch (error) {
      showToast(t("chat.toasts.deleteFailed", { error: (error as Error).message }), "error")
    } finally {
      setDeleting(false)
      setConfirmDelete(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ background: "var(--surface-workspace)" }}>
      <header
        className="flex h-9 shrink-0 items-center gap-2 border-b px-3"
        style={{ borderColor: "var(--border-c)" }}
      >
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium" style={{ color: "var(--fg)" }}>
          {tab.title}
        </span>
        {tab.workspaceName && (
          <span className="shrink-0 truncate text-[12px]" style={{ color: "var(--fg-x-muted)" }}>
            {tab.workspaceName}
          </span>
        )}
        {participants.length > 0 && (
          <span
            className="flex shrink-0 items-center gap-1 text-[12px]"
            style={{ color: "var(--fg-muted)" }}
            title={participants.map((p) => p.agentName).join(", ")}
          >
            <Users className="size-3.5" />
            <span className="tabular-nums">{participants.length}</span>
          </span>
        )}
        <StatusDot status={thinking.length > 0 ? "working" : participants.length > 0 ? "online" : "idle"} size={6} />
        <button
          type="button"
          onClick={() => setConfirmDelete(true)}
          title={t("shell.deleteSession")}
          aria-label={t("shell.deleteSession")}
          className="grid size-6 shrink-0 place-items-center rounded-[var(--r-md)] hover:bg-[var(--surface-2)]"
          style={{ color: "var(--fg-muted)" }}
        >
          <Trash2 className="size-3.5" />
        </button>
      </header>

      <StreamView
        messages={messages}
        pending={pending}
        thinking={thinking}
        loading={loading}
        onDownload={(fileId, filename) => void download(fileId, filename)}
      />

      <Composer participants={participants} onSend={send} onUpload={upload} />

      <ConfirmDialog
        open={confirmDelete}
        title={t("shell.deleteSession")}
        description={t("shell.deleteSessionConfirm", { title: tab.title })}
        confirmLabel={t("shell.delete")}
        busy={deleting}
        onConfirm={() => void performDelete()}
        onCancel={() => setConfirmDelete(false)}
      />
    </div>
  )
}
