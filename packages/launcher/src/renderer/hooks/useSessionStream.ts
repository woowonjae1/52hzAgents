import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { channelKey, useChatStore } from "../store/chat"
import type { Attachment, ChatMessage, ChatStreamEvent, WorkspaceParticipant } from "../types"
import type { ToastType } from "./useToast"

type ShowToast = (msg: string, type?: ToastType) => void

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const index = result.indexOf(",")
      resolve(index >= 0 ? result.slice(index + 1) : result)
    }
    reader.onerror = () => reject(reader.error || new Error("read error"))
    reader.readAsDataURL(file)
  })
}

function triggerDownload(filename: string, base64: string, mime = "application/octet-stream"): void {
  try {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = filename
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  } catch {}
}

/**
 * Single global subscription to the main process chat stream.
 *
 * Mounted once by the shell rather than per session pane: the main process
 * broadcasts every channel's events on one IPC channel, so N panes would each
 * receive N× the events and append duplicates.
 */
export function useChatEventBridge(showToast: ShowToast): void {
  const { t } = useTranslation()
  useEffect(() => {
    const unsubscribe = window.api.onChatEvent((event: ChatStreamEvent) => {
      const key = channelKey(event.workspaceId, event.channel)
      const store = useChatStore.getState()
      if (event.type === "message") {
        store.appendMessage(key, event.message)
        if (event.message.senderType === "human") {
          // Our optimistic copy has been superseded by the canonical one.
          for (const pending of store.pendingMessages[key] ?? []) {
            store.removePending(key, pending.messageId)
          }
        }
        if (event.message.senderType === "agent") {
          store.setThinking(key, event.message.senderName, false)
        }
      } else if (event.type === "agent-status") {
        store.setThinking(key, event.agentName, event.status === "thinking")
      } else if (event.type === "error") {
        showToast(t("chat.toasts.chatError", { error: event.error }), "error")
      }
    })
    return () => {
      if (typeof unsubscribe === "function") unsubscribe()
    }
  }, [showToast, t])
}

export interface SessionStream {
  messages: ChatMessage[]
  pending: ChatMessage[]
  thinking: string[]
  participants: WorkspaceParticipant[]
  loading: boolean
  send: (content: string, attachments: Attachment[], mentions?: string[]) => Promise<void>
  upload: (file: File) => Promise<Attachment | null>
  download: (fileId: string, filename: string) => Promise<void>
}

/** History, participants and send/upload for one open session tab. */
export function useSessionStream({
  workspaceId,
  channelName,
  showToast,
}: {
  workspaceId: string
  channelName: string
  showToast: ShowToast
}): SessionStream {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(true)
  const key = channelKey(workspaceId, channelName)
  const pollingRef = useRef<{ workspaceId: string; channelName: string } | null>(null)

  const messages = useChatStore((s) => s.messages[key])
  const pendingMessages = useChatStore((s) => s.pendingMessages[key])
  const thinkingSet = useChatStore((s) => s.thinkingAgents[key])
  const participantsByWorkspace = useChatStore((s) => s.participants[workspaceId])

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    const activate = async (): Promise<void> => {
      const previous = pollingRef.current
      if (previous && (previous.workspaceId !== workspaceId || previous.channelName !== channelName)) {
        try {
          await window.api.chatStopPolling(previous.workspaceId, previous.channelName)
        } catch {}
      }
      pollingRef.current = { workspaceId, channelName }

      try {
        const [history, participants] = await Promise.all([
          window.api.chatGetMessages(workspaceId, channelName, 200),
          window.api.chatListParticipants(workspaceId).catch(() => [] as WorkspaceParticipant[]),
        ])
        if (cancelled) return
        const store = useChatStore.getState()
        store.setMessages(key, history)
        store.setParticipants(workspaceId, participants)
      } catch (error) {
        if (!cancelled) {
          showToast(t("chat.toasts.loadFailed", { error: (error as Error).message }), "error")
        }
      } finally {
        if (!cancelled) setLoading(false)
      }

      try {
        await window.api.chatStartPolling(workspaceId, channelName)
      } catch {}
    }

    void activate()

    return () => {
      cancelled = true
      const current = pollingRef.current
      if (current) {
        window.api.chatStopPolling(current.workspaceId, current.channelName).catch(() => {})
        pollingRef.current = null
      }
    }
  }, [workspaceId, channelName, key, showToast, t])

  const send = useCallback(
    async (content: string, attachments: Attachment[], mentions?: string[]): Promise<void> => {
      const store = useChatStore.getState()
      const tempId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      store.addPending(key, {
        messageId: tempId,
        sessionId: channelName,
        senderType: "human",
        senderName: "user",
        content,
        attachments,
        createdAt: new Date().toISOString(),
      })
      try {
        const result = await window.api.chatSendMessage({
          workspaceId,
          channelName,
          content,
          attachments,
          ...(mentions && mentions.length > 0 ? { mentions } : {}),
        })
        if (!result.success) {
          store.removePending(key, tempId)
          showToast(t("chat.toasts.sendFailed", { error: result.error }), "error")
          return
        }
        // Keep the optimistic copy until polling echoes the canonical message
        // back; drop it after 15s if that never happens.
        setTimeout(() => useChatStore.getState().removePending(key, tempId), 15_000)
      } catch (error) {
        store.removePending(key, tempId)
        showToast(t("chat.toasts.sendError", { error: (error as Error).message }), "error")
      }
    },
    [key, channelName, workspaceId, showToast, t],
  )

  const upload = useCallback(
    async (file: File): Promise<Attachment | null> => {
      try {
        const base64 = await fileToBase64(file)
        const result = await window.api.chatUploadFile(workspaceId, file.name, base64, {
          contentType: file.type || "application/octet-stream",
          channelName,
        })
        if (result.success) {
          if (!result.fileId) {
            showToast(t("chat.toasts.uploadedNoFileId", { name: file.name }), "warning")
          }
          return {
            fileId: result.fileId,
            filename: result.filename || file.name,
            contentType: file.type,
            size: file.size,
            url: result.url,
          }
        }
        showToast(t("chat.toasts.uploadFailed", { error: result.error }), "error")
        return null
      } catch (error) {
        showToast(t("chat.toasts.uploadError", { error: (error as Error).message }), "error")
        return null
      }
    },
    [workspaceId, channelName, showToast, t],
  )

  const download = useCallback(
    async (fileId: string, filename: string): Promise<void> => {
      try {
        const result = await window.api.chatReadFile(workspaceId, fileId)
        if (result.success && result.contentBase64) {
          triggerDownload(filename, result.contentBase64)
          return
        }
        showToast(
          t("chat.toasts.downloadFailed", {
            error: result.error || t("chat.toasts.downloadUnknownError"),
          }),
          "error",
        )
      } catch (error) {
        showToast(t("chat.toasts.downloadError", { error: (error as Error).message }), "error")
      }
    },
    [workspaceId, showToast, t],
  )

  const thinking = useMemo(() => (thinkingSet ? Array.from(thinkingSet) : []), [thinkingSet])

  return {
    messages: messages ?? [],
    pending: pendingMessages ?? [],
    thinking,
    participants: participantsByWorkspace ?? [],
    loading,
    send,
    upload,
    download,
  }
}
