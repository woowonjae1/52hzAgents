'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useLayout, ViewMode } from './layout-context';
import { useWorkspace } from '@/lib/workspace-context';
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
  Timer,
  Inbox,
  Radio,
  Settings,
  Terminal,
  CornerDownLeft,
  X,
  Sparkles,
  FileText,
  FileCode,
  Keyboard,
  PanelLeft,
  Users,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { workspaceApi } from '@/lib/api';
import { Kbd } from '@/components/ui/kbd';
import { shortcutKeys } from '@/lib/shortcuts';
import { SHORTCUTS_EVENT } from './global-shortcuts';

interface CommandItem {
  id: string;
  category: 'Navigation' | 'Actions' | 'Agents' | 'Threads' | 'Files' | 'Tasks';
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  shortcut?: string[];
  action: () => void;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { setViewMode, openSettings, openNewThread, setActiveRightTab, isMobile, openMobileDetail, sidebarToggle } = useLayout();
  const { agents, currentSessionId, currentUser, sessions, files, todos, setCurrentSessionId, setSelectedFileId, workspaceId, createSession } = useWorkspace();
  const { theme, setTheme } = useTheme();

  // Open/close keyboard shortcut: ⌘K or Ctrl+K
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Keep the cursor visible. Without this the list scrolled only by mouse and
  // arrowing down past the fold moved a selection nobody could see.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>('[data-palette-row][data-selected="true"]');
    row?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, query, open]);

  const execute = useCallback((item: CommandItem) => {
    setOpen(false);
    item.action();
  }, []);

  // Build command list
  const { allCommands, defaultCommands } = useMemo(() => {
    /*
     * EVERY ICON IN HERE IS `text-foreground-muted`. Do not tint them again.
     *
     * The palette used to hand each row its own hue — emerald Tasks, blue
     * Mission Control, yellow Skills, amber Files, purple Knowledge, cyan
     * Browser, rose Routines, orange Timers, indigo Inbox — thirteen colours
     * down one column. None of them encoded anything: the destination is named
     * in the title beside it, and the icon already distinguishes the rows by
     * SHAPE. What the colours actually did was make a list the user scans by
     * reading into a list the user has to look past.
     *
     * Four of them (`-400` steps with no light counterpart) were also authored
     * against the dark theme only. And `text-primary`, on the three rows that
     * used it, is not an accent at all in the light theme — `--primary` is
     * #09090b there, the same near-black as the label next to it.
     */
    const nav: CommandItem[] = [
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
        subtitle: 'Linear-style task tracking and Kanban board',
        icon: <CheckSquare className="size-4 text-foreground-muted" />,
        shortcut: ['G', 'A'],
        action: () => setViewMode('tasks'),
      },
      {
        id: 'nav-mission',
        category: 'Navigation',
        title: 'Agent Dashboard',
        subtitle: 'Agent radar and orchestration topology',
        icon: <Compass className="size-4 text-foreground-muted" />,
        shortcut: ['G', 'M'],
        action: () => setViewMode('mission'),
      },
      {
        id: 'nav-skills',
        shortcut: ['G', 'E'],
        category: 'Navigation',
        title: 'Skills & Capabilities',
        subtitle: 'Manage agent tools and capabilities',
        icon: <Sparkles className="size-4 text-foreground-muted" />,
        action: () => setViewMode('skills'),
      },
      {
        id: 'nav-files',
        shortcut: ['G', 'F'],
        category: 'Navigation',
        title: 'Files & Workspace Artifacts',
        subtitle: 'Browse files and diffs',
        icon: <Folder className="size-4 text-foreground-muted" />,
        action: () => setViewMode('files'),
      },
      {
        id: 'nav-knowledge',
        shortcut: ['G', 'K'],
        category: 'Navigation',
        title: 'Knowledge Base',
        subtitle: 'Manage workspace memories and documents',
        icon: <BookOpen className="size-4 text-foreground-muted" />,
        action: () => setViewMode('knowledge'),
      },
      {
        id: 'nav-browser',
        shortcut: ['G', 'B'],
        category: 'Navigation',
        title: 'Agent Browser',
        subtitle: 'Watch and control automated browser instances',
        icon: <Globe className="size-4 text-foreground-muted" />,
        action: () => setViewMode('browser'),
      },
      {
        id: 'nav-routines',
        shortcut: ['G', 'R'],
        category: 'Navigation',
        title: 'Routines & Automation',
        subtitle: 'Scheduled and recurring cron tasks',
        icon: <Repeat className="size-4 text-foreground-muted" />,
        action: () => setViewMode('routines'),
      },
      {
        id: 'nav-timers',
        category: 'Navigation',
        title: 'Timers & Reminders',
        subtitle: 'One-shot agent timers',
        icon: <Timer className="size-4 text-foreground-muted" />,
        action: () => setViewMode('timers'),
      },
      {
        id: 'nav-inbox',
        shortcut: ['G', 'I'],
        category: 'Navigation',
        title: 'Inbox & Approvals',
        subtitle: 'Review agent notifications and approvals',
        icon: <Inbox className="size-4 text-foreground-muted" />,
        action: () => setViewMode('inbox'),
      },
      {
        id: 'nav-connect',
        shortcut: ['G', 'N'],
        category: 'Navigation',
        title: 'Connect Agents',
        subtitle: 'Add CLI agents (Claude Code, OpenClaw, Pi, etc.)',
        icon: <Radio className="size-4 text-foreground-muted" />,
        action: () => setViewMode('connect'),
      },
      {
        id: 'nav-settings',
        category: 'Navigation',
        title: 'Settings',
        subtitle: 'Workspace preferences and agent configs',
        icon: <Settings className="size-4 text-foreground-muted" />,
        shortcut: ['G', 'S'],
        action: () => openSettings('general'),
      },
    ];

    const actions: CommandItem[] = [
      /*
       * TWO WAYS TO START, AND THEY ARE NOT THE SAME COMMAND.
       *
       * `C` (here, in the sidebar's New-chat row, and in the thread list's key
       * handler) creates a channel immediately. The picker below asks who
       * joins first. They used to share one palette row wearing a `C` cap, so
       * the cap described a dialog the key never opened.
       */
      {
        id: 'act-new-chat',
        category: 'Actions',
        title: 'New Chat',
        subtitle: 'Create an empty channel right away',
        icon: <Plus className="size-4 text-foreground-muted" />,
        shortcut: ['C'],
        action: async () => {
          try {
            await createSession({});
            setViewMode('threads');
            if (isMobile) openMobileDetail();
          } catch (e: any) {
            toast.error(e?.message || 'Could not create the channel');
          }
        },
      },
      {
        id: 'act-new-thread',
        category: 'Actions',
        title: 'New Thread with Agents…',
        subtitle: 'Pick participants, then start the conversation',
        icon: <Users className="size-4 text-foreground-muted" />,
        action: () => openNewThread(),
      },
      {
        id: 'act-new-task',
        category: 'Actions',
        title: 'Create Task',
        subtitle: 'Add a new deliverable to Tasks & Issues',
        icon: <CheckSquare className="size-4 text-foreground-muted" />,
        action: () => setViewMode('tasks'),
      },
      {
        id: 'act-compact-context',
        category: 'Actions',
        title: 'Compact Context',
        subtitle: currentSessionId
          ? `Summarize & compact context for #${currentSessionId.replace(/^channel\//, '')}`
          : 'Compact active channel context window',
        icon: <Sparkles className="size-4 text-foreground-muted" />,
        action: async () => {
          if (!currentSessionId) {
            toast.error('Open a chat thread first to compact its context');
            return;
          }
          const raw = currentSessionId.replace(/^channel\//, '');
          try {
            toast.info(`Compacting context for #${raw}...`);
            const res = await workspaceApi.request<{ compacted_count?: number }>(
              `/v1/workspaces/${workspaceId || 'default'}/channels/${encodeURIComponent(raw)}/compact`,
              { method: 'POST' }
            );
            if (res?.compacted_count) {
              toast.success(`Compacted ${res.compacted_count} messages into a summary`);
            } else {
              toast.info('Context is already compact — nothing to summarize');
            }
          } catch (e: any) {
            toast.error(e?.message || 'Failed to compact context');
          }
        },
      },
      {
        id: 'act-token-dashboard',
        category: 'Actions',
        title: 'Token Dashboard',
        subtitle: 'Inspect workspace token consumption, limits & channel health',
        icon: <Activity className="size-4 text-foreground-muted" />,
        action: () => setActiveRightTab('tokens'),
      },
      {
        id: 'act-toggle-theme',
        category: 'Actions',
        title: `Switch Theme to ${theme === 'dark' ? 'Light' : 'Dark'}`,
        subtitle: 'Toggle workspace appearance',
        icon: theme === 'dark' ? <Sun className="size-4 text-foreground-muted" /> : <Moon className="size-4 text-foreground-muted" />,
        action: () => setTheme(theme === 'dark' ? 'light' : 'dark'),
      },
      {
        id: 'act-terminal',
        category: 'Actions',
        title: 'Toggle Terminal',
        subtitle: 'Open the agent interactive command console',
        icon: <Terminal className="size-4 text-foreground-muted" />,
        action: () => setActiveRightTab('terminal'),
      },
      {
        id: 'act-sidebar',
        category: 'Actions',
        title: 'Toggle Sidebar',
        subtitle: 'Collapse or restore the left column',
        icon: <PanelLeft className="size-4 text-foreground-muted" />,
        shortcut: shortcutKeys('sidebar'),
        action: () => sidebarToggle(),
      },
      {
        id: 'act-shortcuts',
        category: 'Actions',
        title: 'Keyboard Shortcuts',
        subtitle: 'Every binding the app listens for',
        icon: <Keyboard className="size-4 text-foreground-muted" />,
        shortcut: shortcutKeys('help'),
        action: () => window.dispatchEvent(new Event(SHORTCUTS_EVENT)),
      },
    ];

    const threadItems: CommandItem[] = (sessions || []).map((s) => {
      const channelTag = s.sessionId.replace(/^channel\//, '');
      const participantsStr = s.participants?.length ? ` • ${s.participants.map((p) => `@${p}`).join(', ')}` : '';
      return {
        id: `thread-${s.sessionId}`,
        category: 'Threads',
        title: s.title || `Thread #${channelTag}`,
        subtitle: `#${channelTag}${participantsStr}`,
        icon: <MessageSquare className="size-4 text-foreground-muted" />,
        action: () => {
          setCurrentSessionId(s.sessionId);
          setViewMode('threads');
          if (isMobile) openMobileDetail();
        },
      };
    });

    const fileItems: CommandItem[] = (files || []).map((f) => {
      const isCode = /\.(js|ts|tsx|jsx|py|go|rs|json|yaml|yml|sh|css|html|md)$/i.test(f.filename);
      const sizeKb = f.size > 0 ? `${(f.size / 1024).toFixed(1)} KB` : '';
      const channelInfo = f.channelName ? ` in #${f.channelName}` : '';
      return {
        id: `file-${f.id}`,
        category: 'Files',
        title: f.filename,
        subtitle: `${sizeKb || 'Workspace file'}${channelInfo}`,
        icon: isCode ? <FileCode className="size-4 text-foreground-muted" /> : <FileText className="size-4 text-foreground-muted" />,
        action: () => {
          setSelectedFileId(f.id);
          setViewMode('files');
          if (isMobile) openMobileDetail();
        },
      };
    });

    const taskItems: CommandItem[] = (todos || []).map((t) => {
      const statusLabel = t.status.replace('_', ' ');
      const priorityLabel = t.priority ? ` • ${t.priority}` : '';
      const channelInfo = t.channelName ? ` in #${t.channelName}` : '';
      return {
        id: `task-${t.id}`,
        category: 'Tasks',
        title: t.content,
        subtitle: `${t.id} • ${statusLabel}${priorityLabel}${channelInfo}`,
        icon: <CheckSquare className="size-4 text-foreground-muted" />,
        action: () => {
          setViewMode('tasks');
          if (isMobile) openMobileDetail();
        },
      };
    });

    const sortedAgents = [...agents].sort((a, b) => {
      if (a.status !== b.status) {
        return a.status === 'online' ? -1 : 1;
      }
      return a.agentName.localeCompare(b.agentName);
    });

    const agentItems: CommandItem[] = sortedAgents.map((agent) => ({
      id: `agent-${agent.agentName}`,
      category: 'Agents',
      title: `@${agent.agentName}`,
      subtitle: `${agent.status === 'online' ? '● Online' : '○ Offline'} — ${agent.description || 'AI Agent'}`,
      icon: <Bot className="size-4 text-foreground-muted" />,
      action: () => {
        openNewThread();
      },
    }));

    return {
      allCommands: [...actions, ...threadItems, ...fileItems, ...taskItems, ...nav, ...agentItems],
      defaultCommands: [...actions, ...threadItems.slice(0, 4), ...fileItems.slice(0, 4), ...taskItems.slice(0, 4), ...nav, ...agentItems],
    };
  }, [
    setViewMode,
    openSettings,
    openNewThread,
    setActiveRightTab,
    theme,
    setTheme,
    agents,
    sessions,
    files,
    todos,
    currentSessionId,
    workspaceId,
    setCurrentSessionId,
    setSelectedFileId,
    isMobile,
    openMobileDetail,
    createSession,
    sidebarToggle,
  ]);

  // Filter commands by query
  const filtered = useMemo(() => {
    if (!query.trim()) return defaultCommands;
    const q = query.toLowerCase();
    return allCommands.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        (item.subtitle && item.subtitle.toLowerCase().includes(q)) ||
        item.category.toLowerCase().includes(q)
    );
  }, [allCommands, defaultCommands, query]);

  // Handle arrow keys and enter
  const handleKeyDown = (e: React.KeyboardEvent) => {
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
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 sm:pt-28 px-4">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-xs transition-opacity animate-in fade-in-0 duration-150"
        onClick={() => setOpen(false)}
      />

      {/* Palette Container */}
      <div className="relative z-10 w-full max-w-xl rounded-2xl border border-border bg-surface1 text-foreground shadow-xl overflow-hidden animate-in fade-in-0 zoom-in-95 duration-150">
        {/* Search Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-surface1/95">
          <Search className="size-4 text-foreground-extra-muted shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="Type a command or search..."
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
          <div className="flex items-center gap-1.5 shrink-0 pl-3">
            <Kbd>ESC</Kbd>
          </div>
        </div>

        {/* Command List */}
        <div
          ref={listRef}
          id="command-palette-list"
          role="listbox"
          aria-label="Commands"
          className="max-h-96 overflow-y-auto p-2 space-y-1"
        >
          {filtered.length === 0 ? (
            <div className="py-12 text-center text-xs text-foreground-extra-muted">
              No matching commands found.
            </div>
          ) : (
            filtered.map((item, idx) => {
              const isSelected = idx === selectedIndex;
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
                    'group flex items-center justify-between px-3 py-2 rounded-xl text-xs cursor-pointer transition-colors select-none',
                    isSelected ? 'bg-surface2 text-foreground' : 'text-foreground-muted hover:bg-surface2/60'
                  )}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="p-1.5 rounded-lg bg-surface3 border border-border/60 shrink-0">
                      {item.icon}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className={cn('font-medium truncate', isSelected ? 'text-foreground' : 'text-foreground-muted')}>
                        {item.title}
                      </p>
                      {item.subtitle && (
                        <p className="text-3xs text-foreground-extra-muted truncate mt-0.5">
                          {item.subtitle}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Shortcuts or Category */}
                  <div className="flex items-center gap-2 shrink-0 ml-3">
                    {item.shortcut ? (
                      <div className="flex items-center gap-1">
                        {item.shortcut.map((k, i) => (
                          <Kbd key={i}>{k}</Kbd>
                        ))}
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

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2 bg-surface2/60 border-t border-border/60 text-3xs text-foreground-extra-muted font-medium">
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
          </div>
          <div className="flex items-center gap-1">
            <Sparkles className="size-3 text-primary" />
            <span>52hzAgents Palette</span>
          </div>
        </div>
      </div>
    </div>
  );
}
