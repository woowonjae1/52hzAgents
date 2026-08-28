import { getStoredAuth, refreshAccessToken } from './auth';
import { getApiBaseUrl } from './config';

export interface WorkspaceSummary {
  workspaceId: string;
  slug: string;
  name: string;
  status: string;
  /**
   * GET /v1/ws deliberately omits this — the backend stores only a hash of the
   * workspace token and must not leak the plaintext to a list endpoint. Callers
   * have to resolve the real token from wherever the browser cached it when the
   * workspace was created or last opened.
   */
  token?: string;
  agentCount: number;
  createdAt: string | null;
  lastActivityAt: string | null;
}

export interface PaginatedWorkspaces {
  items: WorkspaceSummary[];
  pagination: {
    page: number;
    page_size: number;
    total: number | null;
    total_pages: number | null;
    has_next: boolean;
    has_prev: boolean;
  };
}

async function authFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const { accessToken } = getStoredAuth();

  const doFetch = async (token?: string) => {
    const authHeaders: Record<string, string> = {};
    if (token) {
      authHeaders['Authorization'] = `Bearer ${token}`;
    }
    return fetch(`${getApiBaseUrl()}${path}`, {
      ...options,
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
        ...options.headers,
      },
    });
  };

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let res = await doFetch(accessToken || undefined);

      if (res.status === 401 && accessToken) {
        const newToken = await refreshAccessToken();
        if (!newToken) throw new Error('Session expired');
        res = await doFetch(newToken);
      }

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || body?.detail || `API error (${res.status})`);
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

export async function listMyWorkspaces(
  page = 1,
  pageSize = 50,
  status?: string,
): Promise<PaginatedWorkspaces> {
  let url = `/v1/ws?page=${page}&page_size=${pageSize}`;
  if (status) url += `&status=${status}`;
  return authFetch<PaginatedWorkspaces>(url);
}

export async function createWorkspace(
  agentName: string,
  name?: string,
): Promise<{
  workspaceId: string;
  slug: string;
  name: string;
  token: string;
  url: string;
}> {
  return authFetch('/v1/ws', {
    method: 'POST',
    body: JSON.stringify({ agent_name: agentName, name: name || `${agentName}'s Workspace` }),
  });
}
