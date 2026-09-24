import type * as Wire from '../generated/api-types';
import { BaseWorkspaceApi } from './base';

/**
 * Orchestration: the parallel batch a thread is running, and the router model
 * that dynamic mode uses to choose the next speaker.
 *
 * The parallel-batch shapes are the Go structs' generated wire types
 * (lib/generated/api-types.ts), with the free-form `string` status fields
 * narrowed to the values the UI switches on.
 */

/**
 * `T` with some fields narrowed. Every key in `N` must already exist on `T`
 * and its type must fit the wire type, so a field the backend renames or
 * retypes is a compile error here instead of a silently re-added property.
 */
type Narrow<T, N extends { [K in keyof N]: K extends keyof T ? T[K] : never }> = Omit<T, keyof N> & N;

export type ParallelBatchState = 'idle' | 'running' | 'blocked' | 'done';

/** A task in a worker's lane: the whole todo row, as the server sends it. */
export type ParallelTask = Wire.TodoRecord;

export type ParallelWorker = Wire.ParallelWorker;

export type ScopeConflict = Wire.ScopeConflict;

export type ParallelLaneStatus = 'running' | 'done' | 'failed' | 'merged' | 'conflict' | 'kept';

/** One agent's share of a started batch. `port` 0 = no dev-server port reserved. */
export type ParallelLane = Narrow<Wire.ParallelLaneRecord, { status: ParallelLaneStatus }>;

/** A batch that was actually started, with its lanes. */
export type ParallelRun = Narrow<
  Wire.ParallelRunView,
  {
    batch: Narrow<
      Wire.ParallelBatchRecord,
      {
        isolation: 'worktree' | 'shared';
        origin: 'board' | 'mention';
        status: 'running' | 'done';
      }
    >;
    lanes: ParallelLane[];
  }
>;

/**
 * What a channel's parallel batch is doing. `isolated`: the channel folder is a
 * git repository, so lanes run in their own worktrees. `run`: the latest batch
 * actually started in this channel.
 */
export type ParallelBatch = Narrow<Wire.ParallelBatch, { state: ParallelBatchState; run?: ParallelRun | null }>;

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

  /** Run a failed lane again, on its own worktree. */
  async retryParallelLane(batchId: string, agent: string): Promise<void> {
    await this.request(
      `/v1/workspaces/${this.requireWorkspace()}/parallel-batches/${encodeURIComponent(batchId)}/lanes/${encodeURIComponent(agent)}/retry`,
      { method: 'POST' }
    );
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
