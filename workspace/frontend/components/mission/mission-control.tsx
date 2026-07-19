'use client';

import { useMemo, useState, useEffect } from 'react';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { AgentStation, type StationData, type StationStatus } from './agent-station';
import { Radar, PlusSquare, Activity, Users, Loader2, Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { workspaceApi } from '@/lib/api';
import { eventToMessage } from '@/lib/types';

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
    sessions,
    lastMessageBySession,
    activeSessionIds,
    setCurrentSessionId,
  } = useWorkspace();
  const { setViewMode, setSelectedAgentName, activeRightTab, setActiveRightTab } = useLayout();

  const [hoveredAgent, setHoveredAgent] = useState<string | null>(null);

  const stations = useMemo<StationData[]>(() => {
    const activeThreads = sessions.filter(
      (s) => s.status === 'active' && !s.sessionId.startsWith('routine:'),
    );

    return agents
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
        };
      })
      // Working agents first, then ready, then offline; stable by name within.
      .sort((a, b) => {
        const rank = { working: 0, ready: 1, offline: 2 } as const;
        if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
        return a.agent.agentName.localeCompare(b.agent.agentName);
      });
  }, [agents, sessions, lastMessageBySession, activeSessionIds]);

  const onlineCount = agents.filter((a) => a.status === 'online').length;
  const workingCount = stations.filter((s) => s.status === 'working').length;

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

  // Deterministic agent placement coordinates on the Radar display
  const agentNodes = useMemo(() => {
    return stations.map((s) => {
      let hash = 0;
      for (let i = 0; i < s.agent.agentName.length; i++) {
        hash = s.agent.agentName.charCodeAt(i) + ((hash << 5) - hash);
      }
      const angle = (Math.abs(hash) % 360) * (Math.PI / 180);
      const radiusPercent = 12 + (Math.abs(hash >> 8) % 26); // Between 12% and 38% (falls inside 45px outer circle)

      return {
        agent: s.agent,
        status: s.status,
        focusThread: s.focusThread,
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
          <Stat icon={<Users className="size-3.5" />} value={`${onlineCount}/${agents.length}`} label="online" />
          <Stat
            icon={workingCount > 0 ? <Loader2 className="size-3.5 animate-spin" /> : <Activity className="size-3.5" />}
            value={`${workingCount}`}
            label="working"
            accent={workingCount > 0}
          />
        </div>
      </div>

      {/* 52Hz Sonar Radar & Terminal Console Panel */}
      <div className="shrink-0 grid grid-cols-1 lg:grid-cols-12 gap-4 px-5 py-4 border-b border-zinc-200/60 dark:border-zinc-800/40 bg-zinc-50/60 dark:bg-zinc-950/20 backdrop-blur-xs">
        {/* Radar Graphic display (Col: 5) */}
        <div className="lg:col-span-5 h-56 rounded-xl border border-zinc-200/60 dark:border-zinc-800/60 bg-white/50 dark:bg-zinc-900/40 shadow-xs flex flex-col overflow-hidden relative p-3">
          <div className="absolute top-2.5 left-3 flex items-center gap-1.5 text-[9px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest pointer-events-none select-none">
            <Activity className="size-3 text-cyan-500 animate-pulse" />
            <span>52Hz Sonar Radar Tracker</span>
          </div>

          <div className="flex-1 flex items-center justify-center min-h-0 relative">
            <svg className="w-full max-w-[160px] h-full" viewBox="0 0 100 100">
              <style>{`
                @keyframes radar-sweep {
                  from { transform: rotate(0deg); }
                  to { transform: rotate(360deg); }
                }
              `}</style>
              
              {/* Radar circular guidelines */}
              <circle cx="50" cy="50" r="45" fill="none" stroke="currentColor" className="text-zinc-300/40 dark:text-zinc-800/60" strokeWidth="0.5" />
              <circle cx="50" cy="50" r="30" fill="none" stroke="currentColor" className="text-zinc-300/40 dark:text-zinc-800/60" strokeWidth="0.5" />
              <circle cx="50" cy="50" r="15" fill="none" stroke="currentColor" className="text-zinc-300/40 dark:text-zinc-800/60" strokeWidth="0.5" />
              
              <line x1="5" y1="50" x2="95" y2="50" stroke="currentColor" className="text-zinc-300/40 dark:text-zinc-800/60" strokeWidth="0.5" />
              <line x1="50" y1="5" x2="50" y2="95" stroke="currentColor" className="text-zinc-300/40 dark:text-zinc-800/60" strokeWidth="0.5" />

              {/* Sweep Line */}
              <line 
                x1="50" 
                y1="50" 
                x2="50" 
                y2="5" 
                stroke="url(#radar-sweep)" 
                className="origin-center"
                style={{ animation: 'radar-sweep 6s linear infinite', transformOrigin: '50px 50px' }} 
                strokeWidth="1" 
              />

              <defs>
                <linearGradient id="radar-sweep" x1="0%" y1="100%" x2="0%" y2="0%">
                  <stop offset="0%" stopColor="transparent" />
                  <stop offset="100%" stopColor="var(--color-cyan-500, #06b6d4)" stopOpacity="0.6" />
                </linearGradient>
              </defs>

              {/* Agent Nodes */}
              {agentNodes.map((node) => {
                const isWorking = node.status === 'working';
                const isOffline = node.status === 'offline';
                const colorClass = isWorking 
                  ? 'fill-amber-500 text-amber-500' 
                  : isOffline 
                    ? 'fill-zinc-400 dark:fill-zinc-600 text-zinc-400' 
                    : 'fill-emerald-500 text-emerald-500';

                return (
                  <g 
                    key={node.agent.agentName}
                    className="cursor-pointer"
                    onMouseEnter={() => setHoveredAgent(node.agent.agentName)}
                    onMouseLeave={() => setHoveredAgent(null)}
                    onClick={() => openAgent(node.agent.agentName, !isOffline ? (node.focusThread?.sessionId ?? null) : null)}
                  >
                    {/* Pulsing ripples for working agent representing 52Hz sound waves */}
                    {isWorking && (
                      <>
                        <circle cx={node.x} cy={node.y} r="5" fill="none" stroke="currentColor" className="text-amber-500 animate-ping opacity-75" strokeWidth="0.5" />
                        <circle cx={node.x} cy={node.y} r="9" fill="none" stroke="currentColor" className="text-amber-400 opacity-30 animate-pulse" strokeWidth="0.5" />
                      </>
                    )}

                    {/* Breathing circle for ready state */}
                    {!isWorking && !isOffline && (
                      <circle cx={node.x} cy={node.y} r="4" fill="none" stroke="currentColor" className="text-emerald-400 opacity-35 animate-ping" strokeWidth="0.4" />
                    )}

                    {/* Node central dot */}
                    <circle cx={node.x} cy={node.y} r="2.5" className={`${colorClass} transition-colors duration-300`} />
                    
                    {/* Always visible, crisp, drop-shadowed labels */}
                    <text 
                      x={node.x} 
                      y={node.y + 6.5} 
                      fill="currentColor" 
                      className={cn(
                        'font-mono font-bold select-none pointer-events-none transition-colors duration-200',
                        isWorking ? 'text-amber-500 dark:text-amber-400' :
                        isOffline ? 'text-zinc-500 dark:text-zinc-600' : 'text-zinc-700 dark:text-zinc-300'
                      )}
                      fontSize="4.2" 
                      textAnchor="middle"
                      style={{ textShadow: '0.8px 0.8px 1.5px rgba(0,0,0,0.95), -0.8px -0.8px 1.5px rgba(0,0,0,0.95), 0.8px -0.8px 1.5px rgba(0,0,0,0.95), -0.8px 0.8px 1.5px rgba(0,0,0,0.95)' }}
                    >
                      {node.agent.agentName}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>

          {/* Active Node Info Overlay */}
          <div className="absolute bottom-2.5 left-3 right-3 flex items-center justify-between text-[9px] font-mono bg-zinc-950/85 dark:bg-zinc-900/90 text-zinc-300 border border-zinc-800/85 rounded-lg px-2.5 py-1.5 backdrop-blur-md pointer-events-none select-none">
            {hoveredAgent ? (
              <>
                <span className="text-cyan-400 font-bold">NODE: {hoveredAgent.toUpperCase()}</span>
                <span className="text-zinc-400 flex items-center gap-1">
                  STATUS: 
                  <span className={cn('font-bold tracking-wider', 
                    stations.find(s => s.agent.agentName === hoveredAgent)?.status === 'working' ? 'text-amber-400 animate-pulse' :
                    stations.find(s => s.agent.agentName === hoveredAgent)?.status === 'ready' ? 'text-emerald-400' : 'text-zinc-500'
                  )}>
                    {stations.find(s => s.agent.agentName === hoveredAgent)?.status.toUpperCase()}
                  </span>
                </span>
              </>
            ) : (
              <>
                <span className="text-zinc-500">SYSTEM // MONITOR_ACTIVE</span>
                <span className="text-zinc-500">BANDWIDTH // 52HZ</span>
              </>
            )}
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

