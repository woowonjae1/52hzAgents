import React from "react"
import { Globe, MessageSquare, SlidersHorizontal, X } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useShallow } from "zustand/react/shallow"
import { cn } from "../../lib/utils"
import { useShellStore, type ShellTab } from "../../store/shell"

function KindIcon({ kind }: { kind: ShellTab["kind"] }): React.JSX.Element {
  if (kind === "manage") return <SlidersHorizontal className="size-3.5" />
  if (kind === "embedded") return <Globe className="size-3.5" />
  return <MessageSquare className="size-3.5" />
}

/**
 * Open-tab strip, directly under the workspace title bar.
 *
 * The active tab paints the same surface as the pane below it and covers the
 * bottom border, so tab and content read as one sheet — the detail that makes a
 * tab strip look attached rather than stacked.
 */
export default function TabStrip(): React.JSX.Element {
  const { t } = useTranslation()
  const { tabs, activeTabId, activateTab, closeTab } = useShellStore(
    useShallow((s) => ({
      tabs: s.tabs,
      activeTabId: s.activeTabId,
      activateTab: s.activateTab,
      closeTab: s.closeTab,
    })),
  )

  if (tabs.length === 0) return <></>

  return (
    <div
      className="flex h-9 shrink-0 items-stretch border-b"
      style={{ background: "var(--surface-sidebar)", borderColor: "var(--border-c)" }}
    >
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto scrollbar-hide">
        {tabs.map((tab) => {
          const active = tab.id === activeTabId
          return (
            <div
              key={tab.id}
              className={cn(
                "group relative flex min-w-0 max-w-[220px] shrink-0 items-center gap-1.5 border-r pl-2.5 pr-1.5",
                !active && "hover:bg-[var(--surface-sidebar-hover)]",
              )}
              style={{
                borderColor: "var(--border-c)",
                background: active ? "var(--surface-workspace)" : "transparent",
              }}
            >
              <button
                type="button"
                onClick={() => activateTab(tab.id)}
                onAuxClick={(e) => {
                  if (e.button === 1) closeTab(tab.id)
                }}
                className="flex min-w-0 items-center gap-1.5 py-1.5 text-left"
                title={tab.workspaceName ? `${tab.title} · ${tab.workspaceName}` : tab.title}
              >
                <span className="shrink-0" style={{ color: active ? "var(--fg-muted)" : "var(--fg-x-muted)" }}>
                  <KindIcon kind={tab.kind} />
                </span>
                <span
                  className="min-w-0 truncate text-[12px]"
                  style={{ color: active ? "var(--fg)" : "var(--fg-muted)" }}
                >
                  {tab.title}
                </span>
              </button>
              <button
                type="button"
                onClick={() => closeTab(tab.id)}
                title={t("shell.closeTab")}
                aria-label={t("shell.closeTab")}
                className="grid size-4 shrink-0 place-items-center rounded-[var(--r-sm)] opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--surface-3)]"
                style={{ color: "var(--fg-muted)" }}
              >
                <X className="size-3" />
              </button>
              {active && (
                <span
                  className="absolute inset-x-0 -bottom-px h-px"
                  style={{ background: "var(--surface-workspace)" }}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
