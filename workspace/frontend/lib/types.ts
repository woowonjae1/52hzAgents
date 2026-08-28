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
  autostart?: boolean;
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
  /** Local project directory this thread is bound to ("Open Folder" mode). Null = plain chat, no filesystem access. */
  workingDir: string | null;
  /** Verification command for pipeline quality gate (e.g. "go test ./..." or "npm test"). */
  verificationCmd?: string | null;
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

/**
 * Links a posted `[Decision]` reply back to the agent message whose decision
 * card produced it, so "already answered" survives a reload. Without the id
 * the only correlation available is position or title text, and neither
 * survives two cards asking similar questions in one channel.
 */
export interface DecisionResponse {
  source_message_id: string;
}

export interface WorkspaceMessageMetadata extends Record<string, unknown> {
  tool_approval_request?: ToolApprovalRequest;
  tool_approval_response?: ToolApprovalResponse;
  /** Present on the agent message that asks; rendered as an ApprovalCard. */
  questions?: unknown[];
  decision_questions?: unknown[];
  /** Present on the human message that answers. */
  decision_response?: DecisionResponse;
  /**
   * A dev server the agent reports as live, from a `preview` protocol block.
   * Always loopback — the adapter rejects anything else before it gets here,
   * and the receiving side re-checks rather than trusting that.
   */
  preview?: { url: string; label?: string };
  /**
   * On a `thinking` message: this is the model's REPLY streamed early, not
   * chain-of-thought. Set by `sendThinking(…, { isReplyPreview: true })` in the
   * nine adapters that stream the answer before posting it.
   *
   * Absent means "unknown", not "this is real reasoning" — messages predating the
   * flag, and any adapter yet to be updated, carry nothing. Consumers therefore
   * treat it as a fast path and keep the content-based fallback for the rest.
   */
  reply_preview?: boolean;
  attachments?: Record<string, unknown>[];
  turn_changes?: TurnChangesMetadata;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface TurnFileChange {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  pre_existing?: boolean;
  committed?: boolean;
  reverted?: boolean;
}

export interface TurnChangesMetadata {
  turn_id: string;
  file_count: number;
  additions: number;
  deletions: number;
  status: string;
  changes?: TurnFileChange[];
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
  /**
   * Chosen by whoever wrote the entry: 'rules' | 'architecture' | 'api' | 'docs'.
   * `null` means nobody has classified it, and only then does the client fall
   * back to guessing from the title — see `classifyEntry`.
   */
  category: string | null;
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
  targetAgentName?: string | null;
  createdBy: string | null;
  lastActivityAt: string | null;
  lastActiveAt?: string | null;
  createdAt: string | null;
  sessionId?: string | null;
  sharedWith?: string[];
}

export interface BrowserPersistentContext {
  id: string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  name: string;
  domain?: string | null;
  status?: string;
  sharedWith?: string[];
  storagePath?: string | null;
  createdBy?: string | null;
  createdAt?: string | null;
  created_at?: string | null;
  lastUsedAt?: string | null;
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

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  message: string;
  body: string;
  isRead: boolean;
  priority: 'low' | 'normal' | 'high';
  createdBy: string;
  channelName: string | null;
  threadId: string | null;
  linkUrl: string | null;
  status: string;
  createdAt: string | null;
  readAt: string | null;
}

export interface RoutineItem {
  id: string;
  name: string;
  message: string;
  scheduleHour: number;
  scheduleMinute: number;
  scheduleDays: number[] | null;
  scheduleIntervalMinutes?: number | null;
  timezone: string;
  nextFiresAt: string;
  lastFiredAt: string | null;
  status: string;
  createdBy: string;
  channelName: string;
  createdAt: string | null;
  context?: string | null;
}

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  assignee: string;
  createdBy: string;
  channelName: string;
  threadId: string | null;
  position: number;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface TimerItem {
  id: string;
  message: string;
  delaySeconds: number;
  firesAt: string;
  status: string;
  createdBy: string;
  channelName: string;
  createdAt: string | null;
}

export interface AgentApproval {
  id: string;
  agentName: string;
  requestedBy: string;
  action: string;
  details: Record<string, unknown> | null;
  // 'consumed' is set by the backend when a terminal-execution grant is spent;
  // grants are single-use so a resolved approval cannot be replayed.
  status: 'pending' | 'approved' | 'rejected' | 'consumed';
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string | null;
}

export interface AgentLogEntry {
  id: string;
  agentName: string;
  level: 'info' | 'warn' | 'error' | 'debug';
  message: string;
  createdAt: string | null;
}

export interface AgentRuntime {
  workspaceId: string;
  agentName: string;
  processStatus: 'stopped' | 'running' | 'failed' | 'starting';
  healthStatus: 'healthy' | 'unhealthy' | 'unknown';
  pid: number | null;
  restartCount: number;
  lastError: string | null;
  updatedAt: string | null;
}

export interface AgentUsage {
  workspace_id: string;
  agent_name: string;
  session_used_percent: number;
  session_resets_at: string | null;
  week_used_percent: number;
  week_resets_at: string | null;
  last_24h_summary: string | null;
  last_7d_summary: string | null;
  current_model?: string | null;
  available_models?: string | null;
  /** Reasoning-effort level the agent's CLI is set to, and the levels it accepts
   *  (JSON array). Null means the runtime has no effort concept, not "default". */
  current_effort?: string | null;
  available_efforts?: string | null;
  raw_text: string | null;
  updated_at: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

export interface DMConversation {
  agents: [string, string];
  lastMessage: { content: string; sender: string; timestamp: number };
  messageCount: number;
}

export interface EventConfirmation {
  event_id: string;
  timestamp: number;
  status: string;
  metadata?: Record<string, unknown>;
}

export interface EventPollResponse {
  events: ONMEvent[];
  has_more: boolean;
}

export interface MessagePollResponse {
  messages: WorkspaceMessage[];
  hasMore: boolean;
}

export interface NetworkDiscovery {
  agents: WorkspaceAgent[];
  channels: WorkspaceSession[];
}

export interface ShareSummary {
  token: string;
  shareToken: string;
  title: string;
  channelName: string;
  createdBy: string;
  createdAt: string | null;
  messageCount: number;
}

export interface CloudAgentModelInfo {
  id: string;
  label: string;
  category: 'text' | 'image' | 'audio';
}

export interface CloudAgentProvider {
  id: string;
  name: string;
  label?: string;
  description: string;
  doc_url: string;
  category: string;
  models: CloudAgentModelInfo[];
  // No default_model / supported_envs here: the backend's provider catalog never
  // sends them and nothing reads them. The model picker defaults to models[0].
}

export interface CloudAgentConfig {
  id: string;
  workspaceId: string;
  providerId: string;
  agentName: string;
  model: string;
  category: string;
  apiKeyMasked: string;
  systemPrompt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SharedSnapshotMessage {
  id: string;
  sender_name: string;
  sender_type: string;
  content: string;
  created_at: string | null;
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
  client_message_id?: string;
}

export function eventToMessage(event: ONMEvent): WorkspaceMessage {
  const payload = event.payload || {};
  const metadata = (event.metadata || {}) as WorkspaceMessageMetadata;
  const source = event.source || '';
  const rawType = payload.sender_type as string;
  const senderType = rawType || (source.startsWith('human:') || source.startsWith('user') ? 'human' : 'agent');
  const senderName = (payload.sender_name as string) || (source.includes(':') ? source.split(':')[1] : source) || 'System';
  const sessionId = (event.target || '').replace(/^channel\//, '');
  const clientMsgId = (metadata.client_message_id as string) || (payload.client_message_id as string) || (event.client_message_id as string) || undefined;

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
    clientMessageId: clientMsgId,
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
  const addrName = rawAddr.replace(/^(52hz:|openagents:|agent:|human:)/, '');
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
  const autostart = typeof raw.autostart === 'boolean' ? raw.autostart : (typeof raw.Autostart === 'boolean' ? raw.Autostart : false);

  return {
    agentName: name,
    role: role,
    agentType: type,
    serverHost: host,
    workingDir: dir,
    description: desc,
    enabledSkills: skills,
    status: status,
    autostart: autostart,
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
  workingDir?: string;
  working_dir?: string;
  verificationCmd?: string;
  verification_cmd?: string;
}

export function networkChannelToSession(ch: Record<string, unknown> | NetworkChannel | WorkspaceSession, defaultWorkspaceId?: string): WorkspaceSession {
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
  const workingDir = (raw.workingDir || raw.working_dir || null) as string | null;
  const verificationCmd = (raw.verificationCmd || raw.verification_cmd || null) as string | null;

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
    workingDir: workingDir,
    verificationCmd: verificationCmd,
  };
}
