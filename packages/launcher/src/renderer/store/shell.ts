import { create } from 'zustand'

/**
 * Shell layout + open-tab state for the session-centric window.
 *
 * Mirrors Paseo's panel store: a resizable left sidebar (sessions), a center
 * pane of tabs, and a right explorer panel. Widths are clamped so the center
 * pane can never be squeezed below MIN_CENTER — Paseo does the same clamp in
 * `resolveDesktopPanelWidth`, and without it dragging the sidebar to the right
 * edge leaves an unusable 40px conversation column.
 */

export const MIN_SIDEBAR = 200
export const MAX_SIDEBAR = 600
export const DEFAULT_SIDEBAR = 320
export const MIN_EXPLORER = 280
export const DEFAULT_EXPLORER = 420
export const MIN_CENTER = 400

export type TabKind = 'session' | 'manage' | 'embedded'
export type ExplorerTab = 'changes' | 'files'

export interface ShellTab {
  id: string
  kind: TabKind
  title: string
  /** session tabs */
  workspaceId?: string
  workspaceName?: string
  channelName?: string
  /** manage tabs — one of the legacy page ids (agents, install, settings, …) */
  page?: string
  /** embedded tabs — a workspace web URL rendered by the main process */
  url?: string
}

export function sessionTabId(workspaceId: string, channelName: string): string {
  return `session:${workspaceId}:${channelName}`
}

export function manageTabId(page: string): string {
  return `manage:${page}`
}

interface Persisted {
  sidebarWidth: number
  sidebarOpen: boolean
  explorerWidth: number
  explorerOpen: boolean
  explorerTab: ExplorerTab
  collapsedGroups: Record<string, boolean>
  repoPaths: Record<string, string>
}

const STORAGE_KEY = 'launcher:shell-layout'

function readPersisted(): Partial<Persisted> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Partial<Persisted>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function persist(state: ShellState): void {
  const snapshot: Persisted = {
    sidebarWidth: state.sidebarWidth,
    sidebarOpen: state.sidebarOpen,
    explorerWidth: state.explorerWidth,
    explorerOpen: state.explorerOpen,
    explorerTab: state.explorerTab,
    collapsedGroups: state.collapsedGroups,
    repoPaths: state.repoPaths,
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  } catch {}
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/** Widest a side panel may get before the center pane would drop under MIN_CENTER. */
function panelCeiling(viewportWidth: number, otherPanelWidth: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, viewportWidth - otherPanelWidth - MIN_CENTER))
}

interface ShellState extends Persisted {
  tabs: ShellTab[]
  activeTabId: string | null

  setSidebarWidth: (width: number, viewportWidth: number) => void
  toggleSidebar: () => void
  setExplorerWidth: (width: number, viewportWidth: number) => void
  toggleExplorer: () => void
  setExplorerTab: (tab: ExplorerTab) => void
  toggleGroup: (groupId: string) => void
  setRepoPath: (workspaceId: string, path: string | null) => void

  openTab: (tab: ShellTab, opts?: { activate?: boolean }) => void
  closeTab: (id: string) => void
  activateTab: (id: string) => void
  renameTab: (id: string, title: string) => void
}

const initial = readPersisted()

export const useShellStore = create<ShellState>((set, get) => ({
  sidebarWidth: clamp(initial.sidebarWidth ?? DEFAULT_SIDEBAR, MIN_SIDEBAR, MAX_SIDEBAR),
  sidebarOpen: initial.sidebarOpen ?? true,
  explorerWidth: Math.max(initial.explorerWidth ?? DEFAULT_EXPLORER, MIN_EXPLORER),
  explorerOpen: initial.explorerOpen ?? false,
  explorerTab: initial.explorerTab === 'files' ? 'files' : 'changes',
  collapsedGroups: initial.collapsedGroups ?? {},
  repoPaths: initial.repoPaths ?? {},

  tabs: [],
  activeTabId: null,

  setSidebarWidth: (width, viewportWidth) => {
    const ceiling = panelCeiling(
      viewportWidth,
      get().explorerOpen ? get().explorerWidth : 0,
      MIN_SIDEBAR,
      MAX_SIDEBAR,
    )
    set({ sidebarWidth: clamp(width, MIN_SIDEBAR, ceiling) })
    persist(get())
  },

  toggleSidebar: () => {
    set((s) => ({ sidebarOpen: !s.sidebarOpen }))
    persist(get())
  },

  setExplorerWidth: (width, viewportWidth) => {
    const ceiling = panelCeiling(
      viewportWidth,
      get().sidebarOpen ? get().sidebarWidth : 0,
      MIN_EXPLORER,
      Math.max(MIN_EXPLORER, viewportWidth),
    )
    set({ explorerWidth: clamp(width, MIN_EXPLORER, ceiling) })
    persist(get())
  },

  toggleExplorer: () => {
    set((s) => ({ explorerOpen: !s.explorerOpen }))
    persist(get())
  },

  setExplorerTab: (explorerTab) => {
    set({ explorerTab })
    persist(get())
  },

  toggleGroup: (groupId) => {
    set((s) => ({
      collapsedGroups: { ...s.collapsedGroups, [groupId]: !s.collapsedGroups[groupId] },
    }))
    persist(get())
  },

  setRepoPath: (workspaceId, path) => {
    set((s) => {
      const next = { ...s.repoPaths }
      if (path) next[workspaceId] = path
      else delete next[workspaceId]
      return { repoPaths: next }
    })
    persist(get())
  },

  openTab: (tab, opts) => {
    const activate = opts?.activate !== false
    set((s) => {
      const existing = s.tabs.find((t) => t.id === tab.id)
      if (existing) {
        return { activeTabId: activate ? tab.id : s.activeTabId }
      }
      return {
        tabs: [...s.tabs, tab],
        activeTabId: activate ? tab.id : (s.activeTabId ?? tab.id),
      }
    })
  },

  closeTab: (id) =>
    set((s) => {
      const index = s.tabs.findIndex((t) => t.id === id)
      if (index === -1) return s
      const tabs = s.tabs.filter((t) => t.id !== id)
      if (s.activeTabId !== id) return { tabs }
      // Closing the active tab hands focus to its right neighbour, falling back
      // to the left one — the same rule editors use, so muscle memory carries.
      const next = tabs[index] ?? tabs[index - 1] ?? null
      return { tabs, activeTabId: next ? next.id : null }
    }),

  activateTab: (id) => set({ activeTabId: id }),

  renameTab: (id, title) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)) })),
}))
