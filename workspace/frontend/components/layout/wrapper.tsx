'use client';

import * as React from 'react';
import { Sidebar } from './sidebar';
import { MobileHeader } from './mobile-header';
import { useLayout } from './layout-context';
import { cn } from '@/lib/utils';
import { ChatView } from '@/components/chat/chat-view';
import { SessionMessagesProvider } from '@/components/chat/session-messages-context';
import { SessionGridProvider } from '@/lib/session-grid-context';
import { ThreadList } from '@/components/threads/thread-list';
import { LocalPreview } from '@/components/preview/local-preview';
import { AgentProfilePanel } from '@/components/agents/agent-profile-panel';
import { MonitorGrid } from '@/components/monitor/monitor-grid';
import { TasksView } from '@/components/tasks/tasks-view';
import { InboxView } from '@/components/inbox/inbox-view';
import { useWorkspace } from '@/lib/workspace-context';
import { SettingsView } from '@/components/settings/settings-view';
import { ProjectHome } from '@/components/home/project-home';

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
import { Network, X, PanelLeft, FileText, Globe, BookOpen } from 'lucide-react';
import { KnowledgeView } from '@/components/knowledge/knowledge-view';
import { SkillsView } from '@/components/skills/skills-view';
import { WorkbenchLayout } from '@/components/workbench/workbench-layout';

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
      className="flex h-screen h-dvh w-full overflow-hidden bg-surface0"
      role="status"
      aria-busy="true"
      aria-label="Opening workspace"
    >
      <div
        className="hidden md:flex shrink-0 flex-col bg-surface-sidebar dark:bg-[#0c0d12] border-e border-border-chrome"
        style={{ width: 'var(--dock-width, 48px)' }}
      />
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

/*
  The session poll is mounted ABOVE the shell rather than inside ChatView,
  because the Studio panel's trace is a sibling of ChatView, not a child — and
  it needs the same transcript. One provider here is what stops the two of them
  opening two streams for the same channel. It also survives the loading branch
  below, so completing the initial load does not remount the stream.
*/
export function Wrapper() {
  return (
    <SessionMessagesProvider>
      <SessionGridProvider>
        <WrapperInner />
      </SessionGridProvider>
    </SessionMessagesProvider>
  );
}

function WrapperInner() {
  /* Route every error toast into the log the Recent Errors dialog reads.
     Here rather than in a provider because this is the one component that
     mounts for every workspace route and exactly once. */
  React.useEffect(() => {
    installErrorCapture();
    syncDesktopAttributes();
  }, []);

  const { isMobile, viewMode, isAgentPanelOpen, isSidebarOpen, sidebarToggle, setSidebarOpen, isSidebarResizing, isDetailExpanded, mobilePane, splitBrowser, showBrowserPreview, activeRightTab, setActiveRightTab } = useLayout();
  const { monitorMode, loading, workspace, currentSessionId } = useWorkspace();
  const { isCanvasOpen, closeCanvas, openSeq } = useArtifacts();

  // Opening an output from anywhere brings the panel forward, whatever Studio
  // tab was showing. Without it, "Open in Canvas" with Preview up changed
  // nothing visible.
  React.useEffect(() => {
    if (openSeq > 0) setActiveRightTab('canvas');
  }, [openSeq, setActiveRightTab]);
  /*
    HOME IS WHERE A WINDOW WITH NO OPEN SESSION LANDS.

    Either asked for ('home': the sidebar's Home / New session, G H) or
    implied: the Threads view with nothing selected -- first launch, a
    restored layout whose thread is gone, closing or deleting the open
    thread.
  */
  const isHome = viewMode === 'home';
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
    !isAgentPanelOpen &&
    (activeRightTab !== null || isCanvasOpen) &&
    !isHome &&
    viewMode !== 'knowledge' &&
    viewMode !== 'skills';

  const effectiveStudioTab =
    activeRightTab !== null
      ? activeRightTab
      : isCanvasOpen
      ? 'canvas'
      : null;

  const handleCloseStudio = React.useCallback(() => {
    setActiveRightTab(null);
    closeCanvas();
  }, [setActiveRightTab, closeCanvas]);

  // Synchronize canvas context when activeRightTab transitions to null
  React.useEffect(() => {
    if (activeRightTab === null && isCanvasOpen) {
      closeCanvas();
    }
  }, [activeRightTab, isCanvasOpen, closeCanvas]);


  /*
    ── ShellFit ──

    Fold the sidebar away while the shell is too narrow to carry both panes,
    and BRING IT BACK when it is not. The second half was missing: the old
    version only ever ran `if (isNarrow && isSidebarOpen) sidebarToggle()`, so
    narrowing the window once folded the sidebar permanently — widening it
    again left you to reopen it by hand, every time, forever.

    It was missing because `sidebarToggle` was the only control the layout
    exposed. A handler that wants a KNOWN state and can only say "the other
    one" cannot express "open if there is room"; worse, a toggle fired from a
    measurement will happily open a sidebar the user just closed. `setSidebarOpen`
    exists now for exactly this.

    MOUNT IS NOT A CROSSING IN THE OPENING DIRECTION. A shell that merely has
    room says nothing about whether the user wanted the sidebar open — they may
    have collapsed it deliberately three sessions ago, and it is restored from
    storage. So the first measurement only acts when it is too narrow, which is
    the fold condition itself. `first` is what encodes that.

    Only CROSSINGS are acted on, so a manual toggle at either size stays put
    until the shell actually changes shape.

    `openRef` rather than `isSidebarOpen` in the dependency list: reading the
    value through a ref keeps the observer subscribed once, instead of being
    disconnected and rebuilt every single time the sidebar opens or closes.
  */
  const sidebarOpenRef = React.useRef(isSidebarOpen);
  sidebarOpenRef.current = isSidebarOpen;
  React.useEffect(() => {
    if (isMobile) return;
    const el = desktopContainerRef.current;
    if (!el) return;

    const observer = new ResizeObserver(([entry]) => {
      const isNarrow = entry.contentRect.width < MIN_DOCKED_WIDTH;
      if (narrowStateRef.current === isNarrow) return;
      const first = narrowStateRef.current === null;
      narrowStateRef.current = isNarrow;
      if (first && !isNarrow) return;

      const wanted = !isNarrow;
      // Already where the shell wants it — setting it again would only be a
      // write nobody asked for.
      if (sidebarOpenRef.current === wanted) return;
      setSidebarOpen(wanted);
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, [isMobile, setSidebarOpen]);

  if (loading && !workspace) {
    return <WorkspaceLoadingScreen />;
  }

  // ── Mobile layout: single-pane with list/detail switching ──
  if (isMobile) {
    return (
      <div className="flex flex-col h-screen h-dvh w-full bg-surface0 [&_.container-fluid]:px-5">
        <MobileHeader />
        <div className="flex-1 min-h-0 pt-[var(--header-height-mobile)] pb-[env(safe-area-inset-bottom)]">
          {/* Full-screen views (no list/detail split) */}
          {isHome || (isHome && mobilePane === 'detail') ? (
            <div className="h-full mx-2 my-1.5 bg-card overflow-hidden border border-border dark:border-border rounded-xl shadow-sm">
              <ProjectHome />
            </div>
          ) : viewMode === 'tasks' ? (
            <div className="h-full mx-2 my-1.5 bg-card overflow-hidden border border-border dark:border-border rounded-xl shadow-sm">
              <TasksView />
            </div>
          ) : viewMode === 'inbox' ? (
            <div className="h-full mx-2 my-1.5 bg-card overflow-hidden border border-border dark:border-border rounded-xl shadow-sm">
              <InboxView />
            </div>
          ) : viewMode === 'knowledge' ? (
            <div className="h-full mx-2 my-1.5 bg-card overflow-hidden border border-border dark:border-border rounded-xl shadow-sm">
              <KnowledgeView />
            </div>
          ) : viewMode === 'skills' ? (
            <div className="h-full mx-2 my-1.5 bg-card overflow-hidden border border-border dark:border-border rounded-xl shadow-sm">
              <SkillsView />
            </div>
          ) : viewMode === 'settings' ? (
            <div className="h-full mx-2 my-1.5 bg-card overflow-hidden border border-border dark:border-border rounded-xl shadow-sm">
              <SettingsView />
            </div>
          ) : mobilePane === 'list' ? (
            /* List pane — full width */
            <div className="h-full mx-2 my-1.5 bg-card overflow-hidden border border-border dark:border-border rounded-xl shadow-sm flex flex-col">
              {viewMode === 'threads' && <ThreadList />}
            </div>
          ) : (
            /* Detail pane — full width, edge-to-edge on mobile */
            <div className="relative h-full bg-card overflow-hidden border border-border dark:border-border rounded-xl shadow-sm">
              {viewMode === 'threads' && (
                <main className="h-full">
                  <ChatView />
                </main>
              )}
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

  // ── Desktop layout: modern Claude Desktop 3-pane workbench ──
  return (
    <>
      <WorkbenchLayout
        desktopContainerRef={desktopContainerRef}
        isStudioOpen={isStudioOpen}
        studioWidth={studioWidth}
        isStudioResizing={isStudioResizing}
        effectiveStudioTab={effectiveStudioTab}
        studioSeparatorProps={studioSeparatorProps}
        handleCloseStudio={handleCloseStudio}
      />
      <GlobalShortcuts />
      <DesktopIntegration />
      <RealtimeStatus />
      <WindowTitle />
      <ErrorLogDialog />
      <NewThreadDialogHost />
      <DropzoneOverlay />
      <CommandPalette />
    </>
  );
}
