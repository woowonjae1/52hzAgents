'use client';

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react';
import { useIsMobile } from '@/hooks/use-mobile';
import { TooltipProvider } from '@/components/ui/tooltip';
import { RowContextMenu } from '@/components/layout/row-context-menu';
import {
  DEFAULT_SIDEBAR_WIDTH,
  clampSidebarWidth,
  readStoredSidebarWidth,
  storeSidebarWidth,
} from '@/lib/panel-store';

export type ViewMode = 'mission' | 'threads' | 'files' | 'knowledge' | 'browser' | 'tasks' | 'timers' | 'routines' | 'inbox' | 'connect' | 'skills' | 'settings';

export type SettingsTab = 'general' | 'agents' | 'panels' | 'export' | 'skills' | 'knowledge' | 'routines';

// The Studio holds what THIS thread produced, and nothing else:
// 'preview' — a dev server on this machine; 'file' — the thread's files;
// 'canvas' — the active markdown / code / artifact deliverable; and 'radar',
// pending its move into the Agents view.
//
// This comment used to describe 'browser' as a remote agent-browser session
// that "shares nothing" with 'preview'. The renderer disagreed — both drew the
// same <LocalPreview /> — so the comment had outlived the feature. The agents'
// browser is the Browser view, not a Studio tab. 'trace' and 'tokens' are gone
// too; see the RightPanelTab note below.
/*
  Four values removed: 'tasks', 'terminal', 'routines' and 'tokens'. None had a
  renderer — the Studio pane dispatches on this and drew nothing for them — yet
  seven buttons across the app set 'tokens' (a "token governance dashboard"
  whose component no longer exists) and the command palette set 'terminal'. So
  each opened the Studio panel onto an empty pane. Removing them from the type
  is what made the compiler find every one of those callers.
*/
export type RightPanelTab = 'preview' | 'file' | 'radar' | 'canvas' | null;

// 'canvas' is deliberately absent: it points at one message's artifact.
const RESTORABLE_RIGHT_TABS = new Set<string>(['preview', 'file', 'radar']);

/** On mobile, which pane is showing: the list or the detail */
export type MobilePane = 'list' | 'detail';

interface LayoutState {
  isMobile: boolean;
  isSidebarOpen: boolean;
  sidebarToggle: () => void;
  /**
   * Set the sidebar to a KNOWN state. `sidebarToggle` was the only way to move
   * it, which is fine for a button and wrong for anything reacting to a
   * measurement: a resize handler that wants "closed" and can only say "the
   * other one" is a race, and it is why ShellFit in wrapper.tsx could only
   * ever fold the sidebar and never bring it back.
   */
  setSidebarOpen: (open: boolean) => void;
  /** Sidebar width in px — resizable between 200 and 600, as in Paseo. */
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
  /**
   * True while the handle is being dragged. Anything sized off `sidebarWidth`
   * must drop its width transition during a drag, or it lags behind the cursor —
   * but keep the transition for the open/close toggle.
   */
  isSidebarResizing: boolean;
  setSidebarResizing: (v: boolean) => void;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  /** Alt+← / Alt+→. False when there is nothing in that direction. */
  canGoBack: boolean;
  canGoForward: boolean;
  goBack: () => void;
  goForward: () => void;
  settingsTab: SettingsTab;
  setSettingsTab: (tab: SettingsTab) => void;
  openSettings: (tab?: SettingsTab) => void;
  selectedAgentName: string | null;
  setSelectedAgentName: (name: string | null) => void;
  isAgentPanelOpen: boolean;
  /** Which pane is visible on mobile (ignored on desktop) */
  mobilePane: MobilePane;
  /** Navigate to detail pane on mobile */
  openMobileDetail: () => void;
  /** Navigate back to list pane on mobile */
  openMobileList: () => void;
  /** Whether the detail pane is expanded to full width (hides sidebar + list) */
  isDetailExpanded: boolean;
  toggleDetailExpanded: () => void;
  /** Experimental: show browser tab side-by-side with chat */
  splitBrowser: boolean;
  setSplitBrowser: (v: boolean) => void;
  /** Whether the browser live preview panel is currently showing */
  showBrowserPreview: boolean;
  setShowBrowserPreview: (v: boolean) => void;
  /** Active right-hand preview panel tab */
  activeRightTab: RightPanelTab;
  setActiveRightTab: (tab: RightPanelTab) => void;
  /**
   * Address the Local Preview panel is pointed at. Lives here rather than
   * inside the panel so an agent reporting a dev server can push a target in
   * without the panel needing to be mounted first.
   */
  previewUrl: string | null;
  /** Point the Local Preview panel at a URL and bring it to the front. */
  openPreview: (url: string) => void;
  /** Whether the New Thread dialog (agent picker) is open */
  newThreadOpen: boolean;
  setNewThreadOpen: (v: boolean) => void;
  /** Open the New Thread dialog so the user can pick agents for a new session */
  openNewThread: () => void;
}

/*
 * THE WINDOW COMES BACK THE WAY YOU LEFT IT.
 *
 * The Electron shell already restores its own size, position and maximised
 * state, and three panel widths are in localStorage. What was NOT kept was
 * everything that decides what the window is actually showing: which view you
 * were in, whether the Studio panel was open and on which tab, whether the
 * sidebar was collapsed, which Settings tab you were reading. So a restart
 * always landed on Threads, sidebar open, Studio closed — the layout the app
 * ships with rather than the one you built.
 *
 * Per workspace would be better still, but the layout provider does not know
 * the workspace id; these are window-level preferences and are stored as such.
 */
const LAYOUT_STORAGE_KEY = 'workspace_layout_v1';

interface PersistedLayout {
  viewMode?: ViewMode;
  settingsTab?: SettingsTab;
  activeRightTab?: RightPanelTab;
  sidebarOpen?: boolean;
  detailExpanded?: boolean;
}

function readLayout(): PersistedLayout {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PersistedLayout) : {};
  } catch {
    return {};
  }
}

function writeLayout(patch: PersistedLayout) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({ ...readLayout(), ...patch }),
    );
  } catch {
    /* private mode, quota, a disabled store — a lost preference is not an error */
  }
}

const LayoutContext = createContext<LayoutState | undefined>(undefined);

export function LayoutProvider({ children }: { children: ReactNode }) {
  const isMobile = useIsMobile();
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => readLayout().sidebarOpen ?? true);
  const [sidebarWidth, setSidebarWidthState] = useState(() => readStoredSidebarWidth());
  const setSidebarWidth = useCallback((width: number) => {
    const clamped = clampSidebarWidth(width);
    setSidebarWidthState(clamped);
    storeSidebarWidth(clamped);
  }, []);
  const [isSidebarResizing, setSidebarResizing] = useState(false);
  const [viewMode, setViewModeState] = useState<ViewMode>(() => readLayout().viewMode ?? 'threads');
  const [settingsTab, setSettingsTabState] = useState<SettingsTab>(
    () => readLayout().settingsTab ?? 'general',
  );

  const setSettingsTab = useCallback((tab: SettingsTab) => {
    setSettingsTabState(tab);
    writeLayout({ settingsTab: tab });
  }, []);

  /*
    BACK AND FORWARD.

    The app has a dozen top-level views and no way to return to the one you
    were just in. Every desktop application with panes this deep has Alt+← —
    file managers, mail clients, IDEs — because navigating away to check one
    thing and then hunting for the way back is the most common thing a user
    does and the app made it a fresh navigation every time.

    A stack rather than the browser's own history: this is a single-page shell
    with no URL per view, so `history.back()` would leave the app entirely.

    `historyIndex` is the cursor INTO `viewHistory`, not a count — moving back
    and then navigating somewhere new truncates the forward tail, which is what
    every back button in existence does.
  */
  /** Change the view WITHOUT touching history — used by back/forward itself. */
  const applyViewMode = useCallback((mode: ViewMode) => {
    if (mode === 'skills' || mode === 'knowledge' || mode === 'routines') {
      setSettingsTabState(mode);
      setViewModeState('settings');
      writeLayout({ viewMode: 'settings', settingsTab: mode });
      return;
    }
    setViewModeState(mode);
    writeLayout({ viewMode: mode });
  }, []);

  const [nav, setNav] = useState<{ stack: ViewMode[]; index: number }>(() => ({
    stack: [readLayout().viewMode ?? 'threads'],
    index: 0,
  }));

  const setViewMode = useCallback((mode: ViewMode) => {
    applyViewMode(mode);
    setNav((prev) => {
      // Re-selecting the view you are already on is not a navigation, and
      // recording it would make one Alt+← do nothing.
      if (prev.stack[prev.index] === mode) return prev;
      // Truncating the forward tail is what every back button does: going back
      // and then somewhere new abandons the branch you left.
      const stack = [...prev.stack.slice(0, prev.index + 1), mode].slice(-50);
      return { stack, index: stack.length - 1 };
    });
  }, [applyViewMode]);

  const canGoBack = nav.index > 0;
  const canGoForward = nav.index < nav.stack.length - 1;

  /*
    Both of these apply the view OUTSIDE the state updater. An updater must be
    a pure function of the previous state — React is free to call it twice, and
    in development under StrictMode it does — so driving navigation from inside
    one would fire the view change twice and, worse, make the order in which
    the two pieces of state settle undefined.
  */
  const goBack = useCallback(() => {
    if (nav.index <= 0) return;
    applyViewMode(nav.stack[nav.index - 1]);
    setNav((prev) => ({ ...prev, index: Math.max(0, prev.index - 1) }));
  }, [nav, applyViewMode]);

  const goForward = useCallback(() => {
    if (nav.index >= nav.stack.length - 1) return;
    applyViewMode(nav.stack[nav.index + 1]);
    setNav((prev) => ({ ...prev, index: Math.min(prev.stack.length - 1, prev.index + 1) }));
  }, [nav, applyViewMode]);

  const openSettings = useCallback((tab: SettingsTab = 'general') => {
    setSettingsTabState(tab);
    setViewModeState('settings');
    writeLayout({ viewMode: 'settings', settingsTab: tab });
  }, []);

  const [selectedAgentName, setSelectedAgentName] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<MobilePane>('list');
  const [isDetailExpanded, setIsDetailExpanded] = useState(() => readLayout().detailExpanded ?? false);
  const [splitBrowser, setSplitBrowser] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('x-split-browser') === '1';
  });

  const handleSetSplitBrowser = useCallback((v: boolean) => {
    setSplitBrowser(v);
    localStorage.setItem('x-split-browser', v ? '1' : '0');
  }, []);

  /*
    Only a tab that still renders is restored. Storage outlives the type: a user
    who last closed the app on 'tokens' or 'terminal' has that string saved, and
    restoring it verbatim would reopen the Studio onto the empty pane this
    change exists to remove.
  */
  const [activeRightTab, setActiveRightTabState] = useState<RightPanelTab>(
    () => {
      const saved = readLayout().activeRightTab as string | null | undefined;
      // 'browser' was merged into 'preview' — same component — so it maps across.
      if (saved === 'browser') return 'preview';
      return saved && RESTORABLE_RIGHT_TABS.has(saved) ? (saved as RightPanelTab) : null;
    },
  );
  const setActiveRightTab = useCallback((tab: RightPanelTab) => {
    setActiveRightTabState(tab);
    // 'canvas' is not restorable — it points at an artifact that belongs to a
    // particular message, so a restart would reopen an empty panel.
    writeLayout({ activeRightTab: tab === 'canvas' ? null : tab });
  }, []);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const openPreview = useCallback((url: string) => {
    let ok = false;
    let normalized = url.trim();
    if (/^:?\d+$/.test(normalized)) {
      normalized = `http://localhost:${normalized.replace(':', '')}`;
    } else if (!/^https?:\/\//i.test(normalized)) {
      normalized = `http://${normalized}`;
    }
    try {
      const u = new URL(normalized);
      ok = u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      ok = false;
    }
    if (!ok) {
      console.warn(`[preview] ignored invalid preview target: ${url}`);
      return;
    }
    setPreviewUrl(normalized);
    setActiveRightTab('preview');
  }, []);
  
  /*
    Compatibility pair, now aimed at 'preview'. 'browser' and 'preview' were
    two tab values that rendered the same <LocalPreview /> — the component
    never read which one it was opened as — so they are one value now.
  */
  const showBrowserPreview = activeRightTab === 'preview';
  const setShowBrowserPreview = useCallback((v: boolean) => {
    setActiveRightTab(v ? 'preview' : null);
  }, []);

  const [newThreadOpen, setNewThreadOpen] = useState(false);
  const openNewThread = useCallback(() => setNewThreadOpen(true), []);

  const isAgentPanelOpen = selectedAgentName !== null;
  const openMobileDetail = useCallback(() => setMobilePane('detail'), []);
  const openMobileList = useCallback(() => setMobilePane('list'), []);
  const toggleDetailExpanded = useCallback(() => setIsDetailExpanded((v) => {
    writeLayout({ detailExpanded: !v });
    return !v;
  }), []);

  const cssVariables = useMemo(() => ({
    // Tracks the real, resizable width instead of a hardcoded 240px that never
    // matched what the sidebar actually rendered at.
    '--sidebar-width': `${sidebarWidth}px`,
    '--sidebar-width-collapsed': '52px',
    '--header-height-mobile': '60px',
  } as React.CSSProperties), [sidebarWidth]);

  const sidebarToggle = useCallback(() => setIsSidebarOpen((open) => {
    writeLayout({ sidebarOpen: !open });
    return !open;
  }), []);

  const setSidebarOpen = useCallback((next: boolean) => setIsSidebarOpen((open) => {
    // Persist only a real change, so a no-op call cannot churn localStorage.
    if (open === next) return open;
    writeLayout({ sidebarOpen: next });
    return next;
  }), []);

  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;

    Object.entries(cssVariables).forEach(([prop, val]) => {
      html.style.setProperty(prop, val as string);
    });

    body.setAttribute('data-sidebar-open', isSidebarOpen.toString());

    return () => {
      Object.keys(cssVariables).forEach((prop) => {
        html.style.removeProperty(prop);
      });
      body.removeAttribute('data-sidebar-open');
    };
  }, [cssVariables, isSidebarOpen]);

  /*
    Memoised deliberately. This was an inline object literal, so every provider
    render handed every `useLayout()` consumer a brand-new value and re-rendered
    the entire app shell — including on each pointer event of a sidebar drag.
    The handlers above are all useCallback-stable so this only changes when real
    state does.
  */
  const value = useMemo<LayoutState>(() => ({
      isMobile,
      isSidebarOpen,
      sidebarToggle,
      setSidebarOpen,
      sidebarWidth,
      setSidebarWidth,
      isSidebarResizing,
      setSidebarResizing,
      viewMode,
      setViewMode,
      canGoBack,
      canGoForward,
      goBack,
      goForward,
      settingsTab,
      setSettingsTab,
      openSettings,
      selectedAgentName,
      setSelectedAgentName,
      isAgentPanelOpen,
      mobilePane,
      openMobileDetail,
      openMobileList,
      isDetailExpanded,
      toggleDetailExpanded,
      splitBrowser,
      setSplitBrowser: handleSetSplitBrowser,
      showBrowserPreview,
      setShowBrowserPreview,
      activeRightTab,
      setActiveRightTab,
      previewUrl,
      openPreview,
      newThreadOpen,
      setNewThreadOpen,
      openNewThread,
  }), [
    isMobile, isSidebarOpen, sidebarToggle, setSidebarOpen, sidebarWidth, setSidebarWidth,
    isSidebarResizing, viewMode, setViewMode, canGoBack, canGoForward, goBack, goForward,
    settingsTab, openSettings,
    selectedAgentName, isAgentPanelOpen, mobilePane, openMobileDetail,
    openMobileList, isDetailExpanded, toggleDetailExpanded, splitBrowser,
    handleSetSplitBrowser, showBrowserPreview, setShowBrowserPreview,
    activeRightTab, previewUrl, openPreview, newThreadOpen, openNewThread,
  ]);

  return (
    <LayoutContext.Provider value={value}>
      <div data-slot="layout-wrapper" className="flex grow">
        <TooltipProvider delayDuration={0}>
          {/* Right-click on any row opens that row's own actions menu. One
              listener rather than a prop threaded through every list. */}
          <RowContextMenu />
          {children}
        </TooltipProvider>
      </div>
    </LayoutContext.Provider>
  );
}

export const useLayout = () => {
  const context = useContext(LayoutContext);
  if (!context) {
    throw new Error('useLayout must be used within a LayoutProvider');
  }
  return context;
};
