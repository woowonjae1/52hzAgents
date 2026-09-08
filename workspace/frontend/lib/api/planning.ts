import type {
  NotificationItem,
  RoutineItem,
  RoutineRunItem,
  ShareSummary,
  TimerItem,
  TodoItem,
} from '../types';
import { BaseWorkspaceApi } from './base';

/** The viewer's IANA timezone, falling back to UTC where Intl is unavailable. */
export function localTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function parseScheduleDays(rawDays: unknown): number[] | null {
  if (!rawDays) return null;
  if (Array.isArray(rawDays)) {
    return rawDays.map(Number);
  }
  if (typeof rawDays === 'string') {
    try {
      const decoded = atob(rawDays);
      const parsed = JSON.parse(decoded);
      if (Array.isArray(parsed)) {
        return parsed.map(Number);
      }
    } catch {
      try {
        const parsed = JSON.parse(rawDays);
        if (Array.isArray(parsed)) {
          return parsed.map(Number);
        }
      } catch {
        // ignore
      }
    }
  }
  return null;
}

/**
 * Normalises one routine row. The three endpoints that return a routine each
 * carried their own transcription of these twenty fields; a field added to the
 * model reached whichever copies someone remembered to update.
 */
export function normalizeRoutine(r: Record<string, unknown>): RoutineItem {
  return {
    id: (r.id || r.ID) as string,
    shortId: (r.short_id || r.shortId || r.ShortID) as string | undefined,
    name: (r.name || r.Name) as string,
    message: (r.message || r.Message) as string,
    context: (r.context ?? r.Context ?? null) as string | null,
    scheduleHour: (r.schedule_hour ?? r.scheduleHour ?? r.ScheduleHour ?? 0) as number,
    scheduleMinute: (r.schedule_minute ?? r.scheduleMinute ?? r.ScheduleMinute ?? 0) as number,
    scheduleDays: parseScheduleDays(r.schedule_days ?? r.scheduleDays ?? r.ScheduleDays),
    scheduleIntervalMinutes: (r.schedule_interval_minutes ?? r.scheduleIntervalMinutes ?? r.ScheduleIntervalMinutes ?? null) as number | null,
    timezone: (r.timezone || r.Timezone || 'UTC') as string,
    nextFiresAt: (r.next_fires_at || r.nextFiresAt || r.NextFiresAt || '') as string,
    lastFiredAt: (r.last_fired_at || r.lastFiredAt || r.LastFiredAt || null) as string | null,
    runCount: (r.run_count ?? r.runCount ?? r.RunCount ?? 0) as number,
    lastRunId: (r.last_run_id || r.lastRunId || r.LastRunID || null) as string | null,
    lastRunStatus: (r.last_run_status || r.lastRunStatus || r.LastRunStatus || null) as string | null,
    lastRunError: (r.last_run_error || r.lastRunError || r.LastRunError || null) as string | null,
    status: (r.status || r.Status || 'active') as string,
    createdBy: (r.created_by || r.createdBy || r.CreatedBy || '') as string,
    channelName: (r.channel_name || r.channelName || r.ChannelName || '') as string,
    createdAt: (r.created_at || r.createdAt || r.CreatedAt || null) as string | null,
  };
}

/** The fields a caller may write on a todo. */
export type TodoWritePayload = Pick<TodoItem, 'content' | 'status'> &
  Partial<Pick<TodoItem, 'assignee' | 'priority' | 'dueDate'>>;

/** A partial update of a single todo. */
export type TodoPatch = Partial<
  Pick<TodoItem, 'content' | 'status' | 'priority' | 'assignee' | 'position' | 'dueDate'>
>;

/**
 * Normalises one todo row from the API.
 *
 * There used to be two hand-written copies of this mapping, one per endpoint,
 * and neither carried `priority`, `routine_id` or `run_id`. The task board's
 * priority selector wrote a value the server stored and the client then threw
 * away on the way back, so every priority read as "none"; the "Scheduled" badge
 * could never appear for the same reason.
 */
export function normalizeTodo(t: Record<string, unknown>): TodoItem {
  return {
    id: (t.id || t.ID) as string,
    content: (t.content || t.Content) as string,
    status: (t.status || t.Status) as TodoItem['status'],
    priority: (t.priority || t.Priority || 'none') as TodoItem['priority'],
    assignee: (t.assignee || t.Assignee || '') as string,
    createdBy: (t.created_by || t.createdBy || t.CreatedBy || '') as string,
    channelName: (t.channel_name || t.channelName || t.ChannelName || '') as string,
    threadId: (t.thread_id || t.threadId || t.ThreadID || null) as string | null,
    position: (t.position ?? t.Position ?? 0) as number,
    routineId: (t.routine_id ?? t.routineId ?? t.RoutineID ?? null) as string | null,
    runId: (t.run_id ?? t.runId ?? t.RunID ?? null) as string | null,
    timerId: (t.timer_id ?? t.timerId ?? t.TimerID ?? null) as string | null,
    dueDate: (t.due_date ?? t.dueDate ?? t.DueDate ?? null) as string | null,
    completedAt: (t.completed_at ?? t.completedAt ?? t.CompletedAt ?? null) as string | null,
    createdAt: (t.created_at || t.createdAt || t.CreatedAt || null) as string | null,
    updatedAt: (t.updated_at || t.updatedAt || t.UpdatedAt || null) as string | null,
  };
}

function serializeTodo(todo: TodoWritePayload) {
  return {
    content: todo.content,
    status: todo.status,
    assignee: todo.assignee || '',
    priority: todo.priority || 'none',
    ...(todo.dueDate ? { due_date: todo.dueDate } : {}),
  };
}

export class PlanningApi extends BaseWorkspaceApi {
  async listTodos(): Promise<{ todos: TodoItem[] }> {
    const params = new URLSearchParams({ network: this.workspaceId, all: 'true' });
    const raw = await this.request<{ todos: Record<string, unknown>[] }>(`/v1/todos?${params}`);
    return { todos: (raw.todos || []).map(normalizeTodo) };
  }

  async replaceTodos(params: {
    source: string;
    channel: string;
    threadId?: string;
    todos: TodoWritePayload[];
  }): Promise<{ todos: TodoItem[] }> {
    const raw = await this.request<{ todos: Record<string, unknown>[] }>('/v1/todos', {
      method: 'PUT',
      body: JSON.stringify({
        network: this.workspaceId,
        source: params.source,
        channel: params.channel,
        ...(params.threadId ? { thread_id: params.threadId } : {}),
        todos: params.todos.map(serializeTodo),
      }),
    });
    return { todos: (raw.todos || []).map(normalizeTodo) };
  }

  /** Appends one task to a channel's list without rewriting the rest of it. */
  async createTodo(params: {
    source: string;
    channel: string;
    threadId?: string;
    todo: TodoWritePayload;
  }): Promise<TodoItem> {
    const raw = await this.request<Record<string, unknown>>('/v1/todos', {
      method: 'POST',
      body: JSON.stringify({
        network: this.workspaceId,
        source: params.source,
        channel: params.channel,
        ...(params.threadId ? { thread_id: params.threadId } : {}),
        ...serializeTodo(params.todo),
      }),
    });
    return normalizeTodo(raw);
  }

  /**
   * Updates one todo in place.
   *
   * Prefer this over `replaceTodos` for anything that touches a single task.
   * The PUT endpoint is a whole-list replace — it deletes and re-inserts every
   * row, minting new ids — so using it to flip one checkbox loses concurrent
   * edits from other agents and invalidates any id the UI was holding.
   */
  async updateTodo(todoId: string, patch: TodoPatch): Promise<TodoItem> {
    const raw = await this.request<Record<string, unknown>>(`/v1/todos/${todoId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        network: this.workspaceId,
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
        ...(patch.assignee !== undefined ? { assignee: patch.assignee } : {}),
        ...(patch.position !== undefined ? { position: patch.position } : {}),
        ...(patch.dueDate === null
          ? { clear_due_date: true }
          : patch.dueDate !== undefined
          ? { due_date: patch.dueDate }
          : {}),
      }),
    });
    return normalizeTodo(raw);
  }

  async deleteTodo(todoId: string): Promise<void> {
    await this.request<unknown>(`/v1/todos/${todoId}`, { method: 'DELETE' });
  }

  async cancelChannelTodos(channel: string, source: string): Promise<void> {
    const params = new URLSearchParams({ network: this.workspaceId, channel, source });
    const raw = await this.request<{ todos: Record<string, unknown>[] }>(`/v1/todos?${params}`);
    const todos = (raw.todos || []).map(normalizeTodo);
    const active = todos.filter((t) => t.status === 'pending' || t.status === 'in_progress');
    if (active.length === 0) return;
    // Cancel each open task individually. Rewriting the whole list here used to
    // reset every field the replace payload did not carry — priority and due
    // date included — as a side effect of cancelling.
    await Promise.all(active.map((t) => this.updateTodo(t.id, { status: 'cancelled' })));
  }

  async listTimers(channel?: string): Promise<{ timers: TimerItem[] }> {
    const params = new URLSearchParams({ network: this.workspaceId });
    if (channel) params.set('channel', channel);
    const raw = await this.request<{ timers: Record<string, unknown>[] }>(`/v1/timers?${params}`);
    return {
      timers: (raw.timers || []).map((t): TimerItem => ({
        id: (t.id || t.ID) as string,
        message: (t.message || t.Message) as string,
        delaySeconds: (t.delay_seconds ?? t.delaySeconds ?? t.DelaySeconds ?? 0) as number,
        firesAt: (t.fires_at || t.firesAt || t.FiresAt || '') as string,
        status: (t.status || t.Status || 'active') as string,
        createdBy: (t.created_by || t.createdBy || t.CreatedBy || '') as string,
        channelName: (t.channel_name || t.channelName || t.ChannelName || '') as string,
        createdAt: (t.created_at || t.createdAt || t.CreatedAt || null) as string | null,
      })),
    };
  }

  async createTimer(params: {
    source: string;
    channel: string;
    message: string;
    delaySeconds: number;
    threadId?: string;
  }): Promise<TimerItem> {
    const raw = await this.request<Record<string, unknown>>('/v1/timers', {
      method: 'POST',
      body: JSON.stringify({
        network: this.workspaceId,
        source: params.source,
        channel: params.channel,
        message: params.message,
        delay_seconds: params.delaySeconds,
        ...(params.threadId ? { thread_id: params.threadId } : {}),
      }),
    });
    return {
      id: (raw.id || raw.ID) as string,
      message: (raw.message || raw.Message) as string,
      delaySeconds: (raw.delay_seconds ?? raw.delaySeconds ?? raw.DelaySeconds ?? 0) as number,
      firesAt: (raw.fires_at || raw.firesAt || raw.FiresAt || '') as string,
      status: (raw.status || raw.Status || 'active') as string,
      createdBy: (raw.created_by || raw.createdBy || raw.CreatedBy || '') as string,
      channelName: (raw.channel_name || raw.channelName || raw.ChannelName || '') as string,
      createdAt: (raw.created_at || raw.createdAt || raw.CreatedAt || null) as string | null,
    };
  }

  async cancelTimer(timerId: string): Promise<void> {
    await this.request<unknown>(`/v1/timers/${timerId}`, { method: 'DELETE' });
  }

  async cancelQueuedMessage(channelName: string, queueId: string): Promise<void> {
    // sendEvent will be on the composite class
    await (this as unknown as { sendEvent: (e: Record<string, unknown>) => Promise<unknown> }).sendEvent({
      type: 'workspace.message.posted',
      source: 'human:user',
      target: `channel/${channelName}`,
      payload: {
        content: `__queue_cancel:${queueId}`,
        message_type: 'queue_cancel',
      },
    });
  }

  async listRoutines(): Promise<{ routines: RoutineItem[] }> {
    const params = new URLSearchParams({ network: this.workspaceId });
    const raw = await this.request<{ routines: Record<string, unknown>[] }>(`/v1/routines?${params}`);
    return {
      routines: (raw.routines || []).map(normalizeRoutine),
    };
  }

  async toggleRoutine(routineId: string): Promise<RoutineItem> {
    const raw = await this.request<Record<string, unknown>>(`/v1/routines/${routineId}/toggle`, {
      method: 'PATCH',
    });
    return normalizeRoutine(raw);
  }

  async triggerRoutine(routineId: string): Promise<void> {
    await this.request<unknown>(`/v1/routines/${routineId}/run`, {
      method: 'POST',
    });
  }

  async listRoutineRuns(routineId?: string): Promise<{ runs: RoutineRunItem[] }> {
    const params = new URLSearchParams({ network: this.workspaceId });
    if (routineId) params.set('routine_id', routineId);
    const raw = await this.request<{ runs: Record<string, unknown>[] }>(`/v1/routine-runs?${params}`);
    return {
      runs: (raw.runs || []).map((r) => ({
        id: (r.id || r.ID) as string,
        routineId: (r.routine_id || r.routineId || r.RoutineID) as string,
        routineShortId: (r.routine_short_id || r.routineShortId || r.RoutineShortID) as string,
        runNumber: (r.run_number ?? r.runNumber ?? r.RunNumber ?? 0) as number,
        channelName: (r.channel_name || r.channelName || r.ChannelName || '') as string,
        threadId: (r.thread_id ?? r.threadId ?? r.ThreadID ?? null) as string | null,
        agentName: (r.agent_name || r.agentName || r.AgentName || '') as string,
        triggerMessage: (r.trigger_message || r.triggerMessage || r.TriggerMessage || '') as string,
        status: (r.status || r.Status || 'running') as RoutineRunItem['status'],
        startedAt: (r.started_at || r.startedAt || r.StartedAt || '') as string,
        completedAt: (r.completed_at || r.completedAt || r.CompletedAt || null) as string | null,
        error: (r.error || r.Error || null) as string | null,
      })),
    };
  }

  async createRoutine(params: {
    name: string;
    message: string;
    source: string;
    hour?: number;
    minute?: number;
    days?: number[];
    interval_minutes?: number;
    timezone?: string;
    context?: string;
    conversation_history?: string;
  }): Promise<RoutineItem> {
    const raw = await this.request<Record<string, unknown>>('/v1/routines', {
      method: 'POST',
      body: JSON.stringify({
        ...params,
        // A daily schedule means a wall-clock time where the user is. Without a
        // zone the server stores UTC and "09:00" silently becomes whatever 09:00
        // UTC is locally.
        timezone: params.timezone || localTimezone(),
        network: this.workspaceId,
      }),
    });
    return normalizeRoutine(raw);
  }

  /**
   * Edits a schedule in place, keeping its short id, run counter and run
   * history. `scheduleMode` is required whenever the timing changes: the server
   * clears the fields belonging to the other mode, and a routine holding both an
   * interval and a time always runs on the interval.
   */
  async updateRoutine(
    routineId: string,
    patch: {
      name?: string;
      message?: string;
      context?: string;
      scheduleMode?: 'daily' | 'interval';
      hour?: number;
      minute?: number;
      days?: number[];
      intervalMinutes?: number;
      timezone?: string;
    }
  ): Promise<RoutineItem> {
    const raw = await this.request<Record<string, unknown>>(`/v1/routines/${routineId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.message !== undefined ? { message: patch.message } : {}),
        ...(patch.context !== undefined ? { context: patch.context } : {}),
        ...(patch.scheduleMode ? { schedule_mode: patch.scheduleMode } : {}),
        ...(patch.hour !== undefined ? { hour: patch.hour } : {}),
        ...(patch.minute !== undefined ? { minute: patch.minute } : {}),
        ...(patch.days !== undefined ? { days: patch.days } : {}),
        ...(patch.intervalMinutes !== undefined ? { interval_minutes: patch.intervalMinutes } : {}),
        ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
      }),
    });
    return normalizeRoutine(raw);
  }

  async cancelRoutine(routineId: string): Promise<void> {
    await this.request<unknown>(`/v1/routines/${routineId}`, { method: 'DELETE' });
  }

  async listNotifications(opts?: { status?: string; isRead?: boolean; limit?: number }): Promise<{ notifications: NotificationItem[]; unreadCount: number }> {
    const params = new URLSearchParams({ network: this.workspaceId });
    if (opts?.status) params.set('status', opts.status);
    if (opts?.isRead !== undefined) params.set('is_read', String(opts.isRead));
    if (opts?.limit) params.set('limit', String(opts.limit));
    const raw = await this.request<{ notifications: Record<string, unknown>[]; unread_count: number; unreadCount: number }>(`/v1/notifications?${params}`);
    return {
      notifications: (raw.notifications || []).map((n): NotificationItem => ({
        id: (n.id || n.ID) as string,
        type: (n.type || n.Type || 'info') as string,
        title: (n.title || n.Title) as string,
        body: (n.body || n.Body || n.message || n.Message || '') as string,
        message: (n.message || n.Message) as string,
        priority: (n.priority || n.Priority || 'normal') as NotificationItem['priority'],
        isRead: !!(n.is_read || n.IsRead || n.isRead || n.read),
        createdBy: (n.created_by || n.createdBy || n.CreatedBy || '') as string,
        channelName: (n.channel_name ?? n.channelName ?? n.ChannelName ?? null) as string | null,
        threadId: (n.thread_id ?? n.threadId ?? n.ThreadID ?? null) as string | null,
        linkUrl: (n.link_url ?? n.linkUrl ?? n.LinkURL ?? null) as string | null,
        status: (n.status || n.Status || 'active') as string,
        createdAt: (n.created_at || n.createdAt || n.CreatedAt || null) as string | null,
        readAt: (n.read_at || n.readAt || n.ReadAt || null) as string | null,
      })),
      unreadCount: raw.unread_count || raw.unreadCount || 0,
    };
  }

  async markNotificationRead(notificationId: string): Promise<void> {
    await this.request<unknown>(`/v1/notifications/${notificationId}/read`, { method: 'PATCH' });
  }

  async markAllNotificationsRead(): Promise<void> {
    await this.request<unknown>(`/v1/notifications/read-all?network=${this.workspaceId}`, { method: 'PATCH' });
  }

  async dismissNotification(notificationId: string): Promise<void> {
    await this.request<unknown>(`/v1/notifications/${notificationId}`, { method: 'DELETE' });
  }

  async createShare(channelName: string, createdBy?: string): Promise<ShareSummary> {
    const raw = await this.request<Record<string, unknown>>('/v1/shares', {
      method: 'POST',
      body: JSON.stringify({
        network: this.workspaceId,
        channel: channelName,
        created_by: createdBy || 'human:user',
      }),
    });
    const token = String(raw.share_token || raw.token || raw.id || '');
    return {
      token,
      shareToken: token,
      title: String(raw.title || channelName),
      channelName: String(raw.channel_name || channelName),
      createdBy: String(raw.created_by || createdBy || 'human:user'),
      createdAt: (raw.created_at || null) as string | null,
      messageCount: Number(raw.message_count || 0),
    };
  }

  async deleteShare(shareId: string): Promise<void> {
    await this.request<unknown>(`/v1/shares/${shareId}?network=${this.workspaceId}`, {
      method: 'DELETE',
    });
  }
}
