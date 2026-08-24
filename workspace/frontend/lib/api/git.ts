import type { GitStatus } from '../use-git-status';
import { BaseWorkspaceApi } from './base';

export class GitApi extends BaseWorkspaceApi {
  async getGitStatus(channelId: string): Promise<GitStatus> {
    const params = new URLSearchParams({ network: this.requireWorkspace(), channel: channelId });
    return this.request<GitStatus>(`/v1/git/status?${params}`);
  }

  async stageGitFiles(channelId: string, files: string[]): Promise<void> {
    const params = new URLSearchParams({ network: this.requireWorkspace(), channel: channelId });
    await this.request<unknown>(`/v1/git/stage?${params}`, {
      method: 'POST',
      body: JSON.stringify({ files }),
    });
  }

  async unstageGitFiles(channelId: string, files: string[]): Promise<void> {
    const params = new URLSearchParams({ network: this.requireWorkspace(), channel: channelId });
    await this.request<unknown>(`/v1/git/unstage?${params}`, {
      method: 'POST',
      body: JSON.stringify({ files }),
    });
  }

  async fetchGitRemote(channelId: string): Promise<{ output: string }> {
    const params = new URLSearchParams({ network: this.requireWorkspace(), channel: channelId });
    return this.request<{ output: string }>(`/v1/git/fetch?${params}`, { method: 'POST' });
  }

  async pullGitRemote(channelId: string): Promise<{ output: string }> {
    const params = new URLSearchParams({ network: this.requireWorkspace(), channel: channelId });
    return this.request<{ output: string }>(`/v1/git/pull?${params}`, { method: 'POST' });
  }

  async pushGitRemote(channelId: string): Promise<{ output: string; branch: string }> {
    const params = new URLSearchParams({ network: this.requireWorkspace(), channel: channelId });
    return this.request<{ output: string; branch: string }>(`/v1/git/push?${params}`, { method: 'POST' });
  }

  async createGitCommit(channelId: string, message: string, autoStage: boolean = false): Promise<void> {
    const params = new URLSearchParams({ network: this.requireWorkspace(), channel: channelId });
    await this.request<unknown>(`/v1/git/commit?${params}`, {
      method: 'POST',
      body: JSON.stringify({ message, auto_stage: autoStage }),
    });
  }

  async getGitDiff(channelId: string, filePath?: string): Promise<{ status: string; diff: string; path?: string }> {
    const params = new URLSearchParams({ network: this.requireWorkspace(), channel: channelId });
    if (filePath) params.set('path', filePath);
    return this.request<{ status: string; diff: string; path?: string }>(`/v1/git/diff?${params}`);
  }

  async discardGitChanges(channelId: string, files: string[]): Promise<void> {
    const params = new URLSearchParams({ network: this.requireWorkspace(), channel: channelId });
    await this.request<unknown>(`/v1/git/discard?${params}`, {
      method: 'POST',
      body: JSON.stringify({ files }),
    });
  }

  async rollbackTurn(channelId: string, turnId: string, force: boolean = false): Promise<{ status: string; turn_id: string; reverted: string[]; failed?: Record<string, string> }> {
    const params = new URLSearchParams({ network: this.requireWorkspace() });
    return this.request<{ status: string; turn_id: string; reverted: string[]; failed?: Record<string, string> }>(
      `/v1/git/turn-rollback?${params}`,
      {
        method: 'POST',
        body: JSON.stringify({ turn_id: turnId, force }),
      },
    );
  }
}
