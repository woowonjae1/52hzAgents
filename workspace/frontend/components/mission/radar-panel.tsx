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
    return radarAgents.map((r) => {
      let hash = 0;
      for (let i = 0; i < r.agent.agentName.length; i++) hash = r.agent.agentName.charCodeAt(i) + ((hash << 5) - hash);
      const angle = (Math.abs(hash) % 360) * (Math.PI / 180);
      const radius = 14 + (Math.abs(hash >> 8) % 26);
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
      <div className="shrink-0 flex items-center gap-2 px-4 h-11 border-b border-zinc-100 dark:border-zinc-800/60">
        <Radar className="size-4 text-cyan-500" />
        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">Sonar Radar</span>
        <span className="text-[11px] text-zinc-400 dark:text-zinc-500 ml-auto tabular-nums">{radarAgents.length} nodes</span>
      </div>

      {/* Radar */}
      <div className="shrink-0 px-4 pt-4 pb-2">
        <div className="relative mx-auto w-full max-w-[220px] aspect-square rounded-xl border border-zinc-200/60 dark:border-zinc-800/60 bg-white/50 dark:bg-zinc-900/40 overflow-hidden">
          <svg className="w-full h-full" viewBox="0 0 100 100">
            <style>{`@keyframes radar-sweep-panel { from { transform: rotate(0deg);} to { transform: rotate(360deg);} }`}</style>
            {[45, 30, 15].map((r) => (
              <circle key={r} cx="50" cy="50" r={r} fill="none" stroke="currentColor" className="text-zinc-300/40 dark:text-zinc-800/60" strokeWidth="0.5" />
            ))}
            <line x1="5" y1="50" x2="95" y2="50" stroke="currentColor" className="text-zinc-300/40 dark:text-zinc-800/60" strokeWidth="0.5" />
            <line x1="50" y1="5" x2="50" y2="95" stroke="currentColor" className="text-zinc-300/40 dark:text-zinc-800/60" strokeWidth="0.5" />
            <line x1="50" y1="50" x2="50" y2="5" stroke="url(#radar-panel-grad)" style={{ animation: 'radar-sweep-panel 6s linear infinite', transformOrigin: '50px 50px' }} strokeWidth="1" />
            <defs>
              <linearGradient id="radar-panel-grad" x1="0%" y1="100%" x2="0%" y2="0%">
                <stop offset="0%" stopColor="transparent" />
                <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.6" />
              </linearGradient>
            </defs>
            {nodes.map((n) => {
              const isSel = n.agent.agentName === selected;
              const col = STATUS_COLOR[n.status];
              return (
                <g key={n.agent.agentName} className="cursor-pointer" onClick={() => setSelected(n.agent.agentName)}>
                  {n.status === 'working' && (
                    <circle cx={n.x} cy={n.y} r="5" fill="none" stroke="currentColor" className="text-amber-500 animate-ping opacity-70" strokeWidth="0.5" />
                  )}
                  {isSel && (
                    <circle cx={n.x} cy={n.y} r="6" fill="none" stroke="currentColor" className="text-cyan-500" strokeWidth="0.8" />
                  )}
                  <circle cx={n.x} cy={n.y} r={isSel ? 3 : 2.4} className={cn(col.node, 'transition-all')} />
                </g>
              );
            })}
          </svg>
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
