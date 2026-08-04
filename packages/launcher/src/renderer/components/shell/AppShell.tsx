import React from "react"
import { MessageSquarePlus } from "lucide-react"
import { useTranslation } from "react-i18next"
import { useShallow } from "zustand/react/shallow"
import type { ToastType } from "../../hooks/useToast"
import { useChatEventBridge } from "../../hooks/useSessionStream"
import { usePythonStatus } from "../../hooks/usePythonStatus"
import { useSessionTree, type WorkspaceGroup } from "../../hooks/useSessionTree"
import { useUiStore } from "../../store/ui"
import {
  DEFAULT_EXPLORER,
  DEFAULT_SIDEBAR,
  manageTabId,
  sessionTabId,
  useShellStore,
} from "../../store/shell"
import { workspaceWebBaseUrl } from "../../lib/workspace-urls"
import Dashboard from "../../pages/dashboard"
import Agents from "../../pages/agents"
import Workspaces from "../../pages/workspaces"
import Connections from "../../pages/connections"
import Credentials from "../../pages/credentials"
import GitHubPage from "../../pages/github"
import Install from "../../pages/install"
import Logs from "../../pages/logs"
import Settings from "../../pages/settings"
import ExplorerPanel from "../panel/ExplorerPanel"
import ResizeHandle from "./ResizeHandle"
import SessionPane from "./SessionPane"
import SessionSidebar, { SidebarRail } from "./SessionSidebar"
import TabStrip from "./TabStrip"
import WorkspaceTitleBar from "./WorkspaceTitleBar"

function ManagePage({
  page,
  showToast,
}: {
  page: string
  showToast: (msg: string, type?: ToastType) => void
}): React.JSX.Element | null {
  switch (page) {
    case "dashboard":
      return <Dashboard showToast={showToast} onOpenConfigure={() => {}} onOpenConnectWorkspace={() => {}} />
    case "agents":
      return <Agents showToast={showToast} />
    case "workspaces":
      return <Workspaces showToast={showToast} />
    case "connections":
      return <Connections showToast={showToast} />
    case "credentials":
      return <Credentials showToast={showToast} />
    case "github":
      return <GitHubPage showToast={showToast} />
    case "install":
      return <Install showToast={showToast} />
    case "logs":
      return <Logs showToast={showToast} />
    case "settings":
      return <Settings showToast={showToast} />
    default:
      return null
  }
}

/**
 * Session-centric window: sessions on the left, tabbed panes in the middle,
 * Changes/Files on the right.
 *
 * The management screens didn't go away — they open as tabs. That keeps one
 * navigation model for everything (a tab is a tab) instead of a mode switch
 * between "browsing agents" and "working in a session".
 */
export default function AppShell({
  showToast,
}: {
  showToast: (msg: string, type?: ToastType) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { groups, refresh } = useSessionTree()
  useChatEventBridge(showToast)
  // Keeps the sidebar footer's version label populated regardless of which tab
  // is open — the old sidebar owned this and it went away with it.
  usePythonStatus()

  const currentTab = useUiStore((s) => s.currentTab)

  const {
    sidebarOpen,
    sidebarWidth,
    explorerOpen,
    explorerWidth,
    tabs,
    activeTabId,
    openTab,
    closeTab,
    toggleSidebar,
    toggleExplorer,
    setSidebarWidth,
    setExplorerWidth,
  } = useShellStore(
    useShallow((s) => ({
      sidebarOpen: s.sidebarOpen,
      sidebarWidth: s.sidebarWidth,
      explorerOpen: s.explorerOpen,
      explorerWidth: s.explorerWidth,
      tabs: s.tabs,
      activeTabId: s.activeTabId,
      openTab: s.openTab,
      closeTab: s.closeTab,
      toggleSidebar: s.toggleSidebar,
      toggleExplorer: s.toggleExplorer,
      setSidebarWidth: s.setSidebarWidth,
      setExplorerWidth: s.setExplorerWidth,
    })),
  )

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null
  const centerRef = React.useRef<HTMLDivElement | null>(null)

  // Anything that navigates by `currentTab` — the command palette, notification
  // clicks, the tray's deep-link to Install, dashboard quick actions — keeps
  // working: a change to it opens (or focuses) the matching management tab.
  React.useEffect(() => {
    if (!currentTab) return
    openTab({
      id: manageTabId(currentTab),
      kind: "manage",
      title: t(`nav.items.${currentTab}.label`),
      page: currentTab,
    })
  }, [currentTab, openTab, t])

  React.useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return
      const key = event.key.toLowerCase()
      if (key === "b") {
        event.preventDefault()
        toggleSidebar()
      } else if (key === "j") {
        event.preventDefault()
        toggleExplorer()
      } else if (key === "w" && activeTabId) {
        event.preventDefault()
        closeTab(activeTabId)
      }
    }
    document.addEventListener("keydown", handler)
    return () => document.removeEventListener("keydown", handler)
  }, [toggleSidebar, toggleExplorer, closeTab, activeTabId])

  // The embedded workspace web view is a native child of the window, so it has
  // to be positioned over the center pane in device-independent pixels and
  // hidden the moment another tab takes over.
  React.useEffect(() => {
    const element = centerRef.current
    if (!element) return
    if (activeTab?.kind !== "embedded" || !activeTab.url) {
      void window.api.hideEmbeddedView().catch(() => {})
      return
    }
    const sync = (): void => {
      const rect = element.getBoundingClientRect()
      void window.api
        .showEmbeddedView(
          {
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          activeTab.url,
        )
        .catch(() => {})
    }
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(element)
    window.addEventListener("resize", sync)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", sync)
      void window.api.hideEmbeddedView().catch(() => {})
    }
  }, [activeTab])

  const createSession = async (workspaceId: string): Promise<void> => {
    try {
      const session = await window.api.sessionCreate(workspaceId)
      await refresh()
      openTab({
        id: sessionTabId(session.workspaceId, session.channelName),
        kind: "session",
        title: session.title || session.channelName,
        workspaceId: session.workspaceId,
        workspaceName: session.workspaceName,
        channelName: session.channelName,
      })
    } catch (error) {
      showToast(t("chat.toasts.newChatFailed", { error: (error as Error).message }), "error")
    }
  }

  const openWorkspaceWeb = (group: WorkspaceGroup): void => {
    const url = workspaceWebBaseUrl(group.workspace.endpoint)
    openTab({
      id: `embedded:${group.workspace.id}`,
      kind: "embedded",
      title: group.label,
      workspaceId: group.workspace.id,
      workspaceName: group.label,
      url,
    })
  }

  const firstWorkspaceId = groups[0]?.workspace.id ?? null

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "var(--surface-0)" }}>
      {sidebarOpen ? (
        <>
          <div style={{ width: sidebarWidth }} className="shrink-0">
            <SessionSidebar
              groups={groups}
              onCreateSession={(workspaceId) => void createSession(workspaceId)}
              onOpenWorkspaceWeb={openWorkspaceWeb}
            />
          </div>
          <ResizeHandle
            ariaLabel={t("shell.resizeSidebar")}
            onDrag={(clientX) => setSidebarWidth(clientX, window.innerWidth)}
            onReset={() => setSidebarWidth(DEFAULT_SIDEBAR, window.innerWidth)}
          />
        </>
      ) : (
        <SidebarRail
          onExpand={toggleSidebar}
          onNewSession={() => firstWorkspaceId && void createSession(firstWorkspaceId)}
        />
      )}

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <WorkspaceTitleBar activeTab={activeTab} />
        <TabStrip />

        {activeTab === null ? (
          <div
            className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center"
            style={{ background: "var(--surface-workspace)" }}
          >
            <MessageSquarePlus className="size-7" style={{ color: "var(--fg-x-muted)" }} />
            <p className="m-0 text-[14px]" style={{ color: "var(--fg-muted)" }}>
              {t("shell.welcome")}
            </p>
            {firstWorkspaceId && (
              <button
                type="button"
                onClick={() => void createSession(firstWorkspaceId)}
                className="rounded-[var(--r-md)] px-3 py-1.5 text-[13px]"
                style={{ background: "var(--accent)", color: "var(--accent-fg)" }}
              >
                {t("shell.newSession")}
              </button>
            )}
          </div>
        ) : (
          <div ref={centerRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {activeTab.kind === "session" && (
              <SessionPane
                key={activeTab.id}
                tab={activeTab}
                showToast={showToast}
                onSessionDeleted={() => void refresh()}
              />
            )}
            {activeTab.kind === "manage" && activeTab.page && (
              <div
                className="flex min-h-0 flex-1 flex-col overflow-hidden"
                style={{ background: "var(--surface-0)" }}
              >
                <ManagePage page={activeTab.page} showToast={showToast} />
              </div>
            )}
            {activeTab.kind === "embedded" && (
              // The native view paints here; this element only reserves the box.
              <div className="flex-1" style={{ background: "var(--surface-workspace)" }} />
            )}
          </div>
        )}
      </main>

      {/* The explorer belongs to a workspace, so it only shows for tabs that
          have one. On a management tab it would be a dead column stealing ~460px
          from pages that already want the room. */}
      {explorerOpen && activeTab !== null && activeTab.kind !== "manage" && (
        <>
          <ResizeHandle
            ariaLabel={t("shell.resizePanel")}
            onDrag={(clientX) => setExplorerWidth(window.innerWidth - clientX, window.innerWidth)}
            onReset={() => setExplorerWidth(DEFAULT_EXPLORER, window.innerWidth)}
          />
          <div style={{ width: explorerWidth }} className="shrink-0">
            <ExplorerPanel workspaceId={activeTab?.workspaceId ?? firstWorkspaceId} />
          </div>
        </>
      )}
    </div>
  )
}
