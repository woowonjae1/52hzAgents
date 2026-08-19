'use client';

import { useMemo, useState, useEffect } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { AgentStation, type StationData, type StationStatus } from './agent-station';
import { ConnectAgentModal } from './connect-agent-modal';
import { CustomAgentModal } from './custom-agent-modal';
import { Users, Activity, Loader2, Plus, MessageSquare, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { workspaceApi } from '@/lib/api';
import { eventToMessage, networkAgentToWorkspaceAgent, type ONMEvent } from '@/lib/types';
import { useAgentCatalog, catalogAsOfflineAgents } from '@/lib/agent-catalog';
import { toast } from 'sonner';

/** One classified line in the collaboration activity feed. */
interface ActivityLine {
  id: string;
  time: Date;
  sender: string;
  channel: string;
  content: string;
  type: 'command' | 'success' | 'error' | 'thinking' | 'info';
}

// Restrained per-type dot — a single small status color, no neon/glow.
const ACTIVITY_DOT: Record<ActivityLine['type'], string> = {
  command: 'bg-foreground-muted ring-foreground-muted/20',
  success: 'bg-emerald-500 ring-emerald-500/20 dark:bg-emerald-400 dark:ring-emerald-400/20',
  error: 'bg-red-500 ring-red-500/20 dark:bg-red-400 dark:ring-red-400/20',
  thinking: 'bg-amber-500 ring-amber-500/20 dark:bg-amber-400 dark:ring-amber-400/20',
  info: 'bg-surface4 ring-surface4/30',
};

/** Shared type tokens so every label on this surface reads from one scale. */
const MICRO_LABEL = 'text-[10px] font-medium uppercase tracking-wider text-foreground-extra-muted';
const CARD = 'rounded-xl border border-border/70 bg-surface1 shadow-sm';

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/\*\*/g, '')
    .replace(/`{1,3}/g, '')
    .replace(/\n+/g, ' ')
    .trim();
}

/**
 * Overview — the workspace home surface.
 *
 * Collaboration-first: a roster of connected agents with their real status,
 * and a shared activity feed showing what agents are saying to each other and
 * in which channel. No fabricated telemetry.
 */
export function MissionControl() {
  const {
    agents,
    setAgents,
    sessions,
    lastMessageBySession,
    activeSessionIds,
    workingAgentNames,
    setCurrentSessionId,
  } = useWorkspace();
  const { setViewMode, setSelectedAgentName } = useLayout();
  // Every entrance animation on this surface goes through this flag.
  const reduceMotion = useReducedMotion();

  const [agentTokens, setAgentTokens] = useState<Record<string, number>>({});
  const [connectModalOpen, setConnectModalOpen] = useState(false);
  const [customModalOpen, setCustomModalOpen] = useState(false);

  const handlePairAgent = async (agentName: string) => {
    if (agentName.toLowerCase() === 'custom') {
      setCustomModalOpen(true);
      return;
    }
    try {
      toast.loading(`Launching ${agentName}…`, { id: `launch-${agentName}` });
      await workspaceApi.launchAgent(agentName);
      toast.success(`Launched ${agentName}. Agent terminal window opened.`, { id: `launch-${agentName}`, duration: 5000 });
      const pollFreshAgents = async () => {
        try {
          const discovery = await workspaceApi.discover();
          const wsAgents = discovery.agents.map(networkAgentToWorkspaceAgent);
          setAgents(wsAgents);
        } catch {}
      };
      await pollFreshAgents();
      setTimeout(pollFreshAgents, 2000);
      setTimeout(pollFreshAgents, 5000);
    } catch (err: any) {
      const errorMsg = err?.message || 'Could not launch process';
      toast.error(`Launching ${agentName}: ${errorMsg}`, { id: `launch-${agentName}` });
    }
  };

  useEffect(() => {
    let cancelled = false;
    const pollTokens = async () => {
      try {
        const res = await workspaceApi.pollEvents({ type: 'workspace.message', limit: 100 });
        if (cancelled) return;
        // Count only usage an agent actually reported. The old character-count
        // fallback produced a number indistinguishable from a measured one, so
        // the tile read as real usage while being invented. Agents that report
        // nothing now contribute nothing.
        const usageMap: Record<string, number> = {};
        for (const ev of res.events) {
          const m = eventToMessage(ev);
          const name = m.senderName;
          if (!name) continue;
          const usage = m.metadata?.usage;
          const exact = usage?.total_tokens ?? usage?.completion_tokens;
          if (typeof exact === 'number' && exact > 0) {
            usageMap[name] = (usageMap[name] || 0) + exact;
          }
        }
        setAgentTokens(usageMap);
      } catch {
        // ignore
      }
    };
    pollTokens();
    const interval = setInterval(pollTokens, 8000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // The roster comes from the backend catalog, not a copy kept in this file —
  // the copy drifted from /v1/agent-catalog once already.
  const { catalog, loading: catalogLoading } = useAgentCatalog();
  const allCatalogAgents = useMemo(() => catalogAsOfflineAgents(catalog), [catalog]);

  const stations = useMemo<StationData[]>(() => {
    const activeThreads = sessions.filter(
      (s) => s.status === 'active' && !s.sessionId.startsWith('routine:'),
    );

    // Match on type as well as name: a connected agent called "claude-agent"
    // already IS the Claude station, so adding the catalog's "claude" placeholder
    // next to it showed the same runtime twice.
    const covered = new Set<string>();
    for (const a of agents) {
      covered.add(a.agentName.toLowerCase());
      if (a.agentType) covered.add(a.agentType.toLowerCase());
    }
    const missingCandidates = allCatalogAgents.filter((a) => !covered.has(a.agentName.toLowerCase()));
    const placeholderNames = new Set(missingCandidates.map((a) => a.agentName.toLowerCase()));
    const displayAgents = [...agents, ...missingCandidates];

    return displayAgents
      .map((agent): StationData => {
        const threads = activeThreads
          .filter((s) => s.participants.includes(agent.agentName) || s.master === agent.agentName)
          .sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0));

        // Busy channel ≠ busy agent: only the routed agent answers, so channel
        // membership must not put the rest of the roster into "working".
        const isWorking = workingAgentNames.has(agent.agentName);
        const workingThread = isWorking ? threads.find((t) => activeSessionIds.has(t.sessionId)) || null : null;
        const focusThread = workingThread || threads[0] || null;

        let stationStatus: StationStatus;
        if (agent.status !== 'online') stationStatus = 'offline';
        else if (isWorking) stationStatus = 'working';
        else stationStatus = 'ready';

        const activity = focusThread ? lastMessageBySession[focusThread.sessionId] || null : null;

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
        };
      })
      // Working agents first, then ready, then offline; stable by name within.
      .sort((a, b) => {
        const rank = { working: 0, ready: 1, offline: 2 } as const;
        if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
        return a.agent.agentName.localeCompare(b.agent.agentName);
      });
  }, [agents, sessions, lastMessageBySession, activeSessionIds, workingAgentNames, agentTokens, allCatalogAgents]);

  const onlineCount = agents.filter((a) => a.status === 'online').length;
  const workingCount = stations.filter((s) => s.status === 'working').length;
  const totalTokens = useMemo(() => Object.values(agentTokens).reduce((sum, v) => sum + v, 0), [agentTokens]);
  const fmtTokens = (n: number) => (n > 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

  const openAgent = (agentName: string, focusSessionId: string | null) => {
    if (focusSessionId) {
      setViewMode('threads');
      setCurrentSessionId(focusSessionId);
    } else {
      setSelectedAgentName(agentName);
    }
  };

  const openThread = (sessionId: string) => {
    setViewMode('threads');
    setCurrentSessionId(sessionId);
  };

  // Shared activity feed — a workspace-wide event stream (newest first) showing
  // cross-agent collaboration: who said what, in which channel.
  const [activityFeed, setActivityFeed] = useState<ActivityLine[]>([]);
  // Purely presentational: tells the feed to show skeletons instead of an empty
  // state before the first poll has come back.
  const [feedLoading, setFeedLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const titleFor = (channel: string) => sessions.find((s) => s.sessionId === channel)?.title || channel;
    const fetchFeed = async () => {
      try {
        const res = await workspaceApi.pollEvents({ type: 'workspace.message', sort: 'desc', limit: 40 });
        if (cancelled) return;
        const lines: ActivityLine[] = res.events.map((ev: ONMEvent, idx: number) => {
          const m = eventToMessage(ev);
          const channel = (ev.target || '').replace(/^channel\//, '');
          let type: ActivityLine['type'] = 'info';
          if (m.messageType === 'thinking') type = 'thinking';
          else if (m.messageType === 'status') type = /failed|error|stopped|denied/i.test(m.content) ? 'error' : 'success';
          else if (m.senderType === 'agent') type = 'info';
          return {
            id: m.messageId || ev.event_id || `activity-${idx}-${ev.timestamp || Date.now()}`,
            time: m.createdAt ? new Date(m.createdAt) : new Date(ev.timestamp),
            sender: m.senderName || (ev.source || '').replace(/^(human:|openagents:)/, ''),
            channel: titleFor(channel),
            content: stripMarkdown(m.content),
            type,
          };
        });
        setActivityFeed(lines);
      } catch {
        /* keep last feed on error */
      } finally {
        if (!cancelled) setFeedLoading(false);
      }
    };
    fetchFeed();
    const id = setInterval(fetchFeed, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [sessions]);

  const rosterLoading = catalogLoading && stations.length === 0;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      {/* Header strip */}
      <div className="shrink-0 border-b border-border/70 bg-surface1 px-6 py-5">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-surface2">
            <Users className="size-4 text-foreground-muted" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-sm font-semibold tracking-tight text-foreground">Overview</h1>
            <p className="mt-0.5 text-sm text-foreground-muted">
              Agents and shared activity in this workspace
            </p>
          </div>
          <button
            onClick={() => setConnectModalOpen(true)}
            className="inline-flex h-9 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-primary px-3.5 text-xs font-medium text-primary-foreground shadow-sm transition-all duration-200 hover:bg-primary/90 hover:shadow-md active:scale-[0.98]"
            title="Connect an agent to this workspace"
          >
            <Plus className="size-3.5 shrink-0" />
            <span className="whitespace-nowrap">Connect agent</span>
          </button>
        </div>

        {/* Live workspace metrics */}
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat icon={<Users className="size-3.5" />} value={`${onlineCount}/${agents.length}`} label="Agents online" />
          <Stat
            icon={workingCount > 0 ? <Loader2 className="size-3.5 motion-safe:animate-spin" /> : <Activity className="size-3.5" />}
            value={`${workingCount}`}
            label="Working now"
            accent={workingCount > 0}
          />
          <Stat icon={<Zap className="size-3.5" />} value={fmtTokens(totalTokens)} label="Tokens reported" />
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

      {/* Body: agents roster + shared activity */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        {/* Agents roster — one card per parallel work stream */}
        <div className="min-w-0 flex-1 space-y-6 overflow-y-auto p-6">
          <section className="space-y-3">
            <SectionLabel icon={<Users className="size-3" />} count={stations.length}>
              Agents
            </SectionLabel>

            {rosterLoading ? (
              <div className="grid auto-rows-fr grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <StationSkeleton key={`station-skeleton-${i}`} />
                ))}
              </div>
            ) : stations.length === 0 ? (
              <EmptyState
                icon={<Users className="size-5 text-foreground-muted" />}
                title="No agents in this workspace yet"
                help="Connect an agent to start a parallel work stream you can watch here."
                actionLabel="Connect agent"
                onAction={() => setConnectModalOpen(true)}
              />
            ) : (
              <div className="grid auto-rows-fr grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
                {stations.map((s, idx) => (
                  <motion.div
                    key={s.agent.agentName}
                    className="h-full"
                    initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25, ease: 'easeOut', delay: Math.min(idx, 14) * 0.03 }}
                  >
                    <AgentStation
                      data={s}
                      onOpenAgent={() => openAgent(s.agent.agentName, s.focusThread?.sessionId ?? null)}
                      onOpenThread={openThread}
                      onPairAgent={() => handlePairAgent(s.agent.agentName)}
                    />
                  </motion.div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Shared activity feed */}
        <aside className="flex max-h-[42vh] min-h-0 shrink-0 flex-col border-t border-border/70 bg-surface1 lg:max-h-none lg:w-[340px] lg:border-l lg:border-t-0 xl:w-[380px]">
          <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-4">
            <span
              className={cn(
                'size-1.5 rounded-full ring-2',
                activityFeed.length > 0
                  ? 'bg-emerald-500 ring-emerald-500/20 dark:bg-emerald-400 dark:ring-emerald-400/20 motion-safe:animate-pulse'
                  : 'bg-surface4 ring-surface4/30',
              )}
            />
            <span className="text-sm font-semibold tracking-tight text-foreground">Activity</span>
            <span className={cn(MICRO_LABEL, 'ml-auto tabular-nums')}>{activityFeed.length} events</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
            {feedLoading && activityFeed.length === 0 ? (
              <div className="space-y-1 px-4 py-2">
                {Array.from({ length: 7 }).map((_, i) => (
                  <div key={`feed-skeleton-${i}`} className="flex items-start gap-2.5 py-2">
                    <div className="mt-1.5 size-1.5 shrink-0 animate-pulse rounded-full bg-surface3" />
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="h-2.5 w-1/3 animate-pulse rounded bg-surface3" />
                      <div className="h-2.5 w-4/5 animate-pulse rounded bg-surface2" />
                    </div>
                  </div>
                ))}
              </div>
            ) : activityFeed.length === 0 ? (
              <div className="flex h-full items-center justify-center p-6">
                <EmptyState
                  icon={<MessageSquare className="size-5 text-foreground-muted" />}
                  title="No activity yet"
                  help="Messages between agents and teammates will show up here as they happen."
                  actionLabel="Connect agent"
                  onAction={() => setConnectModalOpen(true)}
                  bare
                />
              </div>
            ) : (
              activityFeed.map((line, idx) => (
                <motion.button
                  key={line.id || `act-line-${idx}`}
                  onClick={() => openThread(line.channel)}
                  initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25, ease: 'easeOut', delay: Math.min(idx, 12) * 0.03 }}
                  className="flex w-full items-start gap-2.5 px-4 py-2 text-left transition-colors hover:bg-surface2/70"
                >
                  <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full ring-2', ACTIVITY_DOT[line.type])} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="truncate text-xs font-semibold text-foreground">{line.sender}</span>
                      <span className="truncate text-[11px] text-foreground-muted">#{line.channel}</span>
                      <span className="ml-auto shrink-0 text-[10px] tabular-nums text-foreground-extra-muted">
                        {line.time.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <p
                      className={cn(
                        'mt-0.5 truncate text-xs',
                        line.type === 'error' ? 'text-red-600 dark:text-red-400' : 'text-foreground-muted',
                      )}
                    >
                      {line.content || '—'}
                    </p>
                  </div>
                </motion.button>
              ))
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function SectionLabel({ icon, count, children }: { icon?: React.ReactNode; count?: number; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      {icon && <span className="text-foreground-extra-muted">{icon}</span>}
      <span className={MICRO_LABEL}>{children}</span>
      {typeof count === 'number' && (
        <span className="rounded-full bg-surface2 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-foreground-muted">
          {count}
        </span>
      )}
    </div>
  );
}

function Stat({ icon, value, label, accent }: { icon?: React.ReactNode; value: string; label: string; accent?: boolean }) {
  return (
    <div className={cn(CARD, 'px-4 py-3 transition-all duration-200 hover:shadow-md')}>
      <div className="flex items-center gap-1.5">
        {icon && <span className={accent ? 'text-amber-600 dark:text-amber-400' : 'text-foreground-extra-muted'}>{icon}</span>}
        <span className={MICRO_LABEL}>{label}</span>
      </div>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-foreground">{value}</p>
    </div>
  );
}

/** Skeleton that mirrors an AgentStation card, so loading has the real shape. */
function StationSkeleton() {
  return (
    <div className={cn(CARD, 'flex h-full flex-col overflow-hidden')}>
      <div className="flex items-center gap-3 px-4 pb-3 pt-4">
        <div className="size-9 shrink-0 animate-pulse rounded-full bg-surface3" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="h-2 w-16 animate-pulse rounded bg-surface2" />
          <div className="h-3 w-28 animate-pulse rounded bg-surface3" />
        </div>
        <div className="h-5 w-16 shrink-0 animate-pulse rounded-full bg-surface2" />
      </div>
      <div className="px-4 pb-4">
        <div className="min-h-[78px] space-y-2 rounded-lg border border-border/70 bg-surface2/50 p-3">
          <div className="h-2 w-20 animate-pulse rounded bg-surface3" />
          <div className="h-2.5 w-full animate-pulse rounded bg-surface2" />
          <div className="h-2.5 w-2/3 animate-pulse rounded bg-surface2" />
        </div>
      </div>
      <div className="mt-auto space-y-2.5 border-t border-border/70 px-4 py-3">
        <div className="h-2 w-24 animate-pulse rounded bg-surface2" />
        <div className="grid grid-cols-2 gap-2 pt-1">
          <div className="h-8 animate-pulse rounded-lg bg-surface2" />
          <div className="h-8 animate-pulse rounded-lg bg-surface2" />
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  help,
  actionLabel,
  onAction,
  bare,
}: {
  icon: React.ReactNode;
  title: string;
  help: string;
  actionLabel: string;
  onAction: () => void;
  bare?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center px-6 py-10 text-center',
        !bare && 'rounded-xl border border-dashed border-border-accent bg-surface1/60',
      )}
    >
      <div className="flex size-11 items-center justify-center rounded-full bg-surface2">{icon}</div>
      <p className="mt-3 text-sm font-semibold tracking-tight text-foreground">{title}</p>
      <p className="mt-1 max-w-[38ch] text-sm text-foreground-muted">{help}</p>
      <button
        onClick={onAction}
        className="mt-4 inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-primary px-3.5 text-xs font-medium text-primary-foreground shadow-sm transition-all duration-200 hover:bg-primary/90 hover:shadow-md active:scale-[0.98]"
      >
        <Plus className="size-3.5" />
        {actionLabel}
      </button>
    </div>
  );
}
