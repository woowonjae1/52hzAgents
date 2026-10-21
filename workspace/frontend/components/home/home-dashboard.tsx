'use client';

import * as React from 'react';
import {
  ArrowUp,
  Eye,
  Folder,
  FolderOpen,
  FolderMinus,
  GitBranch,
  Users,
  Waypoints,
  Wrench,
  ChevronDown,
  Plus,
  Image as ImageIcon,
  SquareTerminal,
  Sparkles,
  Check,
  AtSign,
  BookOpen,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { SidebarExpandButton } from '@/components/layout/sidebar-expand-button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import {
  ProjectFolderPicker,
  basename,
  rememberWorkingDir,
  browseForFolder,
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
import { composerPillClass } from '@/components/ai-elements/composer-pill';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { CURATED_SKILLS } from '@/lib/curated-skills';
import { FieldLabel, FieldValue, HomePanel } from './home-panel';
import { NeedsAttentionPanel, RecentSessionsPanel } from './home-sections';
import { AgentGrid } from './agent-grid';
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
  const effectiveParticipants = React.useMemo(() => {
    if (activeOnlineSelected.length > 0) return activeOnlineSelected;
    if (selected.length > 0) return selected;
    if (onlineAgents.length > 0) return [onlineAgents[0].agentName];
    if (agents.length > 0) return [agents[0].agentName];
    if (allAvailableAgents.length > 0) return [allAvailableAgents[0].agentName];
    return [];
  }, [activeOnlineSelected, selected, onlineAgents, agents, allAvailableAgents]);

  const canStart = !starting;
  const blockedHint =
    allAvailableAgents.length === 0
      ? 'No agent available. Connect an agent below to start a session.'
      : counts.online === 0 && selected.length === 0
        ? 'No agent is online. You can still start or connect an agent below.'
        : null;

  const handleStart = async () => {
    if (starting) return;
    if (effectiveParticipants.length === 0 && allAvailableAgents.length === 0) {
      toast.error('No agents available. Please connect or configure an agent first.');
      return;
    }
    setStarting(true);
    const text = task.trim();
    // The view switches in the same flush that opens the draft, so the chat is
    // visible when ChatView's "new session -> focus the composer" effect runs.
    // Home unmounts on that render; everything below is writes, not state.
    try {
      const session = await createSession({
        participants: effectiveParticipants,
        workingDir: dir || undefined,
        master: effectiveLead ?? undefined,
        orchestrationMode: mode,
      });
      const id = session.sessionId;
      saveThreadProfile(id, profile);
      for (const [agentName, modelId] of Object.entries(modelPicks)) {
        if (!effectiveParticipants.includes(agentName)) continue;
        rememberForSession(id, agentName, modelId);
        setCurrentModel(agentName, modelId);
      }
      for (const [agentName, effort] of Object.entries(effortPicks)) {
        if (!effectiveParticipants.includes(agentName)) continue;
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
      setViewMode('threads');
      if (isMobile) openMobileDetail();
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

  const handlePickFolder = async () => {
    const chosen = await browseForFolder(dir || undefined);
    if (chosen) {
      setWorkingDir(chosen);
      toast.success(`Project folder set to ${basename(chosen)}`);
    }
  };

  const handleDetachFolder = () => {
    setWorkingDir('');
    toast.success('Project folder detached');
  };

  const insertTextAtCursor = (textToInsert: string) => {
    const ta = taskRef.current;
    const val = task;
    const start = ta?.selectionStart ?? val.length;
    const end = ta?.selectionEnd ?? val.length;
    let prefix = val.slice(0, start);
    const after = val.slice(end);
    if (textToInsert.startsWith('@') && prefix.endsWith('@')) prefix = prefix.slice(0, -1);
    else if (textToInsert.startsWith('/') && prefix.endsWith('/')) prefix = prefix.slice(0, -1);
    const updated = prefix + textToInsert + after;
    setTask(updated);
    requestAnimationFrame(() => {
      if (ta) {
        const nextPos = prefix.length + textToInsert.length;
        ta.setSelectionRange(nextPos, nextPos);
        ta.focus();
      }
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface0">
      <div className="app-header px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <SidebarExpandButton />
          <h1 className="shrink-0 text-sm font-semibold tracking-tight text-foreground">Agents</h1>
          {allAvailableAgents.length > 0 && <p className="truncate text-xs tabular-nums text-muted-foreground">{headerCounts}</p>}
        </div>
      </div>

      <div className="@container min-h-0 flex-1 overflow-y-auto">
        <div className="grid w-full grid-cols-1 items-start gap-4 p-4 sm:p-5 @5xl:grid-cols-[minmax(0,1fr)_320px] @7xl:grid-cols-[minmax(0,1fr)_360px]">
          {/* ── Main: what to do, and who does it ── */}
          <div className="@container flex min-w-0 flex-col gap-4">
            {/* ── Unified Single-Entry Hero Composer (Claude/ChatGPT Mental Model) ── */}
            <div className="flex flex-col gap-2">
              {/* Quick suggestion presets (like Claude/ChatGPT prompt chips) */}
              <div role="group" aria-label="Start from a preset" className="flex flex-wrap items-center gap-1.5 px-0.5">
                <span className="text-2xs text-foreground-extra-muted font-medium">Quick presets:</span>
                {PRESETS.map((p) => {
                  const isCur = activePreset?.id === p.id;
                  const Icon = p.icon;
                  return (
                    <Hint key={p.id} label={p.hint}>
                      <button
                        type="button"
                        aria-pressed={isCur}
                        onClick={() => applyPreset(p)}
                        className={cn(
                          'inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-2xs outline-none transition-all cursor-pointer',
                          isCur
                            ? 'border-primary/40 bg-primary/10 text-primary font-medium'
                            : 'border-border/60 bg-surface2/40 text-foreground-muted hover:bg-surface2 hover:text-foreground',
                        )}
                      >
                        <Icon className="size-3" />
                        <span>{p.label}</span>
                      </button>
                    </Hint>
                  );
                })}
              </div>

              {/* Main Composer Box */}
              <section
                aria-label="Composer"
                className="rounded-2xl border border-border/80 bg-card p-3 shadow-xs hover:shadow-sm focus-within:shadow-md focus-within:border-brand/70 focus-within:ring-2 focus-within:ring-brand/15 transition-all"
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
                  aria-label="Message 52hzAgents…"
                  placeholder="Message 52hzAgents… (@ for agents, / for skills)"
                  className="block max-h-48 min-h-[3.5rem] w-full resize-none bg-transparent px-2 pt-1 text-sm text-foreground leading-6 outline-none placeholder:text-muted-foreground/60 scrollbar-hide"
                />

                {/* Bottom Control Row - Identical structure & pills to chat-view composer */}
                <div className="mt-2 flex min-h-8 items-center justify-between gap-1.5 border-t border-border/40 pt-2 flex-nowrap overflow-x-auto scrollbar-hide">
                  <div className="flex items-center gap-1.5 min-w-0 shrink flex-nowrap overflow-x-auto scrollbar-hide">
                    {/* 1. Lead / Participants Selector */}
                    <Popover>
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          className={cn(composerPillClass, 'cursor-pointer gap-1.5')}
                          title="Select lead or assigned agents"
                        >
                          <AgentAvatar
                            name={effectiveLead || (effectiveParticipants[0] ?? 'claude')}
                            size={14}
                            className="rounded-full shrink-0"
                          />
                          <span className="font-medium truncate max-w-[110px]">
                            {effectiveLead ? `@${effectiveLead}` : `${effectiveParticipants.length} agents`}
                          </span>
                          <ChevronDown className="size-3 opacity-60 shrink-0" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent className="w-56 p-1.5" align="start">
                        <div className="px-2 py-1 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                          Assign Lead Agent
                        </div>
                        {allAvailableAgents.map((a) => {
                          const isSel = effectiveLead === a.agentName || (!effectiveLead && effectiveParticipants.includes(a.agentName));
                          return (
                            <button
                              key={a.agentName}
                              type="button"
                              onClick={() => {
                                setLead(a.agentName);
                                if (!selected.includes(a.agentName)) {
                                  setAgentSelected(a.agentName, true);
                                }
                              }}
                              className={cn(
                                'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-left cursor-pointer transition-colors hover:bg-surface2',
                                isSel && 'bg-surface2 font-medium text-primary',
                              )}
                            >
                              <AgentAvatar name={a.agentName} size={14} className="rounded-full shrink-0" />
                              <span className="truncate flex-1">{a.agentName}</span>
                              {isSel && <Check className="size-3.5 text-primary shrink-0" />}
                            </button>
                          );
                        })}
                      </PopoverContent>
                    </Popover>

                    {/* 2. Unified + Menu (Identical to Chat Composer) */}
                    <DropdownMenu>
                      <Hint label="Add context & extensions (+)">
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className={cn(
                              composerPillClass,
                              'size-7 px-0 justify-center text-foreground-extra-muted hover:text-foreground transition-colors cursor-pointer active:scale-95',
                            )}
                            aria-label="Add context"
                          >
                            <Plus className="size-3.5 shrink-0" />
                          </button>
                        </DropdownMenuTrigger>
                      </Hint>
                      <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-52 p-1">
                        <DropdownMenuLabel className="px-2 py-1 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">
                          Add Context
                        </DropdownMenuLabel>

                        {/* Folder */}
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger className="cursor-pointer gap-2.5 py-1.5 text-xs font-medium">
                            <Folder className="size-4 text-muted-foreground shrink-0" />
                            <span>Folder</span>
                            {dir && (
                              <span className="ms-auto me-1 max-w-[80px] truncate text-[10px] text-muted-foreground font-mono">
                                {basename(dir)}
                              </span>
                            )}
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent className="w-56 p-1">
                            <DropdownMenuLabel className="px-2 py-1 text-[11px] font-semibold text-muted-foreground">
                              Project Workspace
                            </DropdownMenuLabel>
                            {dir ? (
                              <>
                                <div className="px-2 py-1.5 text-[11px] text-muted-foreground font-mono truncate border-b border-border/40 mb-1">
                                  {dir}
                                </div>
                                <DropdownMenuItem onClick={handlePickFolder} className="cursor-pointer gap-2 text-xs">
                                  <FolderOpen className="size-3.5 text-muted-foreground" />
                                  <span>Change Folder…</span>
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={handleDetachFolder} className="cursor-pointer gap-2 text-xs text-destructive">
                                  <FolderMinus className="size-3.5" />
                                  <span>Detach Folder</span>
                                </DropdownMenuItem>
                              </>
                            ) : (
                              <DropdownMenuItem onClick={handlePickFolder} className="cursor-pointer gap-2 text-xs">
                                <FolderOpen className="size-3.5 text-muted-foreground" />
                                <span>Select Working Directory…</span>
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>

                        {/* Collaboration Mode */}
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger className="cursor-pointer gap-2.5 py-1.5 text-xs font-medium">
                            <Waypoints className="size-4 text-muted-foreground shrink-0" />
                            <span>Collaboration</span>
                            <span className="ms-auto me-1 text-[10px] text-muted-foreground capitalize font-mono">
                              {modeInfo.label}
                            </span>
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent className="w-52 p-1">
                            <DropdownMenuLabel className="px-2 py-1 text-[11px] font-semibold text-muted-foreground">
                              Orchestration Mode
                            </DropdownMenuLabel>
                            {ORCHESTRATION_MODES.map((m) => {
                              const isCur = mode === m.value;
                              const ModeIcon = m.icon;
                              return (
                                <DropdownMenuItem
                                  key={m.value}
                                  onClick={() => setMode(m.value)}
                                  className="cursor-pointer gap-2 py-1.5 text-xs"
                                >
                                  <ModeIcon className="size-3.5 text-muted-foreground shrink-0" />
                                  <div className="min-w-0 flex-1">
                                    <div className="font-medium text-foreground">{m.label}</div>
                                    <div className="text-[10px] text-muted-foreground leading-tight truncate">
                                      {m.description}
                                    </div>
                                  </div>
                                  {isCur && <Check className="ms-auto size-3.5 text-primary shrink-0" />}
                                </DropdownMenuItem>
                              );
                            })}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>

                        {/* Work Mode */}
                        <DropdownMenuSub>
                          <DropdownMenuSubTrigger className="cursor-pointer gap-2.5 py-1.5 text-xs font-medium">
                            <Wrench className="size-4 text-muted-foreground shrink-0" />
                            <span>Work Mode</span>
                            <span className="ms-auto me-1 text-[10px] text-muted-foreground capitalize font-mono">
                              {profileInfo.label}
                            </span>
                          </DropdownMenuSubTrigger>
                          <DropdownMenuSubContent className="w-52 p-1">
                            <DropdownMenuLabel className="px-2 py-1 text-[11px] font-semibold text-muted-foreground">
                              Agent Permissions
                            </DropdownMenuLabel>
                            {AGENT_PROFILES.map((p) => {
                              const isCur = profile === p.id;
                              const ProfIcon = p.icon;
                              return (
                                <DropdownMenuItem
                                  key={p.id}
                                  onClick={() => setProfile(p.id)}
                                  className="cursor-pointer gap-2 py-1.5 text-xs"
                                >
                                  <ProfIcon className="size-3.5 text-muted-foreground shrink-0" />
                                  <div className="min-w-0 flex-1">
                                    <div className="font-medium text-foreground">{p.label}</div>
                                    <div className="text-[10px] text-muted-foreground leading-tight">
                                      {p.whenToUse}
                                    </div>
                                  </div>
                                  {isCur && <Check className="ms-auto size-3.5 text-primary shrink-0" />}
                                </DropdownMenuItem>
                              );
                            })}
                          </DropdownMenuSubContent>
                        </DropdownMenuSub>

                        <DropdownMenuSeparator />

                        {/* Mention Agent */}
                        <DropdownMenuItem
                          onClick={() => insertTextAtCursor('@')}
                          className="cursor-pointer gap-2.5 py-1.5 text-xs font-medium"
                        >
                          <AtSign className="size-4 text-muted-foreground shrink-0" />
                          <span>Mention Agent (@)</span>
                        </DropdownMenuItem>

                        {/* Skills & Commands */}
                        <DropdownMenuItem
                          onClick={() => insertTextAtCursor('/')}
                          className="cursor-pointer gap-2.5 py-1.5 text-xs font-medium"
                        >
                          <SquareTerminal className="size-4 text-muted-foreground shrink-0" />
                          <span>Skills & Commands (/)</span>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  {/* Right side: High-contrast primary Send / Start button */}
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!canStart}
                    onClick={handleStart}
                    className="h-8.5 rounded-full px-4 text-xs font-medium gap-1.5 transition-all active:scale-95 shadow-md shadow-brand/25 ring-1 ring-white/10"
                  >
                    <span>{starting ? 'Starting…' : task.trim() ? 'Send' : 'Start'}</span>
                    <ArrowUp className="size-3.5 stroke-[2.5]" />
                  </Button>
                </div>
              </section>
            </div>

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

            {/* ── What is going on: attention and recent sessions ── */}
            <div className="grid min-w-0 grid-cols-1 gap-4 @2xl:grid-cols-2">
              <NeedsAttentionPanel onOpenThread={openThread} onOpenAutomations={openAutomations} onOpenInbox={() => setViewMode('inbox')} />
              <RecentSessionsPanel onOpenThread={openThread} onNewSession={() => taskRef.current?.focus()} />
            </div>
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
