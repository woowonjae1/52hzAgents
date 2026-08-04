import React from "react"
import { PanelLeft, PanelRight, PanelRightClose } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useShallow } from "zustand/react/shallow"
import type { GitStatusResult } from "../../types"
import { useShellStore, type ShellTab } from "../../store/shell"
import DiffStat from "./DiffStat"

/**
 * Window title row above the tab strip.
 *
 * Paseo puts the *subject* of the window here — branch, repo, its diff stat —
 * and keeps the tab strip below it. That ordering matters: the tabs belong to
 * the workspace named above them, not the other way round.
 */
export default function WorkspaceTitleBar({ activeTab }: { activeTab: ShellTab | null }): React.JSX.Element {
  const { t } = useTranslation()
  const { sidebarOpen, toggleSidebar, explorerOpen, toggleExplorer, repoPaths } = useShellStore(
    useShallow((s) => ({
      sidebarOpen: s.sidebarOpen,
      toggleSidebar: s.toggleSidebar,
      explorerOpen: s.explorerOpen,
      toggleExplorer: s.toggleExplorer,
      repoPaths: s.repoPaths,
    })),
  )

  const repoPath = activeTab?.workspaceId ? (repoPaths[activeTab.workspaceId] ?? null) : null
  const [status, setStatus] = React.useState<GitStatusResult | null>(null)

  React.useEffect(() => {
    if (!repoPath) {
      setStatus(null)
      return
    }
    let cancelled = false
    void window.api
      .gitStatus(repoPath)
      .then((result) => {
        if (!cancelled) setStatus(result)
      })
      .catch(() => {
        if (!cancelled) setStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [repoPath])

  const showExplorerToggle = activeTab !== null && activeTab.kind !== "manage"

  return (
    <div
      className="sidebar-drag flex h-10 shrink-0 items-center gap-2 border-b px-2"
      style={{ background: "var(--surface-sidebar)", borderColor: "var(--border-c)" }}
    >
      {!sidebarOpen && (
        <button
          type="button"
          onClick={toggleSidebar}
          title={t("shell.expandSidebar")}
          aria-label={t("shell.expandSidebar")}
          className="sidebar-no-drag grid size-7 shrink-0 place-items-center rounded-[var(--r-md)] hover:bg-[var(--surface-sidebar-hover)]"
          style={{ color: "var(--fg-muted)" }}
        >
          <PanelLeft className="size-4" />
        </button>
      )}

      <span className="min-w-0 truncate text-[13px] font-medium" style={{ color: "var(--fg)" }}>
        {activeTab?.title ?? t("shell.sessions")}
      </span>
      {status?.branch && (
        <span className="min-w-0 shrink-0 truncate font-mono text-[12px]" style={{ color: "var(--fg-muted)" }}>
          {status.branch}
        </span>
      )}
      {activeTab?.workspaceName && (
        <span className="min-w-0 truncate text-[12px]" style={{ color: "var(--fg-x-muted)" }}>
          {activeTab.workspaceName}
        </span>
      )}
      {status && (status.additions > 0 || status.deletions > 0) && (
        <span
          className="shrink-0 rounded-[var(--r-md)] border px-1.5 py-0.5"
          style={{ borderColor: "var(--border-c)", background: "var(--surface-2)" }}
        >
          <DiffStat additions={status.additions} deletions={status.deletions} />
        </span>
      )}

      <div className="flex-1" />

      {showExplorerToggle && (
        <button
          type="button"
          onClick={toggleExplorer}
          title={explorerOpen ? t("shell.hidePanel") : t("shell.showPanel")}
          aria-label={explorerOpen ? t("shell.hidePanel") : t("shell.showPanel")}
          className="sidebar-no-drag grid size-7 shrink-0 place-items-center rounded-[var(--r-md)] hover:bg-[var(--surface-sidebar-hover)]"
          style={{ color: explorerOpen ? "var(--fg)" : "var(--fg-muted)" }}
        >
          {explorerOpen ? <PanelRightClose className="size-4" /> : <PanelRight className="size-4" />}
        </button>
      )}
    </div>
  )
}
