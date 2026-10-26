'use client';

import * as React from 'react';
import { useState, useMemo, useCallback } from 'react';
import {
  Layers,
  Plus,
  FolderGit2,
  Columns2,
  FileDiff,
  Globe,
  Search,
  Moon,
  Sun,
  Settings,
  Terminal,
  Radio,
  Check,
} from 'lucide-react';
import { useWorkspace, isDraftSessionId } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { useSessionGridOptional } from '@/lib/session-grid-context';
import { useTheme } from 'next-themes';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { browseForFolder, recentWorkingDirs, rememberWorkingDir } from '@/components/chat/project-folder-picker';
import { COMMAND_PALETTE_EVENT } from '@/components/layout/command-palette';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

function basename(pathStr: string): string {
  if (!pathStr) return '';
  const parts = pathStr.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || pathStr;
}

function getProjectInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'PR';
  const clean = trimmed.replace(/^[^a-zA-Z0-9]+/, '');
  const words = clean.split(/[\s\-_.]+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase() || 'PR';
}

function getDeterministicHsl(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 65%, 52%)`;
}

interface ProjectEntry {
  id: string;
  name: string;
  path: string;
  initials: string;
  color: string;
  sessionCount: number;
}

/**
 * DesktopAppBar (Project Dock & Activity Rail)
 *
 * Modeled after cdesktop AppBar.tsx & Discord/Linear desktop client architecture:
 * - 48px fixed tactile vertical activity rail on the far left of the desktop client.
 * - Top: Local workspaces / root sessions switcher with active pill indicator.
 * - Middle: Unique project folders (workingDir) with colored initial squircles, tooltips & native folder opener (+).
 * - Core Studio Shortcuts: Split View (SessionGrid), Diff Studio, Local Dev Preview.
 * - Bottom: Realtime SSE status pulse, Omni CommandBar (Ctrl+K), Theme Switcher, and Settings.
 */
export function DesktopAppBar() {
  const {
    workspace,
    sessions,
    currentSessionId,
    setCurrentSessionId,
    createSession,
    realtimeStatus,
    reconnectRealtime,
  } = useWorkspace();

  const {
    viewMode,
    setViewMode,
    activeRightTab,
    setActiveRightTab,
    openSettings,
  } = useLayout();

  const grid = useSessionGridOptional();
  const { resolvedTheme, setTheme } = useTheme();

  // Find the active session to see which project is currently active
  const activeSession = useMemo(
    () => sessions.find((s) => s.sessionId === currentSessionId) || null,
    [sessions, currentSessionId]
  );
  const activeWorkingDir = activeSession?.workingDir || null;

  // Aggregate project directories from recent storage and existing sessions
  const [recentDirs, setRecentDirs] = useState<string[]>([]);
  React.useEffect(() => {
    setRecentDirs(recentWorkingDirs());
  }, []);

  const projects = useMemo<ProjectEntry[]>(() => {
    const map = new Map<string, { path: string; count: number }>();

    // 1. Collect from sessions
    for (const s of sessions) {
      if (s.workingDir) {
        const normalized = s.workingDir.trim();
        const existing = map.get(normalized);
        if (existing) {
          existing.count += 1;
        } else {
          map.set(normalized, { path: normalized, count: 1 });
        }
      }
    }

    // 2. Collect from recent working dirs
    for (const dir of recentDirs) {
      const normalized = dir.trim();
      if (!map.has(normalized)) {
        map.set(normalized, { path: normalized, count: 0 });
      }
    }

    // If active working dir is not in map yet, add it
    if (activeWorkingDir && !map.has(activeWorkingDir)) {
      map.set(activeWorkingDir, { path: activeWorkingDir, count: 1 });
    }

    return Array.from(map.values()).map(({ path, count }) => {
      const name = basename(path);
      return {
        id: path,
        name,
        path,
        initials: getProjectInitials(name),
        color: getDeterministicHsl(name),
        sessionCount: count,
      };
    });
  }, [sessions, recentDirs, activeWorkingDir]);

  // Click on a project
  const handleSelectProject = useCallback(
    async (project: ProjectEntry) => {
      // Find an existing session in this project
      const match = sessions.find((s) => s.workingDir === project.path);
      if (match) {
        setCurrentSessionId(match.sessionId);
        setViewMode('threads');
        toast.info(`Switched to project: ${project.name}`);
      } else {
        try {
          const s = await createSession({
            workingDir: project.path,
            title: `Workspace in ${project.name}`,
          });
          setCurrentSessionId(s.sessionId);
          setViewMode('threads');
          toast.success(`Started new session in ${project.name}`);
        } catch {
          toast.error(`Could not start session in ${project.name}`);
        }
      }
    },
    [sessions, setCurrentSessionId, setViewMode, createSession]
  );

  // Add a new project / folder
  const handleAddProject = useCallback(async () => {
    try {
      const dir = await browseForFolder(activeWorkingDir || undefined);
      if (!dir) return;
      rememberWorkingDir(dir);
      setRecentDirs(recentWorkingDirs());

      const s = await createSession({
        workingDir: dir,
        title: `Workspace in ${basename(dir)}`,
      });
      setCurrentSessionId(s.sessionId);
      setViewMode('threads');
      toast.success(`Opened project: ${basename(dir)}`);
    } catch {
      toast.error('Failed to open project folder');
    }
  }, [activeWorkingDir, createSession, setCurrentSessionId, setViewMode]);

  // All Workspaces / Root Home click
  const isAllWorkspacesActive = !activeWorkingDir && viewMode === 'threads';
  const handleAllWorkspacesClick = useCallback(() => {
    setViewMode('threads');
  }, [setViewMode]);

  // Open Command Palette
  const handleOpenCommandPalette = useCallback(() => {
    window.dispatchEvent(new CustomEvent(COMMAND_PALETTE_EVENT));
  }, []);

  return (
    <nav
      aria-label="Desktop App Rail"
      className={cn(
        'hidden md:flex fixed top-0 bottom-0 start-0 z-30 flex-col items-center justify-between',
        'w-[var(--dock-width,48px)] py-2.5 px-1 bg-surface-sidebar dark:bg-[#0c0d12] border-r border-border-chrome select-none'
      )}
      style={{
        width: 'var(--dock-width, 48px)',
      }}
    >
      {/* ── Top Group: Workspaces & Project Squircles ── */}
      <div className="flex flex-col items-center gap-2 w-full">
        {/* All Workspaces / Master Root Button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="relative flex items-center justify-center w-full group">
              {/* Active Indicator Pill (Left Edge) */}
              <span
                className={cn(
                  'absolute -start-1 w-1 rounded-e-full bg-primary transition-all duration-150',
                  isAllWorkspacesActive ? 'h-5 opacity-100' : 'h-2 opacity-0 group-hover:opacity-60'
                )}
                aria-hidden="true"
              />
              <button
                type="button"
                data-no-drag
                onClick={handleAllWorkspacesClick}
                aria-label="All Workspaces & Sessions"
                className={cn(
                  'size-9 rounded-xl flex items-center justify-center transition-all duration-150 cursor-pointer active:scale-95',
                  isAllWorkspacesActive
                    ? 'bg-primary/20 text-primary border border-primary/40 shadow-xs'
                    : 'text-foreground-muted hover:text-foreground hover:bg-surface2'
                )}
              >
                <Layers className="size-4.5" />
              </button>
            </div>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            <div className="font-semibold text-xs">All Sessions & Workspaces</div>
            <div className="text-3xs text-foreground-muted">Universal workspace view</div>
          </TooltipContent>
        </Tooltip>

        <span className="w-5 h-px bg-border/60 my-0.5 shrink-0" aria-hidden="true" />

        {/* Project Initial Squircles List */}
        <div className="flex flex-col items-center gap-1.5 w-full max-h-[36vh] overflow-y-auto no-scrollbar">
          {projects.map((p) => {
            const isActive = activeWorkingDir === p.path;
            return (
              <Tooltip key={p.id}>
                <TooltipTrigger asChild>
                  <div className="relative flex items-center justify-center w-full group">
                    {/* Active Left Indicator Pill */}
                    <span
                      className={cn(
                        'absolute -start-1 w-1 rounded-e-full bg-primary transition-all duration-150',
                        isActive ? 'h-5 opacity-100' : 'h-2 opacity-0 group-hover:opacity-60'
                      )}
                      aria-hidden="true"
                    />
                    <button
                      type="button"
                      data-no-drag
                      onClick={() => handleSelectProject(p)}
                      aria-label={`Project ${p.name}`}
                      className={cn(
                        'size-9 rounded-xl flex items-center justify-center font-mono font-bold text-xs tracking-tight transition-all duration-150 cursor-pointer active:scale-95',
                        isActive
                          ? 'border shadow-xs'
                          : 'bg-surface2/60 text-foreground-muted hover:text-foreground hover:bg-surface3/80'
                      )}
                      style={
                        isActive
                          ? {
                              color: p.color,
                              backgroundColor: `color-mix(in srgb, ${p.color} 16%, transparent)`,
                              borderColor: `color-mix(in srgb, ${p.color} 50%, transparent)`,
                            }
                          : undefined
                      }
                    >
                      {p.initials}
                    </button>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  <div className="font-semibold text-xs flex items-center gap-1.5">
                    <span>{p.name}</span>
                    {p.sessionCount > 0 && (
                      <span className="px-1.5 py-0.2 rounded-full text-3xs font-mono bg-surface3 text-foreground-muted">
                        {p.sessionCount}
                      </span>
                    )}
                  </div>
                  <div className="text-3xs font-mono text-foreground-muted truncate max-w-[220px]">
                    {p.path}
                  </div>
                </TooltipContent>
              </Tooltip>
            );
          })}

          {/* Plus button to open folder */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-no-drag
                onClick={handleAddProject}
                aria-label="Open Local Folder / Project"
                className="size-9 rounded-xl border border-dashed border-border/70 hover:border-primary/80 hover:bg-surface2 text-foreground-muted hover:text-foreground flex items-center justify-center transition-all duration-150 cursor-pointer active:scale-95 mt-0.5"
              >
                <Plus className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              <div className="font-semibold text-xs">Open Local Folder...</div>
              <div className="text-3xs text-foreground-muted">Add code repository to workspace dock</div>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* ── Center Group: Dual Split & Studio View Shortcuts ── */}
      <div className="flex flex-col items-center gap-1.5 w-full my-auto py-2">
        {/* Split Grid View Toggle */}
        {grid && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-no-drag
                onClick={() => grid.toggleSplit()}
                aria-label={grid.isSplit ? 'Single session view' : 'Split dual sessions view'}
                className={cn(
                  'size-8 rounded-lg flex items-center justify-center transition-colors cursor-pointer active:scale-95',
                  grid.isSplit
                    ? 'bg-primary/20 text-primary border border-primary/40 font-semibold'
                    : 'text-foreground-muted hover:text-foreground hover:bg-surface2'
                )}
              >
                <Columns2 className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={8}>
              <div className="font-semibold text-xs">
                {grid.isSplit ? 'Collapse Split View' : 'Split Dual Sessions View'}
              </div>
              <div className="text-3xs text-foreground-muted">Multi-agent side-by-side split grid</div>
            </TooltipContent>
          </Tooltip>
        )}

        {/* Diff Studio Toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-no-drag
              onClick={() => setActiveRightTab(activeRightTab === 'diff' ? null : 'diff')}
              aria-label="Toggle Diff Studio"
              className={cn(
                'size-8 rounded-lg flex items-center justify-center transition-colors cursor-pointer active:scale-95',
                activeRightTab === 'diff'
                  ? 'bg-primary/20 text-primary border border-primary/40 font-semibold'
                  : 'text-foreground-muted hover:text-foreground hover:bg-surface2'
              )}
            >
              <FileDiff className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            <div className="font-semibold text-xs">Diff Studio</div>
            <div className="text-3xs text-foreground-muted">Code review & Git synchronization</div>
          </TooltipContent>
        </Tooltip>

        {/* Terminal Panel Toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-no-drag
              onClick={() => setActiveRightTab(activeRightTab === 'terminal' ? null : 'terminal')}
              aria-label="Toggle Terminal Panel"
              className={cn(
                'size-8 rounded-lg flex items-center justify-center transition-colors cursor-pointer active:scale-95',
                activeRightTab === 'terminal'
                  ? 'bg-primary/20 text-primary border border-primary/40 font-semibold'
                  : 'text-foreground-muted hover:text-foreground hover:bg-surface2'
              )}
            >
              <Terminal className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            <div className="font-semibold text-xs">Terminal Panel</div>
            <div className="text-3xs text-foreground-muted">Interactive multi-tab shell drawer</div>
          </TooltipContent>
        </Tooltip>

        {/* Local Dev Preview Toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-no-drag
              onClick={() => setActiveRightTab(activeRightTab === 'preview' ? null : 'preview')}
              aria-label="Toggle Web Preview"
              className={cn(
                'size-8 rounded-lg flex items-center justify-center transition-colors cursor-pointer active:scale-95',
                activeRightTab === 'preview'
                  ? 'bg-primary/20 text-primary border border-primary/40 font-semibold'
                  : 'text-foreground-muted hover:text-foreground hover:bg-surface2'
              )}
            >
              <Globe className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            <div className="font-semibold text-xs">Web Preview Browser</div>
            <div className="text-3xs text-foreground-muted">Live localhost dev server inspector</div>
          </TooltipContent>
        </Tooltip>
      </div>

      {/* ── Bottom Group: System & Utilities ── */}
      <div className="flex flex-col items-center gap-1.5 w-full">
        {/* Realtime Stream Health Capsule */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-no-drag
              onClick={realtimeStatus !== 'live' ? reconnectRealtime : undefined}
              aria-label={`Realtime: ${realtimeStatus}`}
              className="size-8 rounded-lg flex items-center justify-center hover:bg-surface2 text-foreground-muted hover:text-foreground transition-colors cursor-pointer"
            >
              <span className="relative flex size-2.5">
                {realtimeStatus === 'live' && (
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                )}
                <span
                  className={cn(
                    'relative inline-flex rounded-full size-2.5',
                    realtimeStatus === 'live'
                      ? 'bg-emerald-500 shadow-[0_0_6px_rgba(16,185,129,0.5)]'
                      : realtimeStatus === 'connecting'
                      ? 'bg-amber-500 animate-pulse'
                      : 'bg-rose-500'
                  )}
                />
              </span>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            <div className="font-semibold text-xs">
              {realtimeStatus === 'live'
                ? 'Realtime Connected'
                : realtimeStatus === 'connecting'
                ? 'Reconnecting to Workspace...'
                : 'Workspace Stream Offline (Click to retry)'}
            </div>
            <div className="text-3xs text-foreground-muted">Live WebSocket & event bus status</div>
          </TooltipContent>
        </Tooltip>

        {/* Omni CommandBar Shortcut Trigger */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-no-drag
              onClick={handleOpenCommandPalette}
              aria-label="Command Palette (Ctrl+K)"
              className="size-8 rounded-lg flex items-center justify-center hover:bg-surface2 text-foreground-muted hover:text-foreground transition-colors cursor-pointer active:scale-95"
            >
              <Search className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            <div className="font-semibold text-xs">Command Palette</div>
            <div className="text-3xs text-foreground-muted font-mono">Ctrl + K / Cmd + K</div>
          </TooltipContent>
        </Tooltip>

        {/* Theme Switcher Toggle */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-no-drag
              onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
              aria-label="Toggle Theme"
              className="size-8 rounded-lg flex items-center justify-center hover:bg-surface2 text-foreground-muted hover:text-foreground transition-colors cursor-pointer active:scale-95"
            >
              {resolvedTheme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            <div className="font-semibold text-xs">Toggle Theme</div>
            <div className="text-3xs text-foreground-muted">Switch between Obsidian Dark and Light</div>
          </TooltipContent>
        </Tooltip>

        {/* Settings Button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              data-no-drag
              onClick={() => openSettings()}
              aria-label="Workspace Settings"
              className="size-8 rounded-lg flex items-center justify-center hover:bg-surface2 text-foreground-muted hover:text-foreground transition-colors cursor-pointer active:scale-95"
            >
              <Settings className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            <div className="font-semibold text-xs">Settings & Configuration</div>
            <div className="text-3xs text-foreground-muted">Models, MCP tools & preferences</div>
          </TooltipContent>
        </Tooltip>
      </div>
    </nav>
  );
}
