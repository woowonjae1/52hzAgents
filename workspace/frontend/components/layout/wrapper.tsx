'use client';

import * as React from 'react';
import { Sidebar } from './sidebar';
import { MobileHeader } from './mobile-header';
import { useLayout } from './layout-context';
import { cn } from '@/lib/utils';
import { ChatView } from '@/components/chat/chat-view';
import { ThreadList } from '@/components/threads/thread-list';
import { FileList } from '@/components/files/file-list';
import { FilePreview } from '@/components/files/file-preview';
import { BrowserTabList } from '@/components/browser/browser-tab-list';
import { BrowserView } from '@/components/browser/browser-view';
import { LocalPreview } from '@/components/preview/local-preview';
import { ConnectAgentView } from '@/components/connect/connect-agent-view';
import { AgentProfilePanel } from '@/components/agents/agent-profile-panel';
import { MonitorGrid } from '@/components/monitor/monitor-grid';
import { TasksView } from '@/components/tasks/tasks-view';
import { TimersView } from '@/components/timers/timers-view';
import { RoutineList } from '@/components/routines/routine-list';
import { SkillsView } from '@/components/skills/skills-view';
import { InboxView } from '@/components/inbox/inbox-view';
import { KnowledgeView } from '@/components/knowledge/knowledge-view';
import { MissionControl } from '@/components/mission/mission-control';
import { RadarPanel } from '@/components/mission/radar-panel';
import { useWorkspace } from '@/lib/workspace-context';
import { SettingsView } from '@/components/settings/settings-view';
import { EmptyState } from '@/components/chat/empty-state';
import { TracePanel } from '@/components/trace/trace-panel';
import { NewThreadDialogHost } from '@/components/threads/new-thread-dialog-host';
import { DropzoneOverlay } from '@/components/files/dropzone-overlay';
import { CommandPalette } from './command-palette';
import { GlobalShortcuts } from './global-shortcuts';
import { useSplitter } from '@/hooks/use-splitter';
import { DesktopIntegration } from './desktop-integration';
import { RealtimeStatus } from './realtime-status';
import { WindowTitle } from './window-title';
import { ErrorLogDialog } from './error-log-dialog';
import { installErrorCapture } from '@/lib/error-log';
import { syncDesktopAttributes } from '@/lib/desktop';

import { Hint } from '@/components/ui/hint';
import { ArtifactsCanvas } from '@/components/canvas/artifacts-canvas';
import { useArtifacts } from '@/lib/artifacts-context';
import { SignalMark } from '@/components/brand/signal-mark';
import { Network, X, PanelLeft, FileText, Globe, Activity } from 'lucide-react';

/**
 * THE FIRST FRAME IS THE WINDOW, NOT A SPLASH.
 *
 * This used to be a centred 72px mark over an empty ground, a pulsing wordmark,
 * "Loading your workspace…", and an indeterminate bar sweeping the bottom edge
 * — four separate ways of saying the same thing, on a screen that exists for
 * a few hundred milliseconds. A web page does that because it genuinely has
 * nothing yet. A desktop application paints its frame immediately and fills the
 * frame in: VS Code, Slack and Linear all show you the rail, the header and the
 * empty content well before they know a single thing about your data, which is
 * why they feel like they open rather than load.
 *
 * So this draws the real chrome at the real dimensions — `--sidebar-width`,
 * `--header-height`, `--surface-sidebar` against `--surface0`, the same
 * `--border-chrome` seam — and the layout below simply replaces it. Nothing
 * moves when the data lands, because nothing here is in a different place from
 * where the app puts it.
 *
 * DELIBERATELY NO SPINNER AND NO PROGRESS BAR. An indeterminate bar communicates
 * nothing except that time is passing, and it draws the eye to the one part of
 * the window that is about to be replaced. The mark is present but still
 * (`still`, so it does not start its idle turn during a load) at the size it
 * actually renders at in the titlebar, so the brand does not jump either.
 *
 * `aria-busy` rather than a visible label: the state is worth announcing to a
 * screen reader and not worth a sentence on screen.
 */
export function WorkspaceLoadingScreen() {
  return (
    <div
      className="flex h-screen w-full overflow-hidden bg-surface0"
      role="status"
      aria-busy="true"
      aria-label="Opening workspace"
    >
      <div
        className="hidden md:flex shrink-0 flex-col bg-surface-sidebar border-e border-border-chrome"
        style={{ width: 'var(--sidebar-width)' }}
      >
        <div className="flex items-center gap-2 px-5 shrink-0" style={{ height: 'var(--header-height)' }}>
          <SignalMark size={16} still className="shrink-0" />
          <span className="text-2xs font-medium tracking-tight text-foreground-extra-muted">52hzAgents</span>
        </div>
      </div>
      <div className="flex-1 min-w-0 flex flex-col">
        <div
          className="shrink-0 bg-surface-sidebar border-b border-border-chrome"
          style={{ height: 'var(--header-height)' }}
        />
      </div>
    </div>
  );
}

const MIN_DOCKED_WIDTH = 680;

export function Wrapper() {
  /* Route every error toast into the log the Recent Errors dialog reads.
     Here rather than in a provider because this is the one component that
     mounts for every workspace route and exactly once. */
  React.useEffect(() => {
    installErrorCapture();
    syncDesktopAttributes();
  }, []);

  const { isMobile, viewMode, isAgentPanelOpen, isSidebarOpen, sidebarToggle, isSidebarResizing, isDetailExpanded, mobilePane, splitBrowser, showBrowserPreview, activeRightTab, setActiveRightTab } = useLayout();
  const { monitorMode, agents, loading, workspace } = useWorkspace();
  const { activeArtifact, isCanvasOpen, closeCanvas } = useArtifacts();
  const hasAgents = agents.length > 0;
  const desktopContainerRef = React.useRef<HTMLDivElement>(null);
  const narrowStateRef = React.useRef<boolean | null>(null);

  /*
    Studio width. This was 45 lines of mousedown/mousemove bookkeeping, and the
    drag froze the moment the pointer entered the panel's own iframe — see
    hooks/use-splitter.ts for why, and for the pointer-capture fix.
  */
  const {
    width: studioWidth,
    isResizing: isStudioResizing,
    separatorProps: studioSeparatorProps,
  } = useSplitter({
    min: 380,
    max: () => (typeof window !== 'undefined' ? Math.max(400, window.innerWidth - 380) : 900),
    defaultWidth: 480,
    storageKey: 'studio_panel_width',
    edge: 'end',
    label: 'Resize Studio panel',
  });

  const isStudioOpen =
    !isDetailExpanded &&
    (activeRightTab !== null || isCanvasOpen) &&
    viewMode !== 'mission' &&
    viewMode !== 'connect' &&
    viewMode !== 'files';

  const effectiveStudioTab =
    activeRightTab !== null
      ? activeRightTab
      : isCanvasOpen && activeArtifact
      ? 'canvas'
      : null;

  const handleCloseStudio = React.useCallback(() => {
    setActiveRightTab(null);
    closeCanvas();
  }, [setActiveRightTab, closeCanvas]);

  // ShellFit container query: auto-collapse sidebar if the parent container box width drops below 680px
  React.useEffect(() => {
    if (isMobile) return;
    const el = desktopContainerRef.current;
    if (!el) return;

    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      const isNarrow = width < MIN_DOCKED_WIDTH;
      if (narrowStateRef.current === isNarrow) return;
      narrowStateRef.current = isNarrow;

      if (isNarrow && isSidebarOpen) {
        sidebarToggle();
      }
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, [isMobile, isSidebarOpen, sidebarToggle]);

  if (loading && !workspace) {
    return <WorkspaceLoadingScreen />;
  }

  // ── Mobile layout: single-pane with list/detail switching ──
  if (isMobile) {
    return (
      <div className="flex flex-col h-screen w-full bg-surface0 [&_.container-fluid]:px-5">
        <MobileHeader />
        <div className="flex-1 min-h-0 pt-[var(--header-height-mobile)] pb-[calc(48px+env(safe-area-inset-bottom))]">
          {/* Full-screen views (no list/detail split) */}
          {viewMode === 'mission' ? (
            <div className="h-full mx-2 my-1.5 bg-card overflow-hidden border border-border dark:border-border rounded-xl shadow-sm">
              <MissionControl />
            </div>
          ) : !hasAgents && viewMode === 'threads' ? (
            <div className="h-full mx-2 my-1.5 bg-card overflow-hidden border border-border dark:border-border rounded-xl shadow-sm">
              <EmptyState />
            </div>
          ) : viewMode === 'connect' ? (
            <div className="h-full mx-2 my-1.5 bg-card overflow-hidden border border-border dark:border-border rounded-xl shadow-sm">
              <ConnectAgentView />
            </div>
          ) : viewMode === 'tasks' ? (
            <div className="h-full mx-2 my-1.5 bg-card overflow-hidden border border-border dark:border-border rounded-xl shadow-sm">
              <TasksView />
            </div>
          ) : viewMode === 'timers' ? (
            <div className="h-full mx-2 my-1.5 bg-card overflow-hidden border border-border dark:border-border rounded-xl shadow-sm">
              <TimersView />
            </div>
          ) : viewMode === 'inbox' ? (
            <div className="h-full mx-2 my-1.5 bg-card overflow-hidden border border-border dark:border-border rounded-xl shadow-sm">
              <InboxView />
            </div>
          ) : viewMode === 'skills' ? (
            <div className="h-full mx-2 my-1.5 bg-card overflow-hidden border border-border dark:border-border rounded-xl shadow-sm">
              <SkillsView />
            </div>
          ) : viewMode === 'knowledge' ? (
            <div className="h-full mx-2 my-1.5 bg-card overflow-hidden border border-border dark:border-border rounded-xl shadow-sm">
              <KnowledgeView />
            </div>
          ) : viewMode === 'settings' ? (
            <div className="h-full mx-2 my-1.5 bg-card overflow-hidden border border-border dark:border-border rounded-xl shadow-sm">
              <SettingsView />
            </div>
          ) : mobilePane === 'list' ? (
            /* List pane — full width */
            <div className="h-full mx-2 my-1.5 bg-card overflow-hidden border border-border dark:border-border rounded-xl shadow-sm flex flex-col">
              {viewMode === 'threads' && <ThreadList />}
              {viewMode === 'files' && <FileList />}
              {viewMode === 'browser' && <BrowserTabList />}
              {viewMode === 'routines' && <RoutineList />}
            </div>
          ) : (
            /* Detail pane — full width, edge-to-edge on mobile */
            <div className="relative h-full bg-card overflow-hidden border border-border dark:border-border rounded-xl shadow-sm">
              {(viewMode === 'threads' || viewMode === 'routines') && (
                <main className="h-full">
                  <ChatView />
                </main>
              )}
              {viewMode === 'files' && <FilePreview />}
              {viewMode === 'browser' && <BrowserView />}
              {isAgentPanelOpen && <AgentProfilePanel />}
            </div>
          )}
        </div>
        <GlobalShortcuts />
        <DesktopIntegration />
        <RealtimeStatus />
        <WindowTitle />
        <ErrorLogDialog />
        <NewThreadDialogHost />
      </div>
    );
  }

  const isSettings = viewMode === 'settings';
  const shouldShowSidebar = !isDetailExpanded && !isSettings;

  // ── Desktop layout: sidebar + center chat + collapsible right preview ──
  return (
    <div
      ref={desktopContainerRef}
      className="app-root-container flex h-screen w-full bg-surface0 [&_.container-fluid]:px-5"
    >
      {shouldShowSidebar && <Sidebar />}

      <div
        className="flex flex-col flex-grow min-w-0 w-full"
        data-studio-open={isStudioOpen ? 'true' : 'false'}
      >
        <div className="flex grow min-h-0 overflow-hidden">
          {/* Invisible spacer standing in for the fixed sidebar. Reads the same
              resizable width the sidebar itself does, so dragging the handle moves
              the main pane with it. */}
          {shouldShowSidebar && (
            <div
              data-sidebar-sized
              /* `transition-[width]`, not `ui-transition`: the only property
                 that ever changes here is the width, and `all` puts every
                 animatable property of a flex sibling on a 300ms clock. */
              className={cn('shrink-0', !isSidebarResizing && 'transition-[width] duration-[var(--shell-duration)] ease-[var(--shell-ease)]')}
              style={{ width: isSidebarOpen ? 'var(--sidebar-width)' : '0px' }}
            />
          )}

          {/* Dynamic multi-pane grid based on viewMode and activeRightTab */}
          {viewMode === 'threads' && monitorMode ? (
            /* Monitor mode: replace both panes with 2x3 grid */
            <div className="relative flex-1 min-w-0">
              <MonitorGrid />
              {isAgentPanelOpen && <AgentProfilePanel />}
            </div>
          ) : (
            <>
              {/* Column 2: Center Main Workspace (Seamless Edge-to-Edge Canvas) */}
              <div className={cn("relative flex-grow flex-1 min-w-0 bg-surface0 overflow-hidden flex flex-col", undefined)}>
                {!isSidebarOpen && !isSettings && viewMode !== 'threads' && (
                  <Hint label="Expand sidebar" side="right">
                    <button
                      onClick={sidebarToggle}
                      /*
                        `data-no-drag` — this button is positioned against the
                        main pane, but `top-1.5` lands it inside `.app-header`'s
                        40px band, which is the window's drag region on
                        desktop. It is not a DESCENDANT of the header, so the
                        header's own no-drag rule never reached it, and an
                        app-region drag rect swallows whatever merely paints on
                        top of it: the click moved the window, a double-click
                        maximised it, and a right-click opened Windows' native
                        window menu. Since the button only exists while the
                        sidebar is collapsed, that was the whole symptom.
                      */
                      data-no-drag
                      /* `backdrop-blur` (bare) was the one site not on the blur
                         ramp — it reads `--blur`, which is still Tailwind's 8px.
                         `hover:scale-105` and `transition-all` went with it: a
                         chrome button that grows under the cursor is a web
                         affordance, and a desktop tool answers a hover with
                         colour, not with size. */
                      className="absolute top-1.5 left-3.5 z-30 size-7 rounded-lg bg-surface2/90 backdrop-blur-sm border border-border text-foreground-muted hover:text-foreground hover:bg-surface3/90 shadow-sm flex items-center justify-center transition-colors"
                    >
                      <PanelLeft className="size-4" />
                    </button>
                  </Hint>
                )}
                {/* Keep ChatView alive in DOM to prevent SSE disconnection, dropped messages, and re-fetch flicker */}
                <div className={cn("h-full w-full", viewMode !== 'threads' && "hidden")}>
                  <main className="h-full">
                    <ChatView />
                  </main>
                </div>
                {viewMode === 'mission' && <MissionControl />}
                {viewMode === 'connect' && <ConnectAgentView />}
                {viewMode === 'files' && <FilePreview />}
                {viewMode === 'tasks' && <TasksView />}
                {viewMode === 'timers' && <TimersView />}
                {viewMode === 'inbox' && <InboxView />}
                {viewMode === 'skills' && <SkillsView />}
                {viewMode === 'knowledge' && <KnowledgeView />}
                {viewMode === 'settings' && <SettingsView />}
                {viewMode === 'browser' && <BrowserView />}
                {/* Agent profile slide-over panel */}
                {isAgentPanelOpen && <AgentProfilePanel />}
              </div>

              {/* Column 3: Unified Right Studio */}
              {isStudioOpen && (
                <aside
                  aria-label="Studio Panel"
                  style={{ width: `${studioWidth}px` }}
                  className={cn(
                    "shrink-0 h-full border-l border-border bg-surface1 flex flex-col z-20 relative select-text",
                    isStudioResizing ? "select-none transition-none" : "transition-[width] duration-75"
                  )}
                >
                  {/* Left Drag-to-Resize Handle */}
                  <Hint label="Drag to resize · double-click to reset" side="left">
                    <div
                      {...studioSeparatorProps}
                      className="absolute -left-1.5 top-0 bottom-0 w-3 cursor-col-resize group z-30 flex items-center justify-center select-none focus-visible:outline-none focus-visible:bg-primary/40"
                    >
                      <div className="w-[3px] h-full bg-transparent group-hover:bg-primary/50 group-active:bg-primary transition-colors" />
                      <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 left-1/2 py-2 px-0.5 rounded-full bg-surface2/90 border border-border shadow-xs opacity-0 group-hover:opacity-100 transition-opacity flex flex-col gap-0.5">
                        <div className="size-1 rounded-full bg-foreground-extra-muted" />
                        <div className="size-1 rounded-full bg-foreground-extra-muted" />
                        <div className="size-1 rounded-full bg-foreground-extra-muted" />
                      </div>
                    </div>
                  </Hint>

                  {/* Studio Header Bar (Rendered when not in canvas mode; Canvas provides its own unified 38px header) */}
                  {effectiveStudioTab !== 'canvas' && (
                    <div className="app-header justify-between px-3 shrink-0 flex-nowrap border-b border-border bg-surface1 select-none">
                      <div className="flex items-center gap-1 overflow-x-auto no-scrollbar py-1">
                        {activeArtifact && (
                          <button
                            type="button"
                            onClick={() => setActiveRightTab('canvas')}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-2xs font-medium transition-colors shrink-0 text-foreground-muted hover:text-foreground hover:bg-surface2"
                          >
                            <FileText className="size-3.5" />
                            <span>Canvas</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setActiveRightTab('preview')}
                          className={cn(
                            "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-2xs font-medium transition-colors shrink-0",
                            (effectiveStudioTab === 'preview' || effectiveStudioTab === 'browser')
                              ? "bg-surface3 text-foreground font-semibold border border-border"
                              : "text-foreground-muted hover:text-foreground hover:bg-surface2"
                          )}
                        >
                          <Globe className="size-3.5" />
                          <span>Preview</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setActiveRightTab('trace')}
                          className={cn(
                            "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-2xs font-medium transition-colors shrink-0",
                            effectiveStudioTab === 'trace'
                              ? "bg-surface3 text-foreground font-semibold border border-border"
                              : "text-foreground-muted hover:text-foreground hover:bg-surface2"
                          )}
                        >
                          <Activity className="size-3.5" />
                          <span>Trace</span>
                        </button>
                      </div>

                      <div className="flex items-center gap-1 shrink-0 ml-1">
                        <Hint label="Close Studio (Esc)">
                          <button
                            type="button"
                            onClick={handleCloseStudio}
                            className="size-7 rounded-lg hover:bg-surface2 text-foreground-muted hover:text-foreground flex items-center justify-center transition-colors"
                          >
                            <X className="size-3.5" />
                          </button>
                        </Hint>
                      </div>
                    </div>
                  )}

                  {/* Studio Content Pane */}
                  <div className="flex-1 min-h-0 overflow-hidden relative flex flex-col">
                    {effectiveStudioTab === 'canvas' && <ArtifactsCanvas embedded />}
                    {(effectiveStudioTab === 'browser' || effectiveStudioTab === 'preview') && <LocalPreview />}
                    {effectiveStudioTab === 'file' && <FilePreview />}
                    {effectiveStudioTab === 'radar' && <RadarPanel />}
                    {effectiveStudioTab === 'trace' && <TracePanel />}
                  </div>
                </aside>
              )}
            </>
          )}
        </div>
      </div>
      <GlobalShortcuts />
      <DesktopIntegration />
      <RealtimeStatus />
      <WindowTitle />
      <ErrorLogDialog />
      <NewThreadDialogHost />
      <DropzoneOverlay />
      <CommandPalette />
    </div>
  );
}
