'use client';

import { Hint } from '@/components/ui/hint';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowLeft,
  CalendarClock,
  Globe,
  Hash,
  History,
  LayoutGrid,
  LayoutList,
  ListTodo,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  TriangleAlert,
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
import type { RoutineItem, TodoItem, TodoPriority, TodoStatus } from '@/lib/types';
import { formatAbsolute, timeAgo } from '@/lib/schedule-format';
import { PrioritySelector } from './priority-selector';
import { StatusSelector, StatusGlyph } from './status-selector';
import { TasksDisplayOptions, type TasksDisplaySettings } from './tasks-display-options';
import { TasksBoard } from './tasks-board';
import { SchedulesView } from './schedules-view';
import { RunsView } from './runs-view';

const STATUS_LABEL: Record<TodoStatus, string> = {
  pending: 'Todo',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

const PRIORITY_WEIGHT: Record<TodoPriority, number> = {
  urgent: 5,
  high: 4,
  medium: 3,
  low: 2,
  none: 1,
};

const DEFAULT_SETTINGS: TasksDisplaySettings = {
  viewType: 'list',
  grouping: 'status',
  ordering: 'position',
  showCompleted: true,
};

/**
 * Which slice of the workspace the list shows.
 *
 * This used to be implicit: an unused `channelFilter` state defaulted to 'all',
 * but the branch it never reached silently narrowed the list to the focused
 * chat. So a task created from a different channel — every task a scheduled
 * routine files, which lives in `routines:<agent>` — was simply absent, with no
 * control anywhere to widen the view. The choice is now explicit and visible.
 */
type TaskScope = 'channel' | 'workspace';

/** True for a task past its due date and not yet closed. */
function isOverdue(todo: TodoItem, now: number): boolean {
  if (!todo.dueDate) return false;
  if (todo.status === 'completed' || todo.status === 'cancelled') return false;
  const due = new Date(todo.dueDate).getTime();
  return Number.isFinite(due) && due < now;
}

/** Resolves failure or cancellation reason if a task is cancelled or has an error. */
export function getTaskFailureReason(todo: TodoItem, routines?: RoutineItem[]): string | null {
  if (todo.error && todo.error.trim()) {
    return todo.error.trim();
  }
  if (todo.routineId && routines && routines.length > 0) {
    const matched = routines.find((r) => r.id === todo.routineId);
    if (matched?.lastRunError && matched.lastRunError.trim()) {
      return matched.lastRunError.trim();
    }
  }
  if (todo.status === 'cancelled') {
    return todo.timerId ? 'Reminder cancelled before it fired' : 'Task cancelled';
  }
  return null;
}

/** Short, stable reference for a row. */
function taskRef(todo: TodoItem): string {
  // Routine trackers already carry a meaningful id (TASK-RTN-001-3); keep it.
  if (todo.id.startsWith('TASK-')) return todo.id.replace(/^TASK-/, '');
  return todo.id.slice(-4).toUpperCase();
}

function toDateInputValue(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

export function TasksView() {
  const {
    todos: allTodos,
    refreshTodos,
    createTodo,
    updateTodo,
    deleteTodo,
    routines,
    currentSessionId,
    currentUser,
  } = useWorkspace();
  const { setViewMode } = useLayout();

  const [activeSubTab, setActiveSubTab] = useState<'tasks' | 'schedules' | 'runs'>('tasks');
  const [searchQuery, setSearchQuery] = useState('');
  const [scope, setScope] = useState<TaskScope>('workspace');
  const [displaySettings, setDisplaySettings] = useState<TasksDisplaySettings>(DEFAULT_SETTINGS);
  const [now, setNow] = useState(() => Date.now());

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TodoItem | null>(null);
  const [content, setContent] = useState('');
  const [assignee, setAssignee] = useState('');
  const [status, setStatus] = useState<TodoStatus>('pending');
  const [priority, setPriority] = useState<TodoPriority>('none');
  const [channel, setChannel] = useState('general');
  const [dueDate, setDueDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const manualSource = `human:${currentUser.id || 'user'}`;
  const activeChannel =
    currentSessionId && !currentSessionId.startsWith('routines:') ? currentSessionId : null;

  useEffect(() => {
    void refreshTodos();
  }, [refreshTodos]);

  // "Overdue" and "3m ago" are time-dependent; refresh them on a slow tick
  // rather than only when the list happens to re-render.
  useEffect(() => {
    const tick = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      setNow(Date.now());
    }, 30_000);
    return () => clearInterval(tick);
  }, []);

  const filteredTodos = useMemo(() => {
    let list = allTodos;

    if (scope === 'channel' && activeChannel) {
      list = list.filter((t) => t.channelName === activeChannel);
    }

    if (!displaySettings.showCompleted) {
      list = list.filter((t) => t.status !== 'completed' && t.status !== 'cancelled');
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (t) =>
          t.content.toLowerCase().includes(q) ||
          (t.assignee && t.assignee.toLowerCase().includes(q)) ||
          (t.channelName && t.channelName.toLowerCase().includes(q))
      );
    }

    if (displaySettings.ordering === 'priority') {
      return [...list].sort(
        (a, b) => (PRIORITY_WEIGHT[b.priority || 'none'] || 1) - (PRIORITY_WEIGHT[a.priority || 'none'] || 1)
      );
    }
    if (displaySettings.ordering === 'created') {
      return [...list].sort(
        (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
      );
    }

    // Position is only unique within one author's list, so break ties on
    // creation order — otherwise rows shuffle between renders.
    return [...list].sort(
      (a, b) =>
        a.position - b.position ||
        new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
    );
  }, [allTodos, scope, activeChannel, displaySettings.showCompleted, displaySettings.ordering, searchQuery]);

  const overdueCount = useMemo(
    () => filteredTodos.filter((t) => isOverdue(t, now)).length,
    [filteredTodos, now]
  );

  const openCreate = (initialChannel?: string, initialStatus?: TodoStatus) => {
    const selectedChannel =
      initialChannel && initialChannel !== 'all'
        ? initialChannel
        : activeChannel || 'general';

    setEditing(null);
    setContent('');
    setAssignee('');
    setStatus(initialStatus || 'pending');
    setPriority('none');
    setChannel(selectedChannel);
    setDueDate('');
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
    setDueDate(toDateInputValue(todo.dueDate));
    setError(null);
    setDialogOpen(true);
  };

  const handleSaveModal = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!content.trim()) return;

    setSaving(true);
    setError(null);
    try {
      const due = dueDate ? new Date(`${dueDate}T23:59:59`).toISOString() : null;
      if (editing) {
        // A single-row update: the task keeps its id, its author and its link to
        // any routine run that created it.
        await updateTodo(editing.id, {
          content: content.trim(),
          assignee: assignee.trim(),
          status,
          priority,
          dueDate: due,
        });
      } else {
        await createTodo({
          source: manualSource,
          channel: channel.trim() || 'general',
          todo: {
            content: content.trim(),
            status,
            priority,
            assignee: assignee.trim(),
            ...(due ? { dueDate: due } : {}),
          },
        });
      }
      setDialogOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save task');
    } finally {
      setSaving(false);
    }
  };

  const mutate = async (label: string, action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : label);
    }
  };

  const updateStatus = (todo: TodoItem, nextStatus: TodoStatus) =>
    mutate('The status could not be saved', () => updateTodo(todo.id, { status: nextStatus }));

  const updatePriority = (todo: TodoItem, nextPriority: TodoPriority) =>
    mutate('The priority could not be saved', () => updateTodo(todo.id, { priority: nextPriority }));

  const removeTask = (todo: TodoItem) =>
    mutate('The task could not be deleted', () => deleteTodo(todo.id));

  /**
   * Swaps a task with its neighbour inside the same author's list.
   *
   * Reordering used to re-PUT the author's whole list, which minted new ids for
   * every row it touched. Two position writes do the same job.
   */
  const reorderTask = (todo: TodoItem, direction: -1 | 1) => {
    const siblings = filteredTodos.filter(
      (item) => item.createdBy === todo.createdBy && item.channelName === todo.channelName
    );
    const index = siblings.findIndex((item) => item.id === todo.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= siblings.length) return Promise.resolve();
    const neighbour = siblings[target];
    return mutate('The task could not be reordered', () =>
      Promise.all([
        updateTodo(todo.id, { position: neighbour.position }),
        updateTodo(neighbour.id, { position: todo.position }),
      ])
    );
  };

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
      return assignees.map((name) => ({
        id: name,
        title: name,
        glyph: <User className="size-3.5 text-foreground-muted" />,
        items: filteredTodos.filter((t) => (t.assignee || 'Unassigned') === name),
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
      {/* ── Top Header Toolbar ──
          `.app-header` is a single fixed-height row that does not wrap, so
          everything in it has to fit: the back button is icon-only, and search
          is the one element allowed to give up width. */}
      <div className="app-header justify-between px-6">
        <div className="flex items-center gap-3 shrink-0">
          <Hint label="Back to Chats">
            <button
              type="button"
              onClick={() => setViewMode('threads')}
              className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-surface2/60 text-foreground-muted hover:bg-surface2 hover:text-foreground transition-colors"
              aria-label="Back to Chats"
            >
              <ArrowLeft className="size-3.5" />
            </button>
          </Hint>
          <ScreenTitle>Tasks &amp; Issues</ScreenTitle>

          {/* Sub-tab Navigation */}
          <div className="flex items-center p-0.5 bg-surface2/80 rounded-lg border border-border/60 ml-1">
            <button
              type="button"
              onClick={() => setActiveSubTab('tasks')}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all cursor-pointer',
                activeSubTab === 'tasks'
                  ? 'bg-background text-foreground shadow-xs font-semibold'
                  : 'text-foreground-muted hover:text-foreground'
              )}
            >
              <ListTodo className="size-3.5" />
              <span>Tasks</span>
              <span className="text-2xs font-mono font-medium text-foreground-extra-muted bg-surface2 px-1.5 py-0.2 rounded-full border border-border/60">
                {filteredTodos.length}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setActiveSubTab('schedules')}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all cursor-pointer',
                activeSubTab === 'schedules'
                  ? 'bg-background text-foreground shadow-xs font-semibold'
                  : 'text-foreground-muted hover:text-foreground'
              )}
            >
              <CalendarClock className="size-3.5" />
              <span>Schedules</span>
              <span className="text-2xs font-mono font-medium text-foreground-extra-muted bg-surface2 px-1.5 py-0.2 rounded-full border border-border/60">
                {routines.length}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setActiveSubTab('runs')}
              className={cn(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all cursor-pointer',
                activeSubTab === 'runs'
                  ? 'bg-background text-foreground shadow-xs font-semibold'
                  : 'text-foreground-muted hover:text-foreground'
              )}
            >
              <History className="size-3.5" />
              <span>Runs</span>
            </button>
          </div>
        </div>

        {/* Action Controls for Tasks subtab */}
        {activeSubTab === 'tasks' && (
          <div className="flex min-w-0 items-center gap-2">
            {/* Quick Search — the only flexible element in the row. */}
            <div className="relative min-w-0 flex-1 basis-28 sm:basis-44 lg:basis-52">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-foreground-extra-muted" />
              <input
                type="text"
                placeholder="Search tasks..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full h-8 pl-8 pr-7 text-xs rounded-lg border border-border bg-surface2/60 text-foreground placeholder:text-foreground-extra-muted focus:outline-none focus:ring-1 focus:ring-ring transition-colors"
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

            {/* Scope: everything in the workspace, or just the focused chat. */}
            {activeChannel && (
              <div className="flex shrink-0 items-center p-0.5 bg-surface2/80 rounded-lg border border-border/60">
                <Hint label="Show every task in this workspace">
                  <button
                    type="button"
                    onClick={() => setScope('workspace')}
                    className={cn(
                      'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-all cursor-pointer',
                      scope === 'workspace'
                        ? 'bg-background text-foreground shadow-xs font-semibold'
                        : 'text-foreground-muted hover:text-foreground'
                    )}
                  >
                    <Globe className="size-3.5" />
                    <span>All</span>
                  </button>
                </Hint>
                <Hint label={`Show only tasks from ${activeChannel}`}>
                  <button
                    type="button"
                    onClick={() => setScope('channel')}
                    className={cn(
                      'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-all cursor-pointer',
                      scope === 'channel'
                        ? 'bg-background text-foreground shadow-xs font-semibold'
                        : 'text-foreground-muted hover:text-foreground'
                    )}
                  >
                    <MessageSquare className="size-3.5" />
                    <span>This chat</span>
                  </button>
                </Hint>
              </div>
            )}

            {/* Direct List / Board Segmented Switcher */}
            <div className="flex shrink-0 items-center p-0.5 bg-surface2/80 rounded-lg border border-border/60">
              <Hint label="List view">
                <button
                  type="button"
                  onClick={() => setDisplaySettings((prev) => ({ ...prev, viewType: 'list' }))}
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all cursor-pointer',
                    displaySettings.viewType === 'list'
                      ? 'bg-background text-foreground shadow-xs font-semibold'
                      : 'text-foreground-muted hover:text-foreground'
                  )}
                >
                  <LayoutList className="size-3.5" />
                  <span>List</span>
                </button>
              </Hint>
              <Hint label="Board view">
                <button
                  type="button"
                  onClick={() => setDisplaySettings((prev) => ({ ...prev, viewType: 'board' }))}
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium transition-all cursor-pointer',
                    displaySettings.viewType === 'board'
                      ? 'bg-background text-foreground shadow-xs font-semibold'
                      : 'text-foreground-muted hover:text-foreground'
                  )}
                >
                  <LayoutGrid className="size-3.5" />
                  <span>Board</span>
                </button>
              </Hint>
            </div>

            {/* Display Popover */}
            <TasksDisplayOptions
              className="shrink-0"
              settings={displaySettings}
              onChange={(updated) => setDisplaySettings((prev) => ({ ...prev, ...updated }))}
              onReset={() => setDisplaySettings(DEFAULT_SETTINGS)}
            />

            {/* Refresh Button */}
            <Hint label="Refresh tasks">
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refreshTodos()}
                className="h-8 w-8 shrink-0 p-0 bg-surface1/60 hover:bg-surface2"
              >
                <RefreshCw className="size-3.5 text-foreground-muted" />
              </Button>
            </Hint>

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
        )}
      </div>

      {/* ── Main View Container ── */}
      {activeSubTab === 'schedules' ? (
        <SchedulesView />
      ) : activeSubTab === 'runs' ? (
        <RunsView />
      ) : (
        <div className="flex-1 overflow-y-auto">
          {actionError && (
            <div className="mx-4 mt-4 flex items-start justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive sm:mx-6">
              <span>{actionError}</span>
              <button type="button" onClick={() => setActionError(null)} aria-label="Dismiss">
                <X className="size-3" />
              </button>
            </div>
          )}

          {displaySettings.viewType === 'board' ? (
            <TasksBoard
              tasks={filteredTodos}
              routines={routines}
              grouping={displaySettings.grouping}
              now={now}
              onUpdateStatus={(todo, newStatus) => void updateStatus(todo, newStatus)}
              onUpdatePriority={(todo, newPriority) => void updatePriority(todo, newPriority)}
              onEdit={openEdit}
              onDelete={(todo) => void removeTask(todo)}
              onQuickCreate={(groupVal) =>
                openCreate(
                  displaySettings.grouping === 'channel' ? groupVal : undefined,
                  displaySettings.grouping === 'status' ? (groupVal as TodoStatus) : undefined
                )
              }
            />
          ) : (
            <div className="max-w-5xl mx-auto p-4 sm:p-6 space-y-6">
              {overdueCount > 0 && (
                <div className="flex items-center gap-2 rounded-lg border border-status-warning/30 bg-status-muted-warning px-3 py-2 text-xs text-status-warning">
                  <TriangleAlert className="size-3.5 shrink-0" />
                  <span>
                    {overdueCount === 1
                      ? '1 task is past its due date.'
                      : `${overdueCount} tasks are past their due date.`}
                  </span>
                </div>
              )}

              {filteredTodos.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-64 text-center rounded-xl border border-dashed border-border p-8 space-y-2">
                  <p className="text-sm font-medium text-foreground">No tasks found</p>
                  <p className="text-xs text-foreground-extra-muted max-w-sm">
                    {searchQuery
                      ? 'No tasks match your current search or filter.'
                      : scope === 'channel'
                      ? 'No tasks in this chat yet. Switch to All to see the whole workspace.'
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
                          <span className="text-2xs font-mono font-medium text-foreground-extra-muted bg-surface2 px-1.5 py-0.2 rounded-full border border-border/60">
                            {group.items.length}
                          </span>
                        </div>
                        <Hint label={`Add task to ${group.title}`}>
                          <button
                            type="button"
                            onClick={() =>
                              openCreate(
                                displaySettings.grouping === 'channel' ? group.id : undefined,
                                displaySettings.grouping === 'status' ? (group.id as TodoStatus) : undefined
                              )
                            }
                            className="p-1 text-foreground-extra-muted hover:text-foreground hover:bg-surface2 rounded transition-colors"
                          >
                            <Plus className="size-3.5" />
                          </button>
                        </Hint>
                      </div>

                      {/* Issue rows */}
                      <div className="overflow-hidden rounded-xl border border-border bg-surface1/60 divide-y divide-border/60">
                        {group.items.map((todo) => {
                          const overdue = isOverdue(todo, now);
                          const failureReason = getTaskFailureReason(todo, routines);
                          return (
                            <div
                              key={todo.id}
                              title={failureReason ? `Reason: ${failureReason}` : undefined}
                              className="group skip-offscreen-row flex items-center gap-3 px-4 py-2.5 hover:bg-surface2/60 transition-colors"
                            >
                              <PrioritySelector
                                priority={todo.priority}
                                size="sm"
                                onChange={(p) => void updatePriority(todo, p)}
                              />

                              <StatusSelector
                                status={todo.status}
                                size="sm"
                                failureReason={failureReason}
                                onChange={(s) => void updateStatus(todo, s)}
                              />

                              <span
                                className="text-2xs font-mono font-medium text-foreground-extra-muted shrink-0 hidden sm:inline-block"
                                title={todo.id}
                              >
                                {taskRef(todo)}
                              </span>

                              <div className="min-w-0 flex-1 flex items-center gap-2">
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
                                {failureReason && (
                                  <span
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-destructive/15 text-destructive border border-destructive/30 text-3xs font-medium shrink-0 cursor-help select-none"
                                    title={`Reason: ${failureReason}`}
                                  >
                                    <TriangleAlert className="size-2.5 shrink-0" />
                                    <span className="max-w-[200px] truncate">{failureReason}</span>
                                  </span>
                                )}
                              </div>

                              {/* Stacked badges, fanning out on hover */}
                              <div className="flex items-center -space-x-3 hover:space-x-1.5 transition-all duration-200 shrink-0">
                                {todo.dueDate && (
                                  <span
                                    className={cn(
                                      'inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-3xs font-medium shrink-0',
                                      overdue
                                        ? 'bg-status-muted-warning text-status-warning border-status-warning/30'
                                        : 'bg-surface2 text-foreground-muted border-border/60'
                                    )}
                                    title={`Due ${formatAbsolute(todo.dueDate)}`}
                                  >
                                    <CalendarClock className="size-2.5 shrink-0" />
                                    {overdue ? 'Overdue' : 'Due'}
                                  </span>
                                )}
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
                                  className="hidden md:inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface2 border border-border/60 text-3xs text-foreground-extra-muted shrink-0"
                                  title={formatAbsolute(todo.updatedAt || todo.createdAt)}
                                >
                                  {timeAgo(todo.updatedAt || todo.createdAt, now)}
                                </span>
                                {(todo.routineId || todo.timerId) && (
                                  <span
                                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface2 text-foreground-muted border border-border text-3xs font-medium shrink-0"
                                    title="Created by a scheduled routine"
                                  >
                                    <CalendarClock className="size-2.5 shrink-0" />
                                    Scheduled
                                  </span>
                                )}
                              </div>

                              {/* Row actions.
                                  These used to be hidden for anything the current
                                  user did not author, which left agent- and
                                  routine-created tasks with no way to be renamed
                                  or removed. Single-row writes make that safe. */}
                              <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                <Hint label="Edit task">
                                  <button
                                    type="button"
                                    onClick={() => openEdit(todo)}
                                    className="p-1 rounded text-foreground-extra-muted hover:bg-surface3 hover:text-foreground transition-colors"
                                  >
                                    <Pencil className="size-3.5" />
                                  </button>
                                </Hint>
                                {displaySettings.ordering === 'position' && (
                                  <>
                                    <Hint label="Move up">
                                      <button
                                        type="button"
                                        onClick={() => void reorderTask(todo, -1)}
                                        className="p-1 rounded text-foreground-extra-muted hover:bg-surface3 hover:text-foreground transition-colors"
                                      >
                                        <ArrowUp className="size-3.5" />
                                      </button>
                                    </Hint>
                                    <Hint label="Move down">
                                      <button
                                        type="button"
                                        onClick={() => void reorderTask(todo, 1)}
                                        className="p-1 rounded text-foreground-extra-muted hover:bg-surface3 hover:text-foreground transition-colors"
                                      >
                                        <ArrowDown className="size-3.5" />
                                      </button>
                                    </Hint>
                                  </>
                                )}
                                <Hint label="Delete task">
                                  <button
                                    type="button"
                                    onClick={() => void removeTask(todo)}
                                    className="p-1 rounded text-foreground-extra-muted hover:bg-surface3 hover:text-destructive transition-colors"
                                  >
                                    <Trash2 className="size-3.5" />
                                  </button>
                                </Hint>
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
      )}

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
                  <div className="flex items-center gap-1.5 p-1 rounded-lg border border-border bg-surface2/60">
                    <PrioritySelector priority={priority} onChange={setPriority} />
                    <span className="text-xs font-medium text-foreground capitalize">{priority}</span>
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="font-medium text-foreground-muted">Status</label>
                  <div className="flex items-center gap-1.5 p-1 rounded-lg border border-border bg-surface2/60">
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
                  <label className="font-medium text-foreground-muted">Due date</label>
                  <Input
                    type="date"
                    value={dueDate}
                    onChange={(e) => setDueDate(e.target.value)}
                    className="text-xs h-8"
                  />
                </div>
              </div>

              {/* The channel a task belongs to is fixed once it exists — moving
                  it would detach it from its author's ordered list. */}
              <div className="space-y-1">
                <label className="font-medium text-foreground-muted">Channel / Session</label>
                {editing ? (
                  <p className="h-8 flex items-center px-2 rounded-lg border border-border/60 bg-surface2/30 text-xs text-foreground-muted">
                    {channel || 'general'}
                  </p>
                ) : (
                  <Input
                    value={channel}
                    onChange={(e) => setChannel(e.target.value)}
                    placeholder="general"
                    className="text-xs h-8"
                  />
                )}
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
