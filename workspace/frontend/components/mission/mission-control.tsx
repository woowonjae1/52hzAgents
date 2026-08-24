'use client';

import { useMemo, useState, useEffect, useCallback } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { AgentStation, type StationData, type StationStatus } from './agent-station';
import { ActionRequiredBanner, type PendingActionItem } from './action-required-banner';
import { SwimlaneTimeline, type SwimlaneEvent } from './swimlane-timeline';
import { ActivityTimeline, type TimelineEventItem } from './activity-timeline';
import { OnboardingGuide } from './onboarding-guide';
import { ConnectAgentModal } from './connect-agent-modal';
import { MetricCard, SparklineBar, SparklineArea, RingProgress } from './metrics-charts';
import {
  Users,
  Activity,
  Zap,
  LayoutGrid,
  Clock,
  ShieldAlert,
  Layers,
  ChevronDown,
  ChevronUp,
  Play,
  RotateCw,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { workspaceApi } from '@/lib/api';
import { eventToMessage, type ONMEvent } from '@/lib/types';
import { useAgentCatalog, catalogAsOfflineAgents } from '@/lib/agent-catalog';
import { toast } from 'sonner';

export function MissionControl() {
  const {
    agents,
    setAgents,
    sessions,
    activeSessionIds,
    workingAgentNames,
    setCurrentSessionId,
  } = useWorkspace();
  const { setViewMode, isSidebarOpen } = useLayout();
  const reduceMotion = useReducedMotion();

  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [showIntegrations, setShowIntegrations] = useState(true);

  // View state: 'grid' | 'swimlane'
  const [viewTab, setViewTab] = useState<'grid' | 'swimlane'>('grid');
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

  const fetchRecentData = useCallback(async () => {
    if (!sessions.length) return;
    const activeThreads = sessions.filter((s) => s.status !== 'archived').slice(0, 20);
    const updates: Record<string, { content: string; senderName: string; isStatus?: boolean; timestamp: number }> = {};
    const tokens: Record<string, number> = {};
    const approvals: PendingActionItem[] = [];

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
            if (m.senderType === 'agent' && m.metadata?.tokens) {
              const count = Number(m.metadata.tokens) || 0;
              tokens[m.senderName] = (tokens[m.senderName] || 0) + count;
            }

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

    setLastMessageBySession(updates);
    setAgentTokens(tokens);
    setPendingApprovals(approvals);
  }, [sessions]);

  useEffect(() => {
    fetchRecentData();
    const id = setInterval(fetchRecentData, 4000);
    return () => clearInterval(id);
  }, [fetchRecentData]);

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

  // Swimlane events mapping
  const swimlaneEvents: SwimlaneEvent[] = useMemo(() => {
    return myStations
      .filter((s) => s.status !== 'offline')
      .map((s): SwimlaneEvent => {
        const isBlock = s.status === 'blocked';
        const isStall = s.status === 'stalled';
        const isWork = s.status === 'working';

        return {
          id: `swim-${s.agent.agentName}`,
          agentName: s.agent.agentName,
          type: isBlock ? 'blocked' : isStall ? 'stalled' : isWork ? 'tool' : 'message',
          title: s.pendingApproval?.command ? `$ ${s.pendingApproval.command}` : s.activity?.content || 'Task running',
          startOffsetSec: isWork || isBlock ? 60 : 15,
          durationSec: isWork || isBlock ? 45 : 15,
          channelTitle: s.focusThread?.title || 'Channel',
          sessionId: s.focusThread?.sessionId || '',
          status: isBlock ? 'blocked' : isStall ? 'error' : isWork ? 'running' : 'success',
        };
      });
  }, [myStations]);

  // Filtered station cards
  const filteredMyStations = useMemo(() => {
    if (filterTab === 'working') return myStations.filter((s) => s.status === 'working' || s.status === 'stalled');
    if (filterTab === 'blocked') return myStations.filter((s) => s.status === 'blocked' || s.status === 'stalled');
    if (filterTab === 'online') return myStations.filter((s) => s.status !== 'offline');
    return myStations;
  }, [myStations, filterTab]);

  const onlineCount = agents.filter((a) => a.status === 'online').length;
  const workingCount = myStations.filter((s) => s.status === 'working').length;
  const blockedCount = myStations.filter((s) => s.status === 'blocked' || s.status === 'stalled').length;
  const totalTokens = useMemo(() => Object.values(agentTokens).reduce((sum, v) => sum + v, 0), [agentTokens]);
  const fmtTokens = (n: number) => (n > 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

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

  const handlePairAgent = async (agentName: string) => {
    try {
      toast.info(`Connecting ${agentName}…`);
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

  // Activity feed
  const [activityFeed, setActivityFeed] = useState<TimelineEventItem[]>([]);
  const [feedLoading, setFeedLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const titleFor = (channel: string) => sessions.find((s) => s.sessionId === channel)?.title || channel;
    const fetchFeed = async () => {
      try {
        const res = await workspaceApi.pollEvents({ type: 'workspace.message', sort: 'desc', limit: 40 });
        if (cancelled) return;
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
            sender: m.senderName || (ev.source || '').replace(/^(human:|openagents:)/, ''),
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
        if (!cancelled) setFeedLoading(false);
      }
    };
    fetchFeed();
    const id = setInterval(fetchFeed, 4000);
    return () => { cancelled = true; clearInterval(id); };
  }, [sessions]);

  const hasZeroAgents = agents.length === 0 && !catalogLoading;
  const isAllOffline = agents.length > 0 && onlineCount === 0;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Header Strip with 4 Always-Visible Analytics Cards */}
      <div className={cn("shrink-0 bg-surface1/50 backdrop-blur-md px-6 pt-5 pb-4 space-y-3.5 transition-all duration-200", !isSidebarOpen && "pl-14")}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-surface2 text-primary shadow-2xs">
              <Layers className="size-4" />
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-bold tracking-tight text-foreground">
                Mission control
              </h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                Multi-agent scheduling, load monitoring, and live activity
              </p>
            </div>
          </div>

          {/* View Mode Switcher */}
          <div className="flex items-center gap-1 p-1 rounded-xl bg-surface2 text-xs shadow-2xs">
            <button
              type="button"
              onClick={() => setViewTab('grid')}
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg font-medium transition-colors cursor-pointer',
                viewTab === 'grid'
                  ? 'bg-surface1 text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <LayoutGrid className="size-3.5" />
              <span>Stations</span>
            </button>
            <button
              type="button"
              onClick={() => setViewTab('swimlane')}
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg font-medium transition-colors cursor-pointer',
                viewTab === 'swimlane'
                  ? 'bg-surface1 text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Clock className="size-3.5" />
              <span>Swimlanes</span>
            </button>
          </div>
        </div>

        {/* 4 Rich Metric Cards (Always Visible) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* Card 1: Action Required */}
          <div
            onClick={() => setFilterTab(filterTab === 'blocked' ? 'all' : 'blocked')}
            className="cursor-pointer"
          >
            <MetricCard
              title="Needs attention"
              value={blockedCount}
              subtitle={blockedCount > 0 ? 'Human confirmation required' : 'Running clean, nothing blocked'}
              icon={<ShieldAlert className={cn('size-3.5', blockedCount > 0 ? 'text-amber-500 animate-pulse' : 'text-muted-foreground')} />}
              badge={blockedCount > 0 ? { text: 'Blocked', trend: 'down' } : undefined}
              className={cn(
                filterTab === 'blocked' && 'ring-2 ring-primary border-primary',
                blockedCount > 0 && 'bg-amber-500/[0.04]'
              )}
            />
          </div>

          {/* Card 2: Working Now */}
          <div
            onClick={() => setFilterTab(filterTab === 'working' ? 'all' : 'working')}
            className="cursor-pointer"
          >
            <MetricCard
              title="Running"
              value={workingCount}
              subtitle={workingCount > 0 ? `${workingCount} working on a task` : 'All agents standing by'}
              icon={<Activity className={cn('size-3.5', workingCount > 0 ? 'text-amber-500 animate-spin' : 'text-muted-foreground')} />}
              badge={workingCount > 0 ? { text: `${workingCount} active`, trend: 'neutral' } : undefined}
              chart={workingCount > 0 ? <SparklineBar data={[12, 18, 14, 28, 22, 35, 30]} color="#f59e0b" height={30} barWidth={4} barGap={2.5} /> : undefined}
              className={cn(filterTab === 'working' && 'ring-2 ring-primary border-primary')}
            />
          </div>

          {/* Card 3: Agents Online */}
          <div
            onClick={() => setFilterTab(filterTab === 'online' ? 'all' : 'online')}
            className="cursor-pointer"
          >
            <MetricCard
              title="Agents online"
              value={`${onlineCount} / ${agents.length}`}
              subtitle={onlineCount > 0 ? 'Heartbeat healthy' : 'All agents offline'}
              icon={<Users className="size-3.5 text-emerald-500" />}
              chart={
                onlineCount > 0 ? (
                  <RingProgress
                    value={(onlineCount / agents.length) * 100}
                    size={32}
                    strokeWidth={3}
                    color="#10b981"
                    label={`${onlineCount}`}
                  />
                ) : undefined
              }
              className={cn(filterTab === 'online' && 'ring-2 ring-primary border-primary')}
            />
          </div>

          {/* Card 4: Tokens Reported */}
          <div>
            <MetricCard
              title="Token usage"
              value={totalTokens > 0 ? fmtTokens(totalTokens) : '0 tok'}
              subtitle={totalTokens > 0 ? 'Cumulative across sessions' : 'Nothing recorded yet'}
              icon={<Zap className="size-3.5 text-violet-500" />}
              chart={totalTokens > 0 ? <SparklineArea data={[10, 18, 14, 26, 22, 34, 30]} color="#8b5cf6" height={30} width={72} /> : undefined}
            />
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

          {/* True 0 Configuration State */}
          {hasZeroAgents && (
            <OnboardingGuide
              onQuickConnect={handlePairAgent}
              className="my-2"
            />
          )}

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

          {/* View Tab 1: Grid Cards */}
          {viewTab === 'grid' && (
            <div className="space-y-7">
              {/* Section 1: My Configured Agents */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground font-mono">
                    <Users className="size-3.5 text-primary" />
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
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
                    {filteredMyStations.map((s, idx) => (
                      <motion.div
                        key={s.agent.agentName}
                        initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.15, ease: 'easeOut', delay: Math.min(idx, 8) * 0.02 }}
                      >
                        <AgentStation
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
                  <button
                    type="button"
                    onClick={() => setShowIntegrations((prev) => !prev)}
                    className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground font-mono hover:text-foreground transition-colors cursor-pointer select-none"
                  >
                    <span>Available integrations ({integrationStations.length})</span>
                    {showIntegrations ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                  </button>

                  {showIntegrations && (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
                      {integrationStations.map((s) => (
                        <AgentStation
                          key={s.agent.agentName}
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
          )}

          {/* View Tab 2: Swimlane Timeline */}
          {viewTab === 'swimlane' && (
            <SwimlaneTimeline
              agents={agents}
              events={swimlaneEvents}
              onOpenThread={openThread}
            />
          )}
        </div>

        {/* Right Activity Timeline */}
        <ActivityTimeline
          events={activityFeed}
          agents={agents.map((a) => a.agentName)}
          onOpenThread={openThread}
          loading={feedLoading}
          className="lg:w-[320px] xl:w-[350px]"
        />
      </div>
    </div>
  );
}
