'use client';

import * as React from 'react';
import {
  Check,
  Copy,
  ExternalLink,
  MessageSquare,
  Plug,
  RefreshCw,
  RotateCw,
  ShieldCheck,
  ShieldX,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { Switch } from '@/components/ui/switch';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { ContextRing } from '@/components/chat/context-ring';
import type { OrchestrationMode } from '@/components/chat/orchestration-control';
import { getSmartSessionTitle, extractSessionAgents } from '@/components/threads/thread-list';
import { useLayout } from '@/components/layout/layout-context';
import { useWorkspace } from '@/lib/workspace-context';
import { workspaceApi } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { timeAgo, formatCompactRelativeTime } from '@/lib/helpers';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import {
  currentModelFor,
  hydrateAgentModels,
  modelsFor,
  parseReportedModels,
  useAgentModels,
} from '@/lib/agent-model-store';
import { useAgentContexts, contextPercent, fmtTokens } from '@/lib/use-agent-contexts';
import { useAgentTurns, summarizeAgentTurns } from '@/lib/use-agent-turns';
import type { AgentApproval, AgentCatalogEntry, AgentLogEntry, AgentRuntime, AgentUsage, WorkspaceAgent } from '@/lib/types';
import { FieldLabel, FieldValue, StatusDot } from './home-panel';

/*
  EVERYTHING YOU CAN DO TO ONE AGENT, WHERE YOU PICKED IT.

  This panel opens under the tile that was clicked and replaces the trip to
  the Agents page for per-agent work. Nothing in it is new behaviour: each
  control calls the endpoint the Agents page, the agent profile slide-over or
  the composer already calls --
    Connect / Reconnect   launchAgent              (Agents page station)
    Stop                  sendAgentControl 'stop'  (Needs-attention force stop)
    Model / effort        store + set_effort       (composer chip / Home setup)
    Description, autostart updateMember            (profile slide-over)
    Runtime, logs         getAgentRuntime / listAgentLogs
    Approvals             listAgentApprovals / resolveAgentApproval
    Remove                removeAgent / removeCloudAgent
  What stays in the profile slide-over ("Full profile"): installed skills and
  a cloud agent's API key -- both rare, both long.
*/

export const DEFAULT_PICK = '__agent_default__';

export type AgentState = 'online' | 'working' | 'offline';

interface Props {
  agent: WorkspaceAgent;
  state: AgentState;
  isCatalogPreset?: boolean;
  catalogEntry?: AgentCatalogEntry;
  selected: boolean;
  onToggleSelected: (on: boolean) => void;
  mode: OrchestrationMode;
  isLead: boolean;
  canUnsetLead: boolean;
  onLeadChange: (on: boolean) => void;
  modelPick?: string;
  onModelPick: (modelId: string | null) => void;
  effortPick?: string;
  onEffortPick: (effort: string | null) => void;
  onOpenThread: (sessionId: string) => void;
  onClose: () => void;
}

const short = (id: string) => (id.includes('/') ? id.slice(id.indexOf('/') + 1) : id);

function heartbeatMs(v: string | number | null | undefined): number {
  if (!v) return 0;
  const ms = typeof v === 'number' ? v : new Date(v).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function SubCard({ title, action, children, className }: { title: string; action?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('min-w-0 rounded-lg border border-border bg-background p-3', className)}>
      <div className="mb-2.5 flex h-5 items-center justify-between gap-2">
        <h3 className="text-[10.5px] font-medium uppercase tracking-[0.06em] text-foreground-extra-muted">{title}</h3>
        {action}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Help({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-2xs text-foreground-extra-muted">{children}</p>;
}

export function AgentDetailPanel({
  agent,
  state,
  isCatalogPreset = false,
  catalogEntry,
  selected,
  onToggleSelected,
  mode,
  isLead,
  canUnsetLead,
  onLeadChange,
  modelPick,
  onModelPick,
  effortPick,
  onEffortPick,
  onOpenThread,
  onClose,
}: Props) {
  const name = agent.agentName;
  const displayName = catalogEntry?.label ? `${catalogEntry.label} (${name})` : name;
  const online = state !== 'offline';
  const isCloud = agent.agentType?.startsWith('cloud:') ?? false;
  const { sessions, agents, lastMessageBySession, createSession, refreshAgents, token } = useWorkspace();
  const { setViewMode, setSelectedAgentName } = useLayout();
  const { rows: contextRows } = useAgentContexts();
  const { rows: turnRows } = useAgentTurns();
  const modelState = useAgentModels();
  const { isCopied, copyToClipboard } = useCopyToClipboard();

  // ── What the agent reports ──
  const [usage, setUsage] = React.useState<AgentUsage | null>(null);
  const [runtime, setRuntime] = React.useState<AgentRuntime | null>(null);
  const [logs, setLogs] = React.useState<AgentLogEntry[]>([]);
  const [approvals, setApprovals] = React.useState<AgentApproval[]>([]);
  const [loading, setLoading] = React.useState(false);

  const refresh = React.useCallback(async () => {
    if (isCatalogPreset) return;
    setLoading(true);
    const [u, r, l, a] = await Promise.all([
      workspaceApi.getAgentUsage(name).catch(() => null),
      workspaceApi.getAgentRuntime(name).catch(() => null),
      workspaceApi.listAgentLogs(name, 5).catch(() => [] as AgentLogEntry[]),
      workspaceApi.listAgentApprovals('pending').catch(() => [] as AgentApproval[]),
    ]);
    setUsage(u);
    setRuntime(r);
    setLogs(l);
    setApprovals(a.filter((x) => x.agentName === name));
    if (u) hydrateAgentModels(name, { options: parseReportedModels(u.available_models), current: u.current_model });
    setLoading(false);
  }, [name, isCatalogPreset]);

  React.useEffect(() => {
    setUsage(null);
    setRuntime(null);
    setLogs([]);
    setApprovals([]);
    if (!isCatalogPreset) {
      void refresh();
    }
  }, [refresh, isCatalogPreset]);

  const models = modelsFor(modelState, name);
  const reportedModel = currentModelFor(modelState, name) ?? usage?.current_model ?? undefined;
  const efforts = React.useMemo(() => parseReportedModels(usage?.available_efforts), [usage?.available_efforts]);

  // ── Activity ──
  const turns = summarizeAgentTurns(turnRows, name);
  const runningChannel = state === 'working' ? turns.running[0]?.channelName ?? null : null;
  const failedTurn = turns.reported && turns.running.length === 0 && turns.latest?.state === 'error' ? turns.latest : null;
  const threadTitle = React.useCallback(
    (id: string) => {
      const s = sessions.find((x) => x.sessionId === id);
      return s ? getSmartSessionTitle(s, lastMessageBySession[id]) : null;
    },
    [sessions, lastMessageBySession],
  );

  // Who WORKED in a thread, not who is on the roster -- see
  // channel-participants-are-roster: @mention, last sender, master, or a
  // context report from that thread. Same rule the Agents page uses.
  const recentThreads = React.useMemo(() => {
    const ids = new Set(contextRows.filter((r) => r.agentName.toLowerCase() === name.toLowerCase()).map((r) => r.channelName));
    return sessions
      .filter((s) => s.status !== 'archived' && s.status !== 'deleted')
      .filter(
        (s) =>
          ids.has(s.sessionId) ||
          extractSessionAgents(s, agents, lastMessageBySession[s.sessionId]).some(
            (a) => a.name.toLowerCase() === name.toLowerCase(),
          ),
      )
      .sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0))
      .slice(0, 4);
  }, [sessions, agents, lastMessageBySession, contextRows, name]);

  const myContexts = React.useMemo(
    () =>
      contextRows
        .filter((r) => r.agentName.toLowerCase() === name.toLowerCase())
        .sort((a, b) => (new Date(b.updatedAt).getTime() || 0) - (new Date(a.updatedAt).getTime() || 0))
        .slice(0, 3),
    [contextRows, name],
  );

  const lastSeen = heartbeatMs(agent.lastHeartbeatAt);
  const recentlyLost = !online && lastSeen > 0 && Date.now() - lastSeen < 10 * 60 * 1000;

  // ── Actions ──
  const [busy, setBusy] = React.useState<string | null>(null);

  const connect = async () => {
    setBusy('connect');
    try {
      await workspaceApi.launchAgent(name);
      toast.success(`${displayName} is starting`);
      await refreshAgents();
    } catch (e) {
      // Never swallow this one: a missing runtime, a bad token and a stopped
      // daemon all need different fixes.
      toast.error(`Could not connect ${displayName}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const stop = async () => {
    setBusy('stop');
    try {
      await workspaceApi.sendAgentControl(name, 'stop', { channel: runningChannel || undefined });
      toast.success(`Asked @${name} to stop`);
    } catch {
      toast.error('Stop request failed');
    } finally {
      setBusy(null);
    }
  };

  const chat = async () => {
    await createSession({ master: name, participants: [name] });
    setViewMode('threads');
  };

  // Description + autostart (updateMember), as in the profile slide-over.
  const [description, setDescription] = React.useState(agent.description || '');
  const [descDirty, setDescDirty] = React.useState(false);
  React.useEffect(() => {
    setDescription(agent.description || '');
    setDescDirty(false);
  }, [name, agent.description]);

  const saveDescription = async () => {
    setBusy('desc');
    try {
      await workspaceApi.updateMember(name, { description });
      await refreshAgents();
      setDescDirty(false);
      toast.success('Description saved');
    } catch {
      toast.error('Failed to save description');
    } finally {
      setBusy(null);
    }
  };

  const generateDescription = async () => {
    setBusy('gen');
    try {
      const suggestion = await workspaceApi.generateMemberDescription(name);
      if (suggestion) {
        setDescription(suggestion);
        setDescDirty(true);
      } else toast.error('Could not generate a description');
    } catch {
      toast.error('Failed to generate description');
    } finally {
      setBusy(null);
    }
  };

  const toggleAutostart = async (on: boolean) => {
    setBusy('autostart');
    try {
      await workspaceApi.updateMember(name, { autostart: on });
      await refreshAgents();
    } catch {
      toast.error('Could not update autostart');
    } finally {
      setBusy(null);
    }
  };

  const resolve = async (approval: AgentApproval, status: 'approved' | 'rejected') => {
    try {
      await workspaceApi.resolveAgentApproval(approval.id, status);
      setApprovals((cur) => cur.filter((x) => x.id !== approval.id));
    } catch {
      toast.error('Failed to resolve approval');
    }
  };

  const [confirmRemove, setConfirmRemove] = React.useState(false);
  const remove = async () => {
    if (isCloud) await workspaceApi.removeCloudAgent(name);
    else await workspaceApi.removeAgent(name);
    toast.success(`Removed @${name} from the workspace`);
    onClose();
    await refreshAgents();
  };

  const statusLine = isCatalogPreset
    ? 'Available integration · Not connected'
    : state === 'working'
      ? runningChannel && threadTitle(runningChannel)
        ? `Working in ${threadTitle(runningChannel)}`
        : 'Working'
      : state === 'online'
        ? failedTurn
          ? 'Stopped mid-turn'
          : 'Online, ready'
        : lastSeen
          ? `Offline, last seen ${timeAgo(lastSeen)}`
          : 'Offline, never connected';

  const typeLabel = isCatalogPreset
    ? 'Catalog preset'
    : agent.agentType
      ? agent.agentType.replace(/^cloud:/, 'Cloud: ')
      : 'Agent';

  return (
    <div className="@container">
      {/* ── Header: who, state, the actions that apply right now ── */}
      <div className="flex flex-wrap items-start gap-3">
        <AgentAvatar name={name} agentType={agent.agentType} size={32} status={agent.status} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="truncate text-sm font-semibold text-foreground">{displayName}</h3>
            <span className="truncate text-2xs capitalize text-foreground-extra-muted">{typeLabel}</span>
          </div>
          <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
            <StatusDot state={isCatalogPreset ? 'offline' : state} />
            <span className={cn('truncate', state === 'working' && 'event-running')}>{statusLine}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className={cn('flex items-center gap-2 text-xs', online ? 'text-foreground' : 'text-muted-foreground')}>
            <Switch
              size="sm"
              checked={selected}
              disabled={!online}
              onCheckedChange={onToggleSelected}
              aria-label={`Add @${name} to the session`}
            />
            {online ? 'In this session' : 'Connect to add'}
          </label>
          {online ? (
            <>
              {state === 'working' && (
                <Button variant="ghost" size="sm" disabled={busy === 'stop'} onClick={stop}>
                  <Square className="size-3 fill-current" />
                  Stop
                </Button>
              )}
              <Button variant="outline" size="sm" onClick={chat}>
                <MessageSquare className="size-3.5" />
                Chat
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" disabled={busy === 'connect'} onClick={connect}>
              {recentlyLost ? <RotateCw className="size-3.5" /> : <Plug className="size-3.5" />}
              {busy === 'connect' ? 'Connecting…' : recentlyLost ? 'Reconnect' : 'Connect'}
            </Button>
          )}
          <Hint label="Close (Esc)">
            <button
              type="button"
              onClick={onClose}
              aria-label="Close agent panel"
              className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-surface2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-4" />
            </button>
          </Hint>
        </div>
      </div>

      {/* ── Sections, label above value ── */}
      {isCatalogPreset ? (
        <div className="mt-3 grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
          <SubCard title="This session">
            <div>
              <FieldLabel>Model</FieldLabel>
              <FieldValue className="text-muted-foreground">
                <span className="truncate">Agent default</span>
              </FieldValue>
              <Help>Connect this agent to configure its runtime model.</Help>
            </div>
            {mode === 'master' && (
              <div>
                <FieldLabel>Lead agent</FieldLabel>
                <label className="flex h-8 items-center gap-2.5 text-xs text-muted-foreground">
                  <Switch size="sm" checked={false} disabled aria-label={`Make @${name} the lead`} />
                  Not the lead
                </label>
                <Help>Connect and add this agent to the session to make it the lead.</Help>
              </div>
            )}
          </SubCard>

          <SubCard title="Integration info">
            <div>
              <FieldLabel>Description</FieldLabel>
              <p className="text-xs leading-relaxed text-foreground">
                {catalogEntry?.description || agent.description || 'Pre-configured catalog agent.'}
              </p>
            </div>
            {catalogEntry?.tags && catalogEntry.tags.length > 0 && (
              <div>
                <FieldLabel>Capabilities</FieldLabel>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {catalogEntry.tags.map((t) => (
                    <span key={t} className="rounded bg-surface2 px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
                      {t}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {catalogEntry?.homepage && (
              <div className="pt-1">
                <a
                  href={catalogEntry.homepage}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  Official website <ExternalLink className="size-3" />
                </a>
              </div>
            )}
          </SubCard>

          <SubCard title="Installation & Command">
            {catalogEntry?.install_command ? (
              <div>
                <FieldLabel>Install CLI command</FieldLabel>
                <div className="flex h-8 min-w-0 items-center gap-2 rounded-md border border-border bg-surface2/60 px-2.5">
                  <Terminal className="size-3.5 shrink-0 text-foreground-extra-muted" />
                  <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                    {catalogEntry.install_command}
                  </code>
                  <Hint label={isCopied ? 'Copied' : 'Copy command'}>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(catalogEntry.install_command)}
                      aria-label="Copy install command"
                      className="grid size-5 place-items-center rounded text-foreground-extra-muted hover:text-foreground"
                    >
                      {isCopied ? <Check className="size-3" /> : <Copy className="size-3" />}
                    </button>
                  </Hint>
                </div>
                <Help>Run this command in your terminal to install the agent CLI, or click Connect to launch.</Help>
              </div>
            ) : null}
            <div>
              <FieldLabel>Alternative start command</FieldLabel>
              <div className="flex h-8 min-w-0 items-center gap-2 rounded-md border border-border bg-surface2/60 px-2.5">
                <Terminal className="size-3.5 shrink-0 text-foreground-extra-muted" />
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                  wwj up
                </code>
                <Hint label={isCopied ? 'Copied' : 'Copy command'}>
                  <button
                    type="button"
                    onClick={() => copyToClipboard('wwj up')}
                    aria-label="Copy command"
                    className="grid size-5 place-items-center rounded text-foreground-extra-muted hover:text-foreground"
                  >
                    {isCopied ? <Check className="size-3" /> : <Copy className="size-3" />}
                  </button>
                </Hint>
              </div>
              <Help>The local connector brings configured agents online.</Help>
            </div>
          </SubCard>

          <SubCard title="Connection">
            <div className="grid grid-cols-2 gap-2">
              <div className="min-w-0">
                <FieldLabel>Server</FieldLabel>
                <FieldValue>
                  <span className="truncate font-mono">This machine</span>
                </FieldValue>
              </div>
              <div className="min-w-0">
                <FieldLabel>Agent ID</FieldLabel>
                <FieldValue>
                  <span className="truncate font-mono">52hz:{name}</span>
                </FieldValue>
              </div>
            </div>
          </SubCard>
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
          <SubCard title="This session">
            <div>
              <FieldLabel>Model</FieldLabel>
              {online && models.length > 0 ? (
                <Select value={modelPick ?? DEFAULT_PICK} onValueChange={(v) => onModelPick(v === DEFAULT_PICK ? null : v)}>
                  <SelectTrigger size="sm" className="w-full text-xs" aria-label={`Model for ${name}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_PICK}>Agent default{reportedModel ? ` (${short(reportedModel)})` : ''}</SelectItem>
                    {models.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.shortName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <FieldValue className="text-muted-foreground">
                  <span className="truncate">{reportedModel ? short(reportedModel) : 'Agent default'}</span>
                </FieldValue>
              )}
              <Help>
                {!online
                  ? 'Pick a model once the agent is online.'
                  : models.length > 0
                    ? 'For the session you start here.'
                    : 'This agent has not reported a model list.'}
              </Help>
            </div>
            {online && efforts.length > 0 && (
              <div>
                <FieldLabel>Reasoning effort</FieldLabel>
                <Select value={effortPick ?? DEFAULT_PICK} onValueChange={(v) => onEffortPick(v === DEFAULT_PICK ? null : v)}>
                  <SelectTrigger size="sm" className="w-full text-xs" aria-label={`Reasoning effort for ${name}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={DEFAULT_PICK}>Current{usage?.current_effort ? ` (${usage.current_effort})` : ''}</SelectItem>
                    {efforts.map((e) => (
                      <SelectItem key={e.id} value={e.id}>
                        {e.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Help>Changes this agent&apos;s default, for sessions without their own level.</Help>
              </div>
            )}
            {mode === 'master' && (
              <div>
                <FieldLabel>Lead agent</FieldLabel>
                {online ? (
                  <>
                    <label className="flex h-8 items-center gap-2.5 text-xs text-foreground">
                      <Switch
                        size="sm"
                        checked={isLead}
                        disabled={!selected || (isLead && !canUnsetLead)}
                        onCheckedChange={onLeadChange}
                        aria-label={`Make @${name} the lead`}
                      />
                      {isLead ? `@${name} leads` : 'Not the lead'}
                    </label>
                    <Help>
                      {!selected
                        ? 'Add the agent to the session to make it the lead.'
                        : isLead && !canUnsetLead
                          ? 'Master mode needs a lead. Add another agent to hand it over.'
                          : 'The lead receives every message and delegates.'}
                    </Help>
                  </>
                ) : (
                  <>
                    <label className="flex h-8 items-center gap-2.5 text-xs text-muted-foreground">
                      <Switch size="sm" checked={false} disabled aria-label={`Make @${name} the lead`} />
                      Not the lead
                    </label>
                    <Help>Agent must be online to lead a session.</Help>
                  </>
                )}
              </div>
            )}
          </SubCard>

        <SubCard
          title="Status"
          action={
            <Hint label="Refresh">
              <button
                type="button"
                onClick={() => void refresh()}
                aria-label="Refresh agent status"
                className="grid size-5 place-items-center rounded text-foreground-extra-muted hover:text-foreground"
              >
                <RefreshCw className={cn('size-3', loading && 'opacity-50')} />
              </button>
            </Hint>
          }
        >
          <div>
            <FieldLabel>Activity</FieldLabel>
            {runningChannel ? (
              <button
                type="button"
                onClick={() => onOpenThread(runningChannel)}
                className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md border border-border bg-background px-2.5 text-left text-xs hover:bg-surface2"
              >
                <span className="event-running truncate">Working in {threadTitle(runningChannel) || runningChannel}</span>
              </button>
            ) : (
              <FieldValue>
                <span className={cn('truncate', failedTurn ? 'text-destructive' : 'text-foreground')}>
                  {failedTurn ? `Stopped mid-turn: ${failedTurn.error || 'no reason reported'}` : online ? 'Idle' : 'Not running'}
                </span>
              </FieldValue>
            )}
          </div>
          <div>
            <FieldLabel>Last seen</FieldLabel>
            <FieldValue>
              <span className="truncate">{online ? 'Now' : lastSeen ? timeAgo(lastSeen) : 'Never connected'}</span>
            </FieldValue>
          </div>
          <div>
            <FieldLabel>Connector</FieldLabel>
            <FieldValue>
              <span className="truncate capitalize">
                {runtime ? `${runtime.processStatus} · ${runtime.healthStatus}` : 'No runtime report'}
              </span>
              {runtime && runtime.restartCount > 0 && (
                <span className="ms-auto shrink-0 text-2xs text-foreground-extra-muted">{runtime.restartCount} restarts</span>
              )}
            </FieldValue>
            {runtime?.lastError && <p className="mt-1 break-words text-2xs text-destructive">{runtime.lastError}</p>}
          </div>
        </SubCard>

        <SubCard title="Usage">
          <div>
            <FieldLabel>Context</FieldLabel>
            {myContexts.length === 0 ? (
              <FieldValue className="text-muted-foreground">
                <ContextRing pct={null} size={14} />
                Not reported yet
              </FieldValue>
            ) : (
              <ul className="space-y-1">
                {myContexts.map((c) => {
                  const pct = contextPercent(c);
                  return (
                    <li key={c.channelName}>
                      <button
                        type="button"
                        onClick={() => onOpenThread(c.channelName)}
                        className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1 text-left text-xs hover:bg-surface2"
                      >
                        <ContextRing pct={pct} size={14} />
                        <span className="shrink-0 tabular-nums text-foreground">
                          {pct === null ? `${fmtTokens(c.promptTokens)} tokens` : `${pct}% of ${fmtTokens(c.contextWindow)}`}
                        </span>
                        <span className="truncate text-foreground-extra-muted">{threadTitle(c.channelName) || c.channelName}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <Help>Each thread has its own context; a new session starts fresh.</Help>
          </div>
          {usage && (usage.session_used_percent > 0 || usage.week_used_percent > 0) && (
            <div>
              <FieldLabel>Plan usage</FieldLabel>
              <div className="grid grid-cols-2 gap-2">
                <FieldValue>
                  <span className="tabular-nums">Session {Math.round(usage.session_used_percent)}%</span>
                </FieldValue>
                <FieldValue>
                  <span className="tabular-nums">Week {Math.round(usage.week_used_percent)}%</span>
                </FieldValue>
              </div>
              {usage.session_resets_at && <Help>Session resets {new Date(usage.session_resets_at).toLocaleString()}</Help>}
            </div>
          )}
          {usage?.total_tokens ? (
            <div>
              <FieldLabel>Tokens used</FieldLabel>
              <FieldValue>
                <span className="tabular-nums">{fmtTokens(usage.total_tokens)}</span>
              </FieldValue>
            </div>
          ) : null}
        </SubCard>

        <SubCard title="Recent threads">
          {recentThreads.length === 0 ? (
            <p className="text-xs text-foreground-extra-muted">Has not worked in a thread yet.</p>
          ) : (
            <ul className="-mx-1 space-y-0.5">
              {recentThreads.map((s) => (
                <li key={s.sessionId}>
                  <button
                    type="button"
                    onClick={() => onOpenThread(s.sessionId)}
                    className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-1 text-left text-xs hover:bg-surface2"
                  >
                    <MessageSquare className="size-3.5 shrink-0 text-foreground-extra-muted" />
                    <span className="truncate text-foreground">{threadTitle(s.sessionId)}</span>
                    <span className="ms-auto shrink-0 text-2xs tabular-nums text-foreground-extra-muted">
                      {formatCompactRelativeTime(s.lastEventAt || 0)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </SubCard>

        <SubCard title="Profile">
          <div>
            <div className="mb-1 flex items-center justify-between">
              <FieldLabel htmlFor={`desc-${name}`}>Description</FieldLabel>
              <Hint label="Draft one from this agent's activity and skills">
                <button
                  type="button"
                  onClick={generateDescription}
                  disabled={busy === 'gen'}
                  className="inline-flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  <Sparkles className="size-3" />
                  {busy === 'gen' ? 'Drafting…' : 'Draft'}
                </button>
              </Hint>
            </div>
            <textarea
              id={`desc-${name}`}
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                setDescDirty(true);
              }}
              rows={2}
              placeholder="What this agent is good at. The router reads this."
              className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            />
            {descDirty && (
              <div className="mt-1 flex justify-end">
                <Button variant="outline" size="sm" disabled={busy === 'desc'} onClick={saveDescription}>
                  Save
                </Button>
              </div>
            )}
          </div>
          <label className="flex items-center justify-between gap-3">
            <span>
              <span className="block text-xs text-foreground">Connect on launch</span>
              <span className="block text-2xs text-foreground-extra-muted">Start this agent when the app opens.</span>
            </span>
            <Switch
              size="sm"
              checked={!!agent.autostart}
              disabled={busy === 'autostart'}
              onCheckedChange={toggleAutostart}
              aria-label="Connect on launch"
            />
          </label>
        </SubCard>

        <SubCard title="Connection">
          <div className="grid grid-cols-2 gap-2">
            <div className="min-w-0">
              <FieldLabel>Server</FieldLabel>
              <FieldValue>
                <span className="truncate font-mono">{agent.serverHost || 'This machine'}</span>
              </FieldValue>
            </div>
            <div className="min-w-0">
              <FieldLabel>Agent ID</FieldLabel>
              <FieldValue>
                <span className="truncate font-mono">52hz:{name}</span>
              </FieldValue>
            </div>
          </div>
          {agent.workingDir && (
            <div>
              <FieldLabel>Default folder</FieldLabel>
              <FieldValue>
                <span className="truncate font-mono" title={agent.workingDir}>
                  {agent.workingDir}
                </span>
              </FieldValue>
            </div>
          )}
          {!online && !isCloud && (
            <div>
              <FieldLabel>If Connect does not work</FieldLabel>
              <div className="flex h-8 min-w-0 items-center gap-2 rounded-md border border-border bg-surface2/60 px-2.5">
                <Terminal className="size-3.5 shrink-0 text-foreground-extra-muted" />
                <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">wwj up</code>
                <Hint label={isCopied ? 'Copied' : 'Copy command'}>
                  <button
                    type="button"
                    onClick={() => copyToClipboard('wwj up')}
                    aria-label="Copy command"
                    className="grid size-5 place-items-center rounded text-foreground-extra-muted hover:text-foreground"
                  >
                    {isCopied ? <Check className="size-3" /> : <Copy className="size-3" />}
                  </button>
                </Hint>
              </div>
              <Help>
                Run it on {agent.serverHost ? agent.serverHost : 'the machine that runs this agent'}. The local connector
                brings its configured agents online{token ? '' : ' once it is paired with this workspace'}.
              </Help>
            </div>
          )}
        </SubCard>

        {(approvals.length > 0 || logs.length > 0) && (
          <SubCard title="Diagnostics" className="@2xl:col-span-2 @5xl:col-span-3">
            {approvals.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs text-foreground">Approval requested: {a.action}</span>
                <Button variant="ghost" size="sm" onClick={() => resolve(a, 'rejected')}>
                  <ShieldX className="size-3.5" />
                  Reject
                </Button>
                <Button variant="outline" size="sm" onClick={() => resolve(a, 'approved')}>
                  <ShieldCheck className="size-3.5" />
                  Approve
                </Button>
              </div>
            ))}
            {logs.length > 0 && (
              <ul className="space-y-1">
                {logs.map((l) => (
                  <li key={l.id} className="flex gap-2 font-mono text-2xs">
                    <span className={cn('shrink-0', l.level === 'error' ? 'text-destructive' : 'text-foreground-extra-muted')}>
                      {l.level}
                    </span>
                    <span className="break-all text-foreground-muted">{l.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </SubCard>
        )}
      </div>
      )}

      {/* ── Rare and destructive: out of the way ── */}
      {isCatalogPreset ? (
        <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>Official catalog preset. Click Connect above to launch and pair it with this workspace.</span>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={() => setSelectedAgentName(name)}>
            Full profile{isCloud ? ' and API key' : ''}
          </Button>
          <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setConfirmRemove(true)}>
            <Trash2 className="size-3.5" />
            Remove from workspace
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove agent"
        targetName={`@${name}`}
        description="Its membership is deleted and any thread it led gets a new lead. Messages it already sent stay. Connecting it again adds it back."
        confirmLabel="Remove"
        onConfirm={remove}
      />
    </div>
  );
}
