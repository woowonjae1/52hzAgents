import type { ActivityCommitsResponse, ActivityTurnsResponse } from '../generated/api-types';
import { BaseWorkspaceApi } from './base';

export class ActivityApi extends BaseWorkspaceApi {
  /** Commits in the workspace's own repositories, newest first. Read from local git. */
  async getActivityCommits(weeks: number, refresh = false): Promise<ActivityCommitsResponse> {
    const params = new URLSearchParams({ weeks: String(weeks) });
    if (refresh) params.set('refresh', '1');
    return this.request<ActivityCommitsResponse>(`/v1/workspaces/${this.workspaceId}/activity/commits?${params}`);
  }

  /** Agent turns overlapping [from, to), both unix milliseconds in the caller's own day. */
  async getActivityTurns(from: number, to: number): Promise<ActivityTurnsResponse> {
    const params = new URLSearchParams({ from: String(from), to: String(to) });
    return this.request<ActivityTurnsResponse>(`/v1/workspaces/${this.workspaceId}/activity/turns?${params}`);
  }
}
