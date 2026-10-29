'use client';

import * as React from 'react';
import { useLayout } from '@/components/layout/layout-context';
import { useWorkspace } from '@/lib/workspace-context';
import { Sidebar } from '@/components/layout/sidebar';
import { SidebarExpandButton } from '@/components/layout/sidebar-expand-button';
import { ChatView } from '@/components/chat/chat-view';
import { ProjectHome } from '@/components/home/project-home';
import { TasksView } from '@/components/tasks/tasks-view';
import { InboxView } from '@/components/inbox/inbox-view';
import { KnowledgeView } from '@/components/knowledge/knowledge-view';
import { SkillsView } from '@/components/skills/skills-view';
import { SettingsView } from '@/components/settings/settings-view';
import { AgentProfilePanel } from '@/components/agents/agent-profile-panel';
import { MonitorGrid } from '@/components/monitor/monitor-grid';
import { ArtifactsCanvas } from '@/components/canvas/artifacts-canvas';
import { LocalPreview } from '@/components/preview/local-preview';
import { DiffStudioPanel } from './diff-studio-panel';
import { TerminalPanel } from './terminal-panel';
import { SessionGrid } from './session-grid';
import { ReviewProvider } from '@/lib/review-context';
import { DesktopAppBar } from '@/components/layout/desktop-app-bar';
import { Hint } from '@/components/ui/hint';
import { cn } from '@/lib/utils';
import { X, FileText, Globe, BookOpen, PanelLeft, FileDiff, Terminal } from 'lucide-react';

interface WorkbenchLayoutProps {
  desktopContainerRef: React.RefObject<HTMLDivElement | null>;
  isStudioOpen: boolean;
  studioWidth: number;
  isStudioResizing: boolean;
  effectiveStudioTab: string | null;
  studioSeparatorProps: Record<string, unknown>;
  handleCloseStudio: () => void;
}

/**
 * Modern Claude Desktop-style Workbench Layout.
 *
 * Implements the 3-pane architecture:
 * 1. Left: Collapsible Projects & Sessions Sidebar (Paseo/Claude-styled resizable rail)
 * 2. Center: Seamless Edge-to-Edge Execution Canvas with guaranteed top-bar chrome
 * 3. Right: Collapsible Studio / Inspector Drawer (Artifacts, Diff Reviewer, Previews)
 */
export function WorkbenchLayout({
  desktopContainerRef,
  isStudioOpen,
  studioWidth,
  isStudioResizing,
  effectiveStudioTab,
  studioSeparatorProps,
  handleCloseStudio,
}: WorkbenchLayoutProps) {
  const {
    viewMode,
    isSidebarOpen,
    isSidebarResizing,
    isDetailExpanded,
    isAgentPanelOpen,
    activeRightTab,
    setActiveRightTab,
  } = useLayout();

  const { currentSessionId } = useWorkspace();
  const isHome = viewMode === 'home';
  const monitorMode = false;
  const isSettings = viewMode === 'settings';
  const shouldShowSidebar = !isDetailExpanded && !isSettings;

  return (
    <ReviewProvider workspaceId={currentSessionId}>
      <div
        ref={desktopContainerRef}
        className="app-root-container workbench-root flex h-screen h-dvh w-full bg-surface0 overflow-hidden select-none [&_.container-fluid]:px-5"
      >
      {/* ── Far-Left Project & System Dock (cdesktop AppBar) ── */}
      <DesktopAppBar />

      {/* ── Left Pane: Collapsible Workbench Sidebar ── */}
      {shouldShowSidebar && <Sidebar />}

      {/* ── Center & Right Area ── */}
      <div
        className="flex flex-col flex-grow min-w-0 w-full relative h-full overflow-hidden"
        data-studio-open={isStudioOpen ? 'true' : 'false'}
      >
        <div className="flex grow min-h-0 h-full overflow-hidden relative">
          {/* Dock spacer standing in for the fixed 48px DesktopAppBar */}
          <div
            className="hidden md:block shrink-0"
            style={{ width: 'var(--dock-width, 48px)' }}
            aria-hidden="true"
          />

          {/* Invisible spacer standing in for the fixed sidebar to ensure smooth layout shifts */}
          {shouldShowSidebar && (
            <div
              data-sidebar-sized
              className={cn(
                'shrink-0',
                !isSidebarResizing && 'transition-[width] duration-[var(--shell-duration)] ease-[var(--shell-ease)]'
              )}
              style={{ width: isSidebarOpen ? 'var(--sidebar-width)' : '0px' }}
            />
          )}

          {/* ── Center Stage: Main Canvas Area ── */}
          <div className="relative flex-grow flex-1 min-w-0 bg-surface0 overflow-hidden flex flex-col h-full">
            {/* Monitor mode (2x3 multi-agent grid) */}
            {viewMode === 'threads' && monitorMode ? (
              <div className="relative flex-1 min-w-0 h-full">
                <MonitorGrid />
                {isAgentPanelOpen && <AgentProfilePanel />}
              </div>
            ) : (
              <>
                {/* ChatView kept mounted to preserve real-time WebSocket connection and active turns */}
                <div className={cn('h-full w-full', (viewMode !== 'threads' || isHome) && 'hidden')}>
                  <main className="h-full">
                    <SessionGrid>
                      <ChatView />
                    </SessionGrid>
                  </main>
                </div>

                {isHome && <ProjectHome />}
                {viewMode === 'tasks' && <TasksView />}
                {viewMode === 'inbox' && <InboxView />}
                {viewMode === 'knowledge' && <KnowledgeView />}
                {viewMode === 'skills' && <SkillsView />}
                {viewMode === 'settings' && <SettingsView />}

                {/* Agent slide-over profile drawer */}
                {isAgentPanelOpen && <AgentProfilePanel />}
              </>
            )}
          </div>

          {/* ── Right Pane: Unified Studio & Artifacts Inspector ── */}
          {isStudioOpen && (
            <aside
              aria-label="Studio Panel"
              style={{ width: `${studioWidth}px` }}
              className={cn(
                'shrink-0 h-full border-l border-border-chrome bg-surface1 flex flex-col z-20 relative select-text',
                isStudioResizing ? 'select-none transition-none' : 'transition-[width] duration-75'
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

              {/* Studio Header Bar */}
              <div className="app-header justify-between px-3 shrink-0 flex-nowrap select-none">
                <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar py-1">
                  <button
                    type="button"
                    onClick={() => setActiveRightTab('canvas')}
                    className={cn(
                      'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-2xs font-medium transition-colors shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer active:scale-95',
                      effectiveStudioTab === 'canvas' || effectiveStudioTab === 'file'
                        ? 'bg-surface3 text-foreground font-semibold border border-border'
                        : 'text-foreground-muted hover:text-foreground hover:bg-surface2'
                    )}
                  >
                    <FileText className="size-3.5" />
                    <span>Outputs</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveRightTab('diff')}
                    className={cn(
                      'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-2xs font-medium transition-colors shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer active:scale-95',
                      effectiveStudioTab === 'diff'
                        ? 'bg-surface3 text-foreground font-semibold border border-border'
                        : 'text-foreground-muted hover:text-foreground hover:bg-surface2'
                    )}
                  >
                    <FileDiff className="size-3.5" />
                    <span>Diff</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveRightTab('terminal')}
                    className={cn(
                      'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-2xs font-medium transition-colors shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer active:scale-95',
                      effectiveStudioTab === 'terminal'
                        ? 'bg-surface3 text-foreground font-semibold border border-border'
                        : 'text-foreground-muted hover:text-foreground hover:bg-surface2'
                    )}
                  >
                    <Terminal className="size-3.5" />
                    <span>Terminal</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveRightTab('preview')}
                    className={cn(
                      'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-2xs font-medium transition-colors shrink-0 outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer active:scale-95',
                      effectiveStudioTab === 'preview'
                        ? 'bg-surface3 text-foreground font-semibold border border-border'
                        : 'text-foreground-muted hover:text-foreground hover:bg-surface2'
                    )}
                  >
                    <Globe className="size-3.5" />
                    <span>Preview</span>
                  </button>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Hint label="Close Studio (Esc)">
                    <button
                      type="button"
                      aria-label="Close Studio"
                      onClick={handleCloseStudio}
                      className="size-7 rounded-lg hover:bg-surface2 text-foreground-muted hover:text-foreground flex items-center justify-center transition-colors shrink-0 cursor-pointer active:scale-95"
                    >
                      <X className="size-3.5" />
                    </button>
                  </Hint>
                  <span className="desktop-only h-4 w-px bg-border/60 shrink-0 ms-1 me-0.5" aria-hidden />
                </div>
              </div>

              {/* Studio Content Pane */}
              <div className="flex-1 min-h-0 overflow-hidden relative flex flex-col">
                {(effectiveStudioTab === 'canvas' || effectiveStudioTab === 'file') && <ArtifactsCanvas embedded />}
                {effectiveStudioTab === 'diff' && <DiffStudioPanel key={currentSessionId} />}
                {effectiveStudioTab === 'terminal' && <TerminalPanel />}
                {effectiveStudioTab === 'preview' && <LocalPreview />}
                {effectiveStudioTab === 'knowledge' && <KnowledgeView embedded />}
              </div>
            </aside>
          )}
        </div>
      </div>
    </div>
    </ReviewProvider>
  );
}
