'use client';

import * as React from 'react';
import {
  ArrowRight,
  Check,
  Folder,
  GitBranch,
  Play,
  Plug,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { Switch } from '@/components/ui/switch';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { ContextRing } from '@/components/chat/context-ring';
import {
  ProjectFolderPicker,
  basename,
  rememberWorkingDir,
} from '@/components/chat/project-folder-picker';
import { ORCHESTRATION_MODES, type OrchestrationMode } from '@/components/chat/orchestration-control';
import { useLayout } from '@/components/layout/layout-context';
import { useWorkspace } from '@/lib/workspace-context';
import { workspaceApi } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  currentModelFor,
  hydrateAgentModels,
  modelsFor,
  parseReportedModels,
  rememberForSession,
  setCurrentModel,
  useAgentModels,
} from '@/lib/agent-model-store';
import {
  AGENT_PROFILES,
  DEFAULT_PROFILE_ID,
  getProfile,
  saveThreadProfile,
  type AgentProfileId,
} from '@/lib/agent-profiles';
import { useAgentContexts, contextPercent, fmtTokens } from '@/lib/use-agent-contexts';
import { useAgentTurns, summarizeAgentTurns } from '@/lib/use-agent-turns';
import type { GitStatus } from '@/lib/use-git-status';
import type { AgentUsage, WorkspaceAgent, WorkspaceSession } from '@/lib/types';
import { getSmartSessionTitle } from '@/components/threads/thread-list';
import { FieldLabel, FieldValue, HomePanel, StatusDot } from './home-panel';
import { NeedsAttentionPanel, RecentSessionsPanel, UpcomingPanel } from './home-sections';

/*
  HOME: CONFIGURE, THEN ENTER THE CHAT.

  The landing view when no session is open. Its structure is taken from a
  deploy tool's "new project" page -- a grid of small tiles, the selected tile
  opening its configuration below, a rail of choices on the right ending in
  ONE primary action and a summary of what that action will do. The colours
  are not: tokens only, the status accents only for status.

  Every control here writes through a mechanism the thread already has, so a
  session started from Home is indistinguishable from one configured in the
  composer afterwards:
  - agents + folder -> createSession() (a local draft; nothing reaches the
    server until the first message -- see workspace-context)
  - lead agent      -> createSession({ master }) -> createChannel on first send
  - mode            -> setSessionOrchestration(draftId) -> PATCH on first send
  - Fix / Review    -> saveThreadProfile(draftId), moved to the real id on send
  - model           -> rememberForSession(draftId) (the composer chip's keys),
                       migrated on send and carried as `agent_models` metadata
  - effort          -> `set_effort` control, agent-wide (a draft has no
                       channel yet to scope it to; the card says so)
*/

const DEFAULT_MODEL = '__agent_default__';

type AgentState = 'online' | 'working' | 'offline';

function samePath(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  const norm = (p: string) => p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

function sessionTime(s: WorkspaceSession): number {
  return s.lastEventAt || (s.createdAt ? new Date(s.createdAt).getTime() || 0 : 0);
}

export function HomeDashboard() {
  const {
    agents,
    sessions,
    lastMessageBySession,
    workingAgentNames,
    createSession,
    setSessionOrchestration,
    setCurrentSessionId,
  } = useWorkspace();
  const { setViewMode, setTasksTab, isSidebarOpen, isMobile, openMobileDetail, setSelectedAgentName } = useLayout();
  const { rows: turnRows } = useAgentTurns();
  const { rows: contextRows } = useAgentContexts();
  const modelState = useAgentModels();

  // ── Roster, with the status the rest of the app already agrees on ──
  const stateOf = React.useCallback(
    (a: WorkspaceAgent): AgentState => {
      if (a.status !== 'online') return 'offline';
      const turns = summarizeAgentTurns(turnRows, a.agentName);
      const working = turns.reported ? turns.running.length > 0 : workingAgentNames.has(a.agentName);
      return working ? 'working' : 'online';
    },
    [turnRows, workingAgentNames],
  );
  const onlineAgents = React.useMemo(() => agents.filter((a) => a.status === 'online'), [agents]);
  const counts = React.useMemo(() => {
    let working = 0;
    for (const a of onlineAgents) if (stateOf(a) === 'working') working++;
    return { online: onlineAgents.length, working, offline: agents.length - onlineAgents.length };
  }, [agents.length, onlineAgents, stateOf]);

  // ── Setup state ──
  const [tab, setTab] = React.useState<'online' | 'all'>(() => (onlineAgents.length > 0 ? 'online' : 'all'));
  const [selected, setSelected] = React.useState<string[]>([]);
  const [focused, setFocused] = React.useState<string | null>(null);
  const [workingDir, setWorkingDir] = React.useState('');
  const [mode, setMode] = React.useState<OrchestrationMode>('dynamic');
  const [lead, setLead] = React.useState<string | null>(null);
  const [profile, setProfile] = React.useState<AgentProfileId>(DEFAULT_PROFILE_ID);
  const [modelPicks, setModelPicks] = React.useState<Record<string, string>>({});
  const [effortPicks, setEffortPicks] = React.useState<Record<string, string>>({});
  const [starting, setStarting] = React.useState(false);

  // One agent online: it is the only possible choice, so it starts selected.
  const soleOnline = onlineAgents.length === 1 ? onlineAgents[0].agentName : null;
  React.useEffect(() => {
    if (!soleOnline) return;
    setSelected((prev) => (prev.length === 0 ? [soleOnline] : prev));
    setFocused((prev) => prev ?? soleOnline);
  }, [soleOnline]);

  // An agent that goes offline while selected leaves the selection.
  React.useEffect(() => {
    const online = new Set(onlineAgents.map((a) => a.agentName));
    setSelected((prev) => (prev.every((n) => online.has(n)) ? prev : prev.filter((n) => online.has(n))));
  }, [onlineAgents]);
  React.useEffect(() => {
    if (focused && !selected.includes(focused)) setFocused(selected[selected.length - 1] ?? null);
  }, [selected, focused]);

  const toggleAgent = (name: string) => {
    if (selected.includes(name)) {
      setSelected((prev) => prev.filter((n) => n !== name));
    } else {
      setSelected((prev) => [...prev, name]);
      setFocused(name);
    }
  };

  const effectiveLead = mode === 'master' ? (lead && selected.includes(lead) ? lead : selected[0] ?? null) : null;

  // ── What each agent reports: models, effort ──
  const [usage, setUsage] = React.useState<Record<string, AgentUsage | null>>({});
  React.useEffect(() => {
    if (!focused) return;
    let cancelled = false;
    void workspaceApi.getAgentUsage(focused).then((u) => {
      if (cancelled) return;
      setUsage((prev) => ({ ...prev, [focused]: u }));
      if (u) {
        hydrateAgentModels(focused, {
          options: parseReportedModels(u.available_models),
          current: u.current_model,
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [focused]);

  // ── Project: branch, from a thread already bound to the same folder ──
  const dir = workingDir.trim();
  const sibling = React.useMemo(
    () =>
      dir
        ? sessions
            .filter((s) => s.status !== 'deleted' && samePath(s.workingDir, dir))
            .sort((a, b) => sessionTime(b) - sessionTime(a))[0] ?? null
        : null,
    [sessions, dir],
  );
  const [git, setGit] = React.useState<GitStatus | null>(null);
  const siblingId = sibling?.sessionId ?? null;
  React.useEffect(() => {
    setGit(null);
    if (!siblingId) return;
    let cancelled = false;
    workspaceApi
      .getGitStatus(siblingId)
      .then((g) => {
        if (!cancelled) setGit(g);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [siblingId]);
  const isRepo = git ? git.available : null; // null = not known yet

  // ── Navigation ──
  const openThread = React.useCallback(
    (sessionId: string) => {
      setCurrentSessionId(sessionId);
      setViewMode('threads');
      if (isMobile) openMobileDetail();
    },
    [setCurrentSessionId, setViewMode, isMobile, openMobileDetail],
  );
  const openAutomations = React.useCallback(() => {
    setTasksTab('runs');
    setViewMode('tasks');
  }, [setTasksTab, setViewMode]);

  // ── Start ──
  const canStart = selected.length > 0 && !starting;
  const startBlockedReason =
    onlineAgents.length === 0
      ? 'No agent is online. Connect one in Agents to start a session.'
      : selected.length === 0
        ? 'Select at least one agent to start.'
        : null;

  const handleStart = async () => {
    if (!canStart) return;
    setStarting(true);
    // The view switches in the same flush that opens the draft, so the chat is
    // visible when ChatView's "new session -> focus the composer" effect runs.
    // Home unmounts on that render; everything below is writes, not state.
    setViewMode('threads');
    if (isMobile) openMobileDetail();
    try {
      const session = await createSession({
        participants: selected,
        workingDir: dir || undefined,
        master: effectiveLead ?? undefined,
      });
      const id = session.sessionId;
      if (mode !== 'dynamic') await setSessionOrchestration(id, { mode });
      saveThreadProfile(id, profile);
      for (const [agentName, modelId] of Object.entries(modelPicks)) {
        if (!selected.includes(agentName)) continue;
        rememberForSession(id, agentName, modelId);
        setCurrentModel(agentName, modelId);
      }
      for (const [agentName, effort] of Object.entries(effortPicks)) {
        if (!selected.includes(agentName)) continue;
        workspaceApi
          .sendAgentControl(agentName, 'set_effort', { effort })
          .catch((e) =>
            toast.error(
              `@${agentName} could not switch effort${e instanceof Error && e.message ? `: ${e.message}` : ''}`,
            ),
          );
      }
      rememberWorkingDir(dir);
    } catch (e) {
      setViewMode('home');
      toast.error(e instanceof Error ? e.message : 'Could not start the session');
      setStarting(false);
    }
  };

  // ── Derived display ──
  const shownAgents = tab === 'online' ? onlineAgents : agents;
  const focusedAgent = focused ? agents.find((a) => a.agentName === focused) ?? null : null;
  const modeInfo = ORCHESTRATION_MODES.find((m) => m.value === mode)!;
  const profileInfo = getProfile(profile);
  const isolation =
    mode !== 'parallel'
      ? dir
        ? 'Shared folder'
        : 'No folder'
      : !dir
        ? 'No folder'
        : isRepo === true
          ? 'Own worktree per agent'
          : isRepo === false
            ? 'Shared folder (not a git repo)'
            : 'Own worktree if the folder is a git repo';

  const headerCounts = [
    `${counts.online} of ${agents.length} ${agents.length === 1 ? 'agent' : 'agents'} online`,
    counts.working > 0 ? `${counts.working} working` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface0">
      <div className={cn('app-header ps-6', !isSidebarOpen && !isMobile && 'ps-14')}>
        <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
          <h1 className="shrink-0 text-sm font-semibold tracking-tight text-foreground">Home</h1>
          {agents.length > 0 && <p className="truncate text-xs tabular-nums text-muted-foreground">{headerCounts}</p>}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-6xl grid-cols-1 items-start gap-4 p-4 sm:p-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          {/* ── Setup: agents, then the selected agent's configuration ── */}
          <div className="flex min-w-0 flex-col gap-4">
            <HomePanel
              id="home-agents"
              title="Agents"
              subtitle={
                agents.length === 0
                  ? 'No agents connected yet.'
                  : `Pick who joins the session. ${counts.online} online${counts.working ? `, ${counts.working} working` : ''}${counts.offline ? `, ${counts.offline} offline` : ''}.`
              }
              action={
                <Button variant="ghost" size="sm" onClick={() => setViewMode('mission')}>
                  Manage
                  <ArrowRight className="size-3" />
                </Button>
              }
            >
              {agents.length === 0 ? (
                <div className="flex flex-col items-start gap-3">
                  <p className="text-xs text-muted-foreground">
                    A session needs at least one agent. Connect a CLI agent (Claude Code, Codex, Gemini, …) from the Agents page.
                  </p>
                  <Button variant="outline" size="sm" onClick={() => setViewMode('mission')}>
                    <Plug className="size-3.5" />
                    Connect an agent
                  </Button>
                </div>
              ) : (
                <>
                  <SegmentedControl
                    size="xs"
                    value={tab}
                    onValueChange={setTab}
                    options={[
                      { value: 'online', label: `Online ${counts.online}` },
                      { value: 'all', label: `All ${agents.length}` },
                    ]}
                  />
                  {shownAgents.length === 0 ? (
                    <p className="mt-3 text-xs text-muted-foreground">
                      No agent is online.{' '}
                      <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setTab('all')}>
                        Show all agents
                      </button>
                    </p>
                  ) : (
                    <div
                      role="group"
                      aria-label="Agents to include"
                      className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2"
                    >
                      {shownAgents.map((a) => (
                        <AgentTile
                          key={a.agentName}
                          agent={a}
                          state={stateOf(a)}
                          selected={selected.includes(a.agentName)}
                          focused={focused === a.agentName}
                          isLead={effectiveLead === a.agentName}
                          onToggle={() => toggleAgent(a.agentName)}
                        />
                      ))}
                    </div>
                  )}
                  {tab === 'all' && counts.offline > 0 && (
                    <p className="mt-2.5 text-2xs text-foreground-extra-muted">
                      Offline agents can join once they are connected.
                    </p>
                  )}
                </>
              )}
            </HomePanel>

            {focusedAgent && (
              <AgentConfigCard
                agent={focusedAgent}
                usage={usage[focusedAgent.agentName]}
                models={modelsFor(modelState, focusedAgent.agentName)}
                reportedModel={currentModelFor(modelState, focusedAgent.agentName) ?? usage[focusedAgent.agentName]?.current_model ?? undefined}
                modelPick={modelPicks[focusedAgent.agentName]}
                onModelPick={(m) =>
                  setModelPicks((prev) => {
                    const next = { ...prev };
                    if (m) next[focusedAgent.agentName] = m;
                    else delete next[focusedAgent.agentName];
                    return next;
                  })
                }
                effortPick={effortPicks[focusedAgent.agentName]}
                onEffortPick={(e) =>
                  setEffortPicks((prev) => {
                    const next = { ...prev };
                    if (e) next[focusedAgent.agentName] = e;
                    else delete next[focusedAgent.agentName];
                    return next;
                  })
                }
                contextRows={contextRows}
                threadTitle={(id) => {
                  const s = sessions.find((x) => x.sessionId === id);
                  return s ? getSmartSessionTitle(s, lastMessageBySession[id]) : null;
                }}
                mode={mode}
                isLead={effectiveLead === focusedAgent.agentName}
                canUnsetLead={selected.length > 1}
                onLeadChange={(on) => {
                  if (on) setLead(focusedAgent.agentName);
                  else setLead(selected.find((n) => n !== focusedAgent.agentName) ?? focusedAgent.agentName);
                }}
                onOpenProfile={() => setSelectedAgentName(focusedAgent.agentName)}
              />
            )}
          </div>

          {/* ── Rail: where, how, go, and what "go" will do ── */}
          <aside
            aria-label="Session settings"
            className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-0 lg:col-start-2 lg:row-span-2 lg:row-start-1"
          >
            <HomePanel id="home-project" title="Project" subtitle="The folder agents read and write. Optional.">
              <ProjectFolderPicker
                value={workingDir}
                onChange={setWorkingDir}
                helperText="Leave empty for a plain chat with no file access."
              />
              {dir && (
                <div className="mt-3 space-y-1.5">
                  {git?.available ? (
                    <>
                      <FieldLabel>Branch</FieldLabel>
                      <FieldValue>
                        <GitBranch className="size-3.5 shrink-0 text-foreground-muted" />
                        <span className="truncate font-mono">{git.branch || 'detached'}</span>
                        {(git.additions > 0 || git.deletions > 0) && (
                          <span className="ms-auto shrink-0 font-mono text-2xs text-foreground-extra-muted">
                            +{git.additions} −{git.deletions}
                          </span>
                        )}
                      </FieldValue>
                      <p className="text-2xs text-muted-foreground">Each agent works in its own worktree in Parallel mode.</p>
                    </>
                  ) : git && !git.available ? (
                    <p className="text-2xs text-muted-foreground">
                      Not a git repository. In Parallel mode, agents share this folder.
                    </p>
                  ) : !sibling ? (
                    <p className="text-2xs text-foreground-extra-muted">
                      Branch details appear once a session has used this folder.
                    </p>
                  ) : null}
                </div>
              )}
            </HomePanel>

            <HomePanel id="home-mode" title="Collaboration" subtitle="How the agents take turns.">
              <SegmentedControl
                size="sm"
                className="w-full [&>button]:flex-1"
                value={mode}
                onValueChange={setMode}
                options={ORCHESTRATION_MODES.map((m) => ({
                  value: m.value,
                  label: m.label,
                  icon: m.icon as React.ComponentType<{ className?: string }>,
                }))}
              />
              <p className="mt-2 text-2xs text-muted-foreground">
                {modeInfo.description}
                {mode === 'master' &&
                  (effectiveLead
                    ? ` Lead: @${effectiveLead}. Change it in the agent's configuration.`
                    : ' Select an agent to lead.')}
              </p>
            </HomePanel>

            <HomePanel id="home-profile" title="Work mode" subtitle="Review is read-only.">
              <SegmentedControl
                size="sm"
                className="w-full [&>button]:flex-1"
                value={profile}
                onValueChange={setProfile}
                options={AGENT_PROFILES.map((p) => ({ value: p.id, label: p.label, icon: p.icon }))}
              />
              <p className="mt-2 text-2xs text-muted-foreground">{profileInfo.whenToUse}</p>
            </HomePanel>

            <div>
              <Button
                variant="primary"
                size="lg"
                className="w-full"
                disabled={!canStart}
                onClick={handleStart}
              >
                <Play className="size-3.5" />
                {starting ? 'Starting…' : 'Start session'}
              </Button>
              {startBlockedReason && (
                <p className="mt-1.5 text-center text-2xs text-muted-foreground">{startBlockedReason}</p>
              )}
            </div>

            <HomePanel id="home-summary" title="Summary" subtitle="What Start session will open.">
              <dl className="space-y-2 text-xs">
                <SummaryRow icon={<Folder className="size-3.5" />} label="Folder">
                  {dir ? <span title={dir}>{basename(dir)}</span> : <span className="text-foreground-extra-muted">None, plain chat</span>}
                </SummaryRow>
                <SummaryRow icon={<Users className="size-3.5" />} label="Agents">
                  {selected.length > 0 ? (
                    selected.map((n) => `@${n}`).join(', ')
                  ) : (
                    <span className="text-foreground-extra-muted">None selected</span>
                  )}
                </SummaryRow>
                <SummaryRow icon={<modeInfo.icon className="size-3.5" />} label="Mode">
                  {modeInfo.label}
                  {effectiveLead && <span className="text-foreground-muted"> · lead @{effectiveLead}</span>}
                </SummaryRow>
                <SummaryRow icon={<profileInfo.icon className="size-3.5" />} label="Work mode">
                  {profileInfo.label}
                  {profile === 'review' && <span className="text-foreground-muted"> · read-only</span>}
                </SummaryRow>
                <SummaryRow icon={<GitBranch className="size-3.5" />} label="Isolation">
                  {isolation}
                </SummaryRow>
                {Object.keys(modelPicks).some((n) => selected.includes(n)) && (
                  <SummaryRow icon={<Check className="size-3.5" />} label="Models">
                    {Object.entries(modelPicks)
                      .filter(([n]) => selected.includes(n))
                      .map(([n, m]) => `@${n}: ${m.includes('/') ? m.slice(m.indexOf('/') + 1) : m}`)
                      .join(', ')}
                  </SummaryRow>
                )}
              </dl>
            </HomePanel>
          </aside>

          {/* ── What is going on, from data the app already tracks ── */}
          <div className="flex min-w-0 flex-col gap-4 lg:col-start-1">
            <NeedsAttentionPanel onOpenThread={openThread} onOpenAutomations={openAutomations} />
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <RecentSessionsPanel onOpenThread={openThread} />
              <UpcomingPanel onOpenAutomations={openAutomations} onOpenThread={openThread} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SummaryRow({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-foreground-extra-muted">{icon}</span>
      <dt className="w-20 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-foreground">{children}</dd>
    </div>
  );
}

// ── Tile ─────────────────────────────────────────────────────────────────────

function AgentTile({
  agent,
  state,
  selected,
  focused,
  isLead,
  onToggle,
}: {
  agent: WorkspaceAgent;
  state: AgentState;
  selected: boolean;
  focused: boolean;
  isLead: boolean;
  onToggle: () => void;
}) {
  const offline = state === 'offline';
  const stateWord = state === 'working' ? 'Working' : state === 'online' ? 'Online' : 'Offline';
  const tile = (
    <button
      type="button"
      aria-pressed={selected}
      // aria-disabled, not disabled: a disabled button fires no pointer
      // events, so the Hint that explains WHY it is disabled could never open.
      aria-disabled={offline || undefined}
      onClick={offline ? undefined : onToggle}
      className={cn(
        'relative flex min-w-0 flex-col items-center gap-1.5 rounded-lg border px-2 pb-2 pt-3 text-center outline-none transition-colors',
        'focus-visible:ring-2 focus-visible:ring-ring',
        selected
          ? 'border-foreground/70 bg-surface2 ring-1 ring-foreground/70'
          : 'border-border bg-background hover:border-border-accent hover:bg-surface2/60',
        focused && selected && 'bg-surface2',
        offline && 'cursor-not-allowed opacity-55 hover:border-border hover:bg-background',
      )}
    >
      {selected && (
        <span className="absolute right-1.5 top-1.5 flex size-3.5 items-center justify-center rounded-full bg-foreground text-background">
          <Check className="size-2.5" strokeWidth={3} />
        </span>
      )}
      <AgentAvatar name={agent.agentName} agentType={agent.agentType} size={28} status={agent.status} />
      <span className="w-full truncate text-xs font-medium text-foreground">{agent.agentName}</span>
      <span className="inline-flex items-center gap-1 text-3xs text-muted-foreground">
        <StatusDot state={state} />
        {isLead ? 'Lead' : stateWord}
      </span>
    </button>
  );
  return offline ? (
    <Hint label={`@${agent.agentName} is offline. Connect it in Agents to add it.`}>{tile}</Hint>
  ) : (
    tile
  );
}

// ── Configuration card ───────────────────────────────────────────────────────

function AgentConfigCard({
  agent,
  usage,
  models,
  reportedModel,
  modelPick,
  onModelPick,
  effortPick,
  onEffortPick,
  contextRows,
  threadTitle,
  mode,
  isLead,
  canUnsetLead,
  onLeadChange,
  onOpenProfile,
}: {
  agent: WorkspaceAgent;
  usage: AgentUsage | null | undefined;
  models: ReturnType<typeof modelsFor>;
  reportedModel?: string;
  modelPick?: string;
  onModelPick: (modelId: string | null) => void;
  effortPick?: string;
  onEffortPick: (effort: string | null) => void;
  contextRows: ReturnType<typeof useAgentContexts>['rows'];
  threadTitle: (sessionId: string) => string | null;
  mode: OrchestrationMode;
  isLead: boolean;
  canUnsetLead: boolean;
  onLeadChange: (on: boolean) => void;
  onOpenProfile: () => void;
}) {
  const name = agent.agentName;
  const short = (id: string) => (id.includes('/') ? id.slice(id.indexOf('/') + 1) : id);
  const efforts = React.useMemo(() => parseReportedModels(usage?.available_efforts), [usage?.available_efforts]);

  // The agent's most recent context report, from any thread. Context belongs
  // to the agent's CLI session per thread, so a new session starts fresh; this
  // is shown as "how full it got last time", not as this session's number.
  const lastContext = React.useMemo(() => {
    const mine = contextRows.filter((r) => r.agentName.toLowerCase() === name.toLowerCase());
    return mine.sort((a, b) => (new Date(b.updatedAt).getTime() || 0) - (new Date(a.updatedAt).getTime() || 0))[0] ?? null;
  }, [contextRows, name]);
  const pct = lastContext ? contextPercent(lastContext) : null;

  const subtitle = modelPick
    ? effortPick
      ? 'Custom model and reasoning effort'
      : 'Custom model'
    : effortPick
      ? 'Custom reasoning effort'
      : 'Using defaults';

  return (
    <HomePanel
      id="home-agent-config"
      title={
        <span className="inline-flex items-center gap-2">
          <AgentAvatar name={name} agentType={agent.agentType} size={18} />
          {name} configuration
        </span>
      }
      subtitle={subtitle}
      action={
        <Button variant="ghost" size="sm" onClick={onOpenProfile}>
          Agent details
        </Button>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="min-w-0">
          <FieldLabel>Model</FieldLabel>
          {models.length > 0 ? (
            <Select value={modelPick ?? DEFAULT_MODEL} onValueChange={(v) => onModelPick(v === DEFAULT_MODEL ? null : v)}>
              <SelectTrigger size="sm" className="w-full text-xs" aria-label={`Model for ${name}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_MODEL}>
                  Agent default{reportedModel ? ` (${short(reportedModel)})` : ''}
                </SelectItem>
                {models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.shortName}
                    {m.provider ? <span className="text-foreground-extra-muted"> · {m.provider}</span> : null}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <FieldValue className="text-muted-foreground">
              <span className="truncate">{reportedModel ? short(reportedModel) : 'Agent default'}</span>
            </FieldValue>
          )}
          <p className="mt-1 text-2xs text-foreground-extra-muted">
            {models.length > 0 ? 'For this session only.' : 'This agent has not reported a model list.'}
          </p>
        </div>

        {efforts.length > 0 && (
          <div className="min-w-0">
            <FieldLabel>Reasoning effort</FieldLabel>
            <Select value={effortPick ?? DEFAULT_MODEL} onValueChange={(v) => onEffortPick(v === DEFAULT_MODEL ? null : v)}>
              <SelectTrigger size="sm" className="w-full text-xs" aria-label={`Reasoning effort for ${name}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_MODEL}>
                  Current{usage?.current_effort ? ` (${usage.current_effort})` : ''}
                </SelectItem>
                {efforts.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-2xs text-foreground-extra-muted">
              Changes this agent's default, for sessions without their own level.
            </p>
          </div>
        )}

        <div className="min-w-0">
          <FieldLabel>Last reported context</FieldLabel>
          <FieldValue>
            <ContextRing pct={pct} size={14} />
            {lastContext && lastContext.contextWindow > 0 ? (
              <span className="truncate tabular-nums">
                {pct ?? 0}% of {fmtTokens(lastContext.contextWindow)}
                {threadTitle(lastContext.channelName) && (
                  <span className="text-foreground-extra-muted"> · {threadTitle(lastContext.channelName)}</span>
                )}
              </span>
            ) : (
              <span className="truncate text-muted-foreground">Not reported yet</span>
            )}
          </FieldValue>
          <p className="mt-1 text-2xs text-foreground-extra-muted">A new session starts with a fresh context.</p>
        </div>

        {mode === 'master' && (
          <div className="min-w-0">
            <FieldLabel htmlFor="home-lead-switch">Lead agent</FieldLabel>
            <div className="flex h-8 items-center gap-2.5">
              <Switch
                id="home-lead-switch"
                size="sm"
                checked={isLead}
                disabled={isLead && !canUnsetLead}
                onCheckedChange={onLeadChange}
                aria-label={`Make @${name} the lead`}
              />
              <span className="text-xs text-foreground">{isLead ? `@${name} leads` : 'Not the lead'}</span>
            </div>
            <p className="mt-1 text-2xs text-foreground-extra-muted">
              {isLead && !canUnsetLead
                ? 'Master mode needs a lead. Add another agent to hand it over.'
                : 'The lead receives every message and delegates.'}
            </p>
          </div>
        )}
      </div>
    </HomePanel>
  );
}
