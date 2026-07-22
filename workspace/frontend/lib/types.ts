export interface Workspace {
  workspaceId: string;
  slug: string;
  name: string;
  creatorEmail: string | null;
  settings: Record<string, unknown>;
  browserfabricApiKey: string | null;
  status: string;
  createdAt: string | null;
  lastActivityAt: string | null;
  agents: WorkspaceAgent[];
}

export interface WorkspaceAgent {
  agentName: string;
  role: string;
  agentType: string | null;
  serverHost: string | null;
  workingDir: string | null;
  description: string | null;
  enabledSkills: Record<string, unknown> | null;
  status: string;
  lastHeartbeatAt: string | null;
  joinedAt: string | null;
}

export type SkillState = 'installing' | 'installed' | 'failed' | 'uninstalled';
export interface SkillStatusEntry {
  state: SkillState;
  updated_at?: number;
  path?: string;
  error?: string;
}

export interface SkillCatalogEntry {
  id: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  source_repo: string;
  source_path: string;
  author: string;
}

export interface WorkspaceCustomSkill {
  id: string;
  name: string;
  description?: string;
  category: 'custom';
  tags?: string[];
  author?: string;
  sourceType: 'workspace_file';
  fileId: string;
  filename: string;
  contentType?: string;
  packageType: 'md' | 'zip';
  createdAt?: string;
}

export interface WorkspaceSession {
  sessionId: string;
  workspaceId: string;
  createdBy: string | null;
  title: string;
  status: string;
  starred: boolean;
  participants: string[];
  master: string | null;
  orchestrationMode: string;
  orchestrationInstruction: string | null;
  createdAt: string | null;
  lastEventAt: number | null;
}

export interface ToolApprovalRequest {
  approval_id: string;
  tool?: string;
  args?: {
    command?: string;
    path?: string;
    [key: string]: unknown;
  };
}

export interface ToolApprovalResponse {
  approval_id: string;
  granted: boolean;
}

export interface WorkspaceMessageMetadata extends Record<string, unknown> {
  tool_approval_request?: ToolApprovalRequest;
  tool_approval_response?: ToolApprovalResponse;
  attachments?: Record<string, unknown>[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface WorkspaceMessage {
  messageId: string;
  sessionId: string;
  senderId?: string | null;
  senderType: string;
  senderName: string;
  content: string;
  mentions: string[];
  targetAgents: string[] | null;
  messageType: string;
  metadata: WorkspaceMessageMetadata;
  createdAt: string | null;
  clientMessageId?: string;
  deliveryStatus?: 'sending' | 'confirmed' | 'failed';
}

export interface WorkspaceIdentity {
  id: string;
  name: string;
  isAuthenticated: boolean;
}

export interface OnlineUser {
  id: string;
  name: string;
  status: 'online';
  lastSeen: number;
}

export interface WorkspaceCollaborator {
  email: string;
  role: 'editor' | 'viewer';
  addedBy: string | null;
  addedAt: string | null;
}

export interface WorkspaceInvitation {
  invitationId: string;
  workspaceId: string;
  targetAgentName: string;
  inviteToken: string;
  workspaceName?: string;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  createdAt: string;
  expiresAt: string;
}

export interface WorkspaceFile {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  uploadedBy: string;
  channelName: string | null;
  status: string;
  createdAt: string | null;
}

export interface KnowledgeEntry {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  contentSize: number | null;
  createdBy: string;
  updatedBy: string | null;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface BrowserTab {
  id: string;
  url: string;
  title: string | null;
  liveUrl: string | null;
  status: string;
  contextId: string | null;
  targetAgentName: string | null;
  createdBy: string | null;
  lastActivityAt: string | null;
  createdAt: string | null;
}

export interface BrowserContext {
  id: string;
  workspaceId: string;
  name: string;
  storagePath: string | null;
  createdBy: string | null;
  createdAt: string | null;
}

export interface RoutineTask {
  taskId: string;
  workspaceId: string;
  title: string;
  cronExpr: string;
  prompt: string;
  targetAgents: string[];
  status: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdBy: string | null;
  createdAt: string | null;
}

export interface RoutineExecution {
  executionId: string;
  taskId: string;
  sessionId: string | null;
  status: string;
  errorMsg: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface InboxItem {
  id: string;
  sessionId: string;
  threadTitle: string;
  type: 'approval' | 'mention' | 'routine_failure';
  senderName: string;
  content: string;
  createdAt: string;
  approvalId?: string;
  tool?: string;
  command?: string;
  isRead: boolean;
}

export interface AgentCatalogEntry {
  name: string;
  label: string;
  description: string;
  install_command: string;
  homepage: string;
  tags: string[];
  builtin: boolean;
}

export interface CloudAgentProvider {
  id: string;
  name: string;
  description: string;
  doc_url: string;
  category: 'text' | 'image' | 'audio';
  models: string[];
  default_model: string;
  supported_envs: string[];
}

export interface CloudAgentConfig {
  id: string;
  workspace_id: string;
  provider_id: string;
  agent_name: string;
  model: string;
  system_prompt?: string;
  created_at: string;
  updated_at: string;
}

export interface ONMEvent {
  event_id: string;
  type: string;
  source: string;
  target: string;
  payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
  visibility: string;
  timestamp: number;
}

export function eventToMessage(event: ONMEvent): WorkspaceMessage {
  const payload = event.payload || {};
  const metadata = (event.metadata || {}) as WorkspaceMessageMetadata;
  const source = event.source || '';
  const rawType = payload.sender_type as string;
  const senderType = rawType || (source.startsWith('human:') || source.startsWith('user') ? 'human' : 'agent');
  const senderName = (payload.sender_name as string) || (source.includes(':') ? source.split(':')[1] : source) || 'System';
  const sessionId = (event.target || '').replace(/^channel\//, '');

  return {
    messageId: event.event_id,
    sessionId: sessionId,
    senderId: source,
    senderType: senderType,
    senderName: senderName,
    content: (payload.content as string) || '',
    mentions: (metadata.target_agents as string[]) || [],
    targetAgents: (metadata.target_agents as string[]) || null,
    messageType: (payload.message_type as string) || (event.type === 'workspace.agent.thinking' ? 'thinking' : 'chat'),
    metadata: metadata,
    createdAt: event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString(),
  };
}

export interface NetworkProfile {
  agent_name?: string;
  name?: string;
  role?: string;
  agent_type?: string;
  agentType?: string;
  server_host?: string;
  serverHost?: string;
  working_dir?: string;
  workingDir?: string;
  description?: string;
  enabled_skills?: Record<string, unknown>;
  enabledSkills?: Record<string, unknown>;
  status?: string;
  last_heartbeat_at?: string;
  joined_at?: string;
}

export function networkAgentToWorkspaceAgent(agent: Record<string, unknown> | WorkspaceAgent | NetworkProfile): WorkspaceAgent {
  const raw = (agent || {}) as Record<string, unknown>;
  const rawAddr = (raw.address as string) || '';
  const addrName = rawAddr.replace(/^openagents:/, '').replace(/^agent:/, '');
  const name = (raw.agentName || raw.agent_name || raw.AgentName || raw.name || raw.Name || addrName || 'Unknown') as string;
  const role = (raw.role || raw.Role || 'worker') as string;
  const type = (raw.agentType || raw.agent_type || raw.AgentType || raw.Type || null) as string | null;
  const host = (raw.serverHost || raw.server_host || raw.ServerHost || null) as string | null;
  const dir = (raw.workingDir || raw.working_dir || raw.WorkingDir || null) as string | null;
  const desc = (raw.description || raw.Description || null) as string | null;
  const skills = (raw.enabledSkills || raw.enabled_skills || raw.EnabledSkills || null) as Record<string, unknown> | null;
  const status = (raw.status || raw.Status || 'online') as string;
  const hb = (raw.lastHeartbeatAt || raw.last_heartbeat_at || raw.LastHeartbeatAt || null) as string | null;
  const joined = (raw.joinedAt || raw.joined_at || raw.JoinedAt || null) as string | null;

  return {
    agentName: name,
    role: role,
    agentType: type,
    serverHost: host,
    workingDir: dir,
    description: desc,
    enabledSkills: skills,
    status: status,
    lastHeartbeatAt: hb,
    joinedAt: joined,
  };
}

export interface NetworkChannel {
  sessionId?: string;
  channel_name?: string;
  channelName?: string;
  id?: string;
  workspaceId?: string;
  workspace_id?: string;
  createdBy?: string;
  created_by?: string;
  title?: string;
  status?: string;
  starred?: boolean;
  participants?: string[];
  master?: string;
  orchestrationMode?: string;
  orchestration_mode?: string;
  orchestrationInstruction?: string;
  orchestration_instruction?: string;
  createdAt?: string;
  created_at?: string;
  lastEventAt?: number;
  last_event_at?: number;
}

export function networkChannelToSession(ch: Record<string, unknown> | NetworkChannel, defaultWorkspaceId?: string): WorkspaceSession {
  const raw = (ch || {}) as Record<string, unknown>;
  const rawAddr = (raw.address as string) || '';
  const addrId = rawAddr.replace(/^channel\//, '');
  const id = (raw.sessionId || raw.channel_name || raw.channelName || raw.id || raw.ID || addrId || '') as string;
  const ws = (raw.workspaceId || raw.workspace_id || defaultWorkspaceId || '') as string;
  const creator = (raw.createdBy || raw.created_by || null) as string | null;
  const title = (raw.title || raw.channel_name || raw.channelName || 'Thread') as string;
  const status = (raw.status || 'active') as string;
  const starred = !!raw.starred;
  const parts = (raw.participants || []) as string[];
  const master = (raw.master || null) as string | null;
  const mode = (raw.orchestrationMode || raw.orchestration_mode || 'dynamic') as string;
  const instruction = (raw.orchestrationInstruction || raw.orchestration_instruction || null) as string | null;
  const created = (raw.createdAt || raw.created_at || null) as string | null;
  const lastEvent = (raw.lastEventAt ?? raw.last_event_at ?? null) as number | null;

  return {
    sessionId: id,
    workspaceId: ws,
    createdBy: creator,
    title: title,
    status: status,
    starred: starred,
    participants: parts,
    master: master,
    orchestrationMode: mode,
    orchestrationInstruction: instruction,
    createdAt: created,
    lastEventAt: lastEvent,
  };
}
