'use client';

import { useMemo, useState, useEffect } from 'react';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { AgentStation, type StationData, type StationStatus } from './agent-station';
import { ConnectAgentModal } from './connect-agent-modal';
import { Users, Activity, Loader2, Plus, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { workspaceApi } from '@/lib/api';
import { eventToMessage, networkAgentToWorkspaceAgent, type WorkspaceAgent } from '@/lib/types';
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
  command: 'bg-zinc-400 dark:bg-zinc-500',
  success: 'bg-emerald-500',
  error: 'bg-red-500',
  thinking: 'bg-zinc-300 dark:bg-zinc-600',
  info: 'bg-zinc-300 dark:bg-zinc-600',
};

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
    setCurrentSessionId,
  } = useWorkspace();
  const { setViewMode, setSelectedAgentName } = useLayout();

  const [agentTokens, setAgentTokens] = useState<Record<string, number>>({});
  const [connectModalOpen, setConnectModalOpen] = useState(false);

  const handlePairAgent = async (agentName: string) => {
    try {
      toast.loading(`Launching ${agentName}…`, { id: `launch-${agentName}` });
      await workspaceApi.launchAgent(agentName);
      toast.success(`Launched ${agentName}. Finish setup in the terminal window.`, { id: `launch-${agentName}`, duration: 5000 });
      try {
        const discovery = await workspaceApi.discover();
        const wsAgents = discovery.agents.map(networkAgentToWorkspaceAgent);
        setAgents(wsAgents);
      } catch {
        // ignore discovery refresh glitch
      }
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

  const ALL_CATALOG_AGENTS: WorkspaceAgent[] = [
    { agentName: 'claude-agent', role: 'worker', agentType: 'claude', serverHost: null, workingDir: null, description: 'Anthropic Claude Code autonomous agent', enabledSkills: null, status: 'offline', lastHeartbeatAt: null, joinedAt: null },
    { agentName: 'codex-agent', role: 'worker', agentType: 'codex', serverHost: null, workingDir: null, description: 'OpenAI Codex code generation agent', enabledSkills: null, status: 'offline', lastHeartbeatAt: null, joinedAt: null },
    { agentName: 'cline', role: 'worker', agentType: 'cline', serverHost: null, workingDir: null, description: 'VS Code Agent for autonomous coding', enabledSkills: null, status: 'offline', lastHeartbeatAt: null, joinedAt: null },
    { agentName: 'hermes', role: 'worker', agentType: 'hermes', serverHost: null, workingDir: null, description: 'Autonomous agent framework for devops', enabledSkills: null, status: 'offline', lastHeartbeatAt: null, joinedAt: null },
    { agentName: 'kilo', role: 'worker', agentType: 'kilo', serverHost: null, workingDir: null, description: 'Fast code editing & refactoring agent', enabledSkills: null, status: 'offline', lastHeartbeatAt: null, joinedAt: null },
  ];

  const stations = useMemo<StationData[]>(() => {
    const activeThreads = sessions.filter(
      (s) => s.status === 'active' && !s.sessionId.startsWith('routine:'),
    );

    const existingNames = new Set(agents.map((a) => a.agentName.toLowerCase()));
    const missingCandidates = ALL_CATALOG_AGENTS.filter((a) => !existingNames.has(a.agentName.toLowerCase()));
    const displayAgents = [...agents, ...missingCandidates];

    return displayAgents
      .map((agent): StationData => {
        const threads = activeThreads
          .filter((s) => s.participants.includes(agent.agentName) || s.master === agent.agentName)
          .sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0));

        const workingThread = threads.find((t) => activeSessionIds.has(t.sessionId)) || null;
        const focusThread = workingThread || threads[0] || null;

        let stationStatus: StationStatus;
        if (agent.status !== 'online') stationStatus = 'offline';
        else if (workingThread) stationStatus = 'working';
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
        };
      })
      // Working agents first, then ready, then offline; stable by name within.
      .sort((a, b) => {
        const rank = { working: 0, ready: 1, offline: 2 } as const;
        if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
        return a.agent.agentName.localeCompare(b.agent.agentName);
      });
  }, [agents, sessions, lastMessageBySession, activeSessionIds, agentTokens]);

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
  useEffect(() => {
    let cancelled = false;
    const titleFor = (channel: string) => sessions.find((s) => s.sessionId === channel)?.title || channel;
    const fetchFeed = async () => {
      try {
        const res = await workspaceApi.pollEvents({ type: 'workspace.message', sort: 'desc', limit: 40 });
        if (cancelled) return;
        const lines: ActivityLine[] = res.events.map((ev) => {
          const m = eventToMessage(ev);
          const channel = (ev.target || '').replace(/^channel\//, '');
          let type: ActivityLine['type'] = 'info';
          if (m.messageType === 'thinking') type = 'thinking';
          else if (m.messageType === 'status') type = /failed|error|stopped|denied/i.test(m.content) ? 'error' : 'success';
          else if (m.senderType === 'agent') type = 'info';
          return {
            id: m.messageId || ev.id,
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
      }
    };
    fetchFeed();
    const id = setInterval(fetchFeed, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [sessions]);

  // ── Empty state: no agents connected yet ──
  if (agents.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6">
        <div className="size-12 rounded-xl bg-zinc-100 dark:bg-zinc-900 flex items-center justify-center mb-4">
          <Users className="size-6 text-zinc-400" />
        </div>
        <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-50">No agents connected yet</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1 max-w-sm">
          Connect an agent to see it here, alongside the threads it works on and the
          activity it shares with the rest of your team.
        </p>
        <button
          onClick={() => setViewMode('connect')}
          className="mt-5 inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-white dark:bg-zinc-100 dark:hover:bg-zinc-200 dark:text-zinc-900 text-sm font-semibold transition-colors"
        >
          <Plus className="size-4" />
          Connect your first agent
        </button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-background">
      {/* Header strip */}
      <div className="shrink-0 flex items-center gap-3 px-5 py-3.5 border-b border-zinc-200/60 dark:border-zinc-800/60">
        <div className="size-8 rounded-lg bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center">
          <Users className="size-4 text-zinc-600 dark:text-zinc-300" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50 leading-tight">Overview</h1>
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500">Agents and shared activity in this workspace</p>
        </div>
        <div className="flex items-center gap-2.5">
          <Stat icon={<Users className="size-3.5" />} value={`${onlineCount}/${agents.length}`} label="online" />
          <Stat
            icon={workingCount > 0 ? <Loader2 className="size-3.5 animate-spin" /> : <Activity className="size-3.5" />}
            value={`${workingCount}`}
            label="working"
            accent={workingCount > 0}
          />
          {/* Scoped to the polled window, not a lifetime total — say so. */}
          <Stat value={fmtTokens(totalTokens)} label="recent tokens" />
          <button
            onClick={() => setConnectModalOpen(true)}
            className="ml-1 inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-xs font-semibold bg-zinc-900 hover:bg-zinc-800 text-white dark:bg-zinc-100 dark:hover:bg-zinc-200 dark:text-zinc-900 transition-colors cursor-pointer"
            title="Launch a local agent or pair a remote server"
          >
            <Plus className="size-3.5" />
            <span>Connect agent</span>
          </button>
        </div>
      </div>

      <ConnectAgentModal open={connectModalOpen} onOpenChange={setConnectModalOpen} />

      {/* Body: agents roster + shared activity */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden">
        {/* Agents roster */}
        <div className="flex-1 min-w-0 overflow-y-auto p-5">
          <SectionLabel icon={<Users className="size-3.5" />}>
            Agents · {stations.length}
          </SectionLabel>
          <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-4 auto-rows-fr">
            {stations.map((s) => (
              <AgentStation
                key={s.agent.agentName}
                data={s}
                onOpenAgent={() => openAgent(s.agent.agentName, s.focusThread?.sessionId ?? null)}
                onOpenThread={openThread}
                onPairAgent={() => handlePairAgent(s.agent.agentName)}
              />
            ))}
          </div>
        </div>

        {/* Shared activity feed */}
        <aside className="shrink-0 flex flex-col min-h-0 lg:w-[340px] xl:w-[380px] max-h-[42vh] lg:max-h-none border-t lg:border-t-0 lg:border-l border-zinc-200/60 dark:border-zinc-800/60 bg-zinc-50/40 dark:bg-zinc-950/20">
          <div className="shrink-0 flex items-center gap-2 px-4 h-11 border-b border-zinc-200/60 dark:border-zinc-800/60">
            <span className={cn('size-1.5 rounded-full', activityFeed.length > 0 ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-300 dark:bg-zinc-700')} />
            <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Activity</span>
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500 ml-auto tabular-nums">{activityFeed.length} events</span>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto py-1.5">
            {activityFeed.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center gap-2 text-zinc-400 dark:text-zinc-600 px-6 text-center">
                <MessageSquare className="size-5" />
                <span className="text-xs">No activity yet. Messages between agents and teammates will appear here.</span>
              </div>
            ) : (
              activityFeed.map((line) => (
                <button
                  key={line.id}
                  onClick={() => openThread(line.channel)}
                  className="w-full text-left flex items-start gap-2.5 px-4 py-2 hover:bg-zinc-100/70 dark:hover:bg-zinc-800/30 transition-colors"
                >
                  <span className={cn('mt-1.5 size-1.5 rounded-full shrink-0', ACTIVITY_DOT[line.type])} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs font-semibold text-zinc-800 dark:text-zinc-200 truncate">{line.sender}</span>
                      <span className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate">#{line.channel}</span>
                      <span className="ml-auto shrink-0 text-[10px] text-zinc-400 dark:text-zinc-600 tabular-nums">
                        {line.time.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <p className={cn('text-xs truncate mt-0.5', line.type === 'error' ? 'text-red-600 dark:text-red-400' : 'text-zinc-500 dark:text-zinc-400')}>
                      {line.content || '—'}
                    </p>
                  </div>
                </button>
              ))
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

function SectionLabel({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 mb-3 text-[11px] font-semibold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
      {icon}
      {children}
    </div>
  );
}

function Stat({ icon, value, label, accent }: { icon?: React.ReactNode; value: string; label: string; accent?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-zinc-100/70 dark:bg-zinc-900/50 border border-zinc-200/50 dark:border-zinc-800/50">
      {icon && <span className={accent ? 'text-amber-500' : 'text-zinc-400 dark:text-zinc-500'}>{icon}</span>}
      <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-50 tabular-nums">{value}</span>
      <span className="text-[10px] text-zinc-400 dark:text-zinc-500">{label}</span>
    </div>
  );
}
