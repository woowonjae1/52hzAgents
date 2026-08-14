import type { KnowledgeEntry } from '../types';
import { BaseWorkspaceApi } from './base';

export class KnowledgeApi extends BaseWorkspaceApi {
  async listKnowledge(): Promise<{ entries: KnowledgeEntry[]; total: number }> {
    const raw = await this.request<{ entries: Record<string, unknown>[]; total: number }>(
      `/v1/knowledge?network=${this.workspaceId}`
    );
    return {
      entries: (raw.entries || []).map((e): KnowledgeEntry => ({
        id: e.id as string,
        slug: e.slug as string,
        title: e.title as string,
        description: (e.description ?? null) as string | null,
        contentSize: (e.content_size ?? null) as number | null,
        createdBy: (e.created_by || '') as string,
        updatedBy: (e.updated_by ?? null) as string | null,
        status: (e.status || 'active') as string,
        createdAt: (e.created_at || null) as string | null,
        updatedAt: (e.updated_at || null) as string | null,
      })),
      total: raw.total || 0,
    };
  }

  async getKnowledgeEntry(entryId: string): Promise<KnowledgeEntry & { content: string }> {
    const raw = await this.request<Record<string, unknown>>(`/v1/knowledge/${entryId}`);
    return {
      id: raw.id as string,
      slug: raw.slug as string,
      title: raw.title as string,
      description: (raw.description ?? null) as string | null,
      contentSize: (raw.content_size ?? null) as number | null,
      createdBy: (raw.created_by || '') as string,
      updatedBy: (raw.updated_by ?? null) as string | null,
      status: (raw.status || 'active') as string,
      createdAt: (raw.created_at || null) as string | null,
      updatedAt: (raw.updated_at || null) as string | null,
      content: (raw.content || '') as string,
    };
  }

  async createKnowledge(params: { title: string; content: string; description?: string }): Promise<KnowledgeEntry> {
    const raw = await this.request<Record<string, unknown>>('/v1/knowledge', {
      method: 'POST',
      body: JSON.stringify({
        network: this.workspaceId,
        title: params.title,
        content: params.content,
        description: params.description || null,
        source: 'human:user',
      }),
    });
    return {
      id: raw.id as string,
      slug: raw.slug as string,
      title: raw.title as string,
      description: (raw.description ?? null) as string | null,
      contentSize: (raw.content_size ?? null) as number | null,
      createdBy: (raw.created_by || '') as string,
      updatedBy: (raw.updated_by ?? null) as string | null,
      status: (raw.status || 'active') as string,
      createdAt: (raw.created_at || null) as string | null,
      updatedAt: (raw.updated_at || null) as string | null,
    };
  }

  async updateKnowledge(entryId: string, params: { title?: string; content?: string; description?: string }): Promise<KnowledgeEntry> {
    const raw = await this.request<Record<string, unknown>>(`/v1/knowledge/${entryId}`, {
      method: 'PUT',
      body: JSON.stringify({
        network: this.workspaceId,
        ...params.title !== undefined && { title: params.title },
        ...params.content !== undefined && { content: params.content },
        ...params.description !== undefined && { description: params.description },
        source: 'human:user',
      }),
    });
    return {
      id: raw.id as string,
      slug: raw.slug as string,
      title: raw.title as string,
      description: (raw.description ?? null) as string | null,
      contentSize: (raw.content_size ?? null) as number | null,
      createdBy: (raw.created_by || '') as string,
      updatedBy: (raw.updated_by ?? null) as string | null,
      status: (raw.status || 'active') as string,
      createdAt: (raw.created_at || null) as string | null,
      updatedAt: (raw.updated_at || null) as string | null,
    };
  }

  async deleteKnowledge(entryId: string): Promise<void> {
    await this.request<unknown>(`/v1/knowledge/${entryId}?network=${this.workspaceId}`, { method: 'DELETE' });
  }
}
