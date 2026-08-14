import type {
  BrowserPersistentContext,
  BrowserTab,
} from '../types';
import { getApiBaseUrl } from '../config';
import { BaseWorkspaceApi } from './base';

export class BrowserApi extends BaseWorkspaceApi {
  private mapTab(t: Record<string, unknown>): BrowserTab {
    return {
      id: t.id as string,
      url: t.url as string,
      title: (t.title as string) || null,
      status: t.status as string,
      targetAgentName: (t.target_agent_name || t.targetAgentName || null) as string | null,
      createdBy: (t.created_by as string) || 'unknown',
      sharedWith: (t.shared_with as string[]) || [],
      liveUrl: (t.live_url as string) || null,
      sessionId: (t.session_id as string) || null,
      contextId: (t.context_id as string) || null,
      createdAt: (t.created_at as string) || null,
      lastActivityAt: (t.last_active_at || t.lastActivityAt || null) as string | null,
    };
  }

  private mapContext(c: Record<string, unknown>): BrowserPersistentContext {
    return {
      id: c.id as string,
      name: c.name as string,
      domain: (c.domain as string) || null,
      status: (c.status as string) || 'active',
      createdBy: (c.created_by as string) || 'unknown',
      sharedWith: (c.shared_with as string[]) || [],
      createdAt: (c.created_at as string) || null,
      lastUsedAt: (c.last_used_at as string) || null,
    };
  }

  async listBrowserTabs(): Promise<{ tabs: BrowserTab[]; total: number }> {
    const result = await this.request<{ tabs: unknown[]; total: number }>(
      `/v1/browser/tabs?network=${this.workspaceId}`
    );
    return {
      tabs: (result.tabs as Record<string, unknown>[]).map((t) => this.mapTab(t)),
      total: result.total,
    };
  }

  async openBrowserTab(url = 'about:blank', contextId?: string): Promise<BrowserTab> {
    const body: Record<string, unknown> = { url, network: this.workspaceId, source: 'human:user' };
    if (contextId) body.context_id = contextId;
    const result = await this.request<Record<string, unknown>>('/v1/browser/tabs', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return this.mapTab(result);
  }

  async validateBrowserTab(tabId: string): Promise<BrowserTab> {
    const result = await this.request<Record<string, unknown>>(
      `/v1/browser/tabs/${tabId}?validate=true`,
    );
    return this.mapTab(result);
  }

  async reconnectBrowserTab(tabId: string): Promise<BrowserTab> {
    const result = await this.request<Record<string, unknown>>(
      `/v1/browser/tabs/${tabId}/reconnect`,
      { method: 'POST' },
    );
    return this.mapTab(result);
  }

  async navigateBrowserTab(tabId: string, url: string): Promise<BrowserTab> {
    const result = await this.request<Record<string, unknown>>(
      `/v1/browser/tabs/${tabId}/navigate`,
      { method: 'POST', body: JSON.stringify({ url }) },
    );
    return this.mapTab(result);
  }

  async closeBrowserTab(tabId: string): Promise<void> {
    await this.request<unknown>(`/v1/browser/tabs/${tabId}`, { method: 'DELETE' });
  }

  getBrowserScreenshotUrl(tabId: string): string {
    return `${getApiBaseUrl()}/v1/browser/tabs/${tabId}/screenshot`;
  }

  async unpersistBrowserTab(tabId: string): Promise<BrowserTab> {
    const result = await this.request<Record<string, unknown>>(
      `/v1/browser/tabs/${tabId}/unpersist`,
      { method: 'POST' },
    );
    return this.mapTab(result);
  }

  async persistBrowserTab(tabId: string, name: string): Promise<{ tab: BrowserTab; context: BrowserPersistentContext }> {
    const result = await this.request<{ tab: Record<string, unknown>; context: Record<string, unknown> }>(
      `/v1/browser/tabs/${tabId}/persist`,
      { method: 'POST', body: JSON.stringify({ name }) },
    );
    return { tab: this.mapTab(result.tab), context: this.mapContext(result.context) };
  }

  async listBrowserContexts(): Promise<{ contexts: BrowserPersistentContext[]; total: number }> {
    const result = await this.request<{ contexts: unknown[]; total: number }>(
      `/v1/browser/contexts?network=${this.workspaceId}`,
    );
    return {
      contexts: (result.contexts as Record<string, unknown>[]).map((c) => this.mapContext(c)),
      total: result.total,
    };
  }

  async deleteBrowserContext(contextId: string): Promise<void> {
    await this.request<unknown>(`/v1/browser/contexts/${contextId}`, { method: 'DELETE' });
  }
}
