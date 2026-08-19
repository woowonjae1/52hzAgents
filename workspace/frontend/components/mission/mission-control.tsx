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
  Radio,
  Layers,
  Sparkles,
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

          // Check for pending approval in recent messages
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

  // Build station cards & detect stalled agents
  const stations: StationData[] = useMemo(() => {
    const liveNames = new Set(agents.map((a) => a.agentName.toLowerCase()));
    const placeholderNames = new Set<string>();
    const missingCandidates = allCatalogAgents.filter((a) => {
      const match = liveNames.has(a.agentName.toLowerCase());
      if (!match) placeholderNames.add(a.agentName.toLowerCase());
      return !match;
    });

    const activeThreads = sessions.filter((s) => s.status !== 'archived');
    const displayAgents = [...agents, ...missingCandidates];
    const now = Date.now();

    return displayAgents
      .map((agent): StationData => {
        const threads = activeThreads
          .filter((s) => s.participants.includes(agent.agentName) || s.master === agent.agentName)
          .sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0));

        const isWorking = workingAgentNames.has(agent.agentName);
        const workingThread = isWorking ? threads.find((t) => activeSessionIds.has(t.sessionId)) || null : null;
        const focusThread = workingThread || threads[0] || null;
        const activity = focusThread ? lastMessageBySession[focusThread.sessionId] || null : null;

        // Check if there is a pending approval for this agent
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
          // If working for > 35s with no activity, mark as stalled
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
          isCatalogPlaceholder: placeholderNames.has(agent.agentName.toLowerCase()),
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
      })
      .sort((a, b) => {
        // Priority order: blocked (0) -> stalled (1) -> working (2) -> ready (3) -> offline (4)
        const rank = { blocked: 0, stalled: 1, working: 2, ready: 3, offline: 4 } as const;
        if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
        return a.agent.agentName.localeCompare(b.agent.agentName);
      });
  }, [agents, sessions, lastMessageBySession, activeSessionIds, workingAgentNames, agentTokens, allCatalogAgents, pendingApprovals]);

  // Stalled items for ActionRequiredBanner
  const stalledItems: PendingActionItem[] = useMemo(() => {
    return stations
      .filter((s) => s.status === 'stalled')
      .map((s) => ({
        id: `stall-${s.agent.agentName}`,
        type: 'stalled',
        agentName: s.agent.agentName,
        channelId: s.focusThread?.sessionId || '',
        channelTitle: s.focusThread?.title || '新频道',
        stalledMs: s.stalledMs || 35000,
        timestamp: new Date(),
      }));
  }, [stations]);

  const allActionRequired = useMemo(() => {
    return [...pendingApprovals, ...stalledItems];
  }, [pendingApprovals, stalledItems]);

  // Swimlane events mapping
  const swimlaneEvents: SwimlaneEvent[] = useMemo(() => {
    return stations
      .filter((s) => s.status !== 'offline')
      .map((s): SwimlaneEvent => {
        const isBlock = s.status === 'blocked';
        const isStall = s.status === 'stalled';
        const isWork = s.status === 'working';

        return {
          id: `swim-${s.agent.agentName}`,
          agentName: s.agent.agentName,
          type: isBlock ? 'blocked' : isStall ? 'stalled' : isWork ? 'tool' : 'message',
          title: s.pendingApproval?.command ? `$ ${s.pendingApproval.command}` : s.activity?.content || '执行任务中',
          startOffsetSec: isWork || isBlock ? 60 : 15,
          durationSec: isWork || isBlock ? 45 : 15,
          channelTitle: s.focusThread?.title || '新频道',
          sessionId: s.focusThread?.sessionId || '',
          status: isBlock ? 'blocked' : isStall ? 'error' : isWork ? 'running' : 'success',
        };
      });
  }, [stations]);

  // Filtered station cards
  const filteredStations = useMemo(() => {
    if (filterTab === 'working') return stations.filter((s) => s.status === 'working' || s.status === 'stalled');
    if (filterTab === 'blocked') return stations.filter((s) => s.status === 'blocked' || s.status === 'stalled');
    if (filterTab === 'online') return stations.filter((s) => s.status !== 'offline');
    return stations;
  }, [stations, filterTab]);

  const onlineCount = agents.filter((a) => a.status === 'online').length;
  const workingCount = stations.filter((s) => s.status === 'working').length;
  const blockedCount = stations.filter((s) => s.status === 'blocked' || s.status === 'stalled').length;
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
      toast.info(`正在连接 ${agentName}...`);
      await workspaceApi.launchAgent(agentName);
      toast.success(`${agentName} 已成功上线`);
      const updated = await workspaceApi.listAgents();
      setAgents(updated);
    } catch {
      toast.error(`无法连接 ${agentName}，请检查服务配置`);
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

  const rosterLoading = catalogLoading && stations.length === 0;
  const isAllOffline = onlineCount === 0 && !catalogLoading;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Header Strip with Interactive Analytics Metric Cards */}
      <div className="shrink-0 border-b border-border/70 bg-surface1/70 backdrop-blur-md px-6 py-4 space-y-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-surface2 shadow-2xs">
              <Layers className="size-4 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="text-sm font-bold tracking-tight text-foreground flex items-center gap-2">
                <span>Mission Control</span>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-primary/10 text-primary font-mono font-medium">
                  指挥台
                </span>
              </h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                实时调度中枢 · 异常与审批拦截 · 并行时序追踪
              </p>
            </div>
          </div>

          {/* View Tab Switcher (Cards vs Swimlane) */}
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
              <span>卡片席位</span>
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
              <span>并行泳道</span>
            </button>
          </div>
        </div>

        {/* 4 Clickable Metric Drilldown Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {/* Card 1: Action Required / Blocked */}
          <div
            onClick={() => setFilterTab(filterTab === 'blocked' ? 'all' : 'blocked')}
            className="cursor-pointer"
          >
            <MetricCard
              title="待处理与停滞 (Attention)"
              value={blockedCount}
              subtitle={blockedCount > 0 ? '⚠️ 需要立即人工处理' : '运行正常，无阻塞'}
              icon={<ShieldAlert className={cn('size-3.5', blockedCount > 0 ? 'text-amber-500 animate-pulse' : 'text-muted-foreground')} />}
              badge={{ text: blockedCount > 0 ? 'Action Req' : 'Clear', trend: blockedCount > 0 ? 'down' : 'neutral' }}
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
              title="并行工作中 (Working)"
              value={workingCount}
              subtitle={workingCount > 0 ? `${workingCount} 个 Agent 正在运行` : '处于空闲就绪态'}
              icon={<Activity className={cn('size-3.5', workingCount > 0 ? 'text-amber-500 animate-spin' : 'text-muted-foreground')} />}
              badge={{ text: `${workingCount} Active`, trend: 'neutral' }}
              chart={<SparklineBar data={[10, 18, 14, 28, 22, 35, 30]} color="#f59e0b" height={30} barWidth={4} barGap={2.5} />}
              className={cn(filterTab === 'working' && 'ring-2 ring-primary border-primary')}
            />
          </div>

          {/* Card 3: Agents Online */}
          <div
            onClick={() => setFilterTab(filterTab === 'online' ? 'all' : 'online')}
            className="cursor-pointer"
          >
            <MetricCard
              title="在线 Agent (Online)"
              value={`${onlineCount} / ${agents.length || 3}`}
              subtitle="双向心跳守护通道"
              icon={<Users className="size-3.5 text-emerald-500" />}
              badge={{ text: onlineCount > 0 ? 'Connected' : 'Offline', trend: 'neutral' }}
              chart={
                <RingProgress
                  value={agents.length > 0 ? (onlineCount / agents.length) * 100 : 0}
                  size={32}
                  strokeWidth={3.5}
                  color="#10b981"
                  label={`${onlineCount}`}
                />
              }
              className={cn(filterTab === 'online' && 'ring-2 ring-primary border-primary')}
            />
          </div>

          {/* Card 4: Tokens Used */}
          <div>
            <MetricCard
              title="Token 消耗总量"
              value={totalTokens > 0 ? fmtTokens(totalTokens) : '0 tok'}
              subtitle="7日协同执行消耗"
              icon={<Zap className="size-3.5 text-violet-500" />}
              badge={{ text: '+15%', trend: 'up' }}
              chart={<SparklineArea data={[12, 20, 16, 32, 26, 42, 38]} color="#8b5cf6" height={30} width={75} />}
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
        <div className="min-w-0 flex-1 space-y-4 overflow-y-auto p-5">
          {/* Top Priority Action Required Banner (Only shows when blocked/stalled/error exists) */}
          <ActionRequiredBanner
            items={allActionRequired}
            onOpenThread={openThread}
            onResolved={fetchRecentData}
          />

          {/* 0 Agents Onboarding Guide (Step 6) */}
          {isAllOffline && (
            <OnboardingGuide
              onQuickConnect={handlePairAgent}
              className="my-2"
            />
          )}

          {/* Filter Bar */}
          <div className="flex items-center justify-between pt-1">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
              <Users className="size-3.5 text-primary" />
              <span>智能体协同席位 ({filteredStations.length})</span>
              {filterTab !== 'all' && (
                <button
                  type="button"
                  onClick={() => setFilterTab('all')}
                  className="ml-2 text-[11px] text-primary hover:underline cursor-pointer"
                >
                  清除筛选 ({filterTab})
                </button>
              )}
            </div>
          </div>

          {/* View Tab 1: Grid Cards */}
          {viewTab === 'grid' && (
            <>
              {rosterLoading ? (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3.5">
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div key={`skel-${i}`} className="h-40 rounded-2xl bg-surface2/60 animate-pulse border border-border/40" />
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3.5">
                  {filteredStations.map((s, idx) => (
                    <motion.div
                      key={s.agent.agentName}
                      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.2, ease: 'easeOut', delay: Math.min(idx, 12) * 0.02 }}
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
            </>
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
          className="lg:w-[330px] xl:w-[360px]"
        />
      </div>
    </div>
  );
}
