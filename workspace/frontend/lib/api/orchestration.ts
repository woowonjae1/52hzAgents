import { BaseWorkspaceApi } from './base';

/**
 * Orchestration: the parallel batch a thread is running, and the router model
 * that dynamic mode uses to choose the next speaker.
 */

export type ParallelBatchState = 'idle' | 'running' | 'blocked' | 'done';

export interface ParallelTask {
  id: string;
  content: string;
  status: string;
  assignee: string;
  scope?: string | null;
}

export interface ParallelWorker {
  assignee: string;
  scope: string;
  tasks: ParallelTask[];
  done: number;
  total: number;
  running: boolean;
}

export interface ScopeConflict {
  assignee_a: string;
  assignee_b: string;
  scope_a: string;
  scope_b: string;
  reason: string;
}

export interface ParallelBatch {
  mode: string;
  state: ParallelBatchState;
  workers: ParallelWorker[];
  conflicts: ScopeConflict[];
  done: number;
  total: number;
}

export type RouterProvider = 'openai' | 'anthropic';

export interface RouterConfig {
  enabled: boolean;
  provider: RouterProvider;
  model: string;
  /** Masked when it comes back from the server; see RouterConfigResponse. */
  api_key: string;
  base_url?: string | null;
  /** What the last real routing call did: '', 'ok' or 'failed'. */
  last_status?: string;
  last_error?: string | null;
  last_checked_at?: string | null;
}

export interface RouterTestResult {
  ok: boolean;
  reason?: string;
  reply?: string;
}

export interface RouterConfigResponse {
  /** 'workspace' when saved here, 'env' when it is still the process default. */
  source: 'workspace' | 'env';
  config: RouterConfig;
}

export class OrchestrationApi extends BaseWorkspaceApi {
  async getParallelBatch(channelName: string): Promise<ParallelBatch> {
    const params = new URLSearchParams({ network: this.requireWorkspace(), channel: channelName });
    return this.request<ParallelBatch>(`/v1/parallel-batch?${params}`);
  }

  async getRouterConfig(): Promise<RouterConfigResponse> {
    const params = new URLSearchParams({ network: this.requireWorkspace() });
    return this.request<RouterConfigResponse>(`/v1/router-config?${params}`);
  }

  /**
   * Saves the router configuration. Omitted fields are left alone, and a blank
   * or still-masked key keeps the stored one — so saving after only changing
   * the model does not wipe the key the user typed earlier.
   */
  async updateRouterConfig(updates: Partial<RouterConfig>): Promise<RouterConfigResponse> {
    const params = new URLSearchParams({ network: this.requireWorkspace() });
    return this.request<RouterConfigResponse>(`/v1/router-config?${params}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  }

  /** Makes one real call with the stored settings and reports what happened. */
  async testRouterConfig(): Promise<RouterTestResult> {
    const params = new URLSearchParams({ network: this.requireWorkspace() });
    return this.request<RouterTestResult>(`/v1/router-config/test?${params}`, { method: 'POST' });
  }
}
