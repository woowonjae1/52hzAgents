import React from "react"
import {
  ChevronDown,
  ChevronRight,
  Cpu,
  Download,
  FileText,
  GitBranch,
  Github,
  KeyRound,
  LayoutDashboard,
  Layers,
  MessageSquare,
  PanelLeftClose,
  Plug,
  Plus,
  Search,
  Settings as SettingsIcon,
  Sparkles,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { useShallow } from "zustand/react/shallow"
import { cn } from "../../lib/utils"
import { capture } from "../../lib/analytics"
import { useDaemonStatus, useAgentsStore } from "../../store/agents"
import { manageTabId, sessionTabId, useShellStore } from "../../store/shell"
import { useChatStore, channelKey } from "../../store/chat"
import type { ChatSessionMeta } from "../../types"
import type { WorkspaceGroup } from "../../hooks/useSessionTree"
import StatusDot, { type ShellStatus } from "./StatusDot"
import { NotificationCenterButton } from "../notifications/NotificationCenter"
import ThemePicker from "./ThemePicker"

const MANAGE_PAGES: Array<{ id: string; icon: React.JSX.Element }> = [
  { id: "dashboard", icon: <LayoutDashboard className="size-3.5" /> },
  { id: "workspaces", icon: <Layers className="size-3.5" /> },
  { id: "install", icon: <Download className="size-3.5" /> },
  { id: "agents", icon: <Cpu className="size-3.5" /> },
  { id: "connections", icon: <Plug className="size-3.5" /> },
  { id: "credentials", icon: <KeyRound className="size-3.5" /> },
  { id: "github", icon: <Github className="size-3.5" /> },
  { id: "logs", icon: <FileText className="size-3.5" /> },
  { id: "settings", icon: <SettingsIcon className="size-3.5" /> },
]

/** Stable per-project tint, so the same workspace always gets the same block. */
const AVATAR_TINTS = [
  "#3b6fcf",
  "#20744a",
  "#a670f5",
  "#c38328",
  "#2ead58",
  "#c64f43",
  "#4aabb8",
  "#8728e5",
]

function tintFor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0
  return AVATAR_TINTS[Math.abs(hash) % AVATAR_TINTS.length]
}

/** Letter block standing in for a project logo. */
function ProjectAvatar({ label }: { label: string }): React.JSX.Element {
  const letter = (label.replace(/^[^a-z0-9一-龥]+/i, "")[0] ?? label[0] ?? "?").toUpperCase()
  return (
    <span
      className="grid size-4 shrink-0 place-items-center rounded-[var(--r-base)] text-[9px] font-bold"
      style={{ background: tintFor(label), color: "#ffffff" }}
    >
      {letter}
    </span>
  )
}

function relativeTime(iso: string | null): string {
  if (!iso) return ""
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ""
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/**
 * Gear menu holding the management screens.
 *
 * They used to be a permanent list in the sidebar, which made a session tree and
 * a settings menu compete for the same column. Behind the gear the sidebar is
 * only ever about sessions.
 */
function ManageMenu(): React.JSX.Element {
  const { t } = useTranslation()
  const openTab = useShellStore((s) => s.openTab)
  const [open, setOpen] = React.useState(false)
  const containerRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    if (!open) return
    const handler = (event: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [open])

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        data-testid="open-manage-menu"
        onClick={() => setOpen((v) => !v)}
        title={t("nav.sections.manage")}
        aria-label={t("nav.sections.manage")}
        className="grid size-7 place-items-center rounded-[var(--r-md)] hover:bg-[var(--surface-sidebar-hover)]"
        style={{ color: "var(--fg-muted)" }}
      >
        <SettingsIcon className="size-3.5" />
      </button>

      {open && (
        <div
          className="absolute bottom-[calc(100%+6px)] right-0 z-50 w-52 overflow-hidden rounded-[var(--r-xl)] border py-1"
          style={{
            background: "var(--surface-2)",
            borderColor: "var(--border-c)",
            boxShadow: "var(--shadow-lg)",
          }}
        >
          {MANAGE_PAGES.map((page) => (
            <button
              key={page.id}
              type="button"
              data-tour={page.id}
              data-testid={`nav-${page.id}`}
              onClick={() => {
                capture("tab_switched", { tab: page.id })
                openTab({
                  id: manageTabId(page.id),
                  kind: "manage",
                  title: t(`nav.items.${page.id}.label`),
                  page: page.id,
                })
                setOpen(false)
              }}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-[var(--surface-3)]"
            >
              <span className="shrink-0" style={{ color: "var(--fg-x-muted)" }}>
                {page.icon}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13px]" style={{ color: "var(--fg)" }}>
                {t(`nav.items.${page.id}.label`)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function SessionSidebar({
  groups,
  onCreateSession,
  onOpenWorkspaceWeb,
}: {
  groups: WorkspaceGroup[]
  onCreateSession: (workspaceId: string) => void
  onOpenWorkspaceWeb: (group: WorkspaceGroup) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [query, setQuery] = React.useState("")
  const daemonStatus = useDaemonStatus()
  const launcherVersion = useAgentsStore((s) => s.launcherVersion)
  const thinkingAgents = useChatStore((s) => s.thinkingAgents)

  const { tabs, activeTabId, openTab, toggleGroup, collapsedGroups, toggleSidebar } = useShellStore(
    useShallow((s) => ({
      tabs: s.tabs,
      activeTabId: s.activeTabId,
      openTab: s.openTab,
      toggleGroup: s.toggleGroup,
      collapsedGroups: s.collapsedGroups,
      toggleSidebar: s.toggleSidebar,
    })),
  )

  const needle = query.trim().toLowerCase()
  const visibleGroups = React.useMemo(() => {
    if (!needle) return groups
    return groups
      .map((group) => ({
        ...group,
        sessions: group.sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(needle) ||
            (s.lastMessagePreview ?? "").toLowerCase().includes(needle) ||
            s.channelName.toLowerCase().includes(needle),
        ),
      }))
      .filter((group) => group.sessions.length > 0 || group.label.toLowerCase().includes(needle))
  }, [groups, needle])

  const openSession = (session: ChatSessionMeta): void => {
    capture("session_opened", { workspace: session.workspaceId })
    openTab({
      id: sessionTabId(session.workspaceId, session.channelName),
      kind: "session",
      title: session.title || session.channelName,
      workspaceId: session.workspaceId,
      workspaceName: session.workspaceName,
      channelName: session.channelName,
    })
  }

  const sessionStatus = (session: ChatSessionMeta): ShellStatus => {
    const thinking = thinkingAgents[channelKey(session.workspaceId, session.channelName)]
    if (thinking && thinking.size > 0) return "working"
    return session.messageCount > 0 ? "online" : "idle"
  }

  const daemonLabel =
    daemonStatus === "running"
      ? t("nav.daemon.running")
      : daemonStatus === "starting"
        ? t("nav.daemon.starting")
        : daemonStatus === "stopped"
          ? t("nav.daemon.stopped")
          : t("nav.daemon.offline")

  const daemonDot: ShellStatus =
    daemonStatus === "running"
      ? "online"
      : daemonStatus === "starting"
        ? "working"
        : daemonStatus === "stopped"
          ? "idle"
          : "offline"

  const firstWorkspaceId = groups[0]?.workspace.id ?? null

  return (
    <aside
      className="flex h-screen min-w-0 flex-col border-r"
      style={{ background: "var(--surface-sidebar)", borderColor: "var(--border-c)" }}
    >
      {/* Header — also the window drag strip on frameless platforms. */}
      <div className="sidebar-drag flex h-11 shrink-0 items-center gap-2 pl-3 pr-2">
        <MessageSquare className="size-3.5 shrink-0" style={{ color: "var(--fg-muted)" }} />
        <span className="min-w-0 flex-1 truncate text-[13px]" style={{ color: "var(--fg-muted)" }}>
          {t("shell.sessions")}
        </span>
        <button
          type="button"
          onClick={toggleSidebar}
          title={t("shell.collapseSidebar")}
          className="sidebar-no-drag grid size-6 place-items-center rounded-[var(--r-md)] hover:bg-[var(--surface-sidebar-hover)]"
          style={{ color: "var(--fg-muted)" }}
        >
          <PanelLeftClose className="size-3.5" />
        </button>
      </div>

      {/* Filter */}
      <div className="sidebar-no-drag px-2 pb-1.5">
        <div
          className="flex items-center gap-1.5 rounded-[var(--r-lg)] px-2 py-1"
          style={{ background: "var(--surface-2)" }}
        >
          <Search className="size-3.5 shrink-0" style={{ color: "var(--fg-x-muted)" }} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("shell.filterPlaceholder")}
            className="min-w-0 flex-1 border-0 bg-transparent text-[13px] outline-none"
            style={{ color: "var(--fg)" }}
          />
        </div>
      </div>

      {/* Tree */}
      <div className="sidebar-no-drag min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {visibleGroups.length === 0 && (
          <p className="px-2 py-6 text-center text-[12px]" style={{ color: "var(--fg-x-muted)" }}>
            {needle ? t("shell.noMatches") : t("shell.noWorkspaces")}
          </p>
        )}

        {visibleGroups.map((group) => {
          const collapsed = collapsedGroups[group.workspace.id] === true && !needle
          return (
            <div key={group.workspace.id} className="mb-2">
              <div className="group flex items-center gap-1 rounded-[var(--r-lg)] px-1.5 hover:bg-[var(--surface-sidebar-hover)]">
                <button
                  type="button"
                  onClick={() => toggleGroup(group.workspace.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left"
                >
                  <ProjectAvatar label={group.label} />
                  <span
                    className="min-w-0 flex-1 truncate text-[13px] font-medium"
                    style={{ color: "var(--fg)" }}
                    title={group.workspace.slug}
                  >
                    {group.label}
                  </span>
                  {collapsed ? (
                    <ChevronRight className="size-3 shrink-0" style={{ color: "var(--fg-x-muted)" }} />
                  ) : (
                    <ChevronDown className="size-3 shrink-0" style={{ color: "var(--fg-x-muted)" }} />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => onOpenWorkspaceWeb(group)}
                  title={t("shell.openWorkspaceWeb")}
                  className="grid size-5 shrink-0 place-items-center rounded-[var(--r-base)] opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--surface-2)]"
                  style={{ color: "var(--fg-muted)" }}
                >
                  <Sparkles className="size-3" />
                </button>
                <button
                  type="button"
                  onClick={() => onCreateSession(group.workspace.id)}
                  title={t("shell.newSession")}
                  className="grid size-5 shrink-0 place-items-center rounded-[var(--r-base)] opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[var(--surface-2)]"
                  style={{ color: "var(--fg-muted)" }}
                >
                  <Plus className="size-3" />
                </button>
              </div>

              {!collapsed && (
                <ul className="m-0 list-none p-0">
                  {group.sessions.length === 0 && (
                    <li className="px-2 py-1.5 pl-8 text-[11px]" style={{ color: "var(--fg-x-muted)" }}>
                      {t("shell.noSessions")}
                    </li>
                  )}
                  {group.sessions.map((session) => {
                    const id = sessionTabId(session.workspaceId, session.channelName)
                    const active = activeTabId === id
                    const open = tabs.some((tab) => tab.id === id)
                    return (
                      <li key={id} className="m-0">
                        <button
                          type="button"
                          onClick={() => openSession(session)}
                          className={cn(
                            "flex w-full items-start gap-2 rounded-[var(--r-lg)] px-1.5 py-1.5 pl-3 text-left",
                            "hover:bg-[var(--surface-sidebar-hover)]",
                          )}
                          style={active ? { background: "var(--surface-2)" } : undefined}
                        >
                          <StatusDot status={sessionStatus(session)} size={6} className="mt-1.5" />
                          <span className="min-w-0 flex-1">
                            {/* Row one: title + the trailing signal, Paseo-style. */}
                            <span className="flex items-baseline gap-2">
                              <span
                                className="min-w-0 flex-1 truncate text-[13px]"
                                style={{
                                  color: active || open ? "var(--fg)" : "var(--fg-muted)",
                                  fontWeight: active ? 500 : 400,
                                }}
                              >
                                {session.title || session.channelName}
                              </span>
                              <span
                                className="shrink-0 text-[11px] tabular-nums"
                                style={{ color: "var(--fg-x-muted)" }}
                              >
                                {relativeTime(session.lastMessageAt)}
                              </span>
                            </span>
                            {/* Row two: the channel it lives on + traffic so far. */}
                            <span
                              className="mt-0.5 flex items-center gap-1 text-[11px]"
                              style={{ color: "var(--fg-x-muted)" }}
                            >
                              <GitBranch className="size-3 shrink-0" />
                              <span className="min-w-0 truncate font-mono">{session.channelName}</span>
                              {session.messageCount > 0 && (
                                <span className="shrink-0 tabular-nums">· {session.messageCount}</span>
                              )}
                            </span>
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )
        })}
      </div>

      {/* Footer */}
      <div
        className="sidebar-no-drag flex shrink-0 items-center gap-1 border-t px-2 py-1.5"
        style={{ borderColor: "var(--border-c)" }}
      >
        <span className="flex min-w-0 flex-1 items-center gap-1.5" title={daemonLabel}>
          <StatusDot status={daemonDot} size={6} />
          <span className="truncate text-[11px]" style={{ color: "var(--fg-x-muted)" }}>
            {launcherVersion || "v?"}
          </span>
        </span>
        <button
          type="button"
          onClick={() => firstWorkspaceId && onCreateSession(firstWorkspaceId)}
          disabled={!firstWorkspaceId}
          title={t("shell.newSession")}
          aria-label={t("shell.newSession")}
          className="grid size-7 place-items-center rounded-[var(--r-md)] hover:bg-[var(--surface-sidebar-hover)] disabled:opacity-40"
          style={{ color: "var(--fg-muted)" }}
        >
          <Plus className="size-4" />
        </button>
        <NotificationCenterButton />
        <ThemePicker />
        <ManageMenu />
      </div>
    </aside>
  )
}

/** Collapsed rail — one column of affordances so the sidebar can come back. */
export function SidebarRail({
  onExpand,
  onNewSession,
}: {
  onExpand: () => void
  onNewSession: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      className="flex h-screen w-10 shrink-0 flex-col items-center gap-1 border-r py-2"
      style={{ background: "var(--surface-sidebar)", borderColor: "var(--border-c)" }}
    >
      <button
        type="button"
        onClick={onExpand}
        title={t("shell.expandSidebar")}
        className="sidebar-no-drag grid size-7 place-items-center rounded-[var(--r-md)] hover:bg-[var(--surface-sidebar-hover)]"
        style={{ color: "var(--fg-muted)" }}
      >
        <MessageSquare className="size-4" />
      </button>
      <button
        type="button"
        onClick={onNewSession}
        title={t("shell.newSession")}
        className="sidebar-no-drag grid size-7 place-items-center rounded-[var(--r-md)] hover:bg-[var(--surface-sidebar-hover)]"
        style={{ color: "var(--fg-muted)" }}
      >
        <Plus className="size-4" />
      </button>
      <div className="flex-1" />
      <ManageMenu />
    </div>
  )
}
