import type {
  AgentApproval,
  AgentCatalogEntry,
  AgentLogEntry,
  AgentRuntime,
  CloudAgentConfig,
  CloudAgentModelInfo,
  CloudAgentProvider,
  NetworkDiscovery,
  NetworkProfile,
  WorkspaceAgent,
} from '../types';
import { networkAgentToWorkspaceAgent } from '../types';
import { BaseWorkspaceApi } from './base';

export class AgentsApi extends BaseWorkspaceApi {
  async discover(): Promise<NetworkDiscovery> {
    return this.request<NetworkDiscovery>(`/v1/discover?network=${this.workspaceId}`);
  }

  async launchAgent(agentName: string, workingDir?: string): Promise<{ message: string; agent_name: string; status: string }> {
    const params = new URLSearchParams({ network: this.workspaceId });
    if (workingDir) params.set('working_dir', workingDir);
    return this.request<{ message: string; agent_name: string; status: string }>(
      `/v1/agents/${encodeURIComponent(agentName)}/launch?${params}`,
      { method: 'POST' }
    );
  }

  async createAgent(input: {
    agentName: string;
    agentType: string;
    command?: string;
    args?: string;
    workingDir?: string;
  }): Promise<{ agent_name: string; status: string; output?: string }> {
    return this.request<{ agent_name: string; status: string; output?: string }>('/v1/agents', {
      method: 'POST',
      body: JSON.stringify({
        network: this.workspaceId,
        agent_name: input.agentName,
        agent_type: input.agentType,
        command: input.command || '',
        args: input.args || '',
        working_dir: input.workingDir || '',
      }),
    });
  }

  async networkProfile(): Promise<NetworkProfile> {
    return this.request<NetworkProfile>(`/v1/profile?network=${this.workspaceId}`);
  }

  async listAgents(): Promise<WorkspaceAgent[]> {
    const discovery = await this.discover();
    return discovery.agents.map(networkAgentToWorkspaceAgent);
  }

  async getAgentCatalog(): Promise<AgentCatalogEntry[]> {
    return this.request<AgentCatalogEntry[]>('/v1/agent-catalog');
  }

  async updateAgentRole(_agentName: string, _role: string): Promise<WorkspaceAgent> {
    throw new Error('Agent role management is not yet available in event-native mode');
  }

  async removeAgent(agentName: string): Promise<void> {
    await this.request<unknown>('/v1/remove', {
      method: 'POST',
      body: JSON.stringify({ agent_name: agentName, network: this.workspaceId }),
    });
  }

  async executeTerminalCommand(command: string): Promise<{ output: string }> {
    return this.request<{ output: string }>(`/v1/terminal/execute?network=${this.workspaceId}`, {
      method: 'POST',
      body: JSON.stringify({ command }),
    });
  }

  private mapCloudAgentConfig(raw: Record<string, unknown>): CloudAgentConfig {
    return {
      id: String(raw.id || raw.ID || ''),
      workspaceId: String(raw.workspace_id || raw.workspaceId || raw.network || ''),
      providerId: String(raw.provider_id || raw.providerId || raw.provider || ''),
      agentName: String(raw.agent_name || raw.agentName || ''),
      model: String(raw.model || ''),
      category: String(raw.category || 'text'),
      apiKeyMasked: String(raw.api_key_masked || raw.apiKeyMasked || raw.api_key || ''),
      systemPrompt: (raw.system_prompt || raw.systemPrompt || undefined) as string | undefined,
      createdAt: (raw.created_at || raw.createdAt || undefined) as string | undefined,
      updatedAt: (raw.updated_at || raw.updatedAt || undefined) as string | undefined,
    };
  }

  async getCloudProviders(): Promise<CloudAgentProvider[]> {
    const res = await this.request<{ providers: Record<string, unknown>[] }>('/v1/cloud-agents/providers');
    return (res.providers || []).map((p) => ({
      id: String(p.id || p.provider_id || p.name || ''),
      name: String(p.name || p.id || ''),
      label: String(p.label || p.name || p.id || ''),
      description: String(p.description || ''),
      doc_url: String(p.doc_url || ''),
      category: String(p.category || 'global'),
      models: Array.isArray(p.models)
        ? (p.models as unknown[]).map((m: unknown): CloudAgentModelInfo => {
            if (typeof m === 'object' && m !== null) {
              const obj = m as Record<string, unknown>;
              return {
                id: String(obj.id || obj.model || obj.name || ''),
                label: String(obj.label || obj.name || obj.id || ''),
                category: (obj.category || 'text') as CloudAgentModelInfo['category'],
              };
            }
            const str = String(m);
            return { id: str, label: str, category: 'text' };
          })
        : [],
    }));
  }

  async listCloudAgents(): Promise<CloudAgentConfig[]> {
    const res = await this.request<{ cloud_agents: Record<string, unknown>[] }>(
      `/v1/cloud-agents?network=${this.workspaceId}`
    );
    return (res.cloud_agents || []).map((c) => this.mapCloudAgentConfig(c));
  }

  async addCloudAgent(params: {
    agentName: string;
    provider: string;
    model: string;
    apiKey: string;
    baseUrl?: string;
    systemPrompt?: string;
    maxTokens?: number;
  }): Promise<CloudAgentConfig> {
    const raw = await this.request<Record<string, unknown>>('/v1/cloud-agents', {
      method: 'POST',
      body: JSON.stringify({
        network: this.workspaceId,
        agent_name: params.agentName,
        provider: params.provider,
        model: params.model,
        api_key: params.apiKey,
        base_url: params.baseUrl || null,
        system_prompt: params.systemPrompt || null,
        max_tokens: params.maxTokens || null,
      }),
    });
    return this.mapCloudAgentConfig(raw);
  }

  async updateCloudAgent(agentName: string, updates: {
    model?: string;
    apiKey?: string;
    systemPrompt?: string;
    maxTokens?: number;
    status?: string;
  }): Promise<CloudAgentConfig> {
    const raw = await this.request<Record<string, unknown>>(`/v1/cloud-agents/${agentName}`, {
      method: 'PATCH',
      body: JSON.stringify({
        network: this.workspaceId,
        ...updates.model !== undefined && { model: updates.model },
        ...updates.apiKey !== undefined && { api_key: updates.apiKey },
        ...updates.systemPrompt !== undefined && { system_prompt: updates.systemPrompt },
        ...updates.maxTokens !== undefined && { max_tokens: updates.maxTokens },
        ...updates.status !== undefined && { status: updates.status },
      }),
    });
    return this.mapCloudAgentConfig(raw);
  }

  async removeCloudAgent(agentName: string): Promise<void> {
    await this.request<unknown>(`/v1/cloud-agents/${agentName}?network=${this.workspaceId}`, {
      method: 'DELETE',
    });
  }

  private mapAgentRuntime(raw: Record<string, unknown>): AgentRuntime {
    return {
      workspaceId: (raw.workspace_id || '') as string,
      agentName: (raw.agent_name || '') as string,
      processStatus: (raw.process_status || 'stopped') as AgentRuntime['processStatus'],
      healthStatus: (raw.health_status || 'unknown') as AgentRuntime['healthStatus'],
      pid: (raw.pid ?? null) as number | null,
      restartCount: (raw.restart_count ?? 0) as number,
      lastError: (raw.last_error ?? null) as string | null,
      updatedAt: (raw.updated_at ?? null) as string | null,
    };
  }

  async getAgentRuntime(agentName: string): Promise<AgentRuntime | null> {
    try {
      const raw = await this.request<Record<string, unknown>>(`/v1/workspaces/${this.workspaceId}/agents/${encodeURIComponent(agentName)}/runtime`);
      return this.mapAgentRuntime(raw);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('API 404:')) return null;
      throw error;
    }
  }

  async listAgentLogs(agentName: string, limit = 50): Promise<AgentLogEntry[]> {
    const raw = await this.request<{ logs: Record<string, unknown>[] }>(`/v1/workspaces/${this.workspaceId}/agents/${encodeURIComponent(agentName)}/logs?limit=${limit}`);
    return (raw.logs || []).map((log) => ({
      id: (log.id || '') as string,
      agentName: (log.agent_name || agentName) as string,
      level: (log.level || 'info') as AgentLogEntry['level'],
      message: (log.message || '') as string,
      createdAt: (log.created_at ?? null) as string | null,
    }));
  }

  async listAgentApprovals(status?: AgentApproval['status']): Promise<AgentApproval[]> {
    const params = new URLSearchParams({ network: this.workspaceId });
    if (status) params.set('status', status);
    const raw = await this.request<{ approvals: Record<string, unknown>[] }>(`/v1/approvals?${params}`);
    return (raw.approvals || []).map((approval) => ({
      id: (approval.id || '') as string,
      agentName: (approval.agent_name || '') as string,
      requestedBy: (approval.requested_by || '') as string,
      action: (approval.action || '') as string,
      details: (approval.details ?? null) as Record<string, unknown> | null,
      status: (approval.status || 'pending') as AgentApproval['status'],
      resolvedBy: (approval.resolved_by ?? null) as string | null,
      resolvedAt: (approval.resolved_at ?? null) as string | null,
      createdAt: (approval.created_at ?? null) as string | null,
    }));
  }

  async resolveAgentApproval(approvalId: string, status: 'approved' | 'rejected'): Promise<AgentApproval> {
    const raw = await this.request<Record<string, unknown>>(`/v1/approvals/${encodeURIComponent(approvalId)}`, {
      method: 'PATCH', body: JSON.stringify({ status, resolved_by: 'human:user' }),
    });
    return {
      id: (raw.id || '') as string, agentName: (raw.agent_name || '') as string,
      requestedBy: (raw.requested_by || '') as string, action: (raw.action || '') as string,
      details: (raw.details ?? null) as Record<string, unknown> | null,
      status: (raw.status || status) as AgentApproval['status'],
      resolvedBy: (raw.resolved_by ?? null) as string | null, resolvedAt: (raw.resolved_at ?? null) as string | null,
      createdAt: (raw.created_at ?? null) as string | null,
    };
  }
}
