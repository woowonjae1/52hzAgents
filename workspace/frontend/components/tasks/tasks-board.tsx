'use client';

import React, { useState } from 'react';
import type { RoutineItem, TodoItem, TodoPriority, TodoStatus } from '@/lib/types';
import { PrioritySelector } from './priority-selector';
import { StatusSelector, StatusGlyph } from './status-selector';
import { formatAbsolute, timeAgo } from '@/lib/schedule-format';
import { cn } from '@/lib/utils';
import { Plus, Pencil, Trash2, User, Hash, Clock, CalendarClock, TriangleAlert } from 'lucide-react';
import { getTaskFailureReason } from './tasks-view';

interface TasksBoardProps {
  tasks: TodoItem[];
  routines?: RoutineItem[];
  grouping: 'status' | 'assignee' | 'channel' | 'none';
  onUpdateStatus: (todo: TodoItem, newStatus: TodoStatus) => void;
  onUpdatePriority: (todo: TodoItem, newPriority: TodoPriority) => void;
  onEdit: (todo: TodoItem) => void;
  onDelete: (todo: TodoItem) => void;
  onQuickCreate: (groupValue: string) => void;
  /** Shared clock, so every card's relative time comes from one tick. */
  now: number;
}

/** True for a task past its due date and not yet closed. */
function isOverdue(todo: TodoItem, now: number): boolean {
  if (!todo.dueDate) return false;
  if (todo.status === 'completed' || todo.status === 'cancelled') return false;
  const due = new Date(todo.dueDate).getTime();
  return Number.isFinite(due) && due < now;
}

function taskRef(todo: TodoItem): string {
  if (todo.id.startsWith('TASK-')) return todo.id.replace(/^TASK-/, '');
  return todo.id.slice(-4).toUpperCase();
}

interface BoardColumn {
  id: string;
  title: string;
  glyph?: React.ReactNode;
  tasks: TodoItem[];
}

export function TasksBoard({
  tasks,
  routines,
  grouping,
  onUpdateStatus,
  onUpdatePriority,
  onEdit,
  onDelete,
  onQuickCreate,
  now,
}: TasksBoardProps) {
  // Build columns based on grouping
  const columns: BoardColumn[] = React.useMemo(() => {
    if (grouping === 'status' || grouping === 'none') {
      return [
        {
          id: 'pending',
          title: 'Todo',
          glyph: <StatusGlyph status="pending" className="size-3.5" />,
          tasks: tasks.filter((t) => t.status === 'pending'),
        },
        {
          id: 'in_progress',
          title: 'In Progress',
          glyph: <StatusGlyph status="in_progress" className="size-3.5" />,
          tasks: tasks.filter((t) => t.status === 'in_progress'),
        },
        {
          id: 'completed',
          title: 'Completed',
          glyph: <StatusGlyph status="completed" className="size-3.5" />,
          tasks: tasks.filter((t) => t.status === 'completed' || t.status === 'cancelled'),
        },
      ];
    }

    if (grouping === 'assignee') {
      const assignees = Array.from(new Set(tasks.map((t) => t.assignee || 'Unassigned')));
      if (!assignees.includes('Unassigned')) assignees.push('Unassigned');
      return assignees.map((assignee) => ({
        id: assignee,
        title: assignee === 'Unassigned' ? 'Unassigned' : assignee,
        glyph: <User className="size-3.5 text-foreground-muted" />,
        tasks: tasks.filter((t) => (t.assignee || 'Unassigned') === assignee),
      }));
    }

    if (grouping === 'channel') {
      const channels = Array.from(new Set(tasks.map((t) => t.channelName || 'general')));
      return channels.map((ch) => ({
        id: ch,
        title: ch,
        glyph: <Hash className="size-3.5 text-foreground-muted" />,
        tasks: tasks.filter((t) => (t.channelName || 'general') === ch),
      }));
    }

    return [];
  }, [tasks, grouping]);

  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);

  const handleDragStart = (e: React.DragEvent, id: string) => {
    e.dataTransfer.setData('text/plain', id);
    setDraggedTaskId(id);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent, targetColumnId: string) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData('text/plain') || draggedTaskId;
    setDraggedTaskId(null);
    if (!taskId) return;

    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;

    if (grouping === 'status' || grouping === 'none') {
      if (['pending', 'in_progress', 'completed', 'cancelled'].includes(targetColumnId)) {
        onUpdateStatus(task, targetColumnId as TodoStatus);
      }
    }
  };

  return (
    <div className="flex gap-4 p-4 overflow-x-auto h-full min-h-[calc(100vh-220px)] select-none">
      {columns.map((col) => (
        <div
          key={col.id}
          onDragOver={handleDragOver}
          onDrop={(e) => handleDrop(e, col.id)}
          className="flex flex-col w-80 shrink-0 rounded-xl bg-surface1/60 border border-border/60 overflow-hidden"
        >
          {/* Column Header */}
          <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border/50 bg-surface1">
            <div className="flex items-center gap-2">
              {col.glyph}
              <span className="text-xs font-semibold text-foreground tracking-tight">{col.title}</span>
              <span className="text-2xs font-mono text-foreground-extra-muted bg-surface2 px-1.5 py-0.5 rounded-full border border-border/40">
                {col.tasks.length}
              </span>
            </div>
            <button
              type="button"
              onClick={() => onQuickCreate(col.id)}
              className="p-1 text-foreground-muted hover:text-foreground hover:bg-surface2 rounded-md transition-colors"
              title={`Add task to ${col.title}`}
            >
              <Plus className="size-3.5" />
            </button>
          </div>

          {/* Cards List */}
          <div className="flex-1 p-2 space-y-2 overflow-y-auto">
            {col.tasks.length === 0 ? (
              <div className="flex items-center justify-center h-28 border border-dashed border-border/50 rounded-lg text-3xs text-foreground-extra-muted">
                Drop tasks here
              </div>
            ) : (
              col.tasks.map((task) => {
                const overdue = isOverdue(task, now);
                const failureReason = getTaskFailureReason(task, routines);
                return (
                  <div
                    key={task.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, task.id)}
                    title={failureReason ? `失败/取消原因: ${failureReason}` : undefined}
                    className={cn(
                      'group relative rounded-lg border border-border/70 bg-surface2/90 p-3 text-sm transition-all hover:border-border hover:shadow-xs cursor-grab active:cursor-grabbing',
                      draggedTaskId === task.id && 'opacity-40 border-dashed border-primary/50'
                    )}
                  >
                    {/* Top Row: Priority & Status Controls */}
                    <div className="flex items-center justify-between gap-1 mb-2">
                      <div className="flex items-center gap-1.5">
                        <PrioritySelector
                          priority={task.priority}
                          size="sm"
                          onChange={(p) => onUpdatePriority(task, p)}
                        />
                        <span
                          className="text-3xs font-mono font-medium text-foreground-extra-muted"
                          title={task.id}
                        >
                          {taskRef(task)}
                        </span>
                      </div>
                      <StatusSelector
                        status={task.status}
                        size="sm"
                        failureReason={failureReason}
                        onChange={(s) => onUpdateStatus(task, s)}
                      />
                    </div>

                    {/* Task Content */}
                    <p
                      className={cn(
                        'text-xs font-medium leading-snug line-clamp-3 text-foreground break-words',
                        task.status === 'in_progress' && 'event-running',
                        (task.status === 'completed' || task.status === 'cancelled') &&
                          'line-through text-foreground-extra-muted'
                      )}
                    >
                      {task.content}
                    </p>

                    {/* Failure / Cancellation Reason */}
                    {failureReason && (
                      <div
                        className="mt-1.5 flex items-center gap-1 text-3xs text-destructive font-medium bg-destructive/10 border border-destructive/25 rounded px-1.5 py-0.5 cursor-help select-none"
                        title={`失败/取消原因: ${failureReason}`}
                      >
                        <TriangleAlert className="size-2.5 shrink-0" />
                        <span className="truncate">{failureReason}</span>
                      </div>
                    )}

                    {/* Bottom Row: Stacked Badges with Hover Fan-Out */}
                    <div className="mt-3 pt-2 border-t border-border/40 flex items-center justify-between text-3xs text-foreground-extra-muted">
                      <div className="flex items-center -space-x-3 hover:space-x-1.5 transition-all duration-200">
                        {task.dueDate && (
                          <span
                            className={cn(
                              'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border font-medium shrink-0',
                              overdue
                                ? 'bg-amber-500/10 text-amber-500 border-amber-500/30'
                                : 'bg-surface3 text-foreground-muted border-border/60'
                            )}
                            title={`Due ${formatAbsolute(task.dueDate)}`}
                          >
                            <CalendarClock className="size-2.5 shrink-0" />
                            {overdue ? 'Overdue' : 'Due'}
                          </span>
                        )}
                        {task.channelName && (
                          <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-surface3 border border-border/60 font-medium text-foreground-muted truncate max-w-[100px]"
                            title={`Channel: ${task.channelName}`}
                          >
                            <Hash className="size-2.5 text-foreground-extra-muted shrink-0" />
                            {task.channelName}
                          </span>
                        )}
                        {task.assignee && (
                          <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-surface3 border border-border/60 font-medium text-foreground-muted truncate max-w-[90px]"
                            title={`Assigned to: ${task.assignee}`}
                          >
                            <User className="size-2.5 text-foreground-extra-muted shrink-0" />
                            {task.assignee}
                          </span>
                        )}
                        <span
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-surface3 border border-border/60 text-foreground-extra-muted shrink-0"
                          title={formatAbsolute(task.updatedAt || task.createdAt)}
                        >
                          <Clock className="size-2.5 shrink-0" />
                          {timeAgo(task.updatedAt || task.createdAt, now)}
                        </span>
                        {(task.routineId || task.timerId) && (
                          <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/30 text-3xs font-medium shrink-0"
                            title="Automated Routine Task"
                          >
                            <CalendarClock className="size-2.5 shrink-0" />
                            Scheduled
                          </span>
                        )}
                      </div>

                      {/* Card actions. Previously gated to tasks the current
                          user authored, which left every agent- and
                          routine-created card read-only. */}
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          type="button"
                          onClick={() => onEdit(task)}
                          className="p-1 rounded text-foreground-extra-muted hover:text-foreground hover:bg-surface3 transition-colors"
                          title="Edit"
                        >
                          <Pencil className="size-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onDelete(task)}
                          className="p-1 rounded text-foreground-extra-muted hover:text-destructive hover:bg-surface3 transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
