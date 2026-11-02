import { BaseWorkspaceApi } from './base';

export interface AgentModelResource {
  connectionId: string;
  modelId: string;
  maxOutputTokens?: number;
}
export interface AgentPermissions {
  readFiles: boolean;
  writeFiles: boolean;
  executeCommands: boolean;
  mcp: boolean;
  delegate: boolean;
  knowledge: boolean;
}
export interface AgentLimits {
  maxTokensPerRun?: number | null;
  maxStepsPerRun?: number | null;
  maxDurationSeconds?: number | null;
  /** USD; an unknown price blocks a run with this limit. */
  maxCostPerRun?: number | null;
}
export interface AgentExecutionPolicy {
  instructions: string;
  defaultMode: 'chat' | 'plan' | 'agent';
  maxMode: 'chat' | 'plan' | 'agent';
  modelResource: AgentModelResource | null;
  permissions: AgentPermissions;
  limits: AgentLimits;
}
export interface AgentDefinition extends AgentExecutionPolicy {
  id: string;
  name: string;
  description: string;
  role: string;
  runtimeKind: 'pi';
  status: 'active' | 'disabled';
  revision: number;
  builtIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentIdentityInput {
  name: string;
  description?: string;
  role?: string;
  status?: AgentDefinition['status'];
  instructions?: string;
  defaultMode?: AgentExecutionPolicy['defaultMode'];
  maxMode?: AgentExecutionPolicy['maxMode'];
  modelResource?: AgentModelResource | null;
  permissions?: Partial<AgentPermissions>;
  limits?: AgentLimits;
}

export class AgentDefinitionsApi extends BaseWorkspaceApi {
  listAgentDefinitions(includeDisabled = false): Promise<{ agents: AgentDefinition[] }> {
    return this.request(`/v1/agent-definitions?includeDisabled=${includeDisabled}`);
  }

  createAgentDefinition(input: AgentIdentityInput): Promise<AgentDefinition> {
    return this.request('/v1/agent-definitions', { method: 'POST', body: JSON.stringify(input) });
  }

  updateAgentDefinition(id: string, input: Partial<AgentIdentityInput> & { expectedRevision: number }): Promise<AgentDefinition> {
    return this.request(`/v1/agent-definitions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(input) });
  }

  deleteAgentDefinition(id: string, expectedRevision: number): Promise<{ deleted: boolean }> {
    return this.request(`/v1/agent-definitions/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ expectedRevision }) });
  }

  assignSessionAgent(channel: string, agentId: string, keepSessionOverrides = false): Promise<{ agent: AgentDefinition; config: { provider: string; model: string; mode: 'chat' | 'plan' | 'agent' } }> {
    return this.request('/v1/runtime/session/agent', { method: 'PATCH', body: JSON.stringify({ channel, agentId, keepSessionOverrides }) });
  }
}
