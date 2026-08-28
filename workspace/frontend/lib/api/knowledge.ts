import type { KnowledgeEntry } from '../types';
import { BaseWorkspaceApi } from './base';

export interface KnowledgeSearchResult {
  chunkId: string;
  entryId: string;
  slug: string;
  title: string;
  category: string;
  section: string;
  sectionPath: string[];
  snippet: string;
  charCount: number;
  score: number;
}

export class KnowledgeApi extends BaseWorkspaceApi {
  async listKnowledge(options?: { category?: string; q?: string; limit?: number; offset?: number }): Promise<{ entries: KnowledgeEntry[]; total: number }> {
    const params = new URLSearchParams({ network: this.workspaceId });
    if (options?.category) params.set('category', options.category);
    if (options?.q) params.set('q', options.q);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));

    const raw = await this.request<{ entries: Record<string, unknown>[]; total: number }>(
      `/v1/knowledge?${params}`
    );
    return {
      entries: (raw.entries || []).map((e): KnowledgeEntry => ({
        id: e.id as string,
        slug: e.slug as string,
        title: e.title as string,
        description: (e.description ?? null) as string | null,
        category: (e.category ?? null) as string | null,
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

  async searchKnowledge(params: { q?: string; query?: string; category?: string; limit?: number; threshold?: number }): Promise<{ query: string; totalMatches: number; results: KnowledgeSearchResult[] }> {
    const queryStr = params.q || params.query || '';
    const searchParams = new URLSearchParams({
      network: this.workspaceId,
      q: queryStr,
    });
    if (params.category) searchParams.set('category', params.category);
    if (params.limit) searchParams.set('limit', String(params.limit));
    if (params.threshold !== undefined) searchParams.set('threshold', String(params.threshold));

    const raw = await this.request<{ query: string; total_matches: number; results: Record<string, unknown>[] }>(
      `/v1/knowledge/search?${searchParams}`
    );

    return {
      query: raw.query || queryStr,
      totalMatches: raw.total_matches || 0,
      results: (raw.results || []).map((r): KnowledgeSearchResult => ({
        chunkId: (r.chunk_id || '') as string,
        entryId: (r.entry_id || '') as string,
        slug: (r.slug || '') as string,
        title: (r.title || '') as string,
        category: (r.category || '') as string,
        section: (r.section || '') as string,
        sectionPath: (r.section_path || []) as string[],
        snippet: (r.snippet || '') as string,
        charCount: (r.char_count || 0) as number,
        score: (r.score || 0) as number,
      })),
    };
  }

  async getKnowledgeEntry(entryId: string): Promise<KnowledgeEntry & { content: string }> {
    const raw = await this.request<Record<string, unknown>>(`/v1/knowledge/${entryId}`);
    return {
      id: raw.id as string,
      slug: raw.slug as string,
      title: raw.title as string,
      description: (raw.description ?? null) as string | null,
      category: (raw.category ?? null) as string | null,
      contentSize: (raw.content_size ?? null) as number | null,
      createdBy: (raw.created_by || '') as string,
      updatedBy: (raw.updated_by ?? null) as string | null,
      status: (raw.status || 'active') as string,
      createdAt: (raw.created_at || null) as string | null,
      updatedAt: (raw.updated_at || null) as string | null,
      content: (raw.content || '') as string,
    };
  }

  async createKnowledge(params: { title: string; content: string; description?: string; category?: string }): Promise<KnowledgeEntry> {
    const raw = await this.request<Record<string, unknown>>('/v1/knowledge', {
      method: 'POST',
      body: JSON.stringify({
        network: this.workspaceId,
        title: params.title,
        content: params.content,
        description: params.description || null,
        category: params.category || null,
        source: 'human:user',
      }),
    });
    return {
      id: raw.id as string,
      slug: raw.slug as string,
      title: raw.title as string,
      description: (raw.description ?? null) as string | null,
      category: (raw.category ?? null) as string | null,
      contentSize: (raw.content_size ?? null) as number | null,
      createdBy: (raw.created_by || '') as string,
      updatedBy: (raw.updated_by ?? null) as string | null,
      status: (raw.status || 'active') as string,
      createdAt: (raw.created_at || null) as string | null,
      updatedAt: (raw.updated_at || null) as string | null,
    };
  }

  async updateKnowledge(entryId: string, params: { title?: string; content?: string; description?: string; category?: string }): Promise<KnowledgeEntry> {
    const raw = await this.request<Record<string, unknown>>(`/v1/knowledge/${entryId}`, {
      method: 'PUT',
      body: JSON.stringify({
        network: this.workspaceId,
        ...params.title !== undefined && { title: params.title },
        ...params.content !== undefined && { content: params.content },
        ...params.description !== undefined && { description: params.description },
        ...params.category !== undefined && { category: params.category },
        source: 'human:user',
      }),
    });
    return {
      id: raw.id as string,
      slug: raw.slug as string,
      title: raw.title as string,
      description: (raw.description ?? null) as string | null,
      category: (raw.category ?? null) as string | null,
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
