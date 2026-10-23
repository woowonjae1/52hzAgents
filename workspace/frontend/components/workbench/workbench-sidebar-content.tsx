'use client';

import * as React from 'react';
import { useState, useMemo, useCallback, useRef } from 'react';
import {
  Plus,
  Search,
  MessageSquare,
  SquarePen,
  Trash2,
  FolderGit2,
  Sliders,
  X,
  Settings,
  Folder,
  Loader2,
  Bot,
  Blocks,
  Clock3,
  Activity,
  FileDiff,
} from 'lucide-react';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { useGitStatus } from '@/lib/use-git-status';
import { getSmartSessionTitle } from '@/components/threads/thread-list';
import { browseForFolder, basename } from '@/components/chat/project-folder-picker';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ThemeToggle } from '@/components/motion/theme-toggle';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Hint } from '@/components/ui/hint';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { useTheme } from 'next-themes';
import { isToday, isYesterday, subDays, isAfter } from 'date-fns';
import type { WorkspaceSession } from '@/lib/types';

interface GroupedSessions {
  today: WorkspaceSession[];
  yesterday: WorkspaceSession[];
  lastWeek: WorkspaceSession[];
  older: WorkspaceSession[];
}

export function WorkbenchSidebarContent() {
  const {
    sessions,
    agents,
    currentSessionId,
    setCurrentSessionId,
    lastMessageBySession,
    activeSessionIds,
    createSession,
    renameSession,
    updateSession,
  } = useWorkspace();

  const {
    viewMode,
    setViewMode,
    isMobile,
    openMobileDetail,
    openSettings,
    settingsTab,
    activeRightTab,
    setActiveRightTab,
  } = useLayout();
  const { status: gitStatus } = useGitStatus(currentSessionId);
  const gitDiffCount = gitStatus?.files?.length || 0;
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [browsingFolder, setBrowsingFolder] = useState(false);

  const onlineAgentsCount = useMemo(() => agents.filter((a) => a.status === 'online').length, [agents]);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  const isDark = mounted && resolvedTheme === 'dark';

  // Active sessions sorted by most recent activity
  const validSessions = useMemo(() => {
    return sessions
      .filter((s) => s.status !== 'deleted' && s.status !== 'archived')
      .sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0));
  }, [sessions]);

  // Current working directory from open session or first available session
  const activeWorkingDir = useMemo(() => {
    const active = sessions.find((s) => s.sessionId === currentSessionId);
    return active?.workingDir || sessions.find((s) => s.workingDir)?.workingDir || null;
  }, [sessions, currentSessionId]);

  // Grouped chronologically like Claude Desktop
  const grouped = useMemo<GroupedSessions>(() => {
    const query = searchQuery.trim().toLowerCase();
    const filtered = validSessions.filter((s) => {
      if (!query) return true;
      const title = getSmartSessionTitle(s, lastMessageBySession[s.sessionId]);
      return title.toLowerCase().includes(query);
    });

    const now = new Date();
    const sevenDaysAgo = subDays(now, 7);

    const res: GroupedSessions = {
      today: [],
      yesterday: [],
      lastWeek: [],
      older: [],
    };

    for (const session of filtered) {
      const time = session.lastEventAt
        ? new Date(session.lastEventAt)
        : session.createdAt
        ? new Date(session.createdAt)
        : new Date(0);

      if (isToday(time)) {
        res.today.push(session);
      } else if (isYesterday(time)) {
        res.yesterday.push(session);
      } else if (isAfter(time, sevenDaysAgo)) {
        res.lastWeek.push(session);
      } else {
        res.older.push(session);
      }
    }

    return res;
  }, [validSessions, searchQuery, lastMessageBySession]);

  const handleStartNewSession = useCallback(async () => {
    try {
      const s = await createSession({ workingDir: activeWorkingDir || undefined });
      setCurrentSessionId(s.sessionId);
      setViewMode('threads');
      if (isMobile) openMobileDetail();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create new session');
    }
  }, [createSession, activeWorkingDir, setCurrentSessionId, setViewMode, isMobile, openMobileDetail]);

  const handlePickFolder = useCallback(async () => {
    if (browsingFolder) return;
    setBrowsingFolder(true);
    try {
      const dir = await browseForFolder(activeWorkingDir || undefined);
      if (dir) {
        await createSession({ workingDir: dir });
        setViewMode('threads');
        toast.success(`Switched project workspace to ${basename(dir)}`);
      }
    } catch (e) {
      toast.error('Could not switch project directory');
    } finally {
      setBrowsingFolder(false);
    }
  }, [browsingFolder, activeWorkingDir, createSession, setViewMode]);

  const handleCommitRename = useCallback(async (sessionId: string) => {
    const trimmed = editingTitle.trim();
    setEditingSessionId(null);
    if (!trimmed) return;
    try {
      await renameSession(sessionId, trimmed);
    } catch (e) {
      toast.error('Failed to rename session');
    }
  }, [editingTitle, renameSession]);

  const handleConfirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await updateSession(deleteTarget.id, { status: 'deleted' });
      if (currentSessionId === deleteTarget.id) {
        setCurrentSessionId(null);
      }
      toast.success('Session deleted');
    } catch (e) {
      toast.error('Failed to delete session');
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget, updateSession, currentSessionId, setCurrentSessionId]);

  const renderSessionItem = (session: WorkspaceSession) => {
    const isSelected = session.sessionId === currentSessionId && viewMode === 'threads';
    const isRunning = activeSessionIds.has(session.sessionId);
    const title = getSmartSessionTitle(session, lastMessageBySession[session.sessionId]);
    const isEditing = editingSessionId === session.sessionId;

    return (
      <div
        key={session.sessionId}
        onClick={() => {
          if (isEditing) return;
          setCurrentSessionId(session.sessionId);
          setViewMode('threads');
          if (isMobile) openMobileDetail();
        }}
        className={cn(
          'group relative flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs cursor-pointer select-none transition-colors transition-transform duration-75',
          isSelected
            ? 'bg-surface2 text-foreground font-semibold shadow-xs border border-border/60'
            : 'text-foreground-muted hover:text-foreground hover:bg-surface2/60 border border-transparent'
        )}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {isRunning ? (
            <span className="size-2 rounded-full bg-primary animate-pulse shrink-0" title="Agent is working" />
          ) : (
            <MessageSquare className="size-3.5 shrink-0 text-foreground-extra-muted" />
          )}

          {isEditing ? (
            <input
              type="text"
              value={editingTitle}
              autoFocus
              onChange={(e) => setEditingTitle(e.target.value)}
              onBlur={() => handleCommitRename(session.sessionId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCommitRename(session.sessionId);
                if (e.key === 'Escape') setEditingSessionId(null);
              }}
              onClick={(e) => e.stopPropagation()}
              className="w-full bg-surface3 px-1.5 py-0.5 rounded text-xs text-foreground outline-hidden border border-primary/40 font-normal"
            />
          ) : (
            <span className="truncate flex-1 tracking-tight">{title}</span>
          )}
        </div>

        {/* Hover Action Buttons */}
        {!isEditing && (
          <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 shrink-0 transition-opacity">
            <Hint label="Rename">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingSessionId(session.sessionId);
                  setEditingTitle(title);
                }}
                className="p-1 rounded hover:bg-surface3 text-foreground-extra-muted hover:text-foreground transition-colors cursor-pointer"
              >
                <SquarePen className="size-3" />
              </button>
            </Hint>
            <Hint label="Delete">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleteTarget({ id: session.sessionId, title });
                }}
                className="p-1 rounded hover:bg-destructive/15 text-foreground-extra-muted hover:text-destructive transition-colors cursor-pointer"
              >
                <Trash2 className="size-3" />
              </button>
            </Hint>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface-sidebar select-none">
      {/* ── Top Controls: Project Folder & New Task ── */}
      <div className="p-2.5 pb-1 space-y-2 shrink-0">
        {/* Project Folder Pill */}
        {activeWorkingDir && (
          <Hint label={`Working directory: ${activeWorkingDir}. Click to switch project folder.`}>
            <button
              type="button"
              onClick={handlePickFolder}
              disabled={browsingFolder}
              className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-surface2/70 hover:bg-surface3 border border-border/60 text-xs font-medium text-foreground transition-all cursor-pointer group"
            >
              <div className="flex items-center gap-2 min-w-0">
                <FolderGit2 className="size-3.5 text-primary shrink-0" />
                <span className="font-mono text-2xs truncate">{basename(activeWorkingDir)}</span>
              </div>
              <span className="text-3xs text-foreground-extra-muted group-hover:text-foreground">Switch</span>
            </button>
          </Hint>
        )}

        {/* Claude Desktop-style Big "+ New Task" Button */}
        <button
          type="button"
          onClick={handleStartNewSession}
          className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-surface2 hover:bg-surface3 border border-border/80 text-xs font-semibold text-foreground transition-all shadow-xs cursor-pointer active:scale-[0.98]"
        >
          <div className="flex items-center gap-2">
            <Plus className="size-4 text-primary shrink-0" />
            <span>New Session</span>
          </div>
          <span className="text-3xs font-mono px-1.5 py-0.5 rounded bg-surface3/70 text-foreground-muted border border-border/40">
            Ctrl+N
          </span>
        </button>

        {/* Primary Workbench Destinations */}
        <nav aria-label="Workbench destinations" className="space-y-0.5 pt-1">
          <button
            type="button"
            onClick={() => {
              setViewMode('threads');
              if (activeRightTab === 'diff') setActiveRightTab(null);
              if (isMobile) openMobileDetail();
            }}
            className={cn(
              'w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer',
              viewMode === 'threads' && activeRightTab !== 'diff'
                ? 'bg-surface2 text-foreground font-semibold shadow-2xs border border-border/60'
                : 'text-foreground-muted hover:text-foreground hover:bg-surface2/60 border border-transparent'
            )}
          >
            <div className="flex items-center gap-2 min-w-0">
              <MessageSquare className="size-3.5 text-primary shrink-0" />
              <span className="truncate">Sessions</span>
            </div>
            <span className="text-3xs font-mono px-1.5 py-0.2 rounded-full bg-surface3/70 text-foreground-extra-muted">
              {validSessions.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              setViewMode('threads');
              setActiveRightTab('diff');
              if (isMobile) openMobileDetail();
            }}
            className={cn(
              'w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer group',
              viewMode === 'threads' && activeRightTab === 'diff'
                ? 'bg-surface2 text-foreground font-semibold shadow-2xs border border-border/60'
                : 'text-foreground-muted hover:text-foreground hover:bg-surface2/60 border border-transparent'
            )}
          >
            <div className="flex items-center gap-2 min-w-0">
              <FileDiff className="size-3.5 text-foreground-muted group-hover:text-foreground shrink-0 transition-colors" />
              <span className="truncate">Review & Diff</span>
            </div>
            {gitDiffCount > 0 ? (
              <span className="inline-flex items-center gap-1 text-3xs font-medium px-1.5 py-0.2 rounded-full bg-primary/10 text-primary border border-primary/25 font-mono">
                <span>{gitDiffCount} {gitDiffCount === 1 ? 'file' : 'files'}</span>
              </span>
            ) : (
              <span className="text-3xs font-mono px-1.5 py-0.2 rounded-full bg-surface3/70 text-foreground-extra-muted">
                clean
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => {
              openSettings('agents');
              if (isMobile) openMobileDetail();
            }}
            className={cn(
              'w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer group',
              viewMode === 'settings' && settingsTab === 'agents'
                ? 'bg-surface2 text-foreground font-semibold shadow-2xs border border-border/60'
                : 'text-foreground-muted hover:text-foreground hover:bg-surface2/60 border border-transparent'
            )}
          >
            <div className="flex items-center gap-2 min-w-0">
              <Bot className="size-3.5 text-foreground-muted group-hover:text-foreground shrink-0 transition-colors" />
              <span className="truncate">Agents</span>
            </div>
            <span className="inline-flex items-center gap-1 text-3xs font-medium px-1.5 py-0.2 rounded-full bg-surface3 text-foreground-muted border border-border/40 font-mono">
              <span className="size-1.5 rounded-full bg-emerald-500 shrink-0" />
              <span>{onlineAgentsCount} online</span>
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              setViewMode('skills');
              if (isMobile) openMobileDetail();
            }}
            className={cn(
              'w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer group',
              viewMode === 'skills'
                ? 'bg-surface2 text-foreground font-semibold shadow-2xs border border-border/60'
                : 'text-foreground-muted hover:text-foreground hover:bg-surface2/60 border border-transparent'
            )}
          >
            <div className="flex items-center gap-2 min-w-0">
              <Blocks className="size-3.5 text-foreground-muted group-hover:text-foreground shrink-0 transition-colors" />
              <span className="truncate">Skills & MCP</span>
            </div>
          </button>

          <button
            type="button"
            onClick={() => {
              setViewMode('tasks');
              if (isMobile) openMobileDetail();
            }}
            className={cn(
              'w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer group',
              viewMode === 'tasks'
                ? 'bg-surface2 text-foreground font-semibold shadow-2xs border border-border/60'
                : 'text-foreground-muted hover:text-foreground hover:bg-surface2/60 border border-transparent'
            )}
          >
            <div className="flex items-center gap-2 min-w-0">
              <Clock3 className="size-3.5 text-foreground-muted group-hover:text-foreground shrink-0 transition-colors" />
              <span className="truncate">Tasks & Automations</span>
            </div>
          </button>
        </nav>

        {/* Search Input Box */}
        <div className="relative flex items-center">
          <Search className="size-3.5 absolute left-2.5 text-foreground-extra-muted pointer-events-none" />
          <input
            type="text"
            placeholder="Search sessions…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-7 py-1 rounded-lg bg-surface1/60 hover:bg-surface1 focus:bg-surface2 text-xs text-foreground placeholder:text-foreground-extra-muted border border-border/50 outline-hidden transition-colors"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2 text-foreground-extra-muted hover:text-foreground cursor-pointer"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      </div>

      {/* ── Scrollable Chronological Sessions Feed ── */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-4 no-scrollbar">
        {validSessions.length === 0 ? (
          <div className="py-8 text-center text-xs text-foreground-extra-muted">
            No active sessions yet.
          </div>
        ) : (
          <>
            {grouped.today.length > 0 && (
              <div className="space-y-0.5">
                <div className="px-2 text-[10px] font-semibold uppercase tracking-wider text-foreground-extra-muted">
                  Today
                </div>
                {grouped.today.map(renderSessionItem)}
              </div>
            )}

            {grouped.yesterday.length > 0 && (
              <div className="space-y-0.5">
                <div className="px-2 text-[10px] font-semibold uppercase tracking-wider text-foreground-extra-muted">
                  Yesterday
                </div>
                {grouped.yesterday.map(renderSessionItem)}
              </div>
            )}

            {grouped.lastWeek.length > 0 && (
              <div className="space-y-0.5">
                <div className="px-2 text-[10px] font-semibold uppercase tracking-wider text-foreground-extra-muted">
                  Previous 7 Days
                </div>
                {grouped.lastWeek.map(renderSessionItem)}
              </div>
            )}

            {grouped.older.length > 0 && (
              <div className="space-y-0.5">
                <div className="px-2 text-[10px] font-semibold uppercase tracking-wider text-foreground-extra-muted">
                  Older
                </div>
                {grouped.older.map(renderSessionItem)}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Bottom Status & Settings Bar ── */}
      <div className="shrink-0 px-3 py-2 bg-transparent flex items-center justify-between border-t border-border/60">
        <button
          type="button"
          onClick={() => openSettings('general')}
          className={cn(
            'flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium transition-colors cursor-pointer',
            viewMode === 'settings'
              ? 'bg-surface2 text-foreground font-semibold'
              : 'text-foreground-muted hover:text-foreground hover:bg-surface2/60'
          )}
        >
          <Settings className="size-3.5 text-foreground-muted" />
          <span>Settings</span>
        </button>

        <div className="flex items-center gap-2">
          <Hint label="Workspace agent runtime status">
            <div className="flex items-center gap-1.5 text-3xs font-medium text-foreground-extra-muted px-1.5 py-0.5 rounded-full bg-surface2/50 border border-border/40 select-none">
              <span className="size-1.5 rounded-full bg-status-success animate-pulse" />
              <span>Ready</span>
            </div>
          </Hint>

          <Tooltip>
            <TooltipTrigger asChild>
              <ThemeToggle
                variant="circle-blur"
                start="bottom-right"
                className="size-7 rounded-lg text-foreground-extra-muted hover:text-foreground hover:bg-surface2/60 transition-colors"
                iconClassName="size-3.5"
              />
            </TooltipTrigger>
            <TooltipContent side="top">{isDark ? 'Light mode' : 'Dark mode'}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title="Delete Session"
        description={`Are you sure you want to delete "${deleteTarget?.title}"? All session history will be archived.`}
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
