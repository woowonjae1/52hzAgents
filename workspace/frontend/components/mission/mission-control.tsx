'use client';

import { Hint } from '@/components/ui/hint';
import { useMemo, useState, useEffect, useCallback } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { AgentStation, type StationData, type StationStatus } from './agent-station';
import { ActionRequiredBanner, type PendingActionItem } from './action-required-banner';
import { ActivityTimeline, type TimelineEventItem } from './activity-timeline';
import { ConnectAgentModal } from './connect-agent-modal';
import { useVisibilityPolling } from '@/lib/use-visibility-polling';
import { parseReportedModels } from '@/components/chat/agent-model-switcher';
import { hydrateAgentModels } from '@/lib/agent-model-store';
import {
  Users,
  PanelRight,
  ChevronDown,
  ChevronUp,
  Play,
  RotateCw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { workspaceApi } from '@/lib/api';
import { eventToMessage, type ONMEvent, stripAddressPrefix } from '@/lib/types';
import { useAgentCatalog, catalogAsOfflineAgents } from '@/lib/agent-catalog';
import { toast } from 'sonner';

/*
  The filter affordance that replaced the metric cards. Deliberately flat: no
  card, no badge, no chart. The count IS the state, so nothing is coloured —
  the single exception is a non-zero blocked count, which is the only number
  here that asks the reader to act, and `--destructive` is the token this
  project reserves for exactly that.
*/
function FilterChip({
  label,
  count,
  active,
  urgent,
  onClick,
}: {
  label: string;
  count?: number | string;
  active: boolean;
  urgent?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex items-baseline gap-1.5 rounded-md px-2 py-1 text-xs transition-colors cursor-pointer',
        active
          ? 'bg-surface2 text-foreground'
          : 'text-muted-foreground hover:text-foreground hover:bg-surface2/60',
      )}
    >
      <span>{label}</span>
      {count !== undefined && (
        <span className={cn('font-mono tabular-nums', urgent && 'text-destructive')}>
          {count}
        </span>
      )}
    </button>
  );
}

export function MissionControl() {
  const {
    agents,
    setAgents,
    sessions,
    activeSessionIds,
    workingAgentNames,
    setCurrentSessionId,
  } = useWorkspace();
  const { setViewMode, isSidebarOpen, setActiveRightTab } = useLayout();
  const reduceMotion = useReducedMotion();

  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [showIntegrations, setShowIntegrations] = useState(true);
  // Live activity is the one cross-channel view, but it is a companion pane —
  // on a narrow window it costs 350px that the roster wants back.
  const [showActivity, setShowActivity] = useState(true);

  // Filter state: 'all' | 'working' | 'blocked' | 'online'
  const [filterTab, setFilterTab] = useState<'all' | 'working' | 'blocked' | 'online'>('all');

  // Dynamic catalog from backend
  const { catalog, loading: catalogLoading } = useAgentCatalog();
  const allCatalogAgents = useMemo(() => catalogAsOfflineAgents(catalog), [catalog]);

  // Aggregate session messages & detect approvals / stalls
  const [lastMessageBySession, setLastMessageBySession] = useState<
    Record<string, { content: string; senderName: string; isStatus?: boolean; timestamp: number }>
  >({});
  const [agentTokens, setAgentTokens] = useState<Record<string, number>>({});
  const [pendingApprovals, setPendingApprovals] = useState<PendingActionItem[]>([]);

  // Activity feed
  const [activityFeed, setActivityFeed] = useState<TimelineEventItem[]>([]);
  const [feedLoading, setFeedLoading] = useState(true);

  const fetchRecentData = useCallback(async () => {
    const updates: Record<string, { content: string; senderName: string; isStatus?: boolean; timestamp: number }> = {};
    const tokens: Record<string, number> = {};
    const approvals: PendingActionItem[] = [];

    // Always fetch authoritative token stats from backend
    try {
      const tokenStats = await workspaceApi.getWorkspaceTokenStats();
      if (tokenStats?.agents) {
        for (const a of tokenStats.agents) {
          if (a.total_tokens > 0) {
            tokens[a.agent_name] = a.total_tokens;
          }
        }
      }
    } catch {
      // ignore
    }

    // If there are sessions, inspect recent message status & pending approvals
    if (sessions.length > 0) {
      const activeThreads = sessions.filter((s) => s.status !== 'archived').slice(0, 20);
      await Promise.all(
        activeThreads.map(async (s) => {
          try {
            const res = await workspaceApi.loadMessageHistory(s.sessionId, { limit: 12 });
            const msgs = (res.events || []).map(eventToMessage);
            if (!msgs.length) return;

            const respondedApprovalIds = new Set(
              msgs.map((m) => m.metadata?.tool_approval_response?.approval_id).filter(Boolean)
            );

            for (const m of msgs) {
              const appReq = m.metadata?.tool_approval_request;
              if (appReq && !respondedApprovalIds.has(appReq.approval_id)) {
                approvals.push({
                  id: `app-${m.messageId || appReq.approval_id}`,
                  type: 'approval',
                  agentName: m.senderName,
                  channelId: s.sessionId,
                  channelTitle: s.title,
                  toolName: appReq.tool,
                  command: appReq.args?.command,
                  path: appReq.args?.path,
                  approvalId: appReq.approval_id,
                  timestamp: m.createdAt ? new Date(m.createdAt) : new Date(),
                });
              }
            }

            const meaningful = [...msgs]
              .reverse()
              .find((m) => m.content && m.content.trim() && m.messageType !== 'status');
            const fallback = msgs[msgs.length - 1];
            const chosen = meaningful || fallback;
            if (chosen) {
              updates[s.sessionId] = {
                content: chosen.content,
                senderName: chosen.senderName,
                isStatus: chosen.messageType === 'status',
                timestamp: chosen.createdAt ? new Date(chosen.createdAt).getTime() : Date.now(),
              };
            }
          } catch {
            /* ignore */
          }
        })
      );
    }

    setLastMessageBySession(updates);
    setAgentTokens(tokens);
    setPendingApprovals(approvals);
  }, [sessions]);

  const fetchFeed = useCallback(async () => {
    const titleFor = (channel: string) => sessions.find((s) => s.sessionId === channel)?.title || channel;
    try {
      const res = await workspaceApi.pollEvents({ type: 'workspace.message', sort: 'desc', limit: 40 });
      const lines: TimelineEventItem[] = res.events.map((ev: ONMEvent, idx: number) => {
        const m = eventToMessage(ev);
        const channel = (ev.target || '').replace(/^channel\//, '');
        let type: TimelineEventItem['type'] = 'info';
        if (m.messageType === 'thinking') type = 'thinking';
        else if (m.metadata?.tool_approval_request) type = 'approval';
        else if (m.messageType === 'status') type = /failed|error|stopped|denied/i.test(m.content) ? 'error' : 'success';
        else if (m.senderType === 'agent') type = 'command';
        return {
          id: m.messageId || ev.event_id || `activity-${idx}-${ev.timestamp || Date.now()}`,
          time: m.createdAt ? new Date(m.createdAt) : new Date(ev.timestamp),
          sender: m.senderName || stripAddressPrefix(ev.source),
          channel: titleFor(channel),
          channelId: channel,
          content: m.content,
          type,
        };
      });
      setActivityFeed(lines);
    } catch {
      /* keep last feed */
    } finally {
      setFeedLoading(false);
    }
  }, [sessions]);

  // Unified overview polling: 5s interval, fully paused on document.hidden
  const fetchMissionOverview = useCallback(async () => {
    await Promise.allSettled([fetchRecentData(), fetchFeed()]);
  }, [fetchRecentData, fetchFeed]);

  useVisibilityPolling(fetchMissionOverview, 5000);

  /*
    Keeps the shared model store (lib/agent-model-store.ts) warm for every
    configured agent, not just the online ones the composer chip already
    polls -- so the profile panel and composer chip agree on a model the
    moment either of them needs it, without Mission Control showing its own
    switcher for the same fact.
  */
  const fetchAgentUsages = useCallback(async () => {
    const configuredNames = agents.map((a) => a.agentName);
    if (configuredNames.length === 0) return;

    await Promise.allSettled(
      configuredNames.map(async (name) => {
        const usage = await workspaceApi.getAgentUsage(name);
        hydrateAgentModels(name, {
          options: parseReportedModels(usage?.available_models),
          current: usage?.current_model,
        });
      })
    );
  }, [agents]);

  useVisibilityPolling(fetchAgentUsages, 25_000);

  // Section 1: User's Configured Agents
  const myStations: StationData[] = useMemo(() => {
    const activeThreads = sessions.filter((s) => s.status !== 'archived');
    const now = Date.now();

    return agents.map((agent): StationData => {
      const threads = activeThreads
        .filter((s) => s.participants.includes(agent.agentName) || s.master === agent.agentName)
        .sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0));

      const isWorking = workingAgentNames.has(agent.agentName);
      const workingThread = isWorking ? threads.find((t) => activeSessionIds.has(t.sessionId)) || null : null;
      const focusThread = workingThread || threads[0] || null;
      const activity = focusThread ? lastMessageBySession[focusThread.sessionId] || null : null;

      const pendingApp = pendingApprovals.find((p) => p.agentName.toLowerCase() === agent.agentName.toLowerCase());

      let stationStatus: StationStatus;
      let stalledMs: number | undefined;

      if (agent.status !== 'online') {
        stationStatus = 'offline';
      } else if (pendingApp) {
        stationStatus = 'blocked';
      } else if (isWorking) {
        const lastActivityTime = activity?.timestamp || (focusThread?.lastEventAt ? focusThread.lastEventAt : now);
        const elapsed = now - lastActivityTime;
        if (elapsed > 35000) {
          stationStatus = 'stalled';
          stalledMs = elapsed;
        } else {
          stationStatus = 'working';
        }
      } else {
        stationStatus = 'ready';
      }

      const installed = (agent.enabledSkills?.installed as string[] | undefined) || [];

      return {
        agent,
        status: stationStatus,
        threads,
        focusThread,
        activity,
        skillCount: installed.length,
        tokenCount: agentTokens[agent.agentName] || 0,
        isCatalogPlaceholder: false,
        stalledMs,
        pendingApproval: pendingApp
          ? {
              approvalId: pendingApp.approvalId || '',
              tool: pendingApp.toolName || 'command',
              command: pendingApp.command,
              path: pendingApp.path,
            }
          : undefined,
        lastHeartbeatAt: agent.lastHeartbeatAt,
      };
    }).sort((a, b) => {
      const rank = { blocked: 0, stalled: 1, working: 2, ready: 3, offline: 4 } as const;
      if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
      return a.agent.agentName.localeCompare(b.agent.agentName);
    });
  }, [agents, sessions, lastMessageBySession, activeSessionIds, workingAgentNames, agentTokens, pendingApprovals]);

  // Section 2: Available Catalog Presets
  const integrationStations: StationData[] = useMemo(() => {
    const liveNames = new Set(agents.map((a) => a.agentName.toLowerCase()));
    const unconfigured = allCatalogAgents.filter((a) => !liveNames.has(a.agentName.toLowerCase()));

    return unconfigured.map((agent): StationData => ({
      agent,
      status: 'offline',
      threads: [],
      focusThread: null,
      activity: null,
      skillCount: 0,
      tokenCount: 0,
      isCatalogPlaceholder: true,
    }));
  }, [agents, allCatalogAgents]);

  const allStations = useMemo(() => [...myStations, ...integrationStations], [myStations, integrationStations]);

  // Status Counts for Chips
  const blockedCount = myStations.filter((s) => s.status === 'blocked').length;
  const workingCount = myStations.filter((s) => s.status === 'working').length;
  const onlineCount = agents.filter((a) => a.status === 'online').length;

  // Filtered lists
  const filteredMyStations = useMemo(() => {
    if (filterTab === 'all') return myStations;
    if (filterTab === 'working') return myStations.filter((s) => s.status === 'working' || s.status === 'stalled');
    if (filterTab === 'blocked') return myStations.filter((s) => s.status === 'blocked');
    if (filterTab === 'online') return myStations.filter((s) => s.agent.status === 'online');
    return myStations;
  }, [myStations, filterTab]);

  const openAgent = (agentName: string, focusSessionId: string | null) => {
    setViewMode('threads');
    if (focusSessionId) {
      setCurrentSessionId(focusSessionId);
    }
  };

  const openThread = (sessionId: string) => {
    setViewMode('threads');
    setCurrentSessionId(sessionId);
  };

  // Stalled items for ActionRequiredBanner
  const [dismissedActionIds, setDismissedActionIds] = useState<Set<string>>(new Set());

  const handleActionResolved = useCallback((id: string) => {
    setDismissedActionIds((prev) => new Set(prev).add(id));
    fetchRecentData();
  }, [fetchRecentData]);

  const stalledItems: PendingActionItem[] = useMemo(() => {
    return myStations
      .filter((s) => s.status === 'stalled')
      .map((s) => ({
        id: `stall-${s.agent.agentName}`,
        type: 'stalled',
        agentName: s.agent.agentName,
        channelId: s.focusThread?.sessionId || '',
        channelTitle: s.focusThread?.title || 'New channel',
        stalledMs: s.stalledMs || 35000,
        timestamp: new Date(),
      }));
  }, [myStations]);

  const allActionRequired = useMemo(() => {
    return [...pendingApprovals, ...stalledItems].filter((it) => !dismissedActionIds.has(it.id));
  }, [pendingApprovals, stalledItems, dismissedActionIds]);


  const totalTokens = useMemo(() => Object.values(agentTokens).reduce((sum, v) => sum + v, 0), [agentTokens]);
  const fmtTokens = (n: number) => (n > 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

  const handlePairAgent = async (agentName: string) => {
    try {
      await workspaceApi.launchAgent(agentName);
      toast.success(`${agentName} is online`);
      const updated = await workspaceApi.listAgents();
      setAgents(updated);
    } catch (e) {
      // Never swallow this one. A bare `Could not connect` leaves the user (and
      // anyone debugging with them) with no way to tell a missing runtime from a
      // bad token from a daemon that is not running.
      const reason = e instanceof Error ? e.message : String(e);
      toast.error(`Could not connect ${agentName}: ${reason}`);
      console.error(`[52hzAgents] launchAgent(${agentName}) failed:`, e);
    }
  };



  const hasZeroAgents = agents.length === 0 && !catalogLoading;
  const isAllOffline = agents.length > 0 && onlineCount === 0;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/*
        One header line, not a 110px analytics strip.

        The four "rich metric cards" this replaced carried three problems at
        once. Empty, they were four boxes reading 0 — a whole band of screen
        with nothing in it. Non-empty, two of them drew `SparklineBar`/
        `SparklineArea` over HARDCODED arrays ([12,18,14,28,22,35,30]) in
        hardcoded hex (#f59e0b, #8b5cf6): invented trends, which this project
        does not ship. And the only real facts among them — how many need me,
        how many are running, how many are online — are single integers that
        read faster inline than as cards.

        Every card was also a filter toggle. Those toggles are preserved below
        as chips; nothing that did something lost its home.
      */}
      <div className={cn('app-header px-6', !isSidebarOpen && 'ps-14')}>
        <div className="flex flex-1 items-center justify-between gap-4 min-w-0">
          <div className="flex items-baseline gap-2.5 min-w-0">
            <h1 className="text-sm font-semibold tracking-tight text-foreground shrink-0">
              Mission control
            </h1>
            <p className="truncate text-xs text-muted-foreground tabular-nums">
              {agents.length} {agents.length === 1 ? 'agent' : 'agents'}
              {sessions.length > 0 && ` · ${sessions.length} ${sessions.length === 1 ? 'channel' : 'channels'}`}
              {totalTokens > 0 && (
                <>
                  {' · '}
                  <button
                    type="button"
                    onClick={() => setActiveRightTab('tokens')}
                    className="hover:text-primary hover:underline transition-colors cursor-pointer font-medium"
                    title="Open Token & Context Governance Dashboard"
                  >
                    {fmtTokens(totalTokens)} tokens
                  </button>
                </>
              )}
            </p>
          </div>

          {/*
            The filter set the cards used to carry. State is the count itself,
            so no chip is coloured — except a non-zero blocked count, which is
            the one number that asks the reader to go do something.
          */}
          <div className="flex items-center gap-1 shrink-0">
            {agents.length > 0 && (blockedCount > 0 || workingCount > 0 || filterTab !== 'all') && (
              <FilterChip
                active={filterTab === 'all'}
                onClick={() => setFilterTab('all')}
                label="All"
              />
            )}
            {/*
              A filter that would select nothing is not shown.

              These four rendered unconditionally, so the state a workspace
              spends most of its time in — nothing blocked, nothing running —
              put up "Needs attention 0" and "Running 0" as permanent furniture,
              and an empty workspace showed all four at zero above a pane
              reading "No agents match this filter". `Online` stays whatever its
              count, because x/y is a status readout as much as a filter.

              The active chip also survives its count dropping to 0, or the
              control you are currently filtered by would vanish under you and
              leave no way back to `All`.
            */}
            {(blockedCount > 0 || filterTab === 'blocked') && (
              <FilterChip
                active={filterTab === 'blocked'}
                onClick={() => setFilterTab(filterTab === 'blocked' ? 'all' : 'blocked')}
                label="Needs attention"
                count={blockedCount}
                urgent={blockedCount > 0}
              />
            )}
            {(workingCount > 0 || filterTab === 'working') && (
              <FilterChip
                active={filterTab === 'working'}
                onClick={() => setFilterTab(filterTab === 'working' ? 'all' : 'working')}
                label="Running"
                count={workingCount}
              />
            )}
            {agents.length > 0 && (
              <FilterChip
                active={filterTab === 'online'}
                onClick={() => setFilterTab(filterTab === 'online' ? 'all' : 'online')}
                label="Online"
                count={`${onlineCount}/${agents.length}`}
              />
            )}

            <span className="mx-1 h-4 w-px bg-border/60" aria-hidden />

            <Hint label={showActivity ? 'Hide live activity' : 'Show live activity'}>
              <button
                type="button"
                onClick={() => setShowActivity((prev) => !prev)}
                aria-pressed={showActivity}
                className={cn(
                  'inline-flex size-7 items-center justify-center rounded-md transition-colors cursor-pointer',
                  showActivity
                    ? 'bg-surface2 text-foreground'
                    : 'text-muted-foreground hover:text-foreground hover:bg-surface2/60',
                )}
              >
                <PanelRight className="size-3.5" />
                <span className="sr-only">
                  {showActivity ? 'Hide live activity' : 'Show live activity'}
                </span>
              </button>
            </Hint>
          </div>
        </div>
      </div>

      <ConnectAgentModal
        open={connectModalOpen}
        onOpenChange={setConnectModalOpen}
      />

      {/* Main Body */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        <div className="min-w-0 flex-1 space-y-5 overflow-y-auto p-5">
          {/* Top Priority Action Required Banner */}
          <ActionRequiredBanner
            items={allActionRequired}
            onOpenThread={openThread}
            onResolved={handleActionResolved}
          />

          {/* All Offline Wakeup Callout Banner */}
          {isAllOffline && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3.5 p-3.5 rounded-2xl bg-surface1/90 border border-primary/20 shadow-2xs">
              <div className="flex items-center gap-3 min-w-0">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Play className="size-3.5 fill-current ml-0.5" />
                </div>
                <div className="space-y-0.5 min-w-0">
                  <div className="text-xs font-semibold text-foreground">
                    {agents.length} agents configured — all currently offline
                  </div>
                  <div className="text-2xs text-muted-foreground truncate">
                    Connect a station below, or connect them all at once
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    agents.forEach((a) => handlePairAgent(a.agentName));
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-primary text-primary-foreground text-xs font-semibold hover:opacity-90 transition-opacity cursor-pointer shadow-xs"
                >
                  <RotateCw className="size-3" />
                  <span>Connect all</span>
                </button>
              </div>
            </div>
          )}

          <div className="space-y-7">
            {/* Section 1: My Configured Agents */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                {/*
                  SENTENCE CASE, PROPORTIONAL FACE, NO TRACKING.

                  `uppercase tracking-wider font-mono` on a section heading is
                  the machine-console idiom, and it made "MY AGENTS" cost more
                  attention than the agent names underneath -- which are the
                  actual content. The icon also drops `text-primary`: in the
                  light theme `--primary` is #09090b, the same near-black as the
                  text beside it, so the tint did nothing there while claiming
                  the eye in the dark theme for a decorative glyph.
                */}
                <div className="flex items-center gap-2 text-xs font-medium text-foreground-muted">
                  <Users className="size-3.5 text-foreground-extra-muted" />
                  <span>My agents ({filteredMyStations.length})</span>
                  {filterTab !== 'all' && (
                    <button
                      type="button"
                      onClick={() => setFilterTab('all')}
                      className="ml-2 text-2xs text-primary hover:underline cursor-pointer"
                    >
                      (clear filter: {filterTab})
                    </button>
                  )}
                </div>
              </div>

              {filteredMyStations.length === 0 ? (
                <div className="p-8 text-center rounded-2xl bg-surface1/40 text-xs text-muted-foreground">
                  No agents match this filter
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3 items-stretch">
                  {filteredMyStations.map((s, idx) => (
                    <motion.div
                      key={s.agent.agentName}
                      className="h-full"
                      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.15, ease: 'easeOut', delay: Math.min(idx, 8) * 0.02 }}
                    >
                      <AgentStation
                        className="h-full"
                        data={s}
                        onOpenAgent={() => openAgent(s.agent.agentName, s.focusThread?.sessionId ?? null)}
                        onOpenThread={openThread}
                        onPairAgent={() => handlePairAgent(s.agent.agentName)}
                        onApprovalResolved={fetchRecentData}
                      />
                    </motion.div>
                  ))}
                </div>
              )}
            </div>

            {/* Section 2: Available Integrations */}
            {integrationStations.length > 0 && filterTab === 'all' && (
              <div className="space-y-3 pt-2">
                {/*
                  With nothing connected this list IS the onboarding step, so it
                  says so in a sentence. It used to be preceded by an "Add your
                  first agent" card showing `DEFAULT_AGENT_CATALOG.slice(0, 6)`
                  behind the same `handlePairAgent` — a strict subset of these
                  rows, minus the connection state, shown only in the state where
                  this list is at its longest.
                */}
                {hasZeroAgents && (
                  <p className="text-xs text-muted-foreground">
                    No agents connected yet. Pick one below, or configure a custom
                    ACP / MCP adapter.
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => setShowIntegrations((prev) => !prev)}
                  className="flex items-center gap-2 text-xs font-medium text-foreground-muted hover:text-foreground transition-colors cursor-pointer select-none"
                >
                  <span>Available integrations ({integrationStations.length})</span>
                  {showIntegrations ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                </button>

                {showIntegrations && (
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3 items-stretch">
                    {integrationStations.map((s) => (
                      <AgentStation
                        key={s.agent.agentName}
                        className="h-full"
                        data={s}
                        onOpenAgent={() => openAgent(s.agent.agentName, null)}
                        onOpenThread={openThread}
                        onPairAgent={() => handlePairAgent(s.agent.agentName)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

        </div>

        {/* Right Activity Timeline */}
        {showActivity && <ActivityTimeline
          events={activityFeed}
          agents={agents.map((a) => a.agentName)}
          onOpenThread={openThread}
          loading={feedLoading}
          className="lg:w-[320px] xl:w-[350px]"
        />}
      </div>
    </div>
  );
}
