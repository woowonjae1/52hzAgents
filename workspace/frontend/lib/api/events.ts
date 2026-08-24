import type {
  DMConversation,
  EventConfirmation,
  EventPollResponse,
  MessagePollResponse,
  ONMEvent,
  WorkspaceSession,
} from '../types';
import { eventToMessage } from '../types';
import { BaseWorkspaceApi } from './base';

export class EventsApi extends BaseWorkspaceApi {
  async createChannel(opts: {
    title?: string;
    master?: string;
    participants?: string[];
    resumeFrom?: string;
  } = {}): Promise<WorkspaceSession> {
    const event = await this.sendEvent({
      type: 'network.channel.create',
      source: 'human:user',
      target: 'core',
      payload: {
        ...(opts.title && { title: opts.title }),
        ...(opts.master && { master: opts.master }),
        ...(opts.participants && { participants: opts.participants }),
        ...(opts.resumeFrom && { resume_from: opts.resumeFrom }),
      },
    });

    const channelName = (event.metadata?.channel_name as string) || '';
    return {
      sessionId: channelName,
      workspaceId: this.workspaceId,
      createdBy: 'human:user',
      title: opts.title || 'New Channel',
      status: 'active',
      starred: false,
      participants: opts.participants || [],
      master: opts.master || null,
      orchestrationMode: 'dynamic',
      orchestrationInstruction: null,
      createdAt: event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString(),
      lastEventAt: null,
      workingDir: null,
      verificationCmd: null,
    };
  }

  async addChannelParticipant(channelName: string, agentName: string): Promise<void> {
    await this.sendEvent({
      type: 'network.channel.join',
      source: 'human:user',
      target: `channel/${channelName}`,
      payload: { channel: channelName, agent_name: agentName },
    });
  }

  async removeChannelParticipant(channelName: string, agentName: string): Promise<void> {
    await this.sendEvent({
      type: 'network.channel.leave',
      source: 'human:user',
      target: `channel/${channelName}`,
      payload: { channel: channelName, agent_name: agentName },
    });
  }

  async sendMessage(
    channelName: string,
    content: string,
    senderName = 'user',
    mentions?: string[],
    attachments?: { fileId: string; filename: string; contentType: string; url: string }[],
    senderId?: string,
    clientMessageId?: string,
  ): Promise<EventConfirmation> {
    return this.sendEvent({
      type: 'workspace.message.posted',
      source: `human:${senderId || senderName}`,
      target: `channel/${channelName}`,
      payload: {
        content,
        sender_type: 'human',
        ...(senderId ? { sender_id: senderId } : {}),
        sender_name: senderName,
        ...(mentions && mentions.length > 0 ? { mentions } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      },
      visibility: 'channel',
      client_message_id: clientMessageId,
    });
  }

  async pollMessages(channelName: string, after?: string): Promise<MessagePollResponse> {
    const result = await this.pollEvents({
      channel: channelName,
      type: 'workspace.message',
      after,
      limit: 200,
    });

    return {
      messages: result.events.map(eventToMessage),
      hasMore: result.has_more,
    };
  }

  async sendComposing(channelName: string): Promise<void> {
    try {
      await this.request<unknown>('/v1/composing', {
        method: 'POST',
        body: JSON.stringify({ network: this.workspaceId, channel: channelName }),
      });
    } catch {
      // Fire-and-forget
    }
  }

  async sendAgentControl(
    agentName: string,
    action: string,
    params: Record<string, unknown> = {},
  ): Promise<EventConfirmation> {
    return this.sendEvent({
      type: 'workspace.agent.control',
      source: 'human:user',
      target: `openagents:${agentName}`,
      payload: { action, ...params },
      visibility: 'direct',
    });
  }

  async sendEvent(event: {
    type: string;
    source: string;
    target: string;
    payload?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    visibility?: string;
    client_message_id?: string;
  }): Promise<EventConfirmation> {
    const network = this.requireWorkspace();
    return this.request<EventConfirmation>('/v1/events', {
      method: 'POST',
      body: JSON.stringify({ ...event, network }),
    });
  }

  async pollEvents(opts: {
    after?: string;
    before?: string;
    target?: string;
    channel?: string;
    type?: string;
    search?: string;
    sort?: 'asc' | 'desc';
    limit?: number;
  } = {}): Promise<EventPollResponse> {
    const params = new URLSearchParams({ network: this.requireWorkspace() });
    if (opts.after) params.set('after', opts.after);
    if (opts.before) params.set('before', opts.before);
    if (opts.target) params.set('target', opts.target);
    if (opts.channel) params.set('channel', opts.channel);
    if (opts.type) params.set('type', opts.type);
    if (opts.search) params.set('search', opts.search);
    if (opts.sort) params.set('sort', opts.sort);
    if (opts.limit) params.set('limit', String(opts.limit));
    return this.request<EventPollResponse>(`/v1/events?${params}`);
  }

  async loadMessageHistory(
    channelName: string,
    options?: { before?: string; limit?: number },
  ): Promise<EventPollResponse> {
    return this.pollEvents({
      channel: channelName,
      type: 'workspace.message',
      before: options?.before,
      sort: 'desc',
      limit: options?.limit ?? 50,
    });
  }

  async searchMessages(query: string): Promise<{ channelName: string; snippet: string; messageId: string }[]> {
    const result = await this.pollEvents({
      type: 'workspace.message',
      search: query,
      limit: 50,
    });
    return result.events.map((e) => ({
      channelName: e.target.replace(/^channel\//, ''),
      snippet: (e.payload as Record<string, string>)?.content || '',
      messageId: e.event_id,
    }));
  }

  async listConversations(agentFilter?: string): Promise<DMConversation[]> {
    const params = new URLSearchParams({ network: this.workspaceId });
    if (agentFilter) params.set('agent', agentFilter);
    const result = await this.request<{ conversations: Array<{
      agents: [string, string];
      last_message: { content: string; sender: string; timestamp: number };
      message_count: number;
    }> }>(`/v1/events/conversations?${params}`);
    return result.conversations.map((c) => ({
      agents: c.agents,
      lastMessage: c.last_message,
      messageCount: c.message_count,
    }));
  }

  async pollConversation(
    agentA: string,
    agentB: string,
    opts?: { after?: string; before?: string; sort?: 'asc' | 'desc'; limit?: number },
  ): Promise<EventPollResponse> {
    const params = new URLSearchParams({ network: this.workspaceId });
    params.set('conversation', `${agentA},${agentB}`);
    params.set('type', 'workspace.message');
    if (opts?.after) params.set('after', opts.after);
    if (opts?.before) params.set('before', opts.before);
    if (opts?.sort) params.set('sort', opts.sort);
    if (opts?.limit) params.set('limit', String(opts.limit));
    return this.request<EventPollResponse>(`/v1/events?${params}`);
  }

  async latestPerChannel(): Promise<{ channels: Record<string, ONMEvent> }> {
    const params = new URLSearchParams({ network: this.workspaceId });
    return this.request<{ channels: Record<string, ONMEvent> }>(`/v1/events/latest-per-channel?${params}`);
  }
}
