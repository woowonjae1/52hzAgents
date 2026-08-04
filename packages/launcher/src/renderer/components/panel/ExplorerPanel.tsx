import React from "react"
import { useTranslation } from "react-i18next"
import { useShallow } from "zustand/react/shallow"
import { cn } from "../../lib/utils"
import { useShellStore } from "../../store/shell"
import ChangesPanel from "./ChangesPanel"
import FilesPanel from "./FilesPanel"

/**
 * Right-hand explorer: Changes | Files for the repository behind the active
 * session's workspace.
 */
export default function ExplorerPanel({ workspaceId }: { workspaceId: string | null }): React.JSX.Element {
  const { t } = useTranslation()
  const { explorerTab, setExplorerTab, repoPaths, setRepoPath } = useShellStore(
    useShallow((s) => ({
      explorerTab: s.explorerTab,
      setExplorerTab: s.setExplorerTab,
      repoPaths: s.repoPaths,
      setRepoPath: s.setRepoPath,
    })),
  )

  const repoPath = workspaceId ? (repoPaths[workspaceId] ?? null) : null

  const pickRepo = async (): Promise<void> => {
    if (!workspaceId) return
    const selected = await window.api.selectDirectory(repoPath ?? undefined).catch(() => null)
    if (selected) setRepoPath(workspaceId, selected)
  }

  const tabs: Array<{ id: "changes" | "files"; label: string }> = [
    { id: "changes", label: t("shell.panel.changes") },
    { id: "files", label: t("shell.panel.files") },
  ]

  return (
    <section
      className="flex h-screen min-w-0 flex-col border-l"
      style={{ background: "var(--surface-workspace)", borderColor: "var(--border-c)" }}
    >
      <div
        className="sidebar-drag flex h-11 shrink-0 items-stretch border-b"
        style={{ background: "var(--surface-sidebar)", borderColor: "var(--border-c)" }}
      >
        <div className="sidebar-no-drag flex items-stretch">
          {tabs.map((tab) => {
            const active = explorerTab === tab.id
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setExplorerTab(tab.id)}
                className={cn("relative px-4 text-[13px]", !active && "hover:bg-[var(--surface-sidebar-hover)]")}
                style={{
                  color: active ? "var(--fg)" : "var(--fg-muted)",
                  fontWeight: active ? 500 : 400,
                  background: active ? "var(--surface-workspace)" : "transparent",
                }}
              >
                {tab.label}
                {active && (
                  <span
                    className="absolute inset-x-0 -bottom-px h-px"
                    style={{ background: "var(--surface-workspace)" }}
                  />
                )}
              </button>
            )
          })}
        </div>
        <div className="flex-1" />
      </div>

      {!workspaceId ? (
        <p className="px-4 py-8 text-center text-[13px]" style={{ color: "var(--fg-x-muted)" }}>
          {t("shell.panel.noSession")}
        </p>
      ) : explorerTab === "changes" ? (
        <ChangesPanel repoPath={repoPath} onPickRepo={() => void pickRepo()} />
      ) : (
        <FilesPanel repoPath={repoPath} onPickRepo={() => void pickRepo()} />
      )}
    </section>
  )
}
