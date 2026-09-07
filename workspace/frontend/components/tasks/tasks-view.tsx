'use client';

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowLeft,
  Filter,
  Hash,
  LayoutGrid,
  LayoutList,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { ScreenTitle } from '@/components/headers/screen-title';
import { cn } from '@/lib/utils';
import type { TodoItem, TodoPriority, TodoStatus } from '@/lib/types';
import { stripAddressPrefix } from '@/lib/types';
import { PrioritySelector, PriorityGlyph, PRIORITIES } from './priority-selector';
import { StatusSelector, StatusGlyph, ALL_STATUSES } from './status-selector';
import { TasksDisplayOptions, type TasksDisplaySettings } from './tasks-display-options';
import { TasksBoard } from './tasks-board';

const STATUS_LABEL: Record<TodoStatus, string> = {
  pending: 'Todo',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const DEFAULT_SETTINGS: TasksDisplaySettings = {
  viewType: 'list',
  grouping: 'status',
  ordering: 'position',
  showCompleted: true,
};

export function TasksView() {
  const {
    todos: allTodos,
    refreshTodos,
    replaceTodos,
    sessions,
    currentSessionId,
    currentUser,
  } = useWorkspace();
  const { setViewMode } = useLayout();

  const [searchQuery, setSearchQuery] = useState('');
  const [channelFilter, setChannelFilter] = useState<string>('all');
  const [displaySettings, setDisplaySettings] = useState<TasksDisplaySettings>(DEFAULT_SETTINGS);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TodoItem | null>(null);
  const [content, setContent] = useState('');
  const [assignee, setAssignee] = useState('');
  const [status, setStatus] = useState<TodoStatus>('pending');
  const [priority, setPriority] = useState<TodoPriority>('none');
  const [channel, setChannel] = useState('general');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const manualSource = `human:${currentUser.id || 'user'}`;

  const channels = useMemo(() => {
    const values = sessions
      .filter((session) => !session.sessionId.startsWith('routines:'))
      .map((session) => ({ id: session.sessionId, title: session.title || session.sessionId }));
    return values.length ? values : [{ id: 'general', title: 'General' }];
  }, [sessions]);

  useEffect(() => {
    void refreshTodos();
  }, [refreshTodos]);

  // Filter tasks by session/channel and search keyword
  const filteredTodos = useMemo(() => {
    let list = allTodos;

    // Filter by channel/session
    if (channelFilter !== 'all') {
      list = list.filter((t) => t.channelName === channelFilter);
    } else if (currentSessionId && !currentSessionId.startsWith('routines:')) {
      // If a session is actively focused and user didn't explicitly select 'all', filter to it
      list = list.filter((t) => t.channelName === currentSessionId);
    }

    // Filter completed if toggled off
    if (!displaySettings.showCompleted) {
      list = list.filter((t) => t.status !== 'completed' && t.status !== 'cancelled');
    }

    // Search query filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (t) =>
          t.content.toLowerCase().includes(q) ||
          (t.assignee && t.assignee.toLowerCase().includes(q)) ||
          (t.channelName && t.channelName.toLowerCase().includes(q))
      );
    }

    // Ordering
    const priorityWeight: Record<TodoPriority, number> = {
      urgent: 5,
      high: 4,
      medium: 3,
      low: 2,
      none: 1,
    };

    if (displaySettings.ordering === 'priority') {
      return [...list].sort(
        (a, b) => (priorityWeight[b.priority || 'none'] || 1) - (priorityWeight[a.priority || 'none'] || 1)
      );
    }
    if (displaySettings.ordering === 'created') {
      return [...list].sort(
        (a, b) =>
          new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
      );
    }

    return [...list].sort((a, b) => a.position - b.position);
  }, [allTodos, channelFilter, currentSessionId, displaySettings.showCompleted, displaySettings.ordering, searchQuery]);

  const openCreate = (initialChannel?: string, initialStatus?: TodoStatus) => {
    const selectedChannel =
      initialChannel && initialChannel !== 'general' && initialChannel !== 'all'
        ? initialChannel
        : currentSessionId && !currentSessionId.startsWith('routines:')
        ? currentSessionId
        : channels[0]?.id || 'general';

    setEditing(null);
    setContent('');
    setAssignee('');
    setStatus(initialStatus || 'pending');
    setPriority('none');
    setChannel(selectedChannel);
    setError(null);
    setDialogOpen(true);
  };

  const openEdit = (todo: TodoItem) => {
    setEditing(todo);
    setContent(todo.content);
    setAssignee(todo.assignee || '');
    setStatus(todo.status);
    setPriority(todo.priority || 'none');
    setChannel(todo.channelName || 'general');
    setError(null);
    setDialogOpen(true);
  };

  const saveForSourceAndChannel = async (
    source: string,
    channelName: string,
    updated: TodoItem[]
  ) => {
    setSaving(true);
    setError(null);
    try {
      const payload = updated.map((item, idx) => ({
        content: item.content,
        status: item.status,
        priority: item.priority || 'none',
        assignee: item.assignee,
        channelName: item.channelName,
        position: idx,
      }));
      await replaceTodos({
        source,
        channel: channelName,
        todos: payload,
      });
      setDialogOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save task');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveModal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;

    const source = editing ? editing.createdBy : manualSource;
    const targetChannel = channel.trim() || 'general';
    const group = allTodos.filter(
      (item) => item.createdBy === source && item.channelName === targetChannel
    );

    let nextList: TodoItem[];
    if (editing) {
      nextList = group.map((item) =>
        item.id === editing.id
          ? { ...item, content: content.trim(), assignee: assignee.trim(), status, priority, channelName: targetChannel }
          : item
      );
    } else {
      const created: TodoItem = {
        id: `todo-${Date.now()}`,
        content: content.trim(),
        status,
        priority,
        assignee: assignee.trim(),
        createdBy: source,
        channelName: targetChannel,
        threadId: targetChannel,
        position: group.length,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      nextList = [...group, created];
    }

    await saveForSourceAndChannel(source, targetChannel, nextList);
  };

  const updateStatus = async (todo: TodoItem, nextStatus: TodoStatus) => {
    const group = allTodos.filter(
      (item) => item.createdBy === todo.createdBy && item.channelName === todo.channelName
    );
    const updated = group.map((item) =>
      item.id === todo.id ? { ...item, status: nextStatus, updatedAt: new Date().toISOString() } : item
    );
    try {
      await saveForSourceAndChannel(todo.createdBy, todo.channelName, updated);
    } catch {
      void refreshTodos();
    }
  };

  const updatePriority = async (todo: TodoItem, nextPriority: TodoPriority) => {
    const group = allTodos.filter(
      (item) => item.createdBy === todo.createdBy && item.channelName === todo.channelName
    );
    const updated = group.map((item) =>
      item.id === todo.id ? { ...item, priority: nextPriority, updatedAt: new Date().toISOString() } : item
    );
    try {
      await saveForSourceAndChannel(todo.createdBy, todo.channelName, updated);
    } catch {
      void refreshTodos();
    }
  };

  const deleteTask = async (todo: TodoItem) => {
    const group = allTodos.filter(
      (item) => item.createdBy === todo.createdBy && item.channelName === todo.channelName && item.id !== todo.id
    );
    try {
      await saveForSourceAndChannel(todo.createdBy, todo.channelName, group);
    } catch {
      void refreshTodos();
    }
  };

  const reorderTask = async (todo: TodoItem, direction: -1 | 1) => {
    const group = filteredTodos.filter(
      (item) => item.createdBy === todo.createdBy && item.channelName === todo.channelName
    );
    const index = group.findIndex((item) => item.id === todo.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= group.length) return;
    const reordered = [...group];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    try {
      await saveForSourceAndChannel(todo.createdBy, todo.channelName, reordered);
    } catch {
      void refreshTodos();
    }
  };

  // Grouping for List View
  const listGroups = useMemo(() => {
    const grouping = displaySettings.grouping;

    if (grouping === 'status') {
      return [
        {
          id: 'in_progress',
          title: 'In Progress',
          glyph: <StatusGlyph status="in_progress" className="size-3.5" />,
          items: filteredTodos.filter((t) => t.status === 'in_progress'),
        },
        {
          id: 'pending',
          title: 'Todo',
          glyph: <StatusGlyph status="pending" className="size-3.5" />,
          items: filteredTodos.filter((t) => t.status === 'pending'),
        },
        {
          id: 'completed',
          title: 'Completed',
          glyph: <StatusGlyph status="completed" className="size-3.5" />,
          items: filteredTodos.filter((t) => t.status === 'completed' || t.status === 'cancelled'),
        },
      ];
    }

    if (grouping === 'assignee') {
      const assignees = Array.from(new Set(filteredTodos.map((t) => t.assignee || 'Unassigned')));
      return assignees.map((assignee) => ({
        id: assignee,
        title: assignee,
        glyph: <User className="size-3.5 text-foreground-muted" />,
        items: filteredTodos.filter((t) => (t.assignee || 'Unassigned') === assignee),
      }));
    }

    if (grouping === 'channel') {
      const chs = Array.from(new Set(filteredTodos.map((t) => t.channelName || 'general')));
      return chs.map((ch) => ({
        id: ch,
        title: ch,
        glyph: <Hash className="size-3.5 text-foreground-muted" />,
        items: filteredTodos.filter((t) => (t.channelName || 'general') === ch),
      }));
    }

    // None
    return [
      {
        id: 'all',
        title: 'All Tasks',
        glyph: null,
        items: filteredTodos,
      },
    ];
  }, [filteredTodos, displaySettings.grouping]);

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden">
      {/* ── Top Header Toolbar ── */}
      {/*
        `.app-header` is a single fixed-height row and does not wrap, so
        everything in it has to fit. This header previously relied on
        `flex-wrap` and had eight controls plus a 240px search field: back,
        title, count, search, List/Board, Display, refresh, New Task. At 1180px
        that overflowed — the back button broke onto two lines and New Task was
        cut off at the window edge.

        The back button is icon-only (it is an arrow; the words repeated it),
        the count moved into the title's own row, and search is the one thing
        allowed to give up width.
      */}
      <div className="app-header justify-between px-6">
        <div className="flex items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() => setViewMode('threads')}
            className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-surface2/60 text-foreground-muted hover:bg-surface2 hover:text-foreground transition-colors"
            title="Back to Chats"
            aria-label="Back to Chats"
          >
            <ArrowLeft className="size-3.5" />
          </button>
          <ScreenTitle>Tasks</ScreenTitle>
          <span className="text-2xs font-mono font-medium text-foreground-extra-muted bg-surface2 px-2 py-0.5 rounded-full border border-border/50">
            {filteredTodos.length}
          </span>
        </div>

        {/* Action Controls */}
        <div className="flex min-w-0 items-center gap-2">
          {/* Quick Search — the only flexible element in the row. */}
          <div className="relative min-w-0 flex-1 basis-32 sm:basis-52 lg:basis-60">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-foreground-extra-muted" />
            <input
              type="text"
              placeholder="Search tasks..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full h-8 pl-8 pr-7 text-xs rounded-lg border border-border/70 bg-surface2/60 text-foreground placeholder:text-foreground-extra-muted focus:outline-none focus:ring-1 focus:ring-ring transition-colors"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-foreground-extra-muted hover:text-foreground"
              >
                <X className="size-3" />
              </button>
            )}
          </div>

          {/* Direct List / Board Segmented Switcher */}
          <div className="flex shrink-0 items-center p-0.5 bg-surface2/80 rounded-lg border border-border/60">
            <button
              type="button"
              onClick={() => setDisplaySettings((prev) => ({ ...prev, viewType: 'list' }))}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all cursor-pointer',
                displaySettings.viewType === 'list'
                  ? 'bg-background text-foreground shadow-xs font-semibold'
                  : 'text-foreground-muted hover:text-foreground'
              )}
              title="List View (List)"
            >
              <LayoutList className="size-3.5" />
              <span>List</span>
            </button>
            <button
              type="button"
              onClick={() => setDisplaySettings((prev) => ({ ...prev, viewType: 'board' }))}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all cursor-pointer',
                displaySettings.viewType === 'board'
                  ? 'bg-background text-foreground shadow-xs font-semibold'
                  : 'text-foreground-muted hover:text-foreground'
              )}
              title="Board Kanban View (Board)"
            >
              <LayoutGrid className="size-3.5" />
              <span>Board</span>
            </button>
          </div>

          {/* Display Popover */}
          <TasksDisplayOptions
            className="shrink-0"
            settings={displaySettings}
            onChange={(updated) => setDisplaySettings((prev) => ({ ...prev, ...updated }))}
            onReset={() => setDisplaySettings(DEFAULT_SETTINGS)}
          />

          {/* Refresh Button */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refreshTodos()}
            className="h-8 w-8 shrink-0 p-0 bg-surface1/60 hover:bg-surface2"
            title="Refresh tasks"
          >
            <RefreshCw className="size-3.5 text-foreground-muted" />
          </Button>

          {/* New Task Button */}
          <Button
            size="sm"
            onClick={() => openCreate()}
            className="h-8 shrink-0 gap-1.5 px-3 text-xs font-medium shadow-xs"
          >
            <Plus className="size-3.5" />
            <span>New Task</span>
          </Button>
        </div>
      </div>

      {/* ── Main View Container ── */}
      <div className="flex-1 overflow-y-auto">
        {displaySettings.viewType === 'board' ? (
          /* Kanban Board View */
          <TasksBoard
            tasks={filteredTodos}
            grouping={displaySettings.grouping}
            onUpdateStatus={(todo, newStatus) => void updateStatus(todo, newStatus)}
            onUpdatePriority={(todo, newPriority) => void updatePriority(todo, newPriority)}
            onEdit={openEdit}
            onDelete={(todo) => void deleteTask(todo)}
            onQuickCreate={(groupVal) =>
              openCreate(
                displaySettings.grouping === 'channel' ? groupVal : undefined,
                displaySettings.grouping === 'status' ? (groupVal as TodoStatus) : undefined
              )
            }
            manualSource={manualSource}
          />
        ) : (
          /* Linear-style List View */
          <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-6">
            {filteredTodos.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64 text-center rounded-xl border border-dashed border-border/70 p-8 space-y-2">
                <p className="text-sm font-medium text-foreground">No tasks found</p>
                <p className="text-xs text-foreground-extra-muted max-w-sm">
                  {searchQuery
                    ? 'No tasks match your current search or filter.'
                    : 'Create your first task or let agents track deliverables automatically.'}
                </p>
                <Button size="sm" onClick={() => openCreate()} className="mt-3 gap-1.5 text-xs">
                  <Plus className="size-3.5" />
                  Create Task
                </Button>
              </div>
            ) : (
              listGroups.map((group) => {
                if (group.items.length === 0) return null;
                return (
                  <section key={group.id} className="space-y-2">
                    {/* Group Header */}
                    <div className="flex items-center justify-between px-1">
                      <div className="flex items-center gap-2">
                        {group.glyph}
                        <h3 className="text-xs font-semibold text-foreground tracking-tight">
                          {group.title}
                        </h3>
                        <span className="text-2xs font-mono font-medium text-foreground-extra-muted bg-surface2 px-1.5 py-0.2 rounded-full border border-border/40">
                          {group.items.length}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          openCreate(
                            displaySettings.grouping === 'channel' ? group.id : undefined,
                            displaySettings.grouping === 'status' ? (group.id as TodoStatus) : undefined
                          )
                        }
                        className="p-1 text-foreground-extra-muted hover:text-foreground hover:bg-surface2 rounded transition-colors"
                        title={`Add task to ${group.title}`}
                      >
                        <Plus className="size-3.5" />
                      </button>
                    </div>

                    {/* Linear-style IssueLine List Container */}
                    <div className="overflow-hidden rounded-xl border border-border/80 bg-surface1/60 divide-y divide-border/60 shadow-xs">
                      {group.items.map((todo) => {
                        const isManual = todo.createdBy === manualSource;
                        return (
                          <div
                            key={todo.id}
                            className="group flex items-center gap-3 px-4 py-2.5 hover:bg-surface2/60 transition-colors"
                          >
                            {/* Inline Priority Selector */}
                            <PrioritySelector
                              priority={todo.priority}
                              size="sm"
                              onChange={(p) => void updatePriority(todo, p)}
                            />

                            {/* Inline Status Selector */}
                            <StatusSelector
                              status={todo.status}
                              size="sm"
                              onChange={(s) => void updateStatus(todo, s)}
                            />

                            {/* Task Position ID */}
                            <span className="text-2xs font-mono font-medium text-foreground-extra-muted w-10 shrink-0 hidden sm:inline-block">
                              #{todo.position || todo.id.slice(-4)}
                            </span>

                            {/* Content */}
                            <div className="min-w-0 flex-1">
                              <p
                                className={cn(
                                  'text-sm font-medium leading-snug truncate text-foreground',
                                  todo.status === 'in_progress' && 'event-running',
                                  (todo.status === 'completed' || todo.status === 'cancelled') &&
                                    'line-through text-foreground-extra-muted'
                                )}
                              >
                                {todo.content}
                              </p>
                            </div>

                            {/* Linear Stacked Badges with Hover Fan-Out */}
                            <div className="flex items-center -space-x-3 hover:space-x-1.5 transition-all duration-200 shrink-0">
                              {todo.channelName && (
                                <span
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface2 border border-border/60 text-3xs font-medium text-foreground-muted truncate max-w-[120px]"
                                  title={`Channel: ${todo.channelName}`}
                                >
                                  <Hash className="size-2.5 text-foreground-extra-muted shrink-0" />
                                  {todo.channelName}
                                </span>
                              )}
                              {todo.assignee && (
                                <span
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface2 border border-border/60 text-3xs font-medium text-foreground-muted truncate max-w-[110px]"
                                  title={`Assigned to: ${todo.assignee}`}
                                >
                                  <User className="size-2.5 text-foreground-extra-muted shrink-0" />
                                  {todo.assignee}
                                </span>
                              )}
                              <span
                                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface2 border border-border/60 text-3xs text-foreground-extra-muted shrink-0 hidden md:inline-flex"
                                title={todo.createdAt ? new Date(todo.createdAt).toLocaleString() : ''}
                              >
                                {timeAgo(todo.updatedAt || todo.createdAt)}
                              </span>
                            </div>

                            {/* Actions on hover */}
                            <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                              {isManual && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => openEdit(todo)}
                                    className="p-1 rounded text-foreground-extra-muted hover:bg-surface3 hover:text-foreground transition-colors"
                                    title="Edit task"
                                  >
                                    <Pencil className="size-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void reorderTask(todo, -1)}
                                    className="p-1 rounded text-foreground-extra-muted hover:bg-surface3 hover:text-foreground transition-colors"
                                    title="Move up"
                                  >
                                    <ArrowUp className="size-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void reorderTask(todo, 1)}
                                    className="p-1 rounded text-foreground-extra-muted hover:bg-surface3 hover:text-foreground transition-colors"
                                    title="Move down"
                                  >
                                    <ArrowDown className="size-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void deleteTask(todo)}
                                    className="p-1 rounded text-foreground-extra-muted hover:bg-surface3 hover:text-destructive transition-colors"
                                    title="Delete task"
                                  >
                                    <Trash2 className="size-3.5" />
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* ── Create / Edit Task Dialog ── */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleSaveModal} className="space-y-4">
            <div>
              <DialogTitle className="text-base font-semibold">
                {editing ? 'Edit Task' : 'New Task'}
              </DialogTitle>
              <DialogDescription className="text-xs text-foreground-extra-muted mt-0.5">
                {editing
                  ? 'Update task content, status, priority, or assignment.'
                  : 'Add a new deliverable to your workspace.'}
              </DialogDescription>
            </div>

            {error && (
              <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-2.5 text-xs text-destructive">
                {error}
              </div>
            )}

            <div className="space-y-3 text-xs">
              <div className="space-y-1">
                <label className="font-medium text-foreground-muted">Task Description</label>
                <Input
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="What needs to be done?"
                  required
                  autoFocus
                  className="text-xs h-9"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="font-medium text-foreground-muted">Priority</label>
                  <div className="flex items-center gap-1.5 p-1 rounded-lg border border-border/70 bg-surface2/60">
                    <PrioritySelector priority={priority} onChange={setPriority} />
                    <span className="text-xs font-medium text-foreground capitalize">{priority}</span>
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="font-medium text-foreground-muted">Status</label>
                  <div className="flex items-center gap-1.5 p-1 rounded-lg border border-border/70 bg-surface2/60">
                    <StatusSelector status={status} onChange={setStatus} />
                    <span className="text-xs font-medium text-foreground">{STATUS_LABEL[status]}</span>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="font-medium text-foreground-muted">Assignee</label>
                  <Input
                    value={assignee}
                    onChange={(e) => setAssignee(e.target.value)}
                    placeholder="agent or user name"
                    className="text-xs h-8"
                  />
                </div>

                <div className="space-y-1">
                  <label className="font-medium text-foreground-muted">Channel / Session</label>
                  <Input
                    value={channel}
                    onChange={(e) => setChannel(e.target.value)}
                    placeholder="general"
                    className="text-xs h-8"
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-border/60">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDialogOpen(false)}
                className="text-xs h-8"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={saving || !content.trim()}
                className="text-xs h-8"
              >
                {saving ? 'Saving...' : editing ? 'Save Changes' : 'Create Task'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
