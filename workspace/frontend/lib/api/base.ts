import { getApiBaseUrl } from '../config';

export class BaseWorkspaceApi {
  protected token: string = '';
  protected bearerToken: string = '';
  protected workspaceId: string = '52hz';

  configure(workspaceId: string, token: string, bearerToken?: string) {
    this.workspaceId = workspaceId || '52hz';
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
    return this.workspaceId || '52hz';
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
    let lastErr: unknown;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
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
      } catch (err: unknown) {
        lastErr = err;
        const isNetworkErr =
          err instanceof TypeError &&
          (err.message.includes('fetch') ||
            err.message.includes('network') ||
            err.message.includes('Failed') ||
            err.message.includes('NetworkError'));
        if (isNetworkErr && attempt < 2) {
          await new Promise((r) => setTimeout(r, (attempt + 1) * 350));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }
}
