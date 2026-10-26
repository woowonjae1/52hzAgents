'use client';

import * as React from 'react';
import { useState, useMemo, useCallback } from 'react';
import {
  Plus,
  Search,
  MessageSquare,
  SquarePen,
  Trash2,
  FolderGit2,
  X,
  Settings,
  Bot,
  Blocks,
  Clock3,
  FileDiff,
  Pin,
  Hand,
  FileText,
  Circle,
  ChevronDown,
} from 'lucide-react';
import { useWorkspace, isDraftSessionId } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { useGitStatus } from '@/lib/use-git-status';
import { useReviewOptional } from '@/lib/review-context';
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

/* -------------------------------------------------------------------------- */
/* RunningDots (ported from cdesktop RunningDots.tsx)                         */
/* -------------------------------------------------------------------------- */

export function RunningDots({
  sizeClass = 'size-1',
  colorClass = 'bg-brand',
}: {
  sizeClass?: string;
  colorClass?: string;
} = {}) {
  const dot = cn('rounded-full animate-pulse', sizeClass, colorClass);
  return (
    <div className="flex items-center gap-[2px] shrink-0" aria-label="Agent running">
      <span className={dot} style={{ animationDelay: '0ms' }} />
      <span className={dot} style={{ animationDelay: '180ms' }} />
      <span className={dot} style={{ animationDelay: '360ms' }} />
    </div>
  );
}

const formatRelativeElapsed = (timestamp?: number | string | null): string => {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const diffMs = Date.now() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
};

const PINNED_STORAGE_KEY = '52hz_pinned_sessions_v1';

function loadPinnedSessionIds(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = localStorage.getItem(PINNED_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed) : new Set();
  } catch {
    return new Set();
  }
}

function savePinnedSessionIds(ids: Set<string>): void {
  try {
    localStorage.setItem(PINNED_STORAGE_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    // ignore storage errors
  }
}

interface GroupedSessions {
  needsAttention: WorkspaceSession[];
  running: WorkspaceSession[];
  pinned: WorkspaceSession[];
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
    routines,
    activeProjectDir,
    setActiveProjectDir,
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
  const review = useReviewOptional();
  const reviewCommentCount = review?.comments.length ?? 0;

  const gitDiffCount = gitStatus?.files?.length || 0;
  const gitAdditions = gitStatus?.additions;
  const gitDeletions = gitStatus?.deletions;

  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const [browsingFolder, setBrowsingFolder] = useState(false);
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => loadPinnedSessionIds());
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});

  const onlineAgentsCount = useMemo(() => agents.filter((a) => a.status === 'online').length, [agents]);

  React.useEffect(() => {
    setMounted(true);
    setPinnedIds(loadPinnedSessionIds());
  }, []);

  const isDark = mounted && resolvedTheme === 'dark';

  const togglePinSession = useCallback((sessionId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setPinnedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      savePinnedSessionIds(next);
      return next;
    });
  }, []);

  const toggleSection = useCallback((key: string) => {
    setCollapsedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  // Active sessions sorted by most recent activity, optionally scoped to activeProjectDir
  const validSessions = useMemo(() => {
    const unarchived = sessions
      .filter((s) => s.status !== 'deleted' && s.status !== 'archived')
      .sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0));

    if (!activeProjectDir) {
      return unarchived;
    }
    return unarchived.filter((s) => s.workingDir === activeProjectDir);
  }, [sessions, activeProjectDir]);

  // Current working directory from open session or first available session
  const activeWorkingDir = useMemo(() => {
    const active = sessions.find((s) => s.sessionId === currentSessionId);
    return active?.workingDir || sessions.find((s) => s.workingDir)?.workingDir || null;
  }, [sessions, currentSessionId]);

  const hasPendingRoutineApproval = useMemo(
    () => (routines || []).some((r) => r.status === 'pending_approval'),
    [routines]
  );

  // Detect whether a session needs review / approval ("Raised Hand" in cdesktop)
  const sessionNeedsAttention = useCallback(
    (session: WorkspaceSession): boolean => {
      const isActiveSession = session.sessionId === currentSessionId;
      if (isActiveSession && reviewCommentCount > 0) return true;
      if (isActiveSession && hasPendingRoutineApproval) return true;
      const lastMsg = lastMessageBySession[session.sessionId];
      if (lastMsg?.content && /approval|permission|review needed|waiting for your review/i.test(lastMsg.content)) {
        return true;
      }
      return false;
    },
    [currentSessionId, reviewCommentCount, hasPendingRoutineApproval, lastMessageBySession]
  );

  // Grouped into cdesktop's smart status buckets + chronological buckets
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
      needsAttention: [],
      running: [],
      pinned: [],
      today: [],
      yesterday: [],
      lastWeek: [],
      older: [],
    };

    for (const session of filtered) {
      const isRunning = activeSessionIds.has(session.sessionId);
      const needsHand = sessionNeedsAttention(session);
      const isPinned = pinnedIds.has(session.sessionId);

      if (needsHand) {
        res.needsAttention.push(session);
        continue;
      }
      if (isRunning) {
        res.running.push(session);
        continue;
      }
      if (isPinned) {
        res.pinned.push(session);
        continue;
      }

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
  }, [validSessions, searchQuery, lastMessageBySession, activeSessionIds, sessionNeedsAttention, pinnedIds]);

  const handleStartNewSession = useCallback(async () => {
    try {
      const targetDir = activeProjectDir || activeWorkingDir || undefined;
      const s = await createSession({ workingDir: targetDir });
      setCurrentSessionId(s.sessionId);
      setViewMode('threads');
      if (isMobile) openMobileDetail();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create new session');
    }
  }, [createSession, activeProjectDir, activeWorkingDir, setCurrentSessionId, setViewMode, isMobile, openMobileDetail]);

  const handlePickFolder = useCallback(async () => {
    if (browsingFolder) return;
    setBrowsingFolder(true);
    try {
      const dir = await browseForFolder(activeProjectDir || activeWorkingDir || undefined);
      if (dir) {
        setActiveProjectDir(dir);
        await createSession({ workingDir: dir });
        setViewMode('threads');
        toast.success(`Switched project workspace to ${basename(dir)}`);
      }
    } catch {
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
    } catch {
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
    } catch {
      toast.error('Failed to delete session');
    } finally {
      setDeleteTarget(null);
    }
  }, [deleteTarget, updateSession, currentSessionId, setCurrentSessionId]);

  // Ported from cdesktop WorkspaceSummary.tsx
  const renderSessionItem = (session: WorkspaceSession) => {
    const isSelected = session.sessionId === currentSessionId && viewMode === 'threads';
    const isRunning = activeSessionIds.has(session.sessionId);
    const hasPendingApproval = sessionNeedsAttention(session);
    const isPinned = pinnedIds.has(session.sessionId);
    const isDraft = isDraftSessionId(session.sessionId);
    const title = getSmartSessionTitle(session, lastMessageBySession[session.sessionId]);
    const isEditing = editingSessionId === session.sessionId;

    // Show live git diff stats on the active session (like cdesktop WorkspaceSummary)
    const isCurrentSession = session.sessionId === currentSessionId;
    const filesChanged = isCurrentSession && gitDiffCount > 0 ? gitDiffCount : undefined;
    const linesAdded = isCurrentSession && gitDiffCount > 0 ? gitAdditions : undefined;
    const linesRemoved = isCurrentSession && gitDiffCount > 0 ? gitDeletions : undefined;
    const hasChanges = filesChanged !== undefined && filesChanged > 0;
    const elapsed = formatRelativeElapsed(session.lastEventAt || session.createdAt);
    const showSecondRow = hasChanges || isPinned || Boolean(session.workingDir);

    return (
      <div
        key={session.sessionId}
        data-session-summary={session.sessionId}
        onClick={() => {
          if (isEditing) return;
          setCurrentSessionId(session.sessionId);
          setViewMode('threads');
          if (isMobile) openMobileDetail();
        }}
        className={cn(
          'group relative rounded-[8px] transition-all duration-100 overflow-hidden cursor-pointer select-none',
          isSelected
            ? 'bg-surface2 text-foreground shadow-2xs border border-border/60'
            : 'text-foreground-muted hover:text-foreground hover:bg-surface2/60 border border-transparent'
        )}
      >
        <div className="flex w-full flex-col text-left px-2.5 py-1.5">
          {/* Primary Row: Status Indicator + Title */}
          <div
            className="flex items-center gap-2 overflow-hidden whitespace-nowrap pr-12"
            style={
              !isEditing
                ? {
                    maskImage:
                      'linear-gradient(to right, black calc(100% - 18px), transparent 100%)',
                    WebkitMaskImage:
                      'linear-gradient(to right, black calc(100% - 18px), transparent 100%)',
                  }
                : undefined
            }
          >
            <span className="inline-flex size-3.5 items-center justify-center shrink-0">
              {hasPendingApproval ? (
                <Hand className="size-3.5 text-brand fill-brand/20" />
              ) : isRunning ? (
                <RunningDots sizeClass="size-[3px]" colorClass="bg-brand" />
              ) : isPinned ? (
                <Pin className="size-3 text-brand rotate-45" />
              ) : (
                <Circle
                  className={cn(
                    'size-2',
                    isSelected
                      ? 'text-brand fill-brand'
                      : 'text-foreground-extra-muted opacity-45'
                  )}
                />
              )}
            </span>

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
              <span
                className={cn(
                  'min-w-0 flex-1 text-xs tracking-tight truncate',
                  isSelected ? 'font-semibold text-foreground' : 'font-normal'
                )}
              >
                {title}
              </span>
            )}
          </div>

          {/* Secondary Metadata Row (cdesktop WorkspaceSummary stats + elapsed + folder) */}
          {!isEditing && showSecondRow && (
            <div className="flex w-full items-center gap-1.5 text-[10px] h-4 mt-0.5 pl-5 text-foreground-extra-muted">
              {session.workingDir && (
                <span className="truncate max-w-[90px] font-mono opacity-80">
                  {basename(session.workingDir)}
                </span>
              )}
              {!isRunning && (
                <span className="min-w-0 flex-1 truncate opacity-75">
                  {isDraft ? 'Draft' : elapsed}
                </span>
              )}
              {isRunning && <span className="flex-1" />}

              {hasChanges && (
                <span className="shrink-0 text-right flex items-center gap-1 font-mono">
                  <FileText className="size-2.5" />
                  <span>{filesChanged}</span>
                  {linesAdded !== undefined && (
                    <span className="text-status-success font-medium">+{linesAdded}</span>
                  )}
                  {linesRemoved !== undefined && (
                    <span className="text-status-danger font-medium">-{linesRemoved}</span>
                  )}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Right-side hover action buttons (Pin, Rename, Delete) */}
        {!isEditing && (
          <div className="opacity-0 group-hover:opacity-100 absolute right-1 top-1.5 flex items-center gap-0.5 shrink-0 transition-opacity bg-surface2/95 backdrop-blur-xs px-1 py-0.5 rounded-md shadow-2xs">
            <Hint label={isPinned ? 'Unpin session' : 'Pin session'}>
              <button
                type="button"
                onClick={(e) => togglePinSession(session.sessionId, e)}
                className={cn(
                  'p-1 rounded hover:bg-surface3 transition-colors cursor-pointer',
                  isPinned ? 'text-brand' : 'text-foreground-extra-muted hover:text-foreground'
                )}
                aria-label={isPinned ? 'Unpin session' : 'Pin session'}
              >
                <Pin className="size-3" />
              </button>
            </Hint>
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

  const renderSection = (
    key: string,
    label: string,
    items: WorkspaceSession[],
    badge?: React.ReactNode
  ) => {
    if (items.length === 0) return null;
    const isCollapsed = Boolean(collapsedSections[key]);
    return (
      <div className="space-y-0.5">
        <button
          type="button"
          onClick={() => toggleSection(key)}
          className="group w-full flex items-center justify-between px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-foreground-extra-muted hover:text-foreground transition-colors cursor-pointer"
        >
          <span className="flex items-center gap-1.5">
            <span>{label}</span>
            {badge}
          </span>
          <ChevronDown
            className={cn(
              'size-3 opacity-0 group-hover:opacity-100 transition-transform',
              isCollapsed && '-rotate-90 opacity-70'
            )}
          />
        </button>
        {!isCollapsed && items.map(renderSessionItem)}
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

        {/* Claude Desktop / cdesktop "+ New Session" Button */}
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
              setViewMode('home');
              if (isMobile) openMobileDetail();
            }}
            className={cn(
              'w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors cursor-pointer group',
              viewMode === 'home' || (viewMode === 'settings' && settingsTab === 'agents')
                ? 'bg-surface2 text-foreground font-semibold shadow-2xs border border-border/60'
                : 'text-foreground-muted hover:text-foreground hover:bg-surface2/60 border border-transparent'
            )}
          >
            <div className="flex items-center gap-2 min-w-0">
              <Bot className="size-3.5 text-foreground-muted group-hover:text-foreground shrink-0 transition-colors" />
              <span className="truncate">Agent Team</span>
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

      {/* ── Scrollable cdesktop-style Sessions Feed ── */}
      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-3.5 no-scrollbar">
        {/* Active Project Scope Pill */}
        {activeProjectDir && (
          <div className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-surface2/80 border border-border/60 text-2xs select-none">
            <div className="flex items-center gap-1.5 min-w-0">
              <FolderGit2 className="size-3 text-primary shrink-0" />
              <span className="font-semibold text-foreground truncate max-w-[130px]">
                {basename(activeProjectDir)}
              </span>
              <span className="text-3xs font-mono text-muted-foreground">({validSessions.length})</span>
            </div>
            <Hint label="Clear project filter (show all sessions)">
              <button
                type="button"
                onClick={() => setActiveProjectDir(null)}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-foreground-extra-muted hover:text-foreground hover:bg-surface3 transition-colors cursor-pointer"
              >
                <span className="text-3xs font-mono">All</span>
                <X className="size-2.5" />
              </button>
            </Hint>
          </div>
        )}

        {validSessions.length === 0 ? (
          <div className="py-8 text-center text-xs text-foreground-extra-muted">
            No active sessions yet.
          </div>
        ) : (
          <>
            {renderSection(
              'needsAttention',
              'Needs Review',
              grouped.needsAttention,
              <span className="px-1.5 py-0.2 rounded-full bg-brand/15 text-brand font-mono text-[9px]">
                {grouped.needsAttention.length}
              </span>
            )}
            {renderSection(
              'running',
              'Running',
              grouped.running,
              <RunningDots sizeClass="size-[3px]" colorClass="bg-brand" />
            )}
            {renderSection('pinned', 'Pinned', grouped.pinned)}
            {renderSection('today', 'Today', grouped.today)}
            {renderSection('yesterday', 'Yesterday', grouped.yesterday)}
            {renderSection('lastWeek', 'Previous 7 Days', grouped.lastWeek)}
            {renderSection('older', 'Older', grouped.older)}
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
