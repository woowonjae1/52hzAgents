'use client';

import { Hint } from '@/components/ui/hint';
import React, { useState } from 'react';
import type { RoutineItem, TodoItem, TodoPriority, TodoStatus } from '@/lib/types';
import { PrioritySelector } from './priority-selector';
import { RowActions } from '@/components/ui/row-actions';
import { StatusSelector, StatusGlyph } from './status-selector';
import { formatAbsolute, timeAgo } from '@/lib/schedule-format';
import { cn } from '@/lib/utils';
import { Plus, Pencil, Trash2, User, Hash, Clock, CalendarClock, TriangleAlert, Copy } from 'lucide-react';
import { toast } from '@/lib/toast';
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
  /* Which column the pointer is currently over. Without it the board gave no
     answer at all to "where will this land?" — the card went translucent and
     that was the entire feedback. A drag with no drop target is a guess. */
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);

  const handleDragStart = (e: React.DragEvent, id: string) => {
    e.dataTransfer.setData('text/plain', id);
    // 'move', not the default 'copy': the cursor badge is the only thing
    // telling the user this is a move, and a + sign says the opposite.
    e.dataTransfer.effectAllowed = 'move';
    setDraggedTaskId(id);
  };

  /*
   * A drag that is cancelled — Escape, or a drop outside any column — never
   * fired `onDrop`, so `draggedTaskId` stayed set and the card it belonged to
   * stayed at 40% opacity with a dashed border until the next drag. `dragend`
   * fires for every ending, successful or not, which is the whole reason it
   * exists.
   */
  const handleDragEnd = () => {
    setDraggedTaskId(null);
    setDragOverColumn(null);
  };

  const handleDragOver = (e: React.DragEvent, columnId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverColumn !== columnId) setDragOverColumn(columnId);
  };

  const handleDrop = (e: React.DragEvent, targetColumnId: string) => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData('text/plain') || draggedTaskId;
    setDraggedTaskId(null);
    setDragOverColumn(null);
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
          onDragOver={(e) => handleDragOver(e, col.id)}
          onDragLeave={(e) => {
            // `dragleave` also fires when the pointer crosses into a CHILD of
            // the column, so the highlight has to survive that.
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
            setDragOverColumn((c) => (c === col.id ? null : c));
          }}
          onDrop={(e) => handleDrop(e, col.id)}
          className={cn(
            'flex flex-col w-80 shrink-0 rounded-xl bg-surface1/60 border overflow-hidden ui-transition',
            dragOverColumn === col.id && draggedTaskId
              ? 'border-border-accent bg-surface2/60'
              : 'border-border/60',
          )}
        >
          {/* Column Header */}
          <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-border/60 bg-surface1">
            <div className="flex items-center gap-2">
              {col.glyph}
              <span className="text-xs font-semibold text-foreground tracking-tight">{col.title}</span>
              <span className="text-2xs font-mono text-foreground-extra-muted bg-surface2 px-1.5 py-0.5 rounded-full border border-border/60">
                {col.tasks.length}
              </span>
            </div>
            <Hint label={`Add task to ${col.title}`}>
              <button
                type="button"
                onClick={() => onQuickCreate(col.id)}
                className="p-1 text-foreground-muted hover:text-foreground hover:bg-surface2 rounded-md transition-colors"
              >
                <Plus className="size-3.5" />
              </button>
            </Hint>
          </div>

          {/* Cards List */}
          <div className="flex-1 p-2 space-y-2 overflow-y-auto">
            {col.tasks.length === 0 ? (
              <div className="flex items-center justify-center h-28 border border-dashed border-border/60 rounded-lg text-3xs text-foreground-extra-muted">
                {dragOverColumn === col.id && draggedTaskId ? `Move to ${col.title}` : 'Drop tasks here'}
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
                    onDragEnd={handleDragEnd}
                    className={cn(
                      'group skip-offscreen-card relative rounded-lg border border-border bg-surface2/90 p-3 text-sm ui-transition hover:border-border-accent hover:shadow-xs cursor-grab active:cursor-grabbing',
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
                        <Hint label={task.id}>
                          <span className="text-3xs font-mono font-medium text-foreground-extra-muted">
                            {taskRef(task)}
                          </span>
                        </Hint>
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
                      <Hint label={`Reason: ${failureReason}`}>
                        <div className="mt-1.5 flex items-center gap-1 text-3xs text-destructive font-medium bg-destructive/10 border border-destructive/25 rounded px-1.5 py-0.5 cursor-help select-none">
                          <TriangleAlert className="size-2.5 shrink-0" />
                          <span className="truncate">{failureReason}</span>
                        </div>
                      </Hint>
                    )}

                    {/* Bottom Row: Stacked Badges with Hover Fan-Out */}
                    <div className="mt-3 pt-2 border-t border-border/60 flex items-center justify-between text-3xs text-foreground-extra-muted">
                      <div className="flex items-center -space-x-3 hover:space-x-1.5 ui-transition duration-200">
                        {task.dueDate && (
                          <Hint label={`Due ${formatAbsolute(task.dueDate)}`}>
                            <span
                              className={cn(
                                'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border font-medium shrink-0',
                                overdue
                                  ? 'bg-status-muted-warning text-status-warning border-status-warning/30'
                                  : 'bg-surface3 text-foreground-muted border-border/60'
                              )}
                            >
                              <CalendarClock className="size-2.5 shrink-0" />
                              {overdue ? 'Overdue' : 'Due'}
                            </span>
                          </Hint>
                        )}
                        {task.channelName && (
                          <Hint label={`Channel: ${task.channelName}`}>
                            <span
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-surface3 border border-border/60 font-medium text-foreground-muted truncate max-w-[100px]"
                            >
                              <Hash className="size-2.5 text-foreground-extra-muted shrink-0" />
                              {task.channelName}
                            </span>
                          </Hint>
                        )}
                        {task.assignee && (
                          <Hint label={`Assigned to: ${task.assignee}`}>
                            <span
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-surface3 border border-border/60 font-medium text-foreground-muted truncate max-w-[90px]"
                            >
                              <User className="size-2.5 text-foreground-extra-muted shrink-0" />
                              {task.assignee}
                            </span>
                          </Hint>
                        )}
                        <Hint label={formatAbsolute(task.updatedAt || task.createdAt)}>
                          <span
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-surface3 border border-border/60 text-foreground-extra-muted shrink-0"
                          >
                            <Clock className="size-2.5 shrink-0" />
                            {timeAgo(task.updatedAt || task.createdAt, now)}
                          </span>
                        </Hint>
                        {(task.routineId || task.timerId) && (
                          <Hint label="Created by a scheduled routine">
                            <span
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-surface2 text-foreground-muted border border-border text-3xs font-medium shrink-0"
                            >
                              <CalendarClock className="size-2.5 shrink-0" />
                              Scheduled
                            </span>
                          </Hint>
                        )}
                      </div>

                      {/* Card actions. Previously gated to tasks the current
                          user authored, which left every agent- and
                          routine-created card read-only. */}
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Hint label="Edit">
                          <button
                            type="button"
                            onClick={() => onEdit(task)}
                            className="p-1 rounded text-foreground-extra-muted hover:text-foreground hover:bg-surface3 transition-colors"
                          >
                            <Pencil className="size-3" />
                          </button>
                        </Hint>
                        <Hint label="Delete">
                          <button
                            type="button"
                            onClick={() => onDelete(task)}
                            className="p-1 rounded text-foreground-extra-muted hover:text-destructive hover:bg-surface3 transition-colors"
                          >
                            <Trash2 className="size-3" />
                          </button>
                        </Hint>
                      </div>
                    </div>
                    {/* Direct child of the card, not of the badge row: that is
                        the relationship RowContextMenu matches on when it turns
                        a right-click into this card's own menu. */}
                    <RowActions
                      label={`Actions for ${taskRef(task)}`}
                      className="absolute top-1 right-1"
                      items={[
                        { label: 'Edit task', icon: Pencil, onSelect: () => onEdit(task) },
                        {
                          label: 'Copy task text',
                          icon: Copy,
                          onSelect: () => {
                            navigator.clipboard.writeText(task.content);
                            toast.success('Copied');
                          },
                        },
                        { label: 'Delete task', icon: Trash2, destructive: true, onSelect: () => onDelete(task) },
                      ]}
                    />
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
