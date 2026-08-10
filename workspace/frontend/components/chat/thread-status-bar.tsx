'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { Circle, Loader2, Timer, MessageSquareMore, X, ChevronDown, ChevronUp } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace-context';
import { workspaceApi } from '@/lib/api';
import type { TimerItem, WorkspaceMessage } from '@/lib/types';

function timeUntil(dateStr: string): string {
  const diff = new Date(dateStr).getTime() - Date.now();
  if (diff <= 0) return 'now';
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h`;
}

interface QueuedMessage {
  queueId: string;
  content: string;
}

export function ThreadStatusBar({ channelName, messages = [] }: { channelName: string; messages?: WorkspaceMessage[] }) {
  const { todos, refreshTodos } = useWorkspace();
  const [timers, setTimers] = useState<TimerItem[]>([]);
  const [cancelledQueueIds, setCancelledQueueIds] = useState<Set<string>>(new Set());

  const pollTimers = useCallback(async () => {
    try {
      const result = await workspaceApi.listTimers(channelName);
      setTimers(result.timers);
    } catch {}
  }, [channelName]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const result = await workspaceApi.listTimers(channelName).catch(() => null);
      if (!cancelled && result) setTimers(result.timers);
    };
    poll();
    const interval = setInterval(poll, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [channelName]);

  const [, setTick] = useState(0);
  useEffect(() => {
    if (!timers.length) return;
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, [timers.length]);

  const channelTodos = useMemo(() =>
    todos.filter((t) => t.channelName === channelName && (t.status === 'pending' || t.status === 'in_progress')),
    [todos, channelName]
  );

  // Extract queued messages from status messages with queue metadata
  const queuedMessages = useMemo(() => {
    // First pass: collect queue IDs that have been processed
    const processedIds = new Set<string>();
    for (const msg of messages) {
      if (msg.messageType !== 'status') continue;
      const meta = msg.metadata as Record<string, unknown> | undefined;
      if (meta?.queue_id && meta?.queue_status === 'processed') {
        processedIds.add(meta.queue_id as string);
      }
    }

    const queued: QueuedMessage[] = [];
    const seen = new Set<string>();
    // Walk messages in reverse to get latest state per queue_id
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.messageType !== 'status') continue;
      const meta = msg.metadata as Record<string, unknown> | undefined;
      if (!meta?.queue_id || !meta?.queued_message) continue;
      const qid = meta.queue_id as string;
      if (seen.has(qid) || cancelledQueueIds.has(qid) || processedIds.has(qid)) continue;
      seen.add(qid);
      queued.push({ queueId: qid, content: meta.queued_message as string });
    }
    return queued.reverse();
  }, [messages, cancelledQueueIds]);

  const pendingCount = channelTodos.filter((t) => t.status === 'pending').length;
  const inProgressCount = channelTodos.filter((t) => t.status === 'in_progress').length;
  const activeTimers = timers.filter((t) => t.status === 'active');

  const handleCancelTimer = useCallback(async (timerId: string) => {
    setTimers((prev) => prev.filter((t) => t.id !== timerId));
    try {
      await workspaceApi.cancelTimer(timerId);
    } catch {}
    pollTimers();
  }, [pollTimers]);

  const handleCancelTodos = useCallback(async () => {
    const agents = Array.from(new Set(channelTodos.map((t) => (t.createdBy || '')))).filter(Boolean);
    for (const source of agents) {
      try {
        await workspaceApi.cancelChannelTodos(channelName, source);
      } catch {}
    }
    refreshTodos();
  }, [channelTodos, channelName, refreshTodos]);

  const handleCancelQueued = useCallback(async (queueId: string) => {
    setCancelledQueueIds((prev) => new Set(prev).add(queueId));
    try {
      await workspaceApi.cancelQueuedMessage(channelName, queueId);
    } catch {}
  }, [channelName]);

  const [tasksExpanded, setTasksExpanded] = useState(false);

  const hasContent = pendingCount > 0 || inProgressCount > 0 || activeTimers.length > 0 || queuedMessages.length > 0;
  if (!hasContent) return null;

  return (
    <div className="flex flex-col gap-1 px-1 py-1 text-[11px] text-muted-foreground">
      {/* Expanded tasks card overlay */}
      {tasksExpanded && channelTodos.length > 0 && (
        <div className="mb-1 rounded-lg border border-border bg-card p-2 shadow-lg space-y-1.5 animate-in fade-in slide-in-from-bottom-2 duration-150">
          <div className="flex items-center justify-between px-1 pb-1 border-b border-border text-[11px] font-semibold text-muted-foreground">
            <span>Current Tasks ({channelTodos.length})</span>
            <button
              type="button"
              onClick={() => setTasksExpanded(false)}
              className="p-0.5 rounded hover:bg-muted text-muted-foreground"
            >
              <X className="size-3" />
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto divide-y divide-border/50">
            {channelTodos.map((todo) => (
              <div key={todo.id || todo.content} className="flex items-start gap-2 py-1.5 px-1">
                {todo.status === 'in_progress' ? (
                  <Loader2 className="mt-0.5 size-3.5 text-foreground-muted animate-spin shrink-0" />
                ) : (
                  <Circle className="mt-0.5 size-3.5 text-muted-foreground shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-foreground leading-snug break-words">{todo.content}</p>
                  <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground">
                    {todo.createdBy && <span>by {todo.createdBy.replace(/^(openagents:|human:)/, '')}</span>}
                    {todo.assignee && <span>assigned to {todo.assignee}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Todos and timers row */}
      {(inProgressCount > 0 || pendingCount > 0 || activeTimers.length > 0) && (
        <div className="flex items-center gap-2.5">
          {(inProgressCount > 0 || pendingCount > 0) && (
            <span className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setTasksExpanded((prev) => !prev)}
                className="flex items-center gap-1 hover:text-foreground transition-colors cursor-pointer group"
                title="Click to view all task details"
              >
                {inProgressCount > 0 && (
                  <>
                    <Loader2 className="size-3 text-foreground-muted animate-spin" />
                    <span className="group-hover:underline">{inProgressCount} in progress</span>
                  </>
                )}
                {inProgressCount > 0 && pendingCount > 0 && <span className="text-muted-foreground/30">·</span>}
                {pendingCount > 0 && (
                  <>
                    <Circle className="size-3" />
                    <span className="group-hover:underline">{pendingCount} pending</span>
                  </>
                )}
                {tasksExpanded ? <ChevronDown className="size-3" /> : <ChevronUp className="size-3" />}
              </button>
              <button
                onClick={handleCancelTodos}
                className="ml-1 p-0.5 rounded hover:bg-surface3 dark:hover:bg-primary transition-colors"
                title="Cancel all tasks"
              >
                <X className="size-3" />
              </button>
            </span>
          )}
          {activeTimers.map((t) => {
            const msg = t.message || '';
            const firesAt = t.firesAt || '';
            return (
              <span key={t.id} className="flex items-center gap-1">
                <Timer className="size-3 text-status-warning" />
                <span>{msg.length > 30 ? msg.slice(0, 30) + '…' : msg}</span>
                <span className="text-status-warning font-mono">{firesAt ? timeUntil(firesAt) : ''}</span>
                <button
                  onClick={() => handleCancelTimer(t.id)}
                  className="p-0.5 rounded hover:bg-surface3 dark:hover:bg-primary transition-colors"
                  title="Cancel timer"
                >
                  <X className="size-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}

      {/* Queued messages */}
      {queuedMessages.map((q) => (
        <div key={q.queueId} className="flex items-center gap-1.5 text-foreground-muted">
          <MessageSquareMore className="size-3 shrink-0" />
          <span className="truncate">
            Queued: {q.content.length > 60 ? q.content.slice(0, 60) + '…' : q.content}
          </span>
          <button
            onClick={() => handleCancelQueued(q.queueId)}
            className="shrink-0 p-0.5 rounded hover:bg-surface3 dark:hover:bg-primary transition-colors"
            title="Cancel queued message"
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
