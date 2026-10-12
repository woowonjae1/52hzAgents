import type { WorkspaceFile } from '../types';
import { getApiBaseUrl } from '../config';
import { BaseWorkspaceApi } from './base';

export function mapFileResponse(raw: Record<string, unknown>): WorkspaceFile {
  return {
    id: (raw.id || raw.ID) as string,
    filename: (raw.filename || raw.Filename) as string,
    contentType: (raw.content_type || raw.contentType || raw.ContentType || 'application/octet-stream') as string,
    size: (raw.size ?? raw.Size ?? 0) as number,
    uploadedBy: (raw.uploaded_by || raw.uploadedBy || raw.UploadedBy || 'unknown') as string,
    channelName: (raw.channel_name ?? raw.channelName ?? raw.ChannelName ?? null) as string | null,
    status: (raw.status || raw.Status || 'active') as string,
    createdAt: (raw.created_at || raw.createdAt || raw.CreatedAt || null) as string | null,
  };
}

export class FilesApi extends BaseWorkspaceApi {
  async uploadFile(file: File, channelName?: string): Promise<WorkspaceFile> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('network', this.workspaceId);
    if (channelName) formData.append('channel_name', channelName);

    const authHeaders: Record<string, string> = {};
    if (this.token) authHeaders['X-Workspace-Token'] = this.token;
    if (this.bearerToken) authHeaders['Authorization'] = `Bearer ${this.bearerToken}`;

    const url = `${getApiBaseUrl()}/v1/files`;
    const res = await fetch(url, {
      method: 'POST',
      headers: authHeaders,
      body: formData,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Upload failed: ${body}`);
    }

    const json = await res.json();
    const raw = json && typeof json === 'object' && 'data' in json ? json.data : json;
    return mapFileResponse(raw as Record<string, unknown>);
  }

  async listFiles(): Promise<{ files: WorkspaceFile[]; total: number }> {
    const raw = await this.request<{ files: Record<string, unknown>[]; total: number }>(
      `/v1/files?network=${this.workspaceId}`
    );
    return {
      files: raw.files.map(mapFileResponse),
      total: raw.total,
    };
  }

  getFileUrl(fileId: string, options?: { inline?: boolean; download?: boolean; includeToken?: boolean }): string {
    const params = new URLSearchParams();
    if (this.workspaceId) params.set('network', this.workspaceId);
    if (this.token && options?.includeToken !== false) params.set('token', this.token);
    if (options?.inline) params.set('inline', 'true');
    if (options?.download) params.set('download', 'true');
    const qs = params.toString();
    return `${getApiBaseUrl()}/v1/files/${fileId}${qs ? `?${qs}` : ''}`;
  }

  async deleteFile(fileId: string): Promise<void> {
    await this.request<unknown>(`/v1/files/${fileId}`, { method: 'DELETE' });
  }

  async getFSTree(channelId: string, subpath?: string, depth?: number): Promise<FSTreeResponse> {
    const params = new URLSearchParams({ channel: channelId });
    if (this.workspaceId) params.set('network', this.workspaceId);
    if (subpath) params.set('subpath', subpath);
    if (depth) params.set('depth', String(depth));
    return this.request<FSTreeResponse>(`/v1/fs/tree?${params.toString()}`);
  }

  async getFSContent(channelId: string, path: string): Promise<FSContentResponse> {
    const params = new URLSearchParams({ channel: channelId, path });
    if (this.workspaceId) params.set('network', this.workspaceId);
    return this.request<FSContentResponse>(`/v1/fs/content?${params.toString()}`);
  }

  async openLocalPath(path: string): Promise<void> {
    await this.request<{ status?: string }>('/v1/system/open-path', {
      method: 'POST',
      body: JSON.stringify({ path }),
    });
  }
}

export interface FSEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mod_time: string;
}

export interface FSTreeResponse {
  root: string;
  path: string;
  entries: FSEntry[];
}

export interface FSContentResponse {
  path: string;
  name: string;
  size: number;
  mod_time: string;
  is_binary: boolean;
  content: string;
  mime_type: string;
}

