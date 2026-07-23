import React from "react"
import {
  LayoutDashboard,
  Cpu,
  Layers,
  Plug,
  Download,
  FileText,
  Settings as SettingsIcon,
  Bell,
  Moon,
  Sun,
  Monitor,
  HelpCircle,
  Network,
  CheckSquare,
  BookOpen
} from "lucide-react"
import { useShallow } from "zustand/react/shallow"
import { useTranslation } from "react-i18next"
import { cn } from "../lib/utils"
import { capture } from "../lib/analytics"
import { useUiStore } from "../store/ui"
import { useAgentsStore, useDaemonStatus } from "../store/agents"
import { useInstallStore } from "../store/install"
import { useNotificationsStore } from "../store/notifications"
import { useThemeStore, type ThemeMode } from "../store/theme"
import { useUpdateDismissals } from "../hooks/useUpdateDismissals"

type SectionId = "overview" | "manage" | "system"

interface NavItem {
  id: string
  icon: React.JSX.Element
  section: SectionId
}

const NAV_ITEMS: NavItem[] = [
  { id: "dashboard", icon: <LayoutDashboard className="size-4" />, section: "overview" },
  { id: "workspaces", icon: <Layers className="size-4" />, section: "overview" },
  
  { id: "install", icon: <Download className="size-4" />, section: "manage" },
  { id: "agents", icon: <Cpu className="size-4" />, section: "manage" },
  { id: "skills", icon: <Network className="size-4" />, section: "manage" },
  { id: "tasks", icon: <CheckSquare className="size-4" />, section: "manage" },
  { id: "knowledge", icon: <BookOpen className="size-4" />, section: "manage" },
  
  { id: "connections", icon: <Plug className="size-4" />, section: "system" },
  { id: "logs", icon: <FileText className="size-4" />, section: "system" },
  { id: "settings", icon: <SettingsIcon className="size-4" />, section: "system" },
]

export default function Sidebar(): React.JSX.Element {
  const { t } = useTranslation()
  const { currentTab, setCurrentTab, goToInstallList } = useUiStore(
    useShallow((s) => ({
      currentTab: s.currentTab,
      setCurrentTab: s.setCurrentTab,
      goToInstallList: s.goToInstallList,
    })),
  )
  const launcherVersion = useAgentsStore((s) => s.launcherVersion)
  const updates = useInstallStore((s) => s.updates)
  const { isDismissed } = useUpdateDismissals()
  const daemonStatus = useDaemonStatus()

  const updateCount = updates.filter(
    (u) =>
      u.current &&
      u.latest &&
      u.current !== u.latest &&
      !isDismissed(u.name, u.latest),
  ).length

  const badges: Record<string, number | undefined> = {
    install: updateCount > 0 ? updateCount : undefined,
  }

  const daemonLabel =
    daemonStatus === "running"
      ? t("nav.daemon.running")
      : daemonStatus === "starting"
        ? t("nav.daemon.starting")
        : daemonStatus === "stopped"
          ? t("nav.daemon.stopped")
          : t("nav.daemon.offline")

  const sections: SectionId[] = ["overview", "manage", "system"]

  return (
    <aside
      data-sidebar="dark"
      className={cn(
        "w-(--sidebar-width) shrink-0 h-screen",
        "flex flex-col sidebar-drag select-none",
        "bg-[#060608] text-zinc-400 border-r border-zinc-800/80 shadow-[1px_0_10px_rgba(0,0,0,0.5)] z-20",
      )}
    >
      {/* Brand */}
      <div className="px-4 pt-6 pb-5 sidebar-no-drag">
        <div className="flex items-center gap-3 min-w-0">
          <div className="size-8 rounded-lg flex items-center justify-center text-[10.5px] font-black text-white shrink-0 shadow-[0_2px_12px_rgba(6,182,212,0.5)] bg-gradient-to-br from-cyan-400 to-blue-600 border border-cyan-300/30">
            52
          </div>
          <div className="flex flex-col">
            <span
              className="text-[14.5px] font-bold tracking-tight text-zinc-100 truncate leading-none mb-1"
              title="52hzAgents Workstation"
            >
              52hzAgents
            </span>
            <span className="text-[10px] text-cyan-500 font-medium tracking-wide uppercase">Workstation</span>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto px-3 py-2 sidebar-no-drag custom-scrollbar">
        {sections.map((section) => {
          const items = NAV_ITEMS.filter((i) => i.section === section)
          return (
            <div key={section} className="mb-6 last:mb-0">
              <div className="px-3 mb-2 text-[10px] font-bold uppercase tracking-wider text-zinc-600">
                {t(`nav.sections.${section}`)}
              </div>
              <ul className="m-0 p-0 list-none flex flex-col gap-0.5">
                {items.map((item) => {
                  const active = currentTab === item.id
                  const badge = badges[item.id]
                  return (
                    <li key={item.id} className="m-0">
                      <button
                        type="button"
                        data-tour={item.id}
                        data-testid={`nav-${item.id}`}
                        title={t(`nav.items.${item.id}.description`)}
                        onClick={() => {
                          capture("tab_switched", { tab: item.id })
                          item.id === "install"
                            ? goToInstallList()
                            : setCurrentTab(item.id)
                        }}
                        className={cn(
                          "group w-full flex items-center gap-3 px-3 py-2",
                          "rounded-xl text-[13px] font-medium text-left cursor-pointer",
                          "transition-all duration-200 border-0 relative overflow-hidden",
                          active
                            ? "bg-cyan-500/10 text-cyan-400 font-semibold"
                            : "bg-transparent text-zinc-400 hover:bg-zinc-900/80 hover:text-zinc-200",
                        )}
                      >
                        {active && (
                          <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-3/5 bg-cyan-400 rounded-r-full shadow-[0_0_10px_rgba(6,182,212,0.8)]" />
                        )}
                        <span
                          className={cn(
                            "shrink-0 transition-colors",
                            active ? "text-cyan-400" : "text-zinc-500 group-hover:text-zinc-400",
                          )}
                        >
                          {item.icon}
                        </span>
                        <span className="flex-1 truncate">{t(`nav.items.${item.id}.label`)}</span>
                        {badge !== undefined && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full shrink-0 text-white bg-[#6366f1]">
                            {badge}
                          </span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </nav>

      {/* Footer: bell + theme + guide strip, then daemon status + version */}
      <div className="px-3 py-2 sidebar-no-drag flex items-center gap-1 border-t border-white/5">
        <NotificationBellDark />
        <ThemeToggleDark />
        <GuideButtonDark />
      </div>
      <div
        className="px-4 pt-2 pb-3 sidebar-no-drag flex items-center gap-2 text-[11px] text-[#7a7e8c]"
        title={daemonLabel}
      >
        <span
          className={cn(
            "inline-block w-[7px] h-[7px] rounded-full shrink-0",
            daemonStatus === "running" &&
              "bg-[#22c55e] shadow-[0_0_0_3px_rgba(34,197,94,0.15)]",
            daemonStatus === "starting" &&
              "bg-[#f59e0b] animate-[pulse-dot_1.5s_infinite]",
            daemonStatus === "stopped" && "bg-[#f59e0b]",
            daemonStatus !== "running" &&
              daemonStatus !== "starting" &&
              daemonStatus !== "stopped" &&
              "bg-[#6b7280]",
          )}
        />
        <span className="truncate">{daemonLabel}</span>
        <span className="opacity-60">·</span>
        <span className="opacity-60 truncate">{launcherVersion || "v?"}</span>
      </div>
    </aside>
  )
}

// ── Dark-themed bell + theme toggle for the sidebar header ──────────────────

function NotificationBellDark(): React.JSX.Element {
  const { t } = useTranslation()
  const { items, unread, markRead, markAllRead, clear } = useNotificationsStore(
    useShallow((s) => ({
      items: s.items,
      unread: s.unread,
      markRead: s.markRead,
      markAllRead: s.markAllRead,
      clear: s.clear,
    })),
  )
  const setCurrentTab = useUiStore((s) => s.setCurrentTab)
  const [open, setOpen] = React.useState(false)
  const popoverRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent): void => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        setOpen(false)
      }
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [open])

  const recent = items.slice(0, 30)

  return (
    <div className="relative" ref={popoverRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={t("nav.notifications.tooltip")}
        className="relative w-7 h-7 rounded-md flex items-center justify-center cursor-pointer border-0 bg-transparent text-[#a8aabb] hover:bg-[#15171f] hover:text-white transition-colors"
      >
        <Bell className="w-3.5 h-3.5" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-3.5 h-3.5 px-1 rounded-full text-[9px] font-bold leading-3.5 text-center text-white bg-[#ef4444]">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          className={cn(
            "absolute left-0 bottom-[calc(100%+8px)] z-50",
            "w-[340px] max-h-[460px]",
            "bg-(--bg-card) border border-(--border) rounded-(--radius)",
            "shadow-lg overflow-hidden flex flex-col",
            "text-(--text-primary)",
          )}
        >
          <div className="flex items-center justify-between px-3 py-2.5 border-b border-(--border)">
            <div className="text-[13px] font-semibold text-(--text-primary)">
              {t("nav.notifications.title")}
              {unread > 0 && (
                <span className="ml-1.5 text-[11px] text-(--text-tertiary) font-normal">
                  {t("nav.notifications.unread", { count: unread })}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {unread > 0 && (
                <button
                  type="button"
                  onClick={() => markAllRead()}
                  className="text-[11px] text-(--text-secondary) hover:text-(--text-primary) bg-transparent border-0 cursor-pointer"
                >
                  {t("nav.notifications.markAllRead")}
                </button>
              )}
              {items.length > 0 && (
                <button
                  type="button"
                  onClick={() => clear()}
                  className="text-[11px] text-(--text-secondary) hover:text-(--text-primary) bg-transparent border-0 cursor-pointer"
                >
                  {t("nav.notifications.clear")}
                </button>
              )}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto">
            {recent.length === 0 ? (
              <div className="px-4 py-8 text-center text-[12px] text-(--text-tertiary)">
                {t("nav.notifications.empty")}
              </div>
            ) : (
              <ul className="m-0 p-0 list-none">
                {recent.map((r) => (
                  <li
                    key={r.id}
                    onClick={() => {
                      if (!r.read) void markRead(r.id)
                      if (r.payload && typeof r.payload.tab === "string") {
                        setCurrentTab(r.payload.tab as string)
                        setOpen(false)
                      }
                    }}
                    className={cn(
                      "px-3 py-2 border-b border-(--border) cursor-pointer hover:bg-(--bg-input)",
                      !r.read && "bg-(--accent-bg)",
                    )}
                  >
                    <div className="text-[12px] font-medium text-(--text-primary) truncate">
                      {r.title}
                    </div>
                    <div className="text-[11px] text-(--text-secondary) line-clamp-2 mt-0.5">
                      {r.body}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function GuideButtonDark(): React.JSX.Element {
  const { t } = useTranslation()
  const startTour = useUiStore((s) => s.startTour)
  return (
    <button
      type="button"
      onClick={() => startTour()}
      title={t("nav.guide")}
      aria-label={t("nav.guide")}
      className="w-7 h-7 rounded-md flex items-center justify-center cursor-pointer border-0 bg-transparent text-[#a8aabb] hover:bg-[#15171f] hover:text-white transition-colors"
    >
      <HelpCircle className="w-3.5 h-3.5" />
    </button>
  )
}

function ThemeToggleDark(): React.JSX.Element {
  const { t } = useTranslation()
  const { mode, setMode } = useThemeStore(
    useShallow((s) => ({ mode: s.mode, setMode: s.setMode })),
  )
  const next: ThemeMode =
    mode === "light" ? "dark" : mode === "dark" ? "system" : "light"
  const Icon = mode === "dark" ? Moon : mode === "system" ? Monitor : Sun
  return (
    <button
      type="button"
      onClick={() => setMode(next)}
      title={t("nav.themeTooltip", {
        mode: t(`settings.appearance.modes.${mode}`),
        next: t(`settings.appearance.modes.${next}`),
      })}
      aria-label={t("nav.themeToggle")}
      className="w-7 h-7 rounded-md flex items-center justify-center cursor-pointer border-0 bg-transparent text-[#a8aabb] hover:bg-[#15171f] hover:text-white transition-colors"
    >
      <Icon className="w-3.5 h-3.5" />
    </button>
  )
}
