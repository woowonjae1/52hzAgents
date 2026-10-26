'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useLayout, ViewMode } from './layout-context';
import { useWorkspace } from '@/lib/workspace-context';
import { useArtifacts } from '@/lib/artifacts-context';
import { useGitStatus } from '@/lib/use-git-status';
import { useTheme } from 'next-themes';
import {
  Search,
  Bot,
  Plus,
  Moon,
  Sun,
  Laptop,
  Compass,
  MessageSquare,
  CheckSquare,
  BookOpen,
  Folder,
  Globe,
  Activity,
  Repeat,
  Inbox,
  Radio,
  Settings,
  CornerDownLeft,
  X,
  Sparkles,
  FileText,
  FileCode,
  Keyboard,
  AlertCircle,
  PanelLeft,
  Users,
  House,
  ChevronLeft,
  GitBranch,
  FolderGit2,
  Columns2,
  FileDiff,
  Download,
  Upload,
  RefreshCw,
  ArrowRight,
  Layers,
} from 'lucide-react';
import { requestKnowledgeIntent } from '@/lib/knowledge-intent';
import { browseForFolder, recentWorkingDirs, rememberWorkingDir } from '@/components/chat/project-folder-picker';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { workspaceApi } from '@/lib/api';
import { Kbd } from '@/components/ui/kbd';
import { shortcutKeys } from '@/lib/shortcuts';
import { SHORTCUTS_EVENT } from './global-shortcuts';
import { ERROR_LOG_EVENT } from './error-log-dialog';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { VisuallyHidden } from 'radix-ui';
import { isComposing } from '@/lib/ime';

export type CommandCategory =
  | 'All'
  | 'Projects'
  | 'Git'
  | 'Navigation'
  | 'Actions'
  | 'Sessions'
  | 'Files'
  | 'Tasks'
  | 'Knowledge';

export type CommandBarPageId = 'root' | 'projects' | 'git' | 'sessions' | 'actions';

export interface CommandItem {
  id: string;
  category: CommandCategory;
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  shortcut?: string[];
  pageTarget?: CommandBarPageId;
  action?: () => void;
  badge?: string;
}

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

/**
 * Custom event any surface can fire to open the palette
 */
export const COMMAND_PALETTE_EVENT = 'app:command-palette';

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeCategory, setActiveCategory] = useState<CommandCategory>('All');
  const [pageStack, setPageStack] = useState<CommandBarPageId[]>(['root']);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const {
    setViewMode,
    openSettings,
    openNewThread,
    activeRightTab,
    setActiveRightTab,
    isMobile,
    openMobileDetail,
    sidebarToggle,
  } = useLayout();

  const {
    agents,
    currentSessionId,
    currentUser,
    sessions,
    files,
    todos,
    knowledge,
    setCurrentSessionId,
    setSelectedFileId,
    workspaceId,
    createSession,
    setActiveProjectDir,
  } = useWorkspace();

  const activeSession = useMemo(
    () => sessions.find((s) => s.sessionId === currentSessionId) || null,
    [sessions, currentSessionId]
  );
  const { status: gitStatus, refresh: refreshGit } = useGitStatus(
    activeSession?.sessionId && !activeSession.sessionId.startsWith('draft-')
      ? activeSession.sessionId
      : null
  );

  const { openOutput } = useArtifacts();
  const { theme, setTheme } = useTheme();

  const currentPage = pageStack[pageStack.length - 1];

  // Open / Close listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    const openFromEvent = () => setOpen(true);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener(COMMAND_PALETTE_EVENT, openFromEvent);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener(COMMAND_PALETTE_EVENT, openFromEvent);
    };
  }, []);

  // Reset state on open
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      setActiveCategory('All');
      setPageStack(['root']);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Keep selected row visible
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>('[data-palette-row][data-selected="true"]');
    row?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, query, open, currentPage, activeCategory]);

  const pushPage = useCallback((page: CommandBarPageId) => {
    setPageStack((prev) => [...prev, page]);
    setQuery('');
    setSelectedIndex(0);
  }, []);

  const popPage = useCallback(() => {
    setPageStack((prev) => (prev.length > 1 ? prev.slice(0, prev.length - 1) : prev));
    setQuery('');
    setSelectedIndex(0);
  }, []);

  const execute = useCallback(
    (item: CommandItem) => {
      if (item.pageTarget) {
        pushPage(item.pageTarget);
        return;
      }
      if (item.action) {
        setOpen(false);
        item.action();
      }
    },
    [pushPage]
  );

  // Recent working directories for project switching
  const [recentDirs, setRecentDirs] = useState<string[]>([]);
  useEffect(() => {
    if (open) setRecentDirs(recentWorkingDirs());
  }, [open]);

  // Build complete command registry across pages
  const { allCommands, pageCommands } = useMemo(() => {
    // 1. Projects Items
    const projectMap = new Map<string, { path: string; count: number }>();
    for (const s of sessions) {
      if (s.workingDir) {
        const norm = s.workingDir.trim();
        const prev = projectMap.get(norm);
        if (prev) prev.count += 1;
        else projectMap.set(norm, { path: norm, count: 1 });
      }
    }
    for (const d of recentDirs) {
      const norm = d.trim();
      if (!projectMap.has(norm)) projectMap.set(norm, { path: norm, count: 0 });
    }

    const projectItems: CommandItem[] = [
      {
        id: 'project-open-folder',
        category: 'Projects',
        title: 'Open Local Folder / Repository...',
        subtitle: 'Browse machine directories via native file picker',
        icon: <Plus className="size-4 text-primary" />,
        action: async () => {
          const dir = await browseForFolder();
          if (dir) {
            rememberWorkingDir(dir);
            const s = await createSession({ workingDir: dir, title: `Workspace in ${basename(dir)}` });
            setCurrentSessionId(s.sessionId);
            setViewMode('threads');
            toast.success(`Opened repository: ${basename(dir)}`);
          }
        },
      },
      ...Array.from(projectMap.values()).map(({ path, count }) => {
        const name = basename(path);
        const isCurrent = activeSession?.workingDir === path;
        return {
          id: `project-${path}`,
          category: 'Projects' as CommandCategory,
          title: name,
          subtitle: `${path}${count > 0 ? ` • ${count} sessions` : ''}`,
          icon: (
            <div
              className="size-4 rounded-md flex items-center justify-center font-mono text-3xs font-bold"
              style={{
                color: getDeterministicHsl(name),
                backgroundColor: `color-mix(in srgb, ${getDeterministicHsl(name)} 20%, transparent)`,
              }}
            >
              {getProjectInitials(name)}
            </div>
          ),
          badge: isCurrent ? 'Active Project' : undefined,
          action: async () => {
            setActiveProjectDir(path);
            const match = sessions.find((s) => s.workingDir === path);
            if (match) {
              const stored = typeof window !== 'undefined' ? localStorage.getItem(`last_session_for_${path}`) : null;
              if (!stored) {
                setCurrentSessionId(match.sessionId);
              }
            } else {
              const s = await createSession({ workingDir: path, title: `Workspace in ${name}` });
              setCurrentSessionId(s.sessionId);
            }
            setViewMode('threads');
            toast.info(`Switched to project: ${name}`);
          },
        };
      }),
    ];

    // 2. Git Items
    const stagedCount = gitStatus?.files?.filter((f) => f.staged).length ?? 0;
    const unstagedCount = gitStatus?.files?.filter((f) => !f.staged).length ?? 0;
    const gitItems: CommandItem[] = [
      {
        id: 'git-status-branch',
        category: 'Git',
        title: gitStatus?.branch ? `Current Branch: ${gitStatus.branch}` : 'Git: Check Status',
        subtitle: gitStatus
          ? `${stagedCount} staged, ${unstagedCount} unstaged (+${gitStatus.additions} -${gitStatus.deletions})`
          : 'Inspect repository status in active thread',
        icon: <GitBranch className="size-4 text-emerald-500" />,
        action: () => {
          setActiveRightTab('diff');
          refreshGit();
        },
      },
      {
        id: 'git-pull',
        category: 'Git',
        title: 'Git: Pull Latest Changes',
        subtitle: 'Fetch and integrate remote changes (git pull)',
        icon: <Download className="size-4 text-foreground-muted" />,
        action: async () => {
          if (!activeSession) {
            toast.error('No active session for Git operation');
            return;
          }
          try {
            toast.info('Pulling changes from remote...');
            const res = await workspaceApi.pullGitRemote(activeSession.sessionId);
            toast.success(res.output || 'Git pull completed');
            refreshGit();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Git pull failed');
          }
        },
      },
      {
        id: 'git-push',
        category: 'Git',
        title: 'Git: Push Local Commits',
        subtitle: 'Push local branch commits to remote repository (git push)',
        icon: <Upload className="size-4 text-foreground-muted" />,
        action: async () => {
          if (!activeSession) {
            toast.error('No active session for Git operation');
            return;
          }
          try {
            toast.info('Pushing commits to remote...');
            const res = await workspaceApi.pushGitRemote(activeSession.sessionId);
            toast.success(res.output || 'Git push completed');
            refreshGit();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : 'Git push failed');
          }
        },
      },
      {
        id: 'git-diff-studio',
        category: 'Git',
        title: 'Git: Open Diff & Review Studio',
        subtitle: 'Review staged/unstaged changes and inspect line-by-line diffs',
        icon: <FileDiff className="size-4 text-foreground-muted" />,
        action: () => setActiveRightTab('diff'),
      },
    ];

    // 3. Navigation Items
    const navItems: CommandItem[] = [
      {
        id: 'nav-home',
        category: 'Navigation',
        title: 'Home Dashboard',
        subtitle: 'Overview, recent activity and agent monitoring',
        icon: <House className="size-4 text-foreground-muted" />,
        shortcut: ['G', 'H'],
        action: () => {
          setCurrentSessionId(null);
          setViewMode('home');
        },
      },
      {
        id: 'nav-threads',
        category: 'Navigation',
        title: 'Threads & Conversations',
        subtitle: 'Switch to chat and multi-agent channels',
        icon: <MessageSquare className="size-4 text-foreground-muted" />,
        shortcut: ['G', 'T'],
        action: () => setViewMode('threads'),
      },
      {
        id: 'nav-tasks',
        category: 'Navigation',
        title: 'Tasks & Issues',
        subtitle: 'Linear-style task tracking and issue list',
        icon: <CheckSquare className="size-4 text-foreground-muted" />,
        shortcut: ['G', 'A'],
        action: () => setViewMode('tasks'),
      },
      {
        id: 'nav-skills',
        category: 'Navigation',
        title: 'Skills & Capabilities',
        subtitle: 'Manage MCP tools and agent custom skills',
        icon: <Sparkles className="size-4 text-foreground-muted" />,
        shortcut: ['G', 'E'],
        action: () => setViewMode('skills'),
      },
      {
        id: 'nav-knowledge',
        category: 'Navigation',
        title: 'Knowledge Base',
        subtitle: 'Documentation, design guides and RFC specifications',
        icon: <BookOpen className="size-4 text-foreground-muted" />,
        shortcut: ['G', 'K'],
        action: () => {
          if (currentSessionId) {
            setViewMode('threads');
            setActiveRightTab('knowledge');
          } else {
            setViewMode('knowledge');
          }
        },
      },
      {
        id: 'nav-inbox',
        category: 'Navigation',
        title: 'Notifications & Inbox',
        subtitle: 'Unread activity and agent status alerts',
        icon: <Inbox className="size-4 text-foreground-muted" />,
        action: () => setViewMode('inbox'),
      },
    ];

    // 4. Quick Actions
    const actionItems: CommandItem[] = [
      {
        id: 'act-new-chat',
        category: 'Actions',
        title: 'New Chat Session',
        subtitle: 'Create a fresh thread in current project',
        icon: <Plus className="size-4 text-foreground-muted" />,
        shortcut: ['Ctrl', 'N'],
        action: () => openNewThread(),
      },
      {
        id: 'act-split-view',
        category: 'Actions',
        title: 'Toggle Dual Split View',
        subtitle: 'Split workspace into side-by-side session grid',
        icon: <Columns2 className="size-4 text-foreground-muted" />,
        shortcut: ['Ctrl', '\\'],
        action: () => {
          const splitBtn = document.querySelector<HTMLButtonElement>('[aria-label*="Split"]');
          splitBtn?.click();
        },
      },
      {
        id: 'act-diff-studio',
        category: 'Actions',
        title: 'Toggle Diff Studio Panel',
        subtitle: 'Inspect file trees, diff reviews and git synchronization',
        icon: <FileDiff className="size-4 text-foreground-muted" />,
        action: () => setActiveRightTab(activeRightTab === 'diff' ? null : 'diff'),
      },
      {
        id: 'act-preview',
        category: 'Actions',
        title: 'Toggle Web Preview Browser',
        subtitle: 'Open built-in localhost dev-server browser sandbox',
        icon: <Globe className="size-4 text-foreground-muted" />,
        action: () => setActiveRightTab(activeRightTab === 'preview' ? null : 'preview'),
      },
      {
        id: 'act-theme',
        category: 'Actions',
        title: `Switch Theme to ${theme === 'dark' ? 'Light' : 'Obsidian Dark'}`,
        subtitle: 'Toggle between clean porcelain and obsidian physical materials',
        icon: theme === 'dark' ? <Sun className="size-4 text-foreground-muted" /> : <Moon className="size-4 text-foreground-muted" />,
        action: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
      },
      {
        id: 'act-sidebar',
        category: 'Actions',
        title: 'Toggle Left Sidebar',
        subtitle: 'Collapse or restore project session navigation',
        icon: <PanelLeft className="size-4 text-foreground-muted" />,
        shortcut: ['Ctrl', 'B'],
        action: () => sidebarToggle(),
      },
      {
        id: 'act-settings',
        category: 'Actions',
        title: 'Open Settings',
        subtitle: 'Configure LLM API keys, model parameters and defaults',
        icon: <Settings className="size-4 text-foreground-muted" />,
        action: () => openSettings(),
      },
    ];

    // 5. Session items
    const sessionItems: CommandItem[] = (sessions || []).map((s) => {
      const channelTag = s.sessionId.replace(/^channel\//, '');
      const parts = s.participants?.length ? ` • ${s.participants.map((p) => `@${p}`).join(', ')}` : '';
      const dirTag = s.workingDir ? ` [${basename(s.workingDir)}]` : '';
      return {
        id: `session-${s.sessionId}`,
        category: 'Sessions',
        title: s.title || `Thread #${channelTag}`,
        subtitle: `#${channelTag}${dirTag}${parts}`,
        icon: <MessageSquare className="size-4 text-foreground-muted" />,
        action: () => {
          setCurrentSessionId(s.sessionId);
          setViewMode('threads');
          if (isMobile) openMobileDetail();
        },
      };
    });

    // 6. Subpage Navigator Shortcuts on Root
    const pageTriggers: CommandItem[] = [
      {
        id: 'page-trigger-projects',
        category: 'Projects',
        title: 'Switch Project / Repository...',
        subtitle: `Browse ${projectItems.length - 1} open repositories and project folders`,
        icon: <FolderGit2 className="size-4 text-indigo-400" />,
        pageTarget: 'projects',
      },
      {
        id: 'page-trigger-git',
        category: 'Git',
        title: 'Git Commands & Remote Synchronization...',
        subtitle: 'Pull, push, branch inspection and code rollback',
        icon: <GitBranch className="size-4 text-emerald-400" />,
        pageTarget: 'git',
      },
      {
        id: 'page-trigger-sessions',
        category: 'Sessions',
        title: 'Browse All Sessions & Channels...',
        subtitle: `Search through ${sessions.length} historical and active sessions`,
        icon: <MessageSquare className="size-4 text-cyan-400" />,
        pageTarget: 'sessions',
      },
    ];

    // Compose page-specific lists
    const mapByPage: Record<CommandBarPageId, CommandItem[]> = {
      root: [...pageTriggers, ...actionItems, ...navItems, ...sessionItems.slice(0, 5)],
      projects: projectItems,
      git: gitItems,
      sessions: sessionItems,
      actions: actionItems,
    };

    const all = [
      ...pageTriggers,
      ...projectItems,
      ...gitItems,
      ...actionItems,
      ...navItems,
      ...sessionItems,
    ];

    return {
      allCommands: all,
      pageCommands: mapByPage[currentPage] || mapByPage.root,
    };
  }, [
    sessions,
    recentDirs,
    activeSession,
    gitStatus,
    refreshGit,
    setActiveRightTab,
    setCurrentSessionId,
    setViewMode,
    openNewThread,
    openSettings,
    sidebarToggle,
    createSession,
    theme,
    setTheme,
    isMobile,
    openMobileDetail,
    currentPage,
  ]);

  // Filter commands by Category tab + search Query
  const filtered = useMemo(() => {
    let base = pageCommands;

    // Category filtering
    if (activeCategory !== 'All') {
      base = base.filter((c) => c.category === activeCategory);
    }

    if (!query.trim()) return base;

    const q = query.toLowerCase().trim();
    return base.filter((item) => {
      return (
        item.title.toLowerCase().includes(q) ||
        (item.subtitle && item.subtitle.toLowerCase().includes(q)) ||
        item.category.toLowerCase().includes(q)
      );
    });
  }, [pageCommands, activeCategory, query]);

  // Keyboard navigation & Enter execution
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (isComposing(e)) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(1, filtered.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + filtered.length) % Math.max(1, filtered.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filtered[selectedIndex]) {
        execute(filtered[selectedIndex]);
      }
    } else if (e.key === 'Backspace' && query === '' && pageStack.length > 1) {
      e.preventDefault();
      popPage();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      // Cycle category
      const categories: CommandCategory[] = [
        'All',
        'Projects',
        'Git',
        'Navigation',
        'Actions',
        'Sessions',
      ];
      const nextIdx = (categories.indexOf(activeCategory) + 1) % categories.length;
      setActiveCategory(categories[nextIdx]);
      setSelectedIndex(0);
    }
  };

  const pageTitle = useMemo(() => {
    switch (currentPage) {
      case 'projects':
        return 'Projects';
      case 'git':
        return 'Git';
      case 'sessions':
        return 'Sessions';
      case 'actions':
        return 'Actions';
      default:
        return 'Omni Command';
    }
  }, [currentPage]);

  const categories: CommandCategory[] = [
    'All',
    'Projects',
    'Git',
    'Navigation',
    'Actions',
    'Sessions',
  ];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className={cn(
          'p-0 gap-0 max-w-2xl top-[12%] translate-y-0 overflow-hidden',
          'bg-surface1/95 dark:bg-[#111318]/95 backdrop-blur-2xl border border-border shadow-2xl rounded-2xl'
        )}
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <VisuallyHidden.Root asChild>
          <DialogTitle>Command Palette</DialogTitle>
        </VisuallyHidden.Root>

        {/* ── Search Input Row ── */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-border-chrome bg-surface1/60 dark:bg-[#111318]/60">
          {pageStack.length > 1 ? (
            <button
              type="button"
              onClick={popPage}
              aria-label="Back to previous page"
              className="flex items-center gap-1 px-2 py-1 rounded-md bg-surface3 border border-border/80 text-2xs font-semibold text-foreground hover:bg-surface4 transition-colors shrink-0 cursor-pointer active:scale-95"
            >
              <ChevronLeft className="size-3.5" />
              <span>{pageTitle}</span>
            </button>
          ) : (
            <Search className="size-4 text-foreground-extra-muted shrink-0" />
          )}

          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder={
              pageStack.length > 1
                ? `Search in ${pageTitle.toLowerCase()}... (Backspace to go back)`
                : 'Type a command, project, branch or session...'
            }
            role="combobox"
            aria-expanded
            aria-controls="command-palette-list"
            aria-autocomplete="list"
            className="flex-1 text-sm bg-transparent text-foreground placeholder:text-foreground-extra-muted focus:outline-none"
          />

          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="p-1 rounded text-foreground-extra-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}

          <div className="flex items-center gap-1.5 shrink-0 pl-2">
            <Kbd>ESC</Kbd>
          </div>
        </div>

        {/* ── Category Filter Tabs ── */}
        {pageStack.length === 1 && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border/40 bg-surface2/30 overflow-x-auto no-scrollbar">
            {categories.map((cat) => {
              const isActive = activeCategory === cat;
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => {
                    setActiveCategory(cat);
                    setSelectedIndex(0);
                  }}
                  className={cn(
                    'px-2.5 py-0.5 rounded-md text-3xs font-medium transition-all shrink-0 cursor-pointer select-none',
                    isActive
                      ? 'bg-primary/20 text-primary border border-primary/40 font-semibold shadow-2xs'
                      : 'text-foreground-muted hover:text-foreground hover:bg-surface3/60'
                  )}
                >
                  {cat}
                </button>
              );
            })}
          </div>
        )}

        {/* ── Filtered Command List ── */}
        <div
          ref={listRef}
          id="command-palette-list"
          role="listbox"
          aria-label="Commands"
          className="max-h-[380px] overflow-y-auto p-2 space-y-1 select-none"
        >
          {filtered.length === 0 ? (
            <div className="py-12 text-center text-xs text-foreground-extra-muted">
              No matching commands or actions found.
            </div>
          ) : (
            filtered.map((item, idx) => {
              const isSelected = idx === selectedIndex;
              const isNavPage = Boolean(item.pageTarget);

              return (
                <div
                  key={item.id}
                  role="option"
                  aria-selected={isSelected}
                  data-palette-row
                  data-selected={isSelected ? 'true' : 'false'}
                  onClick={() => execute(item)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={cn(
                    'group flex items-center justify-between px-3 py-2 rounded-xl text-xs transition-colors cursor-pointer select-none',
                    isSelected
                      ? 'bg-surface2 dark:bg-[#1b1f2b] text-foreground border border-border/80 shadow-xs'
                      : 'text-foreground-muted hover:bg-surface2/60'
                  )}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="p-1.5 rounded-lg bg-surface3 border border-border/60 shrink-0">
                      {item.icon}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p
                          className={cn(
                            'font-medium truncate',
                            isSelected ? 'text-foreground font-semibold' : 'text-foreground-muted'
                          )}
                        >
                          {item.title}
                        </p>
                        {item.badge && (
                          <span className="text-3xs px-1.5 py-0.2 rounded-full font-mono bg-primary/20 text-primary border border-primary/30">
                            {item.badge}
                          </span>
                        )}
                      </div>
                      {item.subtitle && (
                        <p className="text-3xs text-foreground-extra-muted truncate mt-0.5">
                          {item.subtitle}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Right side: Shortcut, Page Arrow or Category Tag */}
                  <div className="flex items-center gap-2 shrink-0 ml-3">
                    {item.shortcut ? (
                      <div className="flex items-center gap-1">
                        {item.shortcut.map((k, i) => (
                          <Kbd key={i}>{k}</Kbd>
                        ))}
                      </div>
                    ) : isNavPage ? (
                      <div className="flex items-center gap-1 text-foreground-muted text-3xs font-medium">
                        <span>Browse</span>
                        <ArrowRight className="size-3" />
                      </div>
                    ) : (
                      <span className="text-3xs text-foreground-extra-muted px-1.5 py-0.5 rounded bg-surface3 border border-border/60">
                        {item.category}
                      </span>
                    )}

                    {isSelected && <CornerDownLeft className="size-3 text-foreground-extra-muted" />}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* ── Footer ── */}
        <div className="flex items-center justify-between px-4 py-2 bg-surface2/60 border-t border-border-chrome text-3xs text-foreground-extra-muted font-medium">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              Navigate
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd>
              Select
            </span>
            <span className="flex items-center gap-1">
              <Kbd>Tab</Kbd>
              Switch Tab
            </span>
            {pageStack.length > 1 && (
              <span className="flex items-center gap-1">
                <Kbd>⌫</Kbd>
                Back
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <Sparkles className="size-3 text-primary" />
            <span className="font-mono">52hz Omni CommandBar</span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
