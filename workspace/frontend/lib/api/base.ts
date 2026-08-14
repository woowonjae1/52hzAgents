import { getApiBaseUrl } from '../config';

export class BaseWorkspaceApi {
  protected token: string = '';
  protected bearerToken: string = '';
  protected workspaceId: string = '';

  configure(workspaceId: string, token: string, bearerToken?: string) {
    this.workspaceId = workspaceId;
    this.token = token;
    if (bearerToken !== undefined) this.bearerToken = bearerToken;
  }

  setWorkspaceId(workspaceId: string) {
    if (workspaceId) this.workspaceId = workspaceId;
  }

  setBearerToken(bearerToken: string) {
    this.bearerToken = bearerToken;
  }

  getSSEUrl(channelName: string): string {
    const params = new URLSearchParams({
      network: this.workspaceId,
      channel: channelName,
    });
    if (this.token) params.set('token', this.token);
    return `${getApiBaseUrl()}/v1/events/stream?${params}`;
  }

  isConfigured(): boolean {
    return this.workspaceId !== '';
  }

  requireWorkspace(): string {
    if (this.workspaceId === '') {
      throw new Error('WorkspaceApi not configured yet (workspaceId is empty)');
    }
    return this.workspaceId;
  }

  async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const authHeaders: Record<string, string> = {};
    if (this.token) {
      authHeaders['X-Workspace-Token'] = this.token;
    }
    if (this.bearerToken) {
      authHeaders['Authorization'] = `Bearer ${this.bearerToken}`;
    }

    const url = `${getApiBaseUrl()}${path}`;
    const res = await fetch(url, {
      ...options,
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
        ...options.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`API ${res.status}: ${body}`);
    }

    const json = await res.json();
    return (json && typeof json === 'object' && 'data' in json ? json.data : json) as T;
  }
}
