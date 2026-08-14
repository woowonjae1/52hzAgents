import type {
  NotificationItem,
  RoutineItem,
  ShareSummary,
  TimerItem,
  TodoItem,
} from '../types';
import { BaseWorkspaceApi } from './base';

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

export class PlanningApi extends BaseWorkspaceApi {
  async listTodos(): Promise<{ todos: TodoItem[] }> {
    const params = new URLSearchParams({ network: this.workspaceId, all: 'true' });
    const raw = await this.request<{ todos: Record<string, unknown>[] }>(`/v1/todos?${params}`);
    return {
      todos: (raw.todos || []).map((t): TodoItem => ({
        id: (t.id || t.ID) as string,
        content: (t.content || t.Content) as string,
        status: (t.status || t.Status) as TodoItem['status'],
        assignee: (t.assignee || t.Assignee) as string,
        createdBy: (t.created_by || t.createdBy || t.CreatedBy || '') as string,
        channelName: (t.channel_name || t.channelName || t.ChannelName || '') as string,
        threadId: (t.thread_id || t.threadId || t.ThreadID || null) as string | null,
        position: (t.position ?? t.Position ?? 0) as number,
        createdAt: (t.created_at || t.createdAt || t.CreatedAt || null) as string | null,
        updatedAt: (t.updated_at || t.updatedAt || t.UpdatedAt || null) as string | null,
      })),
    };
  }

  async replaceTodos(params: {
    source: string;
    channel: string;
    threadId?: string;
    todos: Array<Pick<TodoItem, 'content' | 'status' | 'assignee'>>;
  }): Promise<{ todos: TodoItem[] }> {
    const raw = await this.request<{ todos: Record<string, unknown>[] }>('/v1/todos', {
      method: 'PUT',
      body: JSON.stringify({
        network: this.workspaceId,
        source: params.source,
        channel: params.channel,
        ...(params.threadId ? { thread_id: params.threadId } : {}),
        todos: params.todos,
      }),
    });
    return {
      todos: (raw.todos || []).map((t): TodoItem => ({
        id: (t.id || t.ID) as string,
        content: (t.content || t.Content) as string,
        status: (t.status || t.Status) as TodoItem['status'],
        assignee: (t.assignee || t.Assignee) as string,
        createdBy: (t.created_by || t.createdBy || t.CreatedBy || '') as string,
        channelName: (t.channel_name || t.channelName || t.ChannelName || '') as string,
        threadId: (t.thread_id || t.threadId || t.ThreadID || null) as string | null,
        position: (t.position ?? t.Position ?? 0) as number,
        createdAt: (t.created_at || t.createdAt || t.CreatedAt || null) as string | null,
        updatedAt: (t.updated_at || t.updatedAt || t.UpdatedAt || null) as string | null,
      })),
    };
  }

  async cancelChannelTodos(channel: string, source: string): Promise<void> {
    const params = new URLSearchParams({ network: this.workspaceId, channel, source });
    const raw = await this.request<{ todos: Record<string, unknown>[] }>(`/v1/todos?${params}`);
    const todos = raw.todos || [];
    const hasActive = todos.some((t) => (t.status || t.Status) === 'pending' || (t.status || t.Status) === 'in_progress');
    if (!hasActive) return;
    const updated = todos.map((t) => ({
      content: (t.content || t.Content) as string,
      status: ((t.status || t.Status) === 'pending' || (t.status || t.Status) === 'in_progress') ? 'cancelled' : (t.status || t.Status) as string,
      assignee: (t.assignee || t.Assignee) as string,
    }));
    await this.request<unknown>('/v1/todos', {
      method: 'PUT',
      body: JSON.stringify({
        todos: updated,
        network: this.workspaceId,
        channel,
        source,
      }),
    });
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
      routines: (raw.routines || []).map((r) => ({
        id: (r.id || r.ID) as string,
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
        status: (r.status || r.Status || 'active') as string,
        createdBy: (r.created_by || r.createdBy || r.CreatedBy || '') as string,
        channelName: (r.channel_name || r.channelName || r.ChannelName || '') as string,
        createdAt: (r.created_at || r.createdAt || r.CreatedAt || null) as string | null,
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
    conversation_history?: string;
  }): Promise<RoutineItem> {
    const raw = await this.request<Record<string, unknown>>('/v1/routines', {
      method: 'POST',
      body: JSON.stringify({
        ...params,
        network: this.workspaceId,
      }),
    });
    return {
      id: (raw.id || raw.ID) as string,
      name: (raw.name || raw.Name) as string,
      message: (raw.message || raw.Message) as string,
      context: (raw.context ?? raw.Context ?? null) as string | null,
      scheduleHour: (raw.schedule_hour ?? raw.scheduleHour ?? raw.ScheduleHour ?? 0) as number,
      scheduleMinute: (raw.schedule_minute ?? raw.scheduleMinute ?? raw.ScheduleMinute ?? 0) as number,
      scheduleDays: parseScheduleDays(raw.schedule_days ?? raw.scheduleDays ?? raw.ScheduleDays),
      scheduleIntervalMinutes: (raw.schedule_interval_minutes ?? raw.scheduleIntervalMinutes ?? raw.ScheduleIntervalMinutes ?? null) as number | null,
      timezone: (raw.timezone || raw.Timezone || 'UTC') as string,
      nextFiresAt: (raw.next_fires_at || raw.nextFiresAt || raw.NextFiresAt || '') as string,
      lastFiredAt: (raw.last_fired_at || raw.lastFiredAt || raw.LastFiredAt || null) as string | null,
      status: (raw.status || raw.Status || 'active') as string,
      createdBy: (raw.created_by || raw.createdBy || raw.CreatedBy || '') as string,
      channelName: (raw.channel_name || raw.channelName || raw.ChannelName || '') as string,
      createdAt: (raw.created_at || raw.createdAt || raw.CreatedAt || null) as string | null,
    };
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
