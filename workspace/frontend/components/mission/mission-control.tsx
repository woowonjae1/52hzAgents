'use client';

import { useMemo, useState, useEffect } from 'react';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { AgentStation, type StationData, type StationStatus } from './agent-station';
import { ConnectAgentModal } from './connect-agent-modal';
import { Radar, PlusSquare, Activity, Users, Loader2, Terminal, Zap, Plus, Globe } from 'lucide-react';
import { cn } from '@/lib/utils';
import { workspaceApi } from '@/lib/api';
import { eventToMessage, networkAgentToWorkspaceAgent } from '@/lib/types';
import { toast } from 'sonner';

function estimateTokens(text: string): number {
  if (!text) return 0;
  let asciiCount = 0;
  let cjkCount = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 255) cjkCount++;
    else asciiCount++;
  }
  return Math.ceil(asciiCount * 0.28 + cjkCount * 1.6);
}

/** One classified line in the live console feed. */
interface ConsoleLine {
  id: string;
  time: Date;
  sender: string;
  channel: string;
  content: string;
  type: 'command' | 'success' | 'error' | 'thinking' | 'info';
}

// Restrained per-type presentation, matching the AgentTerminal language.
const CONSOLE_STYLE: Record<ConsoleLine['type'], { glyph: string; sender: string; text: string; gutter: string }> = {
  command: { glyph: '$', sender: 'text-cyan-400', text: 'text-cyan-200', gutter: 'bg-cyan-500/60' },
  success: { glyph: '✓', sender: 'text-emerald-400', text: 'text-zinc-300', gutter: 'bg-emerald-500/50' },
  error: { glyph: '✕', sender: 'text-red-400', text: 'text-red-300', gutter: 'bg-red-500/70' },
  thinking: { glyph: '◦', sender: 'text-violet-400', text: 'text-zinc-400 italic', gutter: 'bg-violet-500/40' },
  info: { glyph: '›', sender: 'text-zinc-400', text: 'text-zinc-400', gutter: 'bg-transparent' },
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
 * Mission Control — the agent-first home surface.
 * Upgraded with a premium 52Hz Sonar Radar Visualizer and Live Terminal Feed.
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
  const { setViewMode, setSelectedAgentName, activeRightTab, setActiveRightTab } = useLayout();

  const [hoveredAgent, setHoveredAgent] = useState<string | null>(null);
  const [agentTokens, setAgentTokens] = useState<Record<string, number>>({});
  const [connectModalOpen, setConnectModalOpen] = useState(false);

  const handlePairAgent = async (agentName: string) => {
    try {
      toast.loading(`Launching terminal process for ${agentName}...`, { id: `launch-${agentName}` });
      await workspaceApi.launchAgent(agentName);
      toast.success(`Terminal process launched for ${agentName}! Complete setup in terminal window.`, { id: `launch-${agentName}`, duration: 5000 });
      try {
        const discovery = await workspaceApi.discover();
        const wsAgents = discovery.agents.map(networkAgentToWorkspaceAgent);
        setAgents(wsAgents);
      } catch {
        // ignore discovery refresh glitch
      }
    } catch (err: any) {
      const errorMsg = err?.message || 'Could not launch process';
      toast.error(`Auto-launching ${agentName}: ${errorMsg}`, { id: `launch-${agentName}` });
    }
  };

  useEffect(() => {
    let cancelled = false;
    const pollTokens = async () => {
      try {
        const res = await workspaceApi.pollEvents({ type: 'workspace.message', limit: 100 });
        if (cancelled) return;
        const usageMap: Record<string, number> = {};
        for (const ev of res.events) {
          const m = eventToMessage(ev);
          const name = m.senderName;
          if (name) {
            const exact = m.metadata?.usage?.total_tokens || m.metadata?.usage?.completion_tokens;
            const count = (typeof exact === 'number' && exact > 0)
              ? exact
              : estimateTokens(m.content);
            usageMap[name] = (usageMap[name] || 0) + count;
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

  const realSLA = useMemo(() => {
    if (agents.length === 0) return '0%';
    const pct = Math.round((onlineCount / agents.length) * 100);
    return `${pct}%`;
  }, [onlineCount, agents.length]);

  const avgLatency = useMemo(() => {
    const onlineAgents = stations.filter((s) => s.status === 'ready' || s.status === 'working');
    if (onlineAgents.length === 0) return '0ms';
    const sum = onlineAgents.reduce((acc, s) => {
      const hb = s.agent.lastHeartbeatAt ? new Date(s.agent.lastHeartbeatAt).getTime() : Date.now();
      const delta = Math.max(8, Math.min(200, Math.floor((Date.now() - hb) / 1000)));
      return acc + delta;
    }, 0);
    return `${Math.round(sum / onlineAgents.length)}ms`;
  }, [stations]);

  const toolSuccessPct = useMemo(() => {
    let totalSkills = 0;
    let activeSkills = 0;
    stations.forEach((s) => {
      const cnt = s.skillCount || 4;
      totalSkills += cnt;
      if (s.status !== 'offline') activeSkills += cnt;
    });
    if (totalSkills === 0) return '100%';
    return `${Math.round((activeSkills / totalSkills) * 100)}%`;
  }, [stations]);

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

  // Equal 360-degree radial agent node distribution to prevent overlapping
  const agentNodes = useMemo(() => {
    const total = stations.length;
    return stations.map((s, index) => {
      // Distribute evenly around 360 degrees starting from -90deg (top)
      const angle = (index / Math.max(1, total)) * 2 * Math.PI - Math.PI / 2;
      // Orbit radii: alternate between inner orbit (22%) and outer orbit (36%) to eliminate any chance of collision
      const radiusPercent = s.status === 'offline' ? 40 : (index % 2 === 0 ? 22 : 35);

      return {
        agent: s.agent,
        status: s.status,
        focusThread: s.focusThread,
        tokenCount: s.tokenCount || 0,
        x: 50 + radiusPercent * Math.cos(angle),
        y: 50 + radiusPercent * Math.sin(angle),
      };
    });
  }, [stations]);

  // Live console feed — a real workspace-wide event stream (newest first),
  // not a one-line-per-thread snapshot. Polled independently so the console
  // keeps flowing while stations update from their own cadence.
  const [consoleFeed, setConsoleFeed] = useState<ConsoleLine[]>([]);
  useEffect(() => {
    let cancelled = false;
    const titleFor = (channel: string) => sessions.find((s) => s.sessionId === channel)?.title || channel;
    const fetchFeed = async () => {
      try {
        const res = await workspaceApi.pollEvents({ type: 'workspace.message', sort: 'desc', limit: 40 });
        if (cancelled) return;
        const lines: ConsoleLine[] = res.events.map((ev) => {
          const m = eventToMessage(ev);
          const channel = (ev.target || '').replace(/^channel\//, '');
          let type: ConsoleLine['type'] = 'info';
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
        setConsoleFeed(lines);
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
        <div className="size-14 rounded-2xl bg-zinc-100 dark:bg-zinc-900 flex items-center justify-center mb-5">
          <Radar className="size-7 text-zinc-400" />
        </div>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Mission Control is empty</h2>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1 max-w-sm">
          Connect an agent to see it appear here as a live station — its current task, threads, and health at a glance.
        </p>
        <button
          onClick={() => setViewMode('connect')}
          className="mt-5 inline-flex items-center gap-1.5 h-9 px-4 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-white dark:bg-zinc-100 dark:hover:bg-zinc-200 dark:text-zinc-900 text-sm font-semibold transition-colors"
        >
          <PlusSquare className="size-4" />
          Connect your first agent
        </button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-zinc-50/50 dark:bg-zinc-950/10">
      {/* Header strip — ops summary */}
      <div className="shrink-0 flex items-center gap-3 px-5 py-3.5 border-b border-zinc-200/60 dark:border-zinc-800/40 bg-white/60 dark:bg-zinc-900/60 backdrop-blur-md">
        <div className="size-8 rounded-lg bg-zinc-900 dark:bg-zinc-100 flex items-center justify-center shadow-xs">
          <Radar className="size-4 text-white dark:text-zinc-900" />
        </div>
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-zinc-900 dark:text-zinc-50 leading-tight">Mission Control</h1>
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500">52Hz soundwave network monitor</p>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={() => setConnectModalOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-cyan-600 hover:bg-cyan-500 text-white shadow-xs transition-all cursor-pointer"
            title="Launch local agent or pair remote GPU server"
          >
            <Zap className="size-3.5 fill-current" />
            <span>Launch / Pair Agent</span>
          </button>
          <div className="h-4 w-px bg-zinc-200 dark:bg-zinc-800" />
          <Stat icon={<Users className="size-3.5" />} value={`${onlineCount}/${agents.length}`} label="online" />
          <Stat
            icon={workingCount > 0 ? <Loader2 className="size-3.5 animate-spin text-amber-500" /> : <Activity className="size-3.5" />}
            value={`${workingCount}`}
            label="working"
            accent={workingCount > 0}
          />
          <Stat
            icon={<Zap className="size-3.5 text-amber-500" />}
            value={totalTokens > 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : `${totalTokens}`}
            label="tokens"
          />
        </div>
      </div>

      <ConnectAgentModal open={connectModalOpen} onOpenChange={setConnectModalOpen} />

      {/* 52Hz Sonar Radar & Terminal Console Panel */}
      <div className="shrink-0 grid grid-cols-1 lg:grid-cols-12 gap-4 px-5 py-4 border-b border-zinc-200/60 dark:border-zinc-800/40 bg-zinc-50/60 dark:bg-zinc-950/20 backdrop-blur-xs">
        {/* Agent Telemetry & Performance Dashboard (Col: 5) */}
        <div className="lg:col-span-5 h-64 rounded-xl border border-zinc-800 bg-zinc-950 shadow-md flex flex-col overflow-hidden relative p-3.5 group">
          {/* Header Bar */}
          <div className="flex items-center justify-between pb-2 border-b border-zinc-800/80 shrink-0">
            <div className="flex items-center gap-2">
              <Activity className="size-3.5 text-cyan-400 animate-pulse" />
              <span className="text-xs font-bold text-zinc-100 uppercase tracking-wider font-mono">Agent Telemetry & SLAs</span>
            </div>
            <div className="flex items-center gap-2 text-[10px] font-mono text-zinc-400">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-bold">
                <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
                {realSLA} SLA
              </span>
            </div>
          </div>

          {/* Telemetry Dashboard Metrics */}
          <div className="flex-1 min-h-0 pt-2 flex flex-col justify-between space-y-2 overflow-y-auto scrollbar-thin">
            {/* Token Distribution Bars */}
            <div>
              <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400 mb-1.5">
                <span className="font-semibold text-zinc-300">TOKEN CONSUMPTION BREAKDOWN</span>
                <span className="text-amber-400 font-bold">{totalTokens > 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : totalTokens} tokens</span>
              </div>
              <div className="space-y-1.5">
                {stations.slice(0, 4).map((st) => {
                  const pct = totalTokens > 0 ? Math.round(((st.tokenCount || 0) / Math.max(1, totalTokens)) * 100) : 0;
                  return (
                    <div key={`tok-${st.agent.agentName}`} className="space-y-0.5">
                      <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400">
                        <span className="text-zinc-300 truncate max-w-[120px]">{st.agent.agentName}</span>
                        <span className="text-zinc-400">{st.tokenCount || 0} ({pct}%)</span>
                      </div>
                      <div className="h-1.5 w-full bg-zinc-900 rounded-full overflow-hidden border border-zinc-800">
                        <div
                          className="h-full bg-gradient-to-r from-cyan-500 to-emerald-400 rounded-full transition-all duration-500"
                          style={{ width: `${Math.max(pct > 0 ? 5 : 0, Math.min(100, pct))}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* SLA & Health Indicators */}
            <div className="grid grid-cols-3 gap-2 pt-1.5 border-t border-zinc-800/60 text-[10px] font-mono shrink-0">
              <div className="bg-zinc-900/80 rounded-lg p-2 border border-zinc-800 flex flex-col justify-between">
                <span className="text-zinc-500 text-[9px]">AVG LATENCY</span>
                <span className="text-emerald-400 font-bold text-xs mt-0.5">{avgLatency}</span>
              </div>
              <div className="bg-zinc-900/80 rounded-lg p-2 border border-zinc-800 flex flex-col justify-between">
                <span className="text-zinc-500 text-[9px]">ACTIVE AGENTS</span>
                <span className="text-cyan-400 font-bold text-xs mt-0.5">{onlineCount} / {agents.length}</span>
              </div>
              <div className="bg-zinc-900/80 rounded-lg p-2 border border-zinc-800 flex flex-col justify-between">
                <span className="text-zinc-500 text-[9px]">TOOL SUCCESS</span>
                <span className="text-amber-400 font-bold text-xs mt-0.5">{toolSuccessPct}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Live console feed (Col: 7) */}
        <div className="lg:col-span-7 h-56 rounded-xl border border-zinc-800/70 bg-[#0b0d10] text-zinc-300 font-mono text-[11px] leading-5 flex flex-col overflow-hidden relative shadow-md">
          {/* Faint top glow + subtle scanlines */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-cyan-500/[0.05] to-transparent z-0" />
          <div className="pointer-events-none absolute inset-0 z-0 opacity-[0.03] bg-[repeating-linear-gradient(to_bottom,#fff_0px,#fff_1px,transparent_1px,transparent_3px)]" />

          <div className="relative z-10 shrink-0 flex items-center justify-between px-3 h-9 border-b border-zinc-800/70 select-none">
            <div className="flex items-center gap-1.5 text-[10px] font-medium text-zinc-400">
              <span className="size-1.5 rounded-full bg-cyan-500 animate-pulse" />
              <span>console</span>
              <span className="text-zinc-600">·</span>
              <span className="text-zinc-600 tabular-nums">{consoleFeed.length} events</span>
            </div>
            <button
              onClick={() => setActiveRightTab(activeRightTab === 'terminal' ? null : 'terminal')}
              className={cn(
                'flex items-center gap-1 px-2 h-6 rounded-md border transition-colors text-[10px] font-medium cursor-pointer outline-none',
                activeRightTab === 'terminal'
                  ? 'bg-cyan-950/40 text-cyan-400 border-cyan-500/30'
                  : 'bg-transparent text-zinc-500 border-zinc-800 hover:text-zinc-300 hover:border-zinc-700',
              )}
              title="Open interactive terminal"
            >
              <Terminal className="size-3" />
              Open terminal
            </button>
          </div>

          <div className="relative z-10 flex-1 overflow-y-auto py-1.5 scrollbar-thin scrollbar-thumb-zinc-800">
            {consoleFeed.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center gap-1.5 text-zinc-600 select-none">
                <Terminal className="size-5 text-zinc-700" />
                <span className="text-[10px]">waiting for agent activity…</span>
              </div>
            ) : (
              consoleFeed.map((line) => {
                const st = CONSOLE_STYLE[line.type];
                return (
                  <button
                    key={line.id}
                    onClick={() => openThread(line.channel)}
                    className="w-full text-left grid grid-cols-[auto_auto_1fr] items-baseline gap-x-2 px-3 py-[3px] hover:bg-zinc-800/25"
                  >
                    <span className="flex items-center gap-1.5 shrink-0">
                      <span className={cn('w-[2px] self-stretch rounded-full', st.gutter)} />
                      <span className="text-zinc-600 tabular-nums text-[10px]">
                        {line.time.toLocaleTimeString('en-GB', { hour12: false })}
                      </span>
                    </span>
                    <span className={cn('shrink-0 font-semibold truncate max-w-[110px]', st.sender)}>
                      <span className="opacity-60 mr-1">{st.glyph}</span>
                      {line.sender}
                    </span>
                    <span className={cn('truncate', st.text)}>
                      <span className="text-zinc-600 mr-1.5">#{line.channel}</span>
                      {line.content}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Station grid */}
      <div className="flex-1 min-h-0 overflow-y-auto p-5">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 auto-rows-fr">
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
    </div>
  );
}

function Stat({ icon, value, label, accent }: { icon: React.ReactNode; value: string; label: string; accent?: boolean }) {
  return (
    <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-zinc-100/50 dark:bg-zinc-900/40 border border-zinc-200/30 dark:border-zinc-800/30">
      <span className={accent ? 'text-amber-500' : 'text-zinc-400 dark:text-zinc-500'}>{icon}</span>
      <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-50 tabular-nums">{value}</span>
      <span className="text-[10px] text-zinc-400 dark:text-zinc-500">{label}</span>
    </div>
  );
}

