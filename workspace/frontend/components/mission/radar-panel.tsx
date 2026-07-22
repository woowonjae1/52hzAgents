'use client';

import { useMemo, useState, useEffect } from 'react';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { timeAgo } from '@/lib/helpers';
import { cn } from '@/lib/utils';
import { Radar, ChevronLeft, ChevronRight, Hash, Wrench, Radio, Cpu, MessageSquare } from 'lucide-react';
import type { WorkspaceAgent, WorkspaceSession } from '@/lib/types';

type Status = 'working' | 'ready' | 'offline';

interface RadarAgent {
  agent: WorkspaceAgent;
  status: Status;
  threads: WorkspaceSession[];
  focusThread: WorkspaceSession | null;
  activity: { content: string; senderName: string; isStatus?: boolean } | null;
}

const STATUS_COLOR: Record<Status, { dot: string; text: string; node: string }> = {
  working: { dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400', node: 'fill-amber-500 text-amber-500' },
  ready: { dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400', node: 'fill-emerald-500 text-emerald-500' },
  offline: { dot: 'bg-zinc-400 dark:bg-zinc-600', text: 'text-zinc-400 dark:text-zinc-500', node: 'fill-zinc-400 dark:fill-zinc-600 text-zinc-400' },
};

function stripMarkdown(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '[code]').replace(/\*\*/g, '').replace(/`{1,3}/g, '').replace(/\n+/g, ' ').trim();
}

/**
 * RadarPanel — the compact, side-rail form of Mission Control.
 *
 * The full Mission Control dashboard does not fit a narrow right rail, so this
 * shows the sonar radar plus a single-agent focus: pick one agent (via the
 * radar nodes or the selector) and inspect it "one at a time" without leaving
 * the thread you're chatting in.
 */
export function RadarPanel() {
  const { agents, sessions, lastMessageBySession, activeSessionIds, setCurrentSessionId } = useWorkspace();
  const { setViewMode } = useLayout();

  const radarAgents = useMemo<RadarAgent[]>(() => {
    const activeThreads = sessions.filter((s) => s.status === 'active' && !s.sessionId.startsWith('routine:'));
    return agents.map((agent) => {
      const threads = activeThreads
        .filter((s) => s.participants.includes(agent.agentName) || s.master === agent.agentName)
        .sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0));
      const workingThread = threads.find((t) => activeSessionIds.has(t.sessionId)) || null;
      const focusThread = workingThread || threads[0] || null;
      const status: Status = agent.status !== 'online' ? 'offline' : workingThread ? 'working' : 'ready';
      const activity = focusThread ? lastMessageBySession[focusThread.sessionId] || null : null;
      return { agent, status, threads, focusThread, activity };
    });
  }, [agents, sessions, lastMessageBySession, activeSessionIds]);

  const [selected, setSelected] = useState<string | null>(null);
  // Default to the first agent; keep selection valid as agents change.
  useEffect(() => {
    if (radarAgents.length === 0) { setSelected(null); return; }
    if (!selected || !radarAgents.some((r) => r.agent.agentName === selected)) {
      setSelected(radarAgents[0].agent.agentName);
    }
  }, [radarAgents, selected]);

  const nodes = useMemo(() => {
    const total = radarAgents.length;
    return radarAgents.map((r, index) => {
      const angle = (index / Math.max(1, total)) * 2 * Math.PI - Math.PI / 2;
      const radius = r.status === 'offline' ? 40 : (index % 2 === 0 ? 22 : 35);
      return { ...r, x: 50 + radius * Math.cos(angle), y: 50 + radius * Math.sin(angle) };
    });
  }, [radarAgents]);

  const current = radarAgents.find((r) => r.agent.agentName === selected) || null;
  const currentIdx = radarAgents.findIndex((r) => r.agent.agentName === selected);
  const cycle = (dir: -1 | 1) => {
    if (radarAgents.length === 0) return;
    const next = (currentIdx + dir + radarAgents.length) % radarAgents.length;
    setSelected(radarAgents[next].agent.agentName);
  };

  const openThread = (sessionId: string) => {
    setViewMode('threads');
    setCurrentSessionId(sessionId);
  };

  if (agents.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6 bg-card">
        <Radar className="size-8 text-zinc-300 dark:text-zinc-700 mb-3" />
        <p className="text-sm text-zinc-500 dark:text-zinc-400">No agents to track yet.</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-card overflow-hidden">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-2 pl-4 pr-12 h-11 border-b border-zinc-100 dark:border-zinc-800/60">
        <Radar className="size-4 text-cyan-500" />
        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Sonar Radar</span>
        <span className="text-[11px] text-zinc-400 dark:text-zinc-500 ml-auto tabular-nums">{radarAgents.length} nodes</span>
      </div>

      {/* Radar */}
      <div className="shrink-0 px-4 pt-4 pb-2">
        <div className="relative mx-auto w-full max-w-[220px] aspect-square rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden shadow-md">
          {/* Ambient Glow */}
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(6,182,212,0.12),transparent_70%)] pointer-events-none" />
          
          <svg className="w-full h-full" viewBox="0 0 100 100">
            <style>{`
              @keyframes radar-sweep-panel { from { transform: rotate(0deg);} to { transform: rotate(360deg);} }
              @keyframes sonar-wave-p1 { 0% { r: 2px; opacity: 0.8; } 100% { r: 45px; opacity: 0; } }
              @keyframes sonar-wave-p2 { 0% { r: 2px; opacity: 0.8; } 100% { r: 45px; opacity: 0; } }
            `}</style>
            
            {/* Sonar Expanding Waves */}
            <circle cx="50" cy="50" fill="none" stroke="#06b6d4" strokeWidth="0.4" style={{ animation: 'sonar-wave-p1 4s cubic-bezier(0, 0.2, 0.8, 1) infinite' }} />
            <circle cx="50" cy="50" fill="none" stroke="#06b6d4" strokeWidth="0.4" style={{ animation: 'sonar-wave-p2 4s cubic-bezier(0, 0.2, 0.8, 1) infinite 2s' }} />

            {/* Radar Guidelines */}
            {[45, 30, 15].map((r) => (
              <circle key={r} cx="50" cy="50" r={r} fill="none" stroke="rgba(6,182,212,0.15)" strokeWidth="0.5" strokeDasharray={r === 45 ? '3 3' : 'none'} />
            ))}
            <line x1="5" y1="50" x2="95" y2="50" stroke="rgba(6,182,212,0.15)" strokeWidth="0.5" />
            <line x1="50" y1="5" x2="50" y2="95" stroke="rgba(6,182,212,0.15)" strokeWidth="0.5" />

            {/* Laser lines */}
            {nodes.map((n) => (
              <line
                key={`line-p-${n.agent.agentName}`}
                x1="50"
                y1="50"
                x2={n.x}
                y2={n.y}
                stroke={n.status === 'working' ? '#f59e0b' : n.status === 'offline' ? 'rgba(255,255,255,0.12)' : '#10b981'}
                strokeWidth={n.agent.agentName === selected ? '1.2' : '0.6'}
                opacity={n.status === 'offline' ? 0.3 : 0.6}
              />
            ))}

            {/* Rotating Fan Sector */}
            <g style={{ transformOrigin: '50px 50px', animation: 'radar-sweep-panel 5s linear infinite' }}>
              <path d="M 50 50 L 50 5 A 45 45 0 0 1 72.5 10.9 Z" fill="url(#radar-panel-fan)" />
              <line x1="50" y1="50" x2="50" y2="5" stroke="#06b6d4" strokeWidth="1.2" />
            </g>
            <defs>
              <linearGradient id="radar-panel-fan" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.4" />
                <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.02" />
              </linearGradient>
            </defs>

            {/* Central Node Hub */}
            <circle cx="50" cy="50" r="2.5" fill="#06b6d4" className="animate-pulse" />
          </svg>

          {/* HTML Pinned Collision-Free Node Dots */}
          {nodes.map((n) => {
            const isSel = n.agent.agentName === selected;
            const isWorking = n.status === 'working';
            const isOffline = n.status === 'offline';

            return (
              <div
                key={n.agent.agentName}
                style={{ left: `${n.x}%`, top: `${n.y}%` }}
                className="absolute -translate-x-1/2 -translate-y-1/2 z-20 cursor-pointer group/node"
                onClick={() => setSelected(n.agent.agentName)}
              >
                {isWorking && (
                  <span className="absolute -inset-1.5 rounded-full bg-amber-500/50 animate-ping" />
                )}

                <div className="relative flex flex-col items-center">
                  <div
                    className={cn(
                      'size-3 rounded-full border-2 transition-all duration-200 shadow-md',
                      isWorking
                        ? 'bg-amber-400 border-amber-300 shadow-[0_0_8px_#f59e0b]'
                        : isOffline
                        ? 'bg-zinc-600 border-zinc-500 opacity-60'
                        : 'bg-emerald-400 border-emerald-300 shadow-[0_0_8px_#10b981]',
                      isSel && 'scale-150 ring-4 ring-cyan-400/40 z-30'
                    )}
                  />

                  <span
                    className={cn(
                      'text-[9px] font-mono font-semibold tracking-tight transition-all mt-0.5 select-none pointer-events-none px-1 rounded bg-zinc-950/80 backdrop-blur-xs',
                      isWorking ? 'text-amber-400' : isOffline ? 'text-zinc-500' : 'text-zinc-300',
                      isSel && 'text-cyan-300 font-bold scale-110'
                    )}
                  >
                    {n.agent.agentName}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Selector — one agent at a time */}
      <div className="shrink-0 flex items-center gap-1.5 px-3 py-2 border-y border-zinc-100 dark:border-zinc-800/60">
        <button onClick={() => cycle(-1)} className="size-7 flex items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 shrink-0" title="Previous agent">
          <ChevronLeft className="size-4" />
        </button>
        <div className="flex-1 flex items-center gap-1.5 overflow-x-auto scrollbar-thin px-0.5 py-0.5">
          {radarAgents.map((r) => {
            const isSel = r.agent.agentName === selected;
            return (
              <button
                key={r.agent.agentName}
                onClick={() => setSelected(r.agent.agentName)}
                className={cn(
                  'flex items-center gap-1.5 px-2 h-7 rounded-full border text-[11px] font-medium whitespace-nowrap transition-colors shrink-0',
                  isSel
                    ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 border-transparent'
                    : 'bg-transparent text-zinc-500 dark:text-zinc-400 border-zinc-200 dark:border-zinc-800 hover:text-zinc-900 dark:hover:text-zinc-100',
                )}
              >
                <span className={cn('size-1.5 rounded-full', STATUS_COLOR[r.status].dot)} />
                {r.agent.agentName}
              </button>
            );
          })}
        </div>
        <button onClick={() => cycle(1)} className="size-7 flex items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800/60 shrink-0" title="Next agent">
          <ChevronRight className="size-4" />
        </button>
      </div>

      {/* Focused single agent */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {current ? (
          <div className="space-y-3">
            {/* Identity */}
            <div className="flex items-center gap-3">
              <AgentAvatar name={current.agent.agentName} size={40} status={current.agent.status} showStatus />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-50 truncate">{current.agent.agentName}</div>
                <div className="flex items-center gap-2 mt-0.5">
                  {current.agent.agentType && (
                    <span className="text-[10px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">{current.agent.agentType}</span>
                  )}
                  <span className={cn('flex items-center gap-1 text-[10px] font-semibold', STATUS_COLOR[current.status].text)}>
                    <span className={cn('size-1.5 rounded-full', STATUS_COLOR[current.status].dot, current.status === 'working' && 'animate-pulse')} />
                    {current.status === 'working' ? 'Working' : current.status === 'ready' ? 'Ready' : 'Offline'}
                  </span>
                </div>
              </div>
            </div>

            {/* Current activity */}
            <div className={cn('rounded-lg px-3 py-2.5 flex items-start gap-2 text-xs border', current.status === 'working' ? 'bg-amber-50/70 dark:bg-amber-950/20 border-amber-500/10' : 'bg-zinc-50 dark:bg-zinc-900/40 border-zinc-100/60 dark:border-zinc-800/40')}>
              {current.status === 'working' ? <Wrench className="size-3.5 shrink-0 mt-0.5 text-amber-500 animate-pulse" /> : current.status === 'ready' ? <Radio className="size-3.5 shrink-0 mt-0.5 text-emerald-500" /> : <Cpu className="size-3.5 shrink-0 mt-0.5 text-zinc-400" />}
              {current.activity ? (
                <p className={cn('line-clamp-3 min-w-0', current.status === 'working' ? 'text-amber-700 dark:text-amber-300 italic' : 'text-zinc-600 dark:text-zinc-300')}>
                  {stripMarkdown(current.activity.content).slice(0, 240) || 'Idle'}
                </p>
              ) : (
                <p className="text-zinc-400 dark:text-zinc-500">{current.status === 'offline' ? 'Agent is offline' : 'Standby — awaiting task'}</p>
              )}
            </div>

            {/* Threads */}
            <div>
              <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-400 dark:text-zinc-500 mb-1.5">
                <MessageSquare className="size-3" /> Threads · {current.threads.length}
              </div>
              {current.threads.length === 0 ? (
                <p className="text-[11px] text-zinc-400 dark:text-zinc-600">No threads yet</p>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {current.threads.map((t) => (
                    <button
                      key={t.sessionId}
                      onClick={() => openThread(t.sessionId)}
                      className="flex items-center gap-1.5 px-2 py-1.5 -mx-1 rounded-md hover:bg-zinc-100/70 dark:hover:bg-zinc-800/40 transition-colors text-left"
                    >
                      <Hash className="size-3 shrink-0 text-zinc-300 dark:text-zinc-600" />
                      <span className="text-xs text-zinc-600 dark:text-zinc-300 truncate flex-1">{t.title || 'Untitled'}</span>
                      {t.lastEventAt && <span className="text-[9px] text-zinc-400 dark:text-zinc-600 shrink-0">{timeAgo(new Date(t.lastEventAt).toISOString())}</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
