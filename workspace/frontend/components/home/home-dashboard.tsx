'use client';

import * as React from 'react';
import { ArrowUp, Cpu, Eye, Folder, GitBranch, Users, Waypoints, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { SegmentedControl } from '@/components/ui/segmented-control';
import {
  ProjectFolderPicker,
  basename,
  rememberWorkingDir,
} from '@/components/chat/project-folder-picker';
import { ORCHESTRATION_MODES, type OrchestrationMode } from '@/components/chat/orchestration-control';
import { useLayout } from '@/components/layout/layout-context';
import { ActivityTimeline } from '@/components/mission/activity-timeline';
import { useActivityFeed } from '@/components/mission/use-activity-feed';
import { useWorkspace } from '@/lib/workspace-context';
import { workspaceApi } from '@/lib/api';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { rememberForSession, setCurrentModel } from '@/lib/agent-model-store';
import {
  AGENT_PROFILES,
  DEFAULT_PROFILE_ID,
  getProfile,
  saveThreadProfile,
  type AgentProfileId,
} from '@/lib/agent-profiles';
import { useAgentTurns, summarizeAgentTurns } from '@/lib/use-agent-turns';
import { sendFirstMessage } from '@/lib/first-message';
import { isComposing } from '@/lib/ime';
import type { GitStatus } from '@/lib/use-git-status';
import type { AgentCatalogEntry, WorkspaceAgent, WorkspaceSession } from '@/lib/types';
import { useAgentCatalog, catalogAsOfflineAgents } from '@/lib/agent-catalog';
import { FieldLabel, FieldValue, HomePanel } from './home-panel';
import { NeedsAttentionPanel, RecentSessionsPanel, UpcomingPanel } from './home-sections';
import { AgentGrid } from './agent-grid';
import { OutputPanel } from './output-panel';
import { AgentDetailPanel, type AgentState } from './agent-detail-panel';
import { ConnectAgentModal } from '@/components/mission/connect-agent-modal';

/*
  HOME: CONFIGURE, THEN ENTER THE CHAT.

  The landing view when no session is open, and the one place per-agent work
  happens (the agent panel under each tile -- see agent-detail-panel).

  LAYOUT FOLLOWS THE PANE, NOT THE WINDOW. The sizes are container queries on
  the scroll area (`@container`), because the pane is the window minus a
  resizable sidebar: at a 1650px window the pane is ~1330px, at 1280 it is
  ~960. Main column + rail from 960px; the rail widens and the lower cards go
  three-up from 1200px. Cards in a row stretch to one height, and the rail
  ends in the activity feed, which takes whatever height is left -- so no
  column stops halfway down the page.

  Every control writes through a mechanism the thread already has:
  - agents + folder + lead + mode -> createSession() (a local draft; nothing
    reaches the server until the first message -- see workspace-context)
  - Fix / Review    -> saveThreadProfile(draftId), moved to the real id on send
  - model           -> rememberForSession(draftId) (the composer chip's keys)
  - effort          -> `set_effort` control, agent-wide (a draft has no channel)
  - the task text   -> ChatView's own send path (lib/first-message)
*/

/*
  SCENE PRESETS: two controls set in one click.

  A preset is only ever a (collaboration mode, work mode) pair. It does not tick
  agents or pick a folder: the roster has no notion of which agent is a
  reviewer, and Home has no "current repo" to mount. Which preset is lit is
  derived from those two values, so changing either control by hand turns it
  off without any extra state to keep in sync.
*/
const PRESETS: {
  id: string;
  label: string;
  hint: string;
  icon: React.ElementType;
  mode: OrchestrationMode;
  profile: AgentProfileId;
}[] = [
  { id: 'review', label: 'Code review', hint: 'Router picks who speaks; read-only', icon: Eye, mode: 'dynamic', profile: 'review' },
  { id: 'parallel', label: 'Parallel feature', hint: 'Everyone starts at once, own worktree in a git folder', icon: Waypoints, mode: 'parallel', profile: 'fix' },
  { id: 'bugfix', label: 'Bug fix', hint: 'A lead agent delegates and edits', icon: Wrench, mode: 'master', profile: 'fix' },
];

function samePath(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  const norm = (p: string) => p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

function sessionTime(s: WorkspaceSession): number {
  return s.lastEventAt || (s.createdAt ? new Date(s.createdAt).getTime() || 0 : 0);
}

export function HomeDashboard() {
  const { agents, sessions, workingAgentNames, createSession, setCurrentSessionId } = useWorkspace();
  const { setViewMode, setTasksTab, isSidebarOpen, isMobile, openMobileDetail } = useLayout();
  const { rows: turnRows } = useAgentTurns();
  const feed = useActivityFeed(sessions, 10_000);

  // ── Dynamic catalog from backend / fallback ──
  const { catalog } = useAgentCatalog();
  const allCatalogAgents = React.useMemo(() => catalogAsOfflineAgents(catalog), [catalog]);

  const configuredMap = React.useMemo(() => {
    const map = new Map<string, WorkspaceAgent>();
    for (const a of agents) {
      map.set(a.agentName.toLowerCase(), a);
    }
    return map;
  }, [agents]);

  const unconfiguredCatalogAgents = React.useMemo(() => {
    return allCatalogAgents.filter((c) => !configuredMap.has(c.agentName.toLowerCase()));
  }, [allCatalogAgents, configuredMap]);

  const allAvailableAgents = React.useMemo(() => {
    return [...agents, ...unconfiguredCatalogAgents];
  }, [agents, unconfiguredCatalogAgents]);

  const catalogEntryMap = React.useMemo(() => {
    const map = new Map<string, AgentCatalogEntry>();
    for (const entry of catalog) {
      map.set(entry.name.toLowerCase(), entry);
    }
    return map;
  }, [catalog]);

  const isCatalogPreset = React.useCallback(
    (a: WorkspaceAgent) => !configuredMap.has(a.agentName.toLowerCase()),
    [configuredMap],
  );

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
    return {
      total: allAvailableAgents.length,
      online: onlineAgents.length,
      working,
      offline: allAvailableAgents.length - onlineAgents.length,
      workspace: agents.length,
    };
  }, [allAvailableAgents.length, onlineAgents, stateOf, agents.length]);

  // ── Setup state ──
  const [tab, setTab] = React.useState<'all' | 'online' | 'workspace'>('all');
  const [selected, setSelected] = React.useState<string[]>([]);
  const [openName, setOpenName] = React.useState<string | null>(null);
  const [workingDir, setWorkingDir] = React.useState('');
  const [mode, setMode] = React.useState<OrchestrationMode>('dynamic');
  const [lead, setLead] = React.useState<string | null>(null);
  const [profile, setProfile] = React.useState<AgentProfileId>(DEFAULT_PROFILE_ID);
  const [modelPicks, setModelPicks] = React.useState<Record<string, string>>({});
  const [effortPicks, setEffortPicks] = React.useState<Record<string, string>>({});
  const [task, setTask] = React.useState('');
  const [starting, setStarting] = React.useState(false);
  const [connectOpen, setConnectOpen] = React.useState(false);
  const taskRef = React.useRef<HTMLTextAreaElement>(null);

  // One agent online: it starts selected if none is selected yet.
  const soleOnline = onlineAgents.length === 1 ? onlineAgents[0].agentName : null;
  React.useEffect(() => {
    if (soleOnline) setSelected((prev) => (prev.length === 0 ? [soleOnline] : prev));
  }, [soleOnline]);

  // An agent that goes offline while selected leaves the selection.
  React.useEffect(() => {
    const online = new Set(onlineAgents.map((a) => a.agentName));
    setSelected((prev) => (prev.every((n) => online.has(n)) ? prev : prev.filter((n) => online.has(n))));
  }, [onlineAgents]);

  const setAgentSelected = (name: string, on: boolean) =>
    setSelected((prev) => (on ? (prev.includes(name) ? prev : [...prev, name]) : prev.filter((n) => n !== name)));

  const activeOnlineSelected = React.useMemo(
    () => selected.filter((n) => onlineAgents.some((a) => a.agentName === n)),
    [selected, onlineAgents],
  );

  const effectiveLead = mode === 'master' ? (lead && activeOnlineSelected.includes(lead) ? lead : activeOnlineSelected[0] ?? null) : null;

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
  const canStart = activeOnlineSelected.length > 0 && !starting;
  // Why Start is off; when it is on, the chips under the task say what it will do.
  const blockedHint =
    counts.online === 0
      ? 'No agent is online. Connect an agent below to start a session.'
      : activeOnlineSelected.length === 0
        ? 'Tick at least one online agent below to start.'
        : null;

  const handleStart = async () => {
    if (!canStart) return;
    setStarting(true);
    const text = task.trim();
    // The view switches in the same flush that opens the draft, so the chat is
    // visible when ChatView's "new session -> focus the composer" effect runs.
    // Home unmounts on that render; everything below is writes, not state.
    setViewMode('threads');
    if (isMobile) openMobileDetail();
    try {
      const session = await createSession({
        participants: activeOnlineSelected,
        workingDir: dir || undefined,
        master: effectiveLead ?? undefined,
        orchestrationMode: mode,
      });
      const id = session.sessionId;
      saveThreadProfile(id, profile);
      for (const [agentName, modelId] of Object.entries(modelPicks)) {
        if (!activeOnlineSelected.includes(agentName)) continue;
        rememberForSession(id, agentName, modelId);
        setCurrentModel(agentName, modelId);
      }
      for (const [agentName, effort] of Object.entries(effortPicks)) {
        if (!activeOnlineSelected.includes(agentName)) continue;
        workspaceApi
          .sendAgentControl(agentName, 'set_effort', { effort })
          .catch((e) =>
            toast.error(`@${agentName} could not switch effort${e instanceof Error && e.message ? `: ${e.message}` : ''}`),
          );
      }
      rememberWorkingDir(dir);
      // Last, after the profile and models are stored under the draft id, so
      // the first message carries them.
      if (text) sendFirstMessage(id, text);
    } catch (e) {
      setViewMode('home');
      toast.error(e instanceof Error ? e.message : 'Could not start the session');
      setStarting(false);
    }
  };

  const activePreset = PRESETS.find((p) => p.mode === mode && p.profile === profile) ?? null;
  const applyPreset = (p: (typeof PRESETS)[number]) => {
    // Clicking the lit preset puts both controls back to their defaults.
    setMode(activePreset?.id === p.id ? 'dynamic' : p.mode);
    setProfile(activePreset?.id === p.id ? DEFAULT_PROFILE_ID : p.profile);
  };

  // ── Derived display ──
  const shownAgents = tab === 'online' ? onlineAgents : tab === 'workspace' ? agents : allAvailableAgents;
  const modeInfo = ORCHESTRATION_MODES.find((m) => m.value === mode)!;
  const profileInfo = getProfile(profile);
  // Only meaningful for Parallel in a folder; elsewhere the folder chip says it all.
  const isolation =
    mode !== 'parallel' || !dir
      ? null
      : isRepo === true
        ? 'Own worktree per agent'
        : isRepo === false
          ? 'Shared folder (not a git repo)'
          : 'Own worktree if a git repo';
  const pickedModels = Object.entries(modelPicks)
    .filter(([n]) => activeOnlineSelected.includes(n))
    .map(([n, m]) => `@${n}: ${m.includes('/') ? m.slice(m.indexOf('/') + 1) : m}`);

  const headerCounts = [
    `${counts.online} of ${counts.total} ${counts.total === 1 ? 'agent' : 'agents'} online`,
    counts.working > 0 ? `${counts.working} working` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const renderPanel = (a: WorkspaceAgent) => {
    const isPreset = isCatalogPreset(a);
    const catEntry = catalogEntryMap.get(a.agentName.toLowerCase());
    return (
      <AgentDetailPanel
        agent={a}
        state={stateOf(a)}
        isCatalogPreset={isPreset}
        catalogEntry={catEntry}
        selected={selected.includes(a.agentName)}
        onToggleSelected={(on) => setAgentSelected(a.agentName, on)}
        mode={mode}
        isLead={effectiveLead === a.agentName}
        canUnsetLead={activeOnlineSelected.length > 1}
        onLeadChange={(on) => {
          if (on) setLead(a.agentName);
          else setLead(activeOnlineSelected.find((n) => n !== a.agentName) ?? a.agentName);
        }}
        modelPick={modelPicks[a.agentName]}
        onModelPick={(m) =>
          setModelPicks((prev) => {
            const next = { ...prev };
            if (m) next[a.agentName] = m;
            else delete next[a.agentName];
            return next;
          })
        }
        effortPick={effortPicks[a.agentName]}
        onEffortPick={(e) =>
          setEffortPicks((prev) => {
            const next = { ...prev };
            if (e) next[a.agentName] = e;
            else delete next[a.agentName];
            return next;
          })
        }
        onOpenThread={openThread}
        onClose={() => setOpenName(null)}
      />
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface0">
      <div className={cn('app-header ps-6', !isSidebarOpen && !isMobile && 'ps-14')}>
        <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
          <h1 className="shrink-0 text-sm font-semibold tracking-tight text-foreground">Agents</h1>
          {allAvailableAgents.length > 0 && <p className="truncate text-xs tabular-nums text-muted-foreground">{headerCounts}</p>}
        </div>
      </div>

      <div className="@container min-h-0 flex-1 overflow-y-auto">
        <div className="grid w-full grid-cols-1 items-start gap-4 p-4 sm:p-5 @5xl:grid-cols-[minmax(0,1fr)_320px] @7xl:grid-cols-[minmax(0,1fr)_360px]">
          {/* ── Main: what to do, and who does it ── */}
          <div className="@container flex min-w-0 flex-col gap-4">
            <section
              aria-label="New session"
              className="rounded-xl border border-border bg-card p-3 focus-within:border-border-accent"
            >
              <textarea
                ref={taskRef}
                autoFocus={!isMobile}
                value={task}
                onChange={(e) => setTask(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !isComposing(e)) {
                    e.preventDefault();
                    void handleStart();
                  }
                }}
                rows={2}
                aria-label="What should the agents do?"
                placeholder="What should the agents do?"
                className="block max-h-48 min-h-[3rem] w-full resize-none bg-transparent px-1 text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
              <div role="group" aria-label="Start from a preset" className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="px-1 text-2xs text-foreground-extra-muted">Start from</span>
                {PRESETS.map((p) => (
                  <Hint key={p.id} label={p.hint}>
                    <button
                      type="button"
                      aria-pressed={activePreset?.id === p.id}
                      onClick={() => applyPreset(p)}
                      className={cn(
                        'inline-flex h-6 items-center gap-1 rounded-full border px-2 text-2xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                        activePreset?.id === p.id
                          ? 'border-border-accent bg-surface2 text-foreground'
                          : 'border-border text-foreground-muted hover:bg-surface2/60 hover:text-foreground',
                      )}
                    >
                      <p.icon className="size-3" />
                      {p.label}
                    </button>
                  </Hint>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 px-1" aria-live="polite">
                  {blockedHint ? (
                    <p className="text-2xs text-muted-foreground">{blockedHint}</p>
                  ) : (
                    <>
                      <SetupChip icon={<Users />}>{activeOnlineSelected.map((n) => `@${n}`).join(', ')}</SetupChip>
                      <SetupChip icon={<modeInfo.icon />}>
                        {modeInfo.label}
                        {effectiveLead && ` · lead @${effectiveLead}`}
                      </SetupChip>
                      <SetupChip icon={<profileInfo.icon />}>
                        {profileInfo.label}
                        {profile === 'review' && ' · read-only'}
                      </SetupChip>
                      <SetupChip icon={<Folder />} warn={mode === 'parallel' && !dir}>
                        {dir ? basename(dir) : mode === 'parallel' ? 'No folder, no worktrees' : 'No folder, plain chat'}
                      </SetupChip>
                      {isolation && <SetupChip icon={<GitBranch />}>{isolation}</SetupChip>}
                      {pickedModels.length > 0 && <SetupChip icon={<Cpu />}>{pickedModels.join(', ')}</SetupChip>}
                      <span className="hidden text-2xs text-foreground-extra-muted @lg:inline">Enter to start</span>
                    </>
                  )}
                </div>
                <Button variant="primary" size="sm" disabled={!canStart} onClick={handleStart}>
                  {starting ? 'Starting…' : task.trim() ? 'Start and send' : 'Start session'}
                  <ArrowUp className="size-3.5" />
                </Button>
              </div>
            </section>

            <HomePanel
              id="home-agents"
              title="Agents"
              subtitle={
                allAvailableAgents.length === 0
                  ? 'No agents available.'
                  : `Open an agent to configure it; tick it to add it to the session. ${counts.online} online${counts.working ? `, ${counts.working} working` : ''}${counts.offline ? `, ${counts.offline} offline` : ''}.`
              }
              action={
                allAvailableAgents.length > 0 ? (
                  <SegmentedControl
                    size="xs"
                    value={tab}
                    onValueChange={setTab}
                    options={[
                      { value: 'all', label: `All ${counts.total}` },
                      { value: 'online', label: `Online ${counts.online}` },
                      { value: 'workspace', label: `Configured ${counts.workspace}` },
                    ]}
                  />
                ) : undefined
              }
            >
              {tab === 'online' && shownAgents.length === 0 && allAvailableAgents.length > 0 && (
                <p className="mb-3 text-xs text-muted-foreground">
                  No agent is online.{' '}
                  <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => setTab('all')}>
                    Show all agents
                  </button>{' '}
                  to connect one.
                </p>
              )}
              <AgentGrid
                agents={shownAgents}
                stateOf={stateOf}
                selected={selected}
                openName={openName}
                leadName={effectiveLead}
                isCatalogPreset={isCatalogPreset}
                catalogEntryMap={catalogEntryMap}
                onOpen={setOpenName}
                onToggleSelected={(n) => setAgentSelected(n, !selected.includes(n))}
                onAddAgent={() => setConnectOpen(true)}
                renderPanel={renderPanel}
              />
            </HomePanel>

            {/* ── What is going on: attention, recent sessions, upcoming ── */}
            <div className="grid min-w-0 grid-cols-1 gap-4 @2xl:grid-cols-2 @4xl:grid-cols-3">
              <NeedsAttentionPanel onOpenThread={openThread} onOpenAutomations={openAutomations} onOpenInbox={() => setViewMode('inbox')} />
              <RecentSessionsPanel onOpenThread={openThread} onNewSession={() => taskRef.current?.focus()} />
              <UpcomingPanel
                className="@2xl:col-span-2 @4xl:col-span-1"
                onOpenAutomations={openAutomations}
                onOpenThread={openThread}
              />
            </div>

            {/* Retrospective, so it sits under what needs doing now; collapsed to a line by default. */}
            <OutputPanel onOpenThread={openThread} />
          </div>

          {/* ── Rail: where, and how ── */}
          <aside aria-label="Session settings" className="flex min-w-0 flex-col gap-4">
            <HomePanel id="home-project" title="Project" subtitle="The folder agents read and write. Optional.">
              <ProjectFolderPicker
                value={workingDir}
                onChange={setWorkingDir}
                helperText="Leave empty for a plain chat with no file access."
              />
              {dir ? (
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
                    </>
                  ) : git && !git.available ? (
                    <p className="text-2xs text-muted-foreground">Not a git repository.</p>
                  ) : null}
                </div>
              ) : (
                <p className="mt-2 text-2xs text-muted-foreground">
                  Plain chat mode. Agents converse without access to local files.
                </p>
              )}
            </HomePanel>

            <HomePanel id="home-mode" title="Collaboration">
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
                    ? ` Lead: @${effectiveLead}. Switch lead in any agent's panel.`
                    : ' Tick an online agent below to act as lead.')}
              </p>
            </HomePanel>

            <HomePanel id="home-profile" title="Work mode">
              <SegmentedControl
                size="sm"
                className="w-full [&>button]:flex-1"
                value={profile}
                onValueChange={setProfile}
                options={AGENT_PROFILES.map((p) => ({ value: p.id, label: p.label, icon: p.icon }))}
              />
              <p className="mt-2 text-2xs text-muted-foreground">{profileInfo.whenToUse}</p>
            </HomePanel>

            {/* Takes a neat scrollable height */}
            <section
              aria-labelledby="home-activity-title"
              className="flex min-h-[18rem] max-h-[34rem] flex-col overflow-hidden rounded-xl border border-border bg-card"
            >
              <div className="px-4 pt-4">
                <h2 id="home-activity-title" className="text-sm font-semibold tracking-tight text-foreground">
                  Activity
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">What agents said and did, across threads.</p>
              </div>
              <ActivityTimeline
                hideHeader
                events={feed.events}
                agents={allAvailableAgents.map((a) => a.agentName)}
                onOpenThread={openThread}
                loading={feed.loading}
                className="min-h-0 flex-1 border-l-0 bg-transparent overflow-y-auto"
              />
            </section>
          </aside>
        </div>
      </div>
      <ConnectAgentModal open={connectOpen} onOpenChange={setConnectOpen} />
    </div>
  );
}

/** One fact about what Start will open; read-only, the controls live elsewhere. */
function SetupChip({ icon, warn, children }: { icon?: React.ReactNode; warn?: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-md bg-surface2/60 px-1.5 py-0.5 text-2xs',
        warn ? 'text-status-warning' : 'text-foreground-muted',
      )}
    >
      {icon && <span className="flex shrink-0 [&>svg]:size-3">{icon}</span>}
      <span className="truncate">{children}</span>
    </span>
  );
}
