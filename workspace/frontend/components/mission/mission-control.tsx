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
import { CustomAgentModal } from './custom-agent-modal';
import { MetricCard, SparklineBar, SparklineArea, RingProgress } from './metrics-charts';
import {
  Users,
  Activity,
  Zap,
  BookOpen,
  LayoutGrid,
  Clock,
  ShieldAlert,
  Layers,
  ChevronDown,
  ChevronUp,
  Terminal,
  Copy,
  Check,
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
    knowledge = [],
    activeSessionIds,
    workingAgentNames,
    setCurrentSessionId,
  } = useWorkspace();
  const { setViewMode } = useLayout();
  const reduceMotion = useReducedMotion();

  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [customModalOpen, setCustomModalOpen] = useState(false);
  const [showIntegrations, setShowIntegrations] = useState(true);
  const [copiedAgn, setCopiedAgn] = useState(false);

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

  // Section 2: Available Catalog Presets (Not yet configured)
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

  // Stalled items for ActionRequiredBanner
  const stalledItems: PendingActionItem[] = useMemo(() => {
    return myStations
      .filter((s) => s.status === 'stalled')
      .map((s) => ({
        id: `stall-${s.agent.agentName}`,
        type: 'stalled',
        agentName: s.agent.agentName,
        channelId: s.focusThread?.sessionId || '',
        channelTitle: s.focusThread?.title || 'thread',
        stalledMs: s.stalledMs || 35000,
        timestamp: new Date(),
      }));
  }, [myStations]);

  const allActionRequired = useMemo(() => {
    return [...pendingApprovals, ...stalledItems];
  }, [pendingApprovals, stalledItems]);

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
          channelTitle: s.focusThread?.title || 'channel',
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
    if (agentName.toLowerCase() === 'custom') {
      setCustomModalOpen(true);
      return;
    }
    try {
      toast.info(`Connecting ${agentName}...`);
      await workspaceApi.launchAgent(agentName);
      toast.success(`${agentName} is now online`);
      const updated = await workspaceApi.listAgents();
      setAgents(updated);
    } catch {
      toast.error(`Unable to connect ${agentName}`);
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
      {/* Header Strip with Truthful Data & Metric Cards */}
      <div className="shrink-0 border-b border-border/70 bg-surface1/70 backdrop-blur-md px-6 py-4 space-y-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-surface2 shadow-2xs">
              <Layers className="size-4 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-bold tracking-tight text-foreground flex items-center gap-2">
                <span>Mission Control</span>
              </h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                Real-time agent orchestration, telemetry, and parallel execution
              </p>
            </div>
          </div>

          {/* View Mode Switcher */}
          <div className="flex items-center gap-1 p-1 rounded-xl bg-surface2 border border-border/60 text-xs shadow-2xs">
            <button
              type="button"
              onClick={() => setViewTab('grid')}
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg font-medium transition-colors cursor-pointer',
                viewTab === 'grid'
                  ? 'bg-surface1 text-foreground shadow-xs border border-border/70'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <LayoutGrid className="size-3.5" />
              <span>Cards</span>
            </button>
            <button
              type="button"
              onClick={() => setViewTab('swimlane')}
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg font-medium transition-colors cursor-pointer',
                viewTab === 'swimlane'
                  ? 'bg-surface1 text-foreground shadow-xs border border-border/70'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Clock className="size-3.5" />
              <span>Swimlane</span>
            </button>
          </div>
        </div>

        {/* 4 Clean Metric Cards (No Fake Charts on 0) */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* Card 1: Action Required / Blocked */}
          <div
            onClick={() => setFilterTab(filterTab === 'blocked' ? 'all' : 'blocked')}
            className="cursor-pointer"
          >
            <MetricCard
              title="Action Required"
              value={blockedCount}
              subtitle={blockedCount > 0 ? 'Requires immediate action' : 'No blocked tasks'}
              icon={<ShieldAlert className={cn('size-3.5', blockedCount > 0 ? 'text-amber-500 animate-pulse' : 'text-muted-foreground')} />}
              badge={blockedCount > 0 ? { text: 'Attention', trend: 'down' } : undefined}
              className={cn(
                filterTab === 'blocked' && 'ring-2 ring-primary border-primary',
                blockedCount > 0 && 'border-amber-500/40 bg-amber-500/[0.03]'
              )}
            />
          </div>

          {/* Card 2: Working Now */}
          <div
            onClick={() => setFilterTab(filterTab === 'working' ? 'all' : 'working')}
            className="cursor-pointer"
          >
            <MetricCard
              title="Working Now"
              value={workingCount}
              subtitle={workingCount > 0 ? `${workingCount} active execution` : 'All agents standby'}
              icon={<Activity className={cn('size-3.5', workingCount > 0 ? 'text-amber-500 animate-spin' : 'text-muted-foreground')} />}
              badge={workingCount > 0 ? { text: `${workingCount} active`, trend: 'neutral' } : undefined}
              className={cn(filterTab === 'working' && 'ring-2 ring-primary border-primary')}
            />
          </div>

          {/* Card 3: Agents Online */}
          <div
            onClick={() => setFilterTab(filterTab === 'online' ? 'all' : 'online')}
            className="cursor-pointer"
          >
            <MetricCard
              title="Agents Online"
              value={`${onlineCount} / ${agents.length}`}
              subtitle={onlineCount > 0 ? 'Daemon heartbeat active' : 'Daemons offline'}
              icon={<Users className="size-3.5 text-emerald-500" />}
              chart={
                agents.length > 0 ? (
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
              title="Tokens Reported"
              value={totalTokens > 0 ? fmtTokens(totalTokens) : '0 tok'}
              subtitle={totalTokens > 0 ? 'Reported by active sessions' : 'No tokens recorded'}
              icon={<Zap className="size-3.5 text-violet-500" />}
            />
          </div>
        </div>
      </div>

      <ConnectAgentModal
        open={connectModalOpen}
        onOpenChange={setConnectModalOpen}
        onConfigureCustom={() => {
          setConnectModalOpen(false);
          setCustomModalOpen(true);
        }}
      />
      <CustomAgentModal open={customModalOpen} onOpenChange={setCustomModalOpen} />

      {/* Main Body */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        <div className="min-w-0 flex-1 space-y-5 overflow-y-auto p-5">
          {/* Top Priority Action Required Banner */}
          <ActionRequiredBanner
            items={allActionRequired}
            onOpenThread={openThread}
            onResolved={fetchRecentData}
          />

          {/* True 0 Configuration State */}
          {hasZeroAgents && (
            <OnboardingGuide
              onQuickConnect={handlePairAgent}
              className="my-2"
            />
          )}

          {/* Configured but Offline Guidance Banner */}
          {isAllOffline && (
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-2xl bg-surface1/80 border border-border/70 shadow-2xs">
              <div className="space-y-0.5">
                <div className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-muted-foreground/50" />
                  <span>{agents.length} configured agents are currently offline</span>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Click &ldquo;Connect&rdquo; on any agent card below to initialize their process daemon.
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    agents.forEach((a) => handlePairAgent(a.agentName));
                  }}
                  className="px-3 py-1.5 rounded-xl bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 transition-opacity cursor-pointer shadow-xs"
                >
                  Connect All
                </button>
              </div>
            </div>
          )}

          {/* View Tab 1: Grid Cards */}
          {viewTab === 'grid' && (
            <div className="space-y-6">
              {/* Section 1: My Configured Agents */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground font-mono">
                    <Users className="size-3.5 text-primary" />
                    <span>My Agents ({filteredMyStations.length})</span>
                    {filterTab !== 'all' && (
                      <button
                        type="button"
                        onClick={() => setFilterTab('all')}
                        className="ml-2 text-[10.5px] text-primary hover:underline cursor-pointer lowercase"
                      >
                        (clear filter: {filterTab})
                      </button>
                    )}
                  </div>
                </div>

                {filteredMyStations.length === 0 ? (
                  <div className="p-8 text-center border border-dashed border-border/70 rounded-2xl bg-surface1/30 text-xs text-muted-foreground">
                    No matching agents found for filter: {filterTab}
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

              {/* Section 2: Available Integrations (Collapsible) */}
              {integrationStations.length > 0 && filterTab === 'all' && (
                <div className="space-y-3 pt-2 border-t border-border/40">
                  <button
                    type="button"
                    onClick={() => setShowIntegrations((prev) => !prev)}
                    className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground font-mono hover:text-foreground transition-colors cursor-pointer select-none"
                  >
                    <span>Available Integrations ({integrationStations.length})</span>
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

        {/* Right Filterable Activity Timeline */}
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
