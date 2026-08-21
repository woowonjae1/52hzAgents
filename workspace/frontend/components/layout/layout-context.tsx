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
import {
  DEFAULT_SIDEBAR_WIDTH,
  clampSidebarWidth,
  readStoredSidebarWidth,
  storeSidebarWidth,
} from '@/lib/panel-store';

export type ViewMode = 'mission' | 'threads' | 'files' | 'knowledge' | 'browser' | 'tasks' | 'timers' | 'routines' | 'inbox' | 'connect' | 'skills' | 'settings';

export type SettingsTab = 'general' | 'agents' | 'panels' | 'export' | 'skills' | 'knowledge' | 'routines';

// 'browser' watches the browser an agent is driving (remote session, expires,
// reconnects). 'preview' points at a dev server on this machine. They look
// alike and share nothing.
export type RightPanelTab = 'browser' | 'preview' | 'file' | 'tasks' | 'radar' | 'terminal' | 'routines' | null;

/** On mobile, which pane is showing: the list or the detail */
export type MobilePane = 'list' | 'detail';

interface LayoutState {
  isMobile: boolean;
  isSidebarOpen: boolean;
  sidebarToggle: () => void;
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

const LayoutContext = createContext<LayoutState | undefined>(undefined);

export function LayoutProvider({ children }: { children: ReactNode }) {
  const isMobile = useIsMobile();
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  // Start at the default and hydrate from storage after mount — reading
  // localStorage in the initializer would desync from the server-rendered markup.
  const [sidebarWidth, setSidebarWidthState] = useState(DEFAULT_SIDEBAR_WIDTH);
  useEffect(() => {
    setSidebarWidthState(readStoredSidebarWidth());
  }, []);
  const setSidebarWidth = (width: number) => {
    const clamped = clampSidebarWidth(width);
    setSidebarWidthState(clamped);
    storeSidebarWidth(clamped);
  };
  const [isSidebarResizing, setSidebarResizing] = useState(false);
  const [viewMode, setViewModeState] = useState<ViewMode>('threads');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');

  const setViewMode = (mode: ViewMode) => {
    if (mode === 'skills') {
      setSettingsTab('skills');
      setViewModeState('settings');
      return;
    }
    if (mode === 'knowledge') {
      setSettingsTab('knowledge');
      setViewModeState('settings');
      return;
    }
    if (mode === 'routines') {
      setSettingsTab('routines');
      setViewModeState('settings');
      return;
    }
    setViewModeState(mode);
  };

  const openSettings = (tab: SettingsTab = 'general') => {
    setSettingsTab(tab);
    setViewModeState('settings');
  };

  const [selectedAgentName, setSelectedAgentName] = useState<string | null>(null);
  const [mobilePane, setMobilePane] = useState<MobilePane>('list');
  const [isDetailExpanded, setIsDetailExpanded] = useState(false);
  const [splitBrowser, setSplitBrowser] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('x-split-browser') === '1';
  });

  const handleSetSplitBrowser = (v: boolean) => {
    setSplitBrowser(v);
    localStorage.setItem('x-split-browser', v ? '1' : '0');
  };

  const [activeRightTab, setActiveRightTab] = useState<RightPanelTab>(null);
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
  
  // Compatibility computed helper
  const showBrowserPreview = activeRightTab === 'browser';
  const setShowBrowserPreview = (v: boolean) => {
    setActiveRightTab(v ? 'browser' : null);
  };

  const [newThreadOpen, setNewThreadOpen] = useState(false);
  const openNewThread = () => setNewThreadOpen(true);

  const isAgentPanelOpen = selectedAgentName !== null;
  const openMobileDetail = () => setMobilePane('detail');
  const openMobileList = () => setMobilePane('list');
  const toggleDetailExpanded = () => setIsDetailExpanded((v) => !v);

  const cssVariables = useMemo(() => ({
    // Tracks the real, resizable width instead of a hardcoded 240px that never
    // matched what the sidebar actually rendered at.
    '--sidebar-width': `${sidebarWidth}px`,
    '--sidebar-width-collapsed': '52px',
    '--header-height-mobile': '60px',
  } as React.CSSProperties), [sidebarWidth]);

  const sidebarToggle = () => setIsSidebarOpen((open) => !open);

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

  return (
    <LayoutContext.Provider value={{
      isMobile,
      isSidebarOpen,
      sidebarToggle,
      sidebarWidth,
      setSidebarWidth,
      isSidebarResizing,
      setSidebarResizing,
      viewMode,
      setViewMode,
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
    }}>
      <div data-slot="layout-wrapper" className="flex grow">
        <TooltipProvider delayDuration={0}>
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
