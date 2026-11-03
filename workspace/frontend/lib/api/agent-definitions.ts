import { BaseWorkspaceApi } from './base';
export type AgentRuntimeKind = 'pi' | 'codex' | 'antigravity' | 'gemini';
export type AgentConnectionKind = 'native-pi' | 'native-codex' | 'native-antigravity' | 'native-openclaw' | 'native-hermes';
export interface AgentRuntimeStatus { kind: AgentRuntimeKind; name: string; installed: boolean; supported: boolean; modes: string[]; reason: string; }
export interface AgentExecutionDescriptor {
  connectionKind: 'builtin-pi-sdk' | 'native-pi' | 'native-codex' | 'native-antigravity' | 'native-gemini' | 'native-openclaw' | 'native-hermes';
  connectionId?: string | null;
  label: string;
  compatibility: 'legacy-builtin' | 'native-preview' | 'native-pending' | 'deferred';
  nativeConnection: string | null;
  usesWorkbenchModelConnection: boolean;
  note: string;
}

export interface AgentConnectionStatusBreakdown {
  installationDetected: boolean;
  configReadable: boolean;
  authConfigured: boolean;
  executionVerified: boolean;
}

export interface AgentConnectionSharedMember {
  id: string;
  name: string;
  role: string;
  status: 'active' | 'disabled';
  runtimeModel?: string | null;
}

export interface AgentConfigSource {
  id: string;
  connectionId: string;
  sourceKey: string;
  scope: 'session' | 'profile' | 'project' | 'global';
  format: 'json' | 'jsonc' | 'toml';
  canonicalPath: string;
  contentSha256: string | null;
  holdsSecret: boolean;
  exists?: boolean;
  sha256?: string | null;
  updatedAt?: string;
}

export interface AgentConnection {
  id: string;
  kind: AgentConnectionKind;
  displayName: string;
  environment: 'local' | 'wsl' | 'remote';
  installationRef: string;
  configDir: string | null;
  nativeProfile: string | null;
  status: 'registered' | 'disabled';
  revision: number;
  sources: AgentConfigSource[];
  sharedMembers: AgentConnectionSharedMember[];
  createdAt: string;
  updatedAt: string;
}

export interface AgentConnectionCandidate {
  candidateKind: AgentConnectionKind | null;
  probeKind: string;
  name: string;
  stage: string;
  stageNote: string;
  canRegister: boolean;
  installation: {
    detected: boolean;
    path: string | null;
    version: string | null;
    versionError: string | null;
  };
  defaultConfigDir: string | null;
  configSources: Array<{
    id: string;
    scope: string;
    format: string;
    path: string;
    holds: string;
    secret: boolean;
    exists: boolean;
  }>;
  configNote: string;
  statusBreakdown: AgentConnectionStatusBreakdown;
  registeredConnections: Array<{
    id: string;
    displayName: string;
    configDir: string | null;
    sharedMembers: AgentConnectionSharedMember[];
  }>;
}

export interface NativeConfigChangeRecord {
  id: string;
  connectionId: string;
  state: 'prepared' | 'applying' | 'committed' | 'activating' | 'applied' | 'apply_failed' | 'rolled_back';
  scope: string;
  redactedPatch: Array<{
    sourceKey: string;
    fieldPath: string;
    before: unknown;
    after: unknown;
    credentialAction?: string;
  }>;
  files: Array<{
    sourceKey: string;
    canonicalPath: string;
    oldExisted: boolean;
    oldSha256: string | null;
    newSha256: string | null;
  }>;
  applyResult?: {
    saveStatus?: string;
    applicationStatus?: string;
    applicationNote?: string;
    verifiedAt?: string;
    rolledBackAt?: string;
    error?: string;
  } | null;
  actor: string;
  createdAt: string;
  updatedAt: string;
}

export interface NativeConfigInspection {
  connection: AgentConnection;
  sources: AgentConfigSource[];
  versions: Record<string, string | null>;
  brokenChangeState?: { id: string; state: string } | null;
  view: Record<string, any>;
  effective: {
    defaultProvider?: string | null;
    defaultModel?: string | null;
    defaultThinkingLevel?: string | null;
    defaultReasoningEffort?: string | null;
    sourceScope?: string;
    shadowedByProject?: boolean;
  };
  readiness: Record<string, any>;
  statusBreakdown: AgentConnectionStatusBreakdown;
  editableFields: Array<{
    path: string;
    sourceKey: string;
    scope: string;
    type: string;
    options?: string[];
    label: string;
  }>;
  scopeWarning?: string;
  recentChanges: NativeConfigChangeRecord[];
}

export interface NativeResourcesResponse {
  connection: AgentConnection;
  effective: Record<string, any>;
  readiness: Record<string, any>;
  providers?: Array<{
    id: string;
    name: string;
    source: string;
    baseUrl: string | null;
    authenticated: boolean;
    authSource: string;
    models: Array<{ id: string; name: string; reasoning?: boolean; contextWindow?: number | null; source?: string }>;
  }>;
  models: Array<{
    id: string;
    name: string;
    providerId: string;
    providerName: string;
    reasoning?: boolean;
    contextWindow?: number | null;
    source?: string;
    verificationStatus?: 'verified' | 'cached' | 'configured' | 'declared';
    authenticated?: boolean;
    isDefault?: boolean;
  }>;
  cachedModels?: Array<any>;
  declaredModels?: Array<any>;
  configuredModels?: Array<any>;
  verifiedModels?: Array<any>;
  reasoningEfforts?: string[];
  supportsSessionOverride?: boolean;
  supportsGlobalDefaultWrite?: boolean;
  note?: string;
}

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
  runtimeKind: AgentRuntimeKind;
  runtimeModel?: string | null;
  connectionId?: string | null;
  /** Derived, read-only. `runtimeKind: 'pi'` without `connectionId` means the built-in Pi SDK assistant. */
  execution?: AgentExecutionDescriptor;
  status: 'active' | 'disabled';
  revision: number;
  builtIn: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentIdentityInput {
  runtimeKind?: AgentRuntimeKind;
  runtimeModel?: string | null;
  connectionId?: string | null;
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
  listAgentRuntimes(): Promise<{ runtimes: AgentRuntimeStatus[] }> {
    return this.request('/v1/agent-runtimes');
  }
  listAgentDefinitions(includeDisabled = false): Promise<{ agents: AgentDefinition[] }> {
    return this.request(`/v1/agent-definitions?includeDisabled=${includeDisabled}`);
  }

  getAgentDefinition(id: string): Promise<AgentDefinition> {
    return this.request(`/v1/agent-definitions/${encodeURIComponent(id)}`);
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

  listAgentConnectionCandidates(versions = false): Promise<{ probedAt: string; platform: string; candidates: AgentConnectionCandidate[] }> {
    return this.request(`/v1/agent-connections/candidates?versions=${versions}`);
  }

  listAgentConnections(includeDisabled = false): Promise<{ connections: AgentConnection[] }> {
    return this.request(`/v1/agent-connections?includeDisabled=${includeDisabled}`);
  }

  registerAgentConnection(input: {
    kind: AgentConnectionKind;
    displayName?: string;
    memberName?: string;
    configDir?: string | null;
    runtimeModel?: string | null;
    createMember?: boolean;
  }): Promise<{ connection: AgentConnection; member: AgentDefinition | null }> {
    return this.request('/v1/agent-connections', { method: 'POST', body: JSON.stringify(input) });
  }

  inspectAgentConnectionConfig(connectionId: string, projectDir?: string | null): Promise<NativeConfigInspection> {
    const q = projectDir ? `?projectDir=${encodeURIComponent(projectDir)}` : '';
    return this.request(`/v1/agent-connections/${encodeURIComponent(connectionId)}/config${q}`);
  }

  listAgentConnectionResources(connectionId: string): Promise<NativeResourcesResponse> {
    return this.request(`/v1/agent-connections/${encodeURIComponent(connectionId)}/resources`);
  }

  previewAgentConnectionConfigChange(
    connectionId: string,
    body: { patch: Record<string, any>; expectedVersions?: Record<string, string | null> }
  ): Promise<{
    connectionId: string;
    scope: string;
    sharedMembers: AgentConnectionSharedMember[];
    requiresRestart: boolean;
    applicationMode: string;
    applicationNote: string;
    redactedChanges: Array<{ sourceKey: string; fieldPath: string; before: unknown; after: unknown }>;
    currentVersions: Record<string, string | null>;
  }> {
    return this.request(`/v1/agent-connections/${encodeURIComponent(connectionId)}/config/preview`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  applyAgentConnectionConfigChange(
    connectionId: string,
    body: { patch: Record<string, any>; expectedVersions: Record<string, string | null> }
  ): Promise<{
    change: NativeConfigChangeRecord;
    saveStatus: string;
    applicationStatus: string;
    applicationNote: string;
    effective: Record<string, any>;
    versions: Record<string, string | null>;
    sharedMembers: AgentConnectionSharedMember[];
  }> {
    return this.request(`/v1/agent-connections/${encodeURIComponent(connectionId)}/config/apply`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  rollbackAgentConnectionConfigChange(
    connectionId: string,
    body: { changeId: string }
  ): Promise<{
    change: NativeConfigChangeRecord;
    restoredStatus: string;
    effective: Record<string, any>;
    versions: Record<string, string | null>;
  }> {
    return this.request(`/v1/agent-connections/${encodeURIComponent(connectionId)}/config/rollback`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }
}
