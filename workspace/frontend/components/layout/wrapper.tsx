'use client';

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
import { EmptyState } from '@/components/chat/empty-state';
import { AgentTerminal } from '@/components/terminal/agent-terminal';
import { NewThreadDialogHost } from '@/components/threads/new-thread-dialog-host';
import { DropzoneOverlay } from '@/components/files/dropzone-overlay';

import { Network, X, PanelLeft } from 'lucide-react';

function WorkspaceLoadingScreen() {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-5 animate-[pulse_2s_ease-in-out_infinite]">
        <div className="size-16 flex items-center justify-center rounded-xl border border-border/10 dark:border-border/10 bg-surface1 overflow-hidden p-2.5 shadow-md">
          <img src="/logo-icon.png" alt="52hzAgents Logo" className="w-full h-full object-contain" />
        </div>
        <div className="text-center">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">52hzAgents Workspace</h1>
          <p className="text-xs text-foreground-extra-muted mt-1.5">Loading your workspace…</p>
        </div>
      </div>
      <div className="absolute bottom-0 left-0 right-0 h-1 bg-muted overflow-hidden">
        <div className="h-full w-1/3 bg-primary rounded-full animate-[loading-bar_1.5s_ease-in-out_infinite]" />
      </div>
      <style>{`
        @keyframes loading-bar {
          0% { transform: translateX(-100%); }
          50% { transform: translateX(150%); }
          100% { transform: translateX(400%); }
        }
      `}</style>
    </div>
  );
}

export function Wrapper() {
  const { isMobile, viewMode, isAgentPanelOpen, isSidebarOpen, sidebarToggle, sidebarWidth, isSidebarResizing, isDetailExpanded, mobilePane, splitBrowser, showBrowserPreview, activeRightTab, setActiveRightTab } = useLayout();
  const { monitorMode, agents, loading } = useWorkspace();
  const hasAgents = agents.length > 0;

  if (loading) {
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
            <div className="h-full mx-2 my-1.5 bg-card overflow-hidden border border-border/80 dark:border-border/80 rounded-xl shadow-sm">
              <MissionControl />
            </div>
          ) : !hasAgents && viewMode === 'threads' ? (
            <div className="h-full mx-2 my-1.5 bg-card overflow-hidden border border-border/80 dark:border-border/80 rounded-xl shadow-sm">
              <EmptyState />
            </div>
          ) : viewMode === 'connect' ? (
            <div className="h-full mx-2 my-1.5 bg-card overflow-hidden border border-border/80 dark:border-border/80 rounded-xl shadow-sm">
              <ConnectAgentView />
            </div>
          ) : viewMode === 'tasks' ? (
            <div className="h-full mx-2 my-1.5 bg-card overflow-hidden border border-border/80 dark:border-border/80 rounded-xl shadow-sm">
              <TasksView />
            </div>
          ) : viewMode === 'timers' ? (
            <div className="h-full mx-2 my-1.5 bg-card overflow-hidden border border-border/80 dark:border-border/80 rounded-xl shadow-sm">
              <TimersView />
            </div>
          ) : viewMode === 'inbox' ? (
            <div className="h-full mx-2 my-1.5 bg-card overflow-hidden border border-border/80 dark:border-border/80 rounded-xl shadow-sm">
              <InboxView />
            </div>
          ) : viewMode === 'skills' ? (
            <div className="h-full mx-2 my-1.5 bg-card overflow-hidden border border-border/80 dark:border-border/80 rounded-xl shadow-sm">
              <SkillsView />
            </div>
          ) : viewMode === 'knowledge' ? (
            <div className="h-full mx-2 my-1.5 bg-card overflow-hidden border border-border/80 dark:border-border/80 rounded-xl shadow-sm">
              <KnowledgeView />
            </div>
          ) : mobilePane === 'list' ? (
            /* List pane — full width */
            <div className="h-full mx-2 my-1.5 bg-card overflow-hidden border border-border/80 dark:border-border/80 rounded-xl shadow-sm flex flex-col">
              {viewMode === 'threads' && <ThreadList />}
              {viewMode === 'files' && <FileList />}
              {viewMode === 'browser' && <BrowserTabList />}
              {viewMode === 'routines' && <RoutineList />}
            </div>
          ) : (
            /* Detail pane — full width, edge-to-edge on mobile */
            <div className="relative h-full bg-card overflow-hidden border border-border/80 dark:border-border/80 rounded-xl shadow-sm">
              {(viewMode === 'threads' || viewMode === 'routines') && (
                <main className="h-full" role="content">
                  <ChatView />
                </main>
              )}
              {viewMode === 'files' && <FilePreview />}
              {viewMode === 'browser' && <BrowserView />}
              {isAgentPanelOpen && <AgentProfilePanel />}
            </div>
          )}
        </div>
        <NewThreadDialogHost />
      </div>
    );
  }

  // ── Desktop layout: sidebar + center chat + collapsible right preview ──
  return (
    <div className="flex h-screen w-full bg-surface0 [&_.container-fluid]:px-5">
      {!isDetailExpanded && <Sidebar />}

      <div className="flex flex-col flex-grow min-w-0 w-full">
        <div className="flex grow min-h-0 overflow-hidden mx-2.5 py-2.5 gap-2.5">
          {/* Invisible spacer standing in for the fixed sidebar. Reads the same
              resizable width the sidebar itself does, so dragging the handle moves
              the main pane with it. */}
          {!isDetailExpanded && (
            <div
              className={cn('shrink-0', !isSidebarResizing && 'transition-all duration-300')}
              style={{ width: isSidebarOpen ? `${sidebarWidth}px` : '0px' }}
            />
          )}

          {/* Dynamic multi-pane grid based on viewMode and activeRightTab */}
          {!hasAgents && viewMode === 'threads' ? (
            /* No agents + threads view: full-width onboarding */
            <div className="relative flex-1 min-w-0 bg-card overflow-hidden border border-border/80 dark:border-border/80 rounded-xl shadow-sm">
              <EmptyState />
            </div>
          ) : viewMode === 'threads' && monitorMode ? (
            /* Monitor mode: replace both panes with 2x3 grid */
            <div className="relative flex-1 min-w-0">
              <MonitorGrid />
              {isAgentPanelOpen && <AgentProfilePanel />}
            </div>
          ) : (
            <>
              {/* Column 2: Center Main Workspace */}
              <div className="relative flex-grow flex-1 min-w-0 bg-card overflow-hidden border border-border/80 dark:border-border/80 rounded-xl shadow-sm flex flex-col">
                {!isSidebarOpen && (
                  <button
                    onClick={sidebarToggle}
                    className="absolute top-3 left-3 z-30 size-8 rounded-lg bg-background/90 backdrop-blur border border-border text-foreground-muted hover:text-foreground shadow-sm flex items-center justify-center transition-all hover:scale-105 cursor-pointer"
                    title="Expand Sidebar"
                  >
                    <PanelLeft className="size-4" />
                  </button>
                )}
                {viewMode === 'mission' ? (
                  <MissionControl />
                ) : viewMode === 'connect' ? (
                  <ConnectAgentView />
                ) : viewMode === 'files' ? (
                  <FilePreview />
                ) : viewMode === 'tasks' ? (
                  <TasksView />
                ) : viewMode === 'timers' ? (
                  <TimersView />
                ) : viewMode === 'inbox' ? (
                  <InboxView />
                ) : viewMode === 'skills' ? (
                  <SkillsView />
                ) : viewMode === 'knowledge' ? (
                  <KnowledgeView />
                ) : viewMode === 'browser' ? (
                  <BrowserView />
                ) : (
                  <main className="h-full" role="content">
                    <ChatView />
                  </main>
                )}
                {/* Agent profile slide-over panel */}
                {isAgentPanelOpen && <AgentProfilePanel />}
              </div>

              {/* Column 3: Right Collapsible Preview Panel */}
              {!isDetailExpanded && activeRightTab !== null && viewMode !== 'mission' && viewMode !== 'connect' && viewMode !== 'files' && (
                <div className="shrink-0 w-[420px] xl:w-[460px] bg-card overflow-hidden border border-border/80 dark:border-border/80 rounded-xl shadow-sm flex flex-col animate-[fadeIn_0.15s_ease-out] relative">
                  {/* Close button for right panel */}
                  <button 
                    onClick={() => setActiveRightTab(null)}
                    className="absolute top-3 right-3 z-10 size-7 flex items-center justify-center rounded-lg hover:bg-surface2 text-foreground-muted hover:text-foreground dark:text-foreground-extra-muted dark:hover:text-foreground-extra-muted transition-colors cursor-pointer"
                    title="Close preview panel"
                  >
                    <X className="size-4" />
                  </button>
                  {activeRightTab === 'browser' && <BrowserView />}
                  {activeRightTab === 'file' && <FilePreview />}
                  {activeRightTab === 'tasks' && <TasksView />}
                  {activeRightTab === 'radar' && <RadarPanel />}
                  {activeRightTab === 'terminal' && <AgentTerminal />}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <NewThreadDialogHost />
      <DropzoneOverlay />
    </div>
  );
}
