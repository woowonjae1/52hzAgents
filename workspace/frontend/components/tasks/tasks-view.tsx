'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, CheckCircle2, Circle, Loader2, Pencil, Plus, RefreshCw, Trash2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useWorkspace } from '@/lib/workspace-context';
import { ScreenTitle } from '@/components/headers/screen-title';
import { cn } from '@/lib/utils';
import type { TodoItem } from '@/lib/types';

type TodoStatus = TodoItem['status'];

const STATUS_LABEL: Record<TodoStatus, string> = {
  pending: 'Pending',
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

function StatusIcon({ status }: { status: TodoStatus }) {
  if (status === 'completed') return <CheckCircle2 className="size-4 text-foreground-muted shrink-0" />;
  if (status === 'in_progress') return <Loader2 className="size-4 text-foreground-muted shrink-0 animate-spin" />;
  if (status === 'cancelled') return <XCircle className="size-4 text-foreground-extra-muted shrink-0" />;
  return <Circle className="size-4 text-foreground-extra-muted shrink-0" />;
}

function nextStatus(status: TodoStatus): TodoStatus {
  if (status === 'pending') return 'in_progress';
  if (status === 'in_progress') return 'completed';
  return 'pending';
}

export function TasksView() {
  const { todos: allTodos, refreshTodos, replaceTodos, sessions, currentSessionId, currentUser } = useWorkspace();
  // This panel opens from a thread's header, so it shows what THIS thread's
  // agents are working on, not every task across the workspace.
  const todos = useMemo(
    () => (currentSessionId ? allTodos.filter((t) => t.channelName === currentSessionId) : allTodos),
    [allTodos, currentSessionId]
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<TodoItem | null>(null);
  const [content, setContent] = useState('');
  const [assignee, setAssignee] = useState('');
  const [status, setStatus] = useState<TodoStatus>('pending');
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

  const openCreate = () => {
    const selectedChannel = currentSessionId && !currentSessionId.startsWith('routines:')
      ? currentSessionId
      : channels[0]?.id || 'general';
    setEditing(null);
    setContent('');
    setAssignee('');
    setStatus('pending');
    setChannel(selectedChannel);
    setError(null);
    setDialogOpen(true);
  };

  const openEdit = (todo: TodoItem) => {
    setEditing(todo);
    setContent(todo.content);
    setAssignee(todo.assignee);
    setStatus(todo.status);
    setChannel(todo.channelName);
    setError(null);
    setDialogOpen(true);
  };

  const saveForSourceAndChannel = async (source: string, channelName: string, updated: TodoItem[]) => {
    await replaceTodos({
      source,
      channel: channelName,
      todos: updated.map((todo) => ({ content: todo.content, status: todo.status, assignee: todo.assignee })),
    });
  };

  const handleSubmit = async () => {
    const trimmed = content.trim();
    if (!trimmed) {
      setError('Task description is required.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (editing) {
        const group = todos.filter((todo) => todo.createdBy === editing.createdBy && todo.channelName === editing.channelName);
        await saveForSourceAndChannel(editing.createdBy, editing.channelName, group.map((todo) => (
          todo.id === editing.id ? { ...todo, content: trimmed, assignee: assignee.trim(), status } : todo
        )));
      } else {
        const group = todos.filter((todo) => todo.createdBy === manualSource && todo.channelName === channel);
        await saveForSourceAndChannel(manualSource, channel, [...group, {
          id: '', content: trimmed, assignee: assignee.trim(), status, createdBy: manualSource,
          channelName: channel, threadId: null, position: group.length, createdAt: null, updatedAt: null,
        }]);
      }
      setDialogOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save task.');
    } finally {
      setSaving(false);
    }
  };

  const updateStatus = async (todo: TodoItem) => {
    const group = todos.filter((item) => item.createdBy === todo.createdBy && item.channelName === todo.channelName);
    try {
      await saveForSourceAndChannel(todo.createdBy, todo.channelName, group.map((item) => (
        item.id === todo.id ? { ...item, status: nextStatus(item.status) } : item
      )));
    } catch {
      void refreshTodos();
    }
  };

  const deleteTask = async (todo: TodoItem) => {
    const group = todos.filter((item) => item.createdBy === todo.createdBy && item.channelName === todo.channelName && item.id !== todo.id);
    try {
      await saveForSourceAndChannel(todo.createdBy, todo.channelName, group);
    } catch {
      void refreshTodos();
    }
  };

  const reorderTask = async (todo: TodoItem, direction: -1 | 1) => {
    const group = todos.filter((item) => item.createdBy === todo.createdBy && item.channelName === todo.channelName);
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

  const buckets = useMemo(() => ({
    in_progress: todos.filter((todo) => todo.status === 'in_progress'),
    pending: todos.filter((todo) => todo.status === 'pending'),
    completed: todos.filter((todo) => todo.status === 'completed' || todo.status === 'cancelled'),
  }), [todos]);
  const activeCount = buckets.in_progress.length + buckets.pending.length;

  const renderSection = (sectionStatus: 'in_progress' | 'pending' | 'completed') => {
    const items = buckets[sectionStatus];
    if (!items.length) return null;
    return (
      <section key={sectionStatus}>
        <h3 className="mb-2 text-2xs font-medium text-muted-foreground">
          {STATUS_LABEL[sectionStatus]} <span className="text-muted-foreground/60">{items.length}</span>
        </h3>
        <div className="overflow-hidden rounded-lg border border-border bg-card divide-y divide-border">
          {items.map((todo) => {
            const isManual = todo.createdBy === manualSource;
            return (
              <div key={todo.id} className="flex items-start gap-2.5 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => isManual && void updateStatus(todo)}
                  disabled={!isManual}
                  title={isManual ? `Mark ${nextStatus(todo.status).replace('_', ' ')}` : STATUS_LABEL[todo.status]}
                  className={cn('mt-0.5 rounded-sm', isManual && 'hover:scale-110 transition-transform')}
                >
                  <StatusIcon status={todo.status} />
                </button>
                <div className="min-w-0 flex-1">
                  <p className={cn('text-sm leading-snug', (todo.status === 'completed' || todo.status === 'cancelled') && 'line-through text-muted-foreground')}>
                    {todo.content}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-3xs text-muted-foreground">
                    <span className={cn(
                      'px-1.5 py-0.5 rounded text-2xs font-medium',
                      todo.status === 'in_progress' && 'bg-surface3 text-foreground-muted border border-border-accent',
                      todo.status === 'completed' && 'bg-status-success/10 text-status-success border border-border-accent',
                      todo.status === 'pending' && 'bg-surface2 text-muted-foreground border border-border/50',
                      todo.status === 'cancelled' && 'bg-status-danger/10 text-status-danger border border-border-accent'
                    )}>
                      {todo.status.replace('_', ' ')}
                    </span>
                    <span>{todo.channelName}</span>
                    <span>by {todo.createdBy.replace(/^(openagents:|human:)/, '')}</span>
                    {todo.assignee && <span>assigned to {todo.assignee}</span>}
                    <span>{timeAgo(todo.updatedAt || todo.createdAt)}</span>
                  </div>
                </div>
                {isManual && (
                  <div className="flex shrink-0 items-center gap-1">
                    <button type="button" onClick={() => openEdit(todo)} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title="Edit task">
                      <Pencil className="size-3.5" />
                    </button>
                    <button type="button" onClick={() => void reorderTask(todo, -1)} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title="Move task up">
                      <ArrowUp className="size-3.5" />
                    </button>
                    <button type="button" onClick={() => void reorderTask(todo, 1)} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" title="Move task down">
                      <ArrowDown className="size-3.5" />
                    </button>
                    <button type="button" onClick={() => void deleteTask(todo)} className="rounded p-1 text-muted-foreground hover:bg-surface3 hover:text-status-danger dark:hover:bg-red-950/30" title="Delete task">
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>
    );
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <div>
          <ScreenTitle>Tasks</ScreenTitle>
          <p className="text-xs text-muted-foreground">{activeCount ? `${activeCount} active` : 'Plan and track work across conversations'}</p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" mode="icon" size="sm" onClick={() => void refreshTodos()} title="Refresh tasks"><RefreshCw className="size-4" /></Button>
          <button
            onClick={openCreate}
            className="inline-flex items-center justify-center whitespace-nowrap shrink-0 gap-1.5 h-8 px-3.5 rounded-lg text-xs font-semibold bg-primary text-primary-foreground border border-primary hover:bg-primary/90 transition-colors cursor-pointer shadow-xs"
          >
            <Plus className="size-3.5 shrink-0" />
            <span className="whitespace-nowrap">New task</span>
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        {todos.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
            <Circle className="size-8 opacity-30" />
            <p className="text-sm">No tasks yet</p>
            <Button variant="outline" size="sm" onClick={openCreate}>Create your first task</Button>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-6">
            {renderSection('in_progress')}
            {renderSection('pending')}
            {renderSection('completed')}
          </div>
        )}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogTitle>{editing ? 'Edit task' : 'Create task'}</DialogTitle>
          <DialogDescription>Tasks you create are shared with everyone in this workspace.</DialogDescription>
          <div className="mt-4 space-y-4">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Task</label>
              <textarea value={content} onChange={(event) => setContent(event.target.value)} rows={3} disabled={saving} placeholder="What needs to be done?" className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:border-border-accent transition-colors" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Status</label>
                <select value={status} onChange={(event) => setStatus(event.target.value as TodoStatus)} disabled={saving} className="w-full rounded-lg border border-input bg-background px-2.5 py-2 text-sm outline-none focus:border-border-accent transition-colors">
                  {Object.entries(STATUS_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Assignee (optional)</label>
                <Input value={assignee} onChange={(event) => setAssignee(event.target.value)} disabled={saving} placeholder="Name" className="focus-visible:ring-0 focus-visible:border-border-accent transition-colors" />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Conversation</label>
              <select value={channel} onChange={(event) => setChannel(event.target.value)} disabled={saving || !!editing} className="w-full rounded-lg border border-input bg-background px-2.5 py-2 text-sm outline-none focus:border-border-accent transition-colors">
                {channels.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
                {editing && !channels.some((item) => item.id === channel) && <option value={channel}>{channel}</option>}
              </select>
            </div>
            {error && <p className="text-xs text-status-danger">{error}</p>}
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)} disabled={saving}>Cancel</Button>
            <Button size="sm" onClick={() => void handleSubmit()} disabled={saving || !content.trim()}>{saving ? 'Saving...' : editing ? 'Save task' : 'Create task'}</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
