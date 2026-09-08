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
} from 'lucide-react';
import { cn } from '@/lib/utils';

function KeyBadge({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-5 h-5 px-1 rounded border border-border/80 bg-surface2 font-mono text-3xs text-foreground-extra-muted">
      {children}
    </kbd>
  );
}

interface CommandItem {
  id: string;
  category: 'Navigation' | 'Actions' | 'Agents';
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

  const { setViewMode, openSettings, openNewThread, setActiveRightTab } = useLayout();
  const { agents, currentSessionId, currentUser } = useWorkspace();
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

  const execute = useCallback((item: CommandItem) => {
    setOpen(false);
    item.action();
  }, []);

  // Build command list
  const allCommands: CommandItem[] = useMemo(() => {
    const nav: CommandItem[] = [
      {
        id: 'nav-threads',
        category: 'Navigation',
        title: 'Threads & Conversations',
        subtitle: 'Switch to chat and multi-agent channels',
        icon: <MessageSquare className="size-4 text-primary" />,
        shortcut: ['G', 'T'],
        action: () => setViewMode('threads'),
      },
      {
        id: 'nav-tasks',
        category: 'Navigation',
        title: 'Tasks & Issues',
        subtitle: 'Linear-style task tracking and Kanban board',
        icon: <CheckSquare className="size-4 text-emerald-500" />,
        shortcut: ['G', 'A'],
        action: () => setViewMode('tasks'),
      },
      {
        id: 'nav-mission',
        category: 'Navigation',
        title: 'Mission Control',
        subtitle: 'Agent radar and orchestration topology',
        icon: <Compass className="size-4 text-blue-500" />,
        shortcut: ['G', 'M'],
        action: () => setViewMode('mission'),
      },
      {
        id: 'nav-skills',
        category: 'Navigation',
        title: 'Skills & Capabilities',
        subtitle: 'Manage agent tools and capabilities',
        icon: <Sparkles className="size-4 text-yellow-500" />,
        action: () => setViewMode('skills'),
      },
      {
        id: 'nav-files',
        category: 'Navigation',
        title: 'Files & Workspace Artifacts',
        subtitle: 'Browse files and diffs',
        icon: <Folder className="size-4 text-amber-500" />,
        action: () => setViewMode('files'),
      },
      {
        id: 'nav-knowledge',
        category: 'Navigation',
        title: 'Knowledge Base',
        subtitle: 'Manage workspace memories and documents',
        icon: <BookOpen className="size-4 text-purple-500" />,
        action: () => setViewMode('knowledge'),
      },
      {
        id: 'nav-browser',
        category: 'Navigation',
        title: 'Agent Browser',
        subtitle: 'Watch and control automated browser instances',
        icon: <Globe className="size-4 text-cyan-500" />,
        action: () => setViewMode('browser'),
      },
      {
        id: 'nav-routines',
        category: 'Navigation',
        title: 'Routines & Automation',
        subtitle: 'Scheduled and recurring cron tasks',
        icon: <Repeat className="size-4 text-rose-500" />,
        action: () => setViewMode('routines'),
      },
      {
        id: 'nav-timers',
        category: 'Navigation',
        title: 'Timers & Reminders',
        subtitle: 'One-shot agent timers',
        icon: <Timer className="size-4 text-orange-400" />,
        action: () => setViewMode('timers'),
      },
      {
        id: 'nav-inbox',
        category: 'Navigation',
        title: 'Inbox & Approvals',
        subtitle: 'Review agent notifications and approvals',
        icon: <Inbox className="size-4 text-indigo-400" />,
        action: () => setViewMode('inbox'),
      },
      {
        id: 'nav-connect',
        category: 'Navigation',
        title: 'Connect Agents',
        subtitle: 'Add CLI agents (Claude Code, OpenClaw, Pi, etc.)',
        icon: <Radio className="size-4 text-emerald-400" />,
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
      {
        id: 'act-new-thread',
        category: 'Actions',
        title: 'New Thread',
        subtitle: 'Start a new multi-agent conversation',
        icon: <Plus className="size-4 text-primary" />,
        shortcut: ['C'],
        action: () => openNewThread(),
      },
      {
        id: 'act-new-task',
        category: 'Actions',
        title: 'Create Task',
        subtitle: 'Add a new deliverable to Tasks & Issues',
        icon: <CheckSquare className="size-4 text-emerald-500" />,
        action: () => setViewMode('tasks'),
      },
      {
        id: 'act-toggle-theme',
        category: 'Actions',
        title: `Switch Theme to ${theme === 'dark' ? 'Light' : 'Dark'}`,
        subtitle: 'Toggle workspace appearance',
        icon: theme === 'dark' ? <Sun className="size-4 text-yellow-400" /> : <Moon className="size-4 text-indigo-400" />,
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
    ];

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
      icon: <Bot className="size-4 text-primary" />,
      action: () => {
        openNewThread();
      },
    }));

    return [...actions, ...nav, ...agentItems];
  }, [setViewMode, openSettings, openNewThread, setActiveRightTab, theme, setTheme, agents]);

  // Filter commands by query
  const filtered = useMemo(() => {
    if (!query.trim()) return allCommands;
    const q = query.toLowerCase();
    return allCommands.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        (item.subtitle && item.subtitle.toLowerCase().includes(q)) ||
        item.category.toLowerCase().includes(q)
    );
  }, [allCommands, query]);

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
      <div className="relative z-10 w-full max-w-xl rounded-2xl border border-border/80 bg-surface1 text-foreground shadow-2xl overflow-hidden animate-in fade-in-0 zoom-in-95 duration-150">
        {/* Search Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border/70 bg-surface1/95">
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
          <div className="flex items-center gap-1.5 shrink-0 pl-2 border-l border-border/60">
            <KeyBadge>ESC</KeyBadge>
          </div>
        </div>

        {/* Command List */}
        <div ref={listRef} className="max-h-96 overflow-y-auto p-2 divide-y divide-border/30 space-y-1">
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
                  onClick={() => execute(item)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  className={cn(
                    'group flex items-center justify-between px-3 py-2 rounded-xl text-xs cursor-pointer transition-colors select-none',
                    isSelected ? 'bg-surface2 text-foreground' : 'text-foreground-muted hover:bg-surface2/60'
                  )}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <div className="p-1.5 rounded-lg bg-surface3 border border-border/50 shrink-0">
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
                          <KeyBadge key={i}>{k}</KeyBadge>
                        ))}
                      </div>
                    ) : (
                      <span className="text-3xs text-foreground-extra-muted px-1.5 py-0.5 rounded bg-surface3 border border-border/40">
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
              <KeyBadge>↑</KeyBadge>
              <KeyBadge>↓</KeyBadge>
              Navigate
            </span>
            <span className="flex items-center gap-1">
              <KeyBadge>↵</KeyBadge>
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
