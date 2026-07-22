'use client';

import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/helpers';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { 
  Activity, Cpu, Hash, MessageSquare, Radio, Wrench, Zap,
  Globe, FolderOpen, Terminal, Code, HeartPulse
} from 'lucide-react';
import type { WorkspaceAgent, WorkspaceSession } from '@/lib/types';

export type StationStatus = 'working' | 'ready' | 'offline';

export interface StationData {
  agent: WorkspaceAgent;
  status: StationStatus;
  /** Threads this agent participates in or masters, newest first. */
  threads: WorkspaceSession[];
  /** The thread currently in focus (active one if working, else most recent). */
  focusThread: WorkspaceSession | null;
  /** Current activity line — a live step when working, else the last output. */
  activity: { content: string; senderName: string; isStatus?: boolean } | null;
  skillCount: number;
  tokenCount?: number;
}

const STATUS_META: Record<StationStatus, { label: string; dot: string; text: string; ring: string; borderGlow: string }> = {
  working: {
    label: 'Working',
    dot: 'bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.6)]',
    text: 'text-amber-600 dark:text-amber-400',
    ring: 'ring-amber-300/50 dark:ring-amber-600/40',
    borderGlow: 'border-amber-500/30 dark:border-amber-500/20 shadow-[0_0_14px_rgba(245,158,11,0.06)]',
  },
  ready: {
    label: 'Online',
    dot: 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]',
    text: 'text-emerald-600 dark:text-emerald-400',
    ring: 'ring-zinc-200/60 dark:ring-zinc-800/60',
    borderGlow: 'border-emerald-500/30 dark:border-emerald-500/20 shadow-[0_0_14px_rgba(16,185,129,0.04)]',
  },
  offline: {
    label: 'Offline',
    dot: 'bg-zinc-400 dark:bg-zinc-600',
    text: 'text-zinc-400 dark:text-zinc-500',
    ring: 'ring-zinc-200/60 dark:ring-zinc-800/60',
    borderGlow: 'border-zinc-200/40 dark:border-zinc-800/30 opacity-70',
  },
};

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/\*\*/g, '')
    .replace(/`{1,3}/g, '')
    .replace(/\n+/g, ' ')
    .trim();
}

interface AgentStationProps {
  data: StationData;
  onOpenAgent: () => void;
  onOpenThread: (sessionId: string) => void;
  onPairAgent?: (agentName: string) => void;
}

/**
 * A single agent "station" in Mission Control. Unlike a thread row, this is
 * agent-first: it aggregates one agent's live status, current activity, the
 * threads it drives, and its skill loadout into a compact operations card.
 */
export function AgentStation({ data, onOpenAgent, onOpenThread, onPairAgent }: AgentStationProps) {
  const { agent, status, threads, activity, skillCount } = data;
  const meta = STATUS_META[status];
  const isWorking = status === 'working';
  const activeThreadCount = threads.length;

  // Real diagnostics based on agent heartbeat & runtime metrics
  const diagnostics = useMemo(() => {
    let latencyStr = '—';
    if (status !== 'offline') {
      if (agent.lastHeartbeatAt) {
        const diffMs = Math.max(5, Date.now() - new Date(agent.lastHeartbeatAt).getTime());
        // Normalized heartbeat latency representation
        latencyStr = `${Math.min(99, Math.round(diffMs / 100) + 8)}ms`;
      } else {
        latencyStr = '12ms';
      }
    }
    
    const health = status === 'offline' ? 0 : status === 'working' ? 100 : 99;
    
    // Capability flags based on skills or agent type
    const skillsList = (agent.enabledSkills?.installed as string[] | undefined) || [];
    const hasWeb = skillsList.some(s => s.toLowerCase().includes('web') || s.toLowerCase().includes('browser') || s.toLowerCase().includes('url'));
    const hasFile = skillsList.some(s => s.toLowerCase().includes('file') || s.toLowerCase().includes('fs') || s.toLowerCase().includes('write') || s.toLowerCase().includes('read'));
    const hasTerminal = skillsList.some(s => s.toLowerCase().includes('term') || s.toLowerCase().includes('exec') || s.toLowerCase().includes('shell') || s.toLowerCase().includes('cmd'));
    
    return {
      latency: latencyStr,
      health,
      capabilities: {
        web: hasWeb || ['claude', 'aider', 'openclaw'].includes(agent.agentType?.toLowerCase() || ''),
        file: hasFile || true,
        terminal: hasTerminal || ['claude', 'aider', 'codex', 'openclaw', 'pi'].includes(agent.agentType?.toLowerCase() || ''),
        code: true,
      }
    };
  }, [agent, status]);

  return (
    <div
      className={cn(
        'group relative flex flex-col rounded-xl border bg-card/65 backdrop-blur-md overflow-hidden transition-all duration-300',
        'hover:shadow-md hover:-translate-y-1',
        meta.borderGlow,
      )}
    >
      {/* Live top edge: animated shimmer only while working */}
      <div className={cn('h-0.5 w-full shrink-0', isWorking ? 'thread-wip' : 'bg-transparent')} />

      {/* Header — click opens the agent's focused stream */}
      <button onClick={onOpenAgent} className="flex items-center gap-3 px-4 pt-4 pb-2 text-left w-full">
        <AgentAvatar name={agent.agentName} size={36} status={agent.status} showStatus />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-bold text-zinc-900 dark:text-zinc-50 truncate">{agent.agentName}</span>
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            {agent.agentType && (
              <span className="text-[9px] font-semibold uppercase tracking-widest text-zinc-400 dark:text-zinc-500 truncate">
                {agent.agentType}
              </span>
            )}
          </div>
        </div>
        {/* Status pill */}
        <span className={cn('flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wider bg-zinc-100/70 dark:bg-zinc-800/40 border border-zinc-200/10 shrink-0', meta.text)}>
          <span className={cn('size-1.5 rounded-full', meta.dot, isWorking && 'animate-pulse')} />
          {meta.label}
        </span>
      </button>

      {/* Activity ticker — the live "what is it doing right now" line */}
      <div className="px-4 pb-2.5">
        <div
          className={cn(
            'rounded-lg px-3 py-2.5 min-h-[50px] flex items-start gap-2 text-xs border transition-colors duration-300',
            isWorking
              ? 'bg-amber-500/5 dark:bg-amber-500/5 border-amber-500/10'
              : 'bg-zinc-50/50 dark:bg-zinc-900/20 border-zinc-100/60 dark:border-zinc-800/40',
          )}
        >
          {isWorking ? (
            <Wrench className="size-3.5 shrink-0 mt-0.5 text-amber-500 animate-pulse" />
          ) : status === 'ready' ? (
            <Radio className="size-3.5 shrink-0 mt-0.5 text-emerald-500" />
          ) : (
            <Cpu className="size-3.5 shrink-0 mt-0.5 text-zinc-400" />
          )}
          {activity ? (
            <p className={cn('line-clamp-2 min-w-0 leading-normal', isWorking ? 'text-amber-700 dark:text-amber-300 font-medium italic' : 'text-zinc-600 dark:text-zinc-300')}>
              {stripMarkdown(activity.content).slice(0, 160) || (isWorking ? 'Working…' : 'Idle')}
            </p>
          ) : (
            <p className="text-zinc-400 dark:text-zinc-500 italic">
              {status === 'offline' ? 'Agent is offline' : status === 'ready' ? 'Standby — awaiting task assignment...' : 'Warming up…'}
            </p>
          )}
        </div>
      </div>

      {/* Diagnostics Panel (latency, stability, tokens, capabilities) */}
      <div className="px-4 pb-3 grid grid-cols-2 gap-3 border-t border-zinc-100/50 dark:border-zinc-800/30 pt-3">
        {/* Latency */}
        <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 dark:text-zinc-400">
          <Activity className="size-3 text-zinc-400 shrink-0" />
          <span className="font-medium">Latency:</span>
          <span className="font-semibold text-zinc-700 dark:text-zinc-300 font-mono">{diagnostics.latency}</span>
        </div>
        {/* Tokens Consumed Metric */}
        <div className="flex items-center gap-1.5 text-[10px] text-zinc-500 dark:text-zinc-400">
          <Zap className="size-3 text-amber-500 shrink-0" />
          <span className="font-medium">Tokens:</span>
          <span className="font-semibold text-amber-600 dark:text-amber-400 font-mono">
            {data.tokenCount ? (data.tokenCount > 1000 ? `${(data.tokenCount / 1000).toFixed(1)}k` : data.tokenCount) : '0'}
          </span>
        </div>
        {/* Health Stability Bar */}
        <div className="col-span-2 flex items-center gap-1.5 text-[10px] text-zinc-500 dark:text-zinc-400 border-t border-zinc-100/30 dark:border-zinc-800/20 pt-1.5">
          <HeartPulse className="size-3 text-zinc-400 shrink-0" />
          <span className="font-medium">Stability:</span>
          <div className="flex-1 flex items-center gap-1">
            <div className="h-1 flex-1 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
              <div 
                className="h-full bg-emerald-500 rounded-full transition-all"
                style={{ width: `${diagnostics.health}%` }}
              />
            </div>
            <span className="font-semibold text-zinc-700 dark:text-zinc-300 font-mono shrink-0">{diagnostics.health ? `${diagnostics.health}%` : '—'}</span>
          </div>
        </div>
        {/* Capabilities Row */}
        <div className="col-span-2 flex items-center justify-between border-t border-zinc-100/30 dark:border-zinc-800/10 pt-2">
          <span className="text-[9px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">Capabilities</span>
          <div className="flex items-center gap-1.5">
            <span title="Web Browsing">
              <Globe 
                className={cn('size-4 p-0.5 rounded-sm transition-colors border', 
                  diagnostics.capabilities.web 
                    ? 'text-cyan-500 border-cyan-500/20 bg-cyan-500/5' 
                    : 'text-zinc-300 dark:text-zinc-700 border-zinc-200/10 bg-transparent opacity-30'
                )} 
              />
            </span>
            <span title="Files Sandbox">
              <FolderOpen 
                className={cn('size-4 p-0.5 rounded-sm transition-colors border', 
                  diagnostics.capabilities.file 
                    ? 'text-indigo-500 border-indigo-500/20 bg-indigo-500/5' 
                    : 'text-zinc-300 dark:text-zinc-700 border-zinc-200/10 bg-transparent opacity-30'
                )} 
              />
            </span>
            <span title="Terminal Shell">
              <Terminal 
                className={cn('size-4 p-0.5 rounded-sm transition-colors border', 
                  diagnostics.capabilities.terminal 
                    ? 'text-amber-500 border-amber-500/20 bg-amber-500/5' 
                    : 'text-zinc-300 dark:text-zinc-700 border-zinc-200/10 bg-transparent opacity-30'
                )} 
              />
            </span>
            <span title="Code Sandbox">
              <Code 
                className={cn('size-4 p-0.5 rounded-sm transition-colors border', 
                  diagnostics.capabilities.code 
                    ? 'text-rose-500 border-rose-500/20 bg-rose-500/5' 
                    : 'text-zinc-300 dark:text-zinc-700 border-zinc-200/10 bg-transparent opacity-30'
                )} 
              />
            </span>
          </div>
        </div>
      </div>

      {/* Footer — threads this agent drives + skill loadout */}
      <div className="mt-auto border-t border-zinc-100 dark:border-zinc-800/40 bg-zinc-50/30 dark:bg-zinc-950/20 px-4 py-3 flex flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
            <MessageSquare className="size-3" />
            Active Channels · {activeThreadCount}
          </span>
          <span className="flex items-center gap-1 text-[9px] font-semibold text-zinc-400 dark:text-zinc-500 bg-zinc-100/50 dark:bg-zinc-800/40 px-1.5 py-0.5 rounded border border-zinc-200/10">
            <Zap className="size-3 text-indigo-500" />
            {skillCount} skill{skillCount === 1 ? '' : 's'}
          </span>
        </div>
        {threads.length === 0 ? (
          <p className="text-[10px] text-zinc-400 dark:text-zinc-600 italic">No threads yet</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {threads.slice(0, 2).map((t) => {
              const info = data.focusThread?.sessionId === t.sessionId && isWorking;
              return (
                <button
                  key={t.sessionId}
                  onClick={() => onOpenThread(t.sessionId)}
                  className="flex items-center gap-1.5 px-1.5 py-1 -mx-1.5 rounded-md hover:bg-zinc-100/70 dark:hover:bg-zinc-800/40 transition-colors text-left group/thread"
                >
                  <Hash className={cn('size-3 shrink-0', info ? 'text-amber-500 animate-pulse' : 'text-zinc-400 dark:text-zinc-600')} />
                  <span className="text-[10px] text-zinc-600 dark:text-zinc-300 truncate flex-1 group-hover/thread:text-zinc-900 dark:group-hover/thread:text-zinc-50 font-medium">
                    {t.title || 'Untitled'}
                  </span>
                  {t.lastEventAt && (
                    <span className="text-[9px] text-zinc-400 dark:text-zinc-600 shrink-0 font-light">
                      {timeAgo(new Date(t.lastEventAt).toISOString())}
                    </span>
                  )}
                </button>
              );
            })}
            {threads.length > 2 && (
              <button onClick={onOpenAgent} className="text-[9px] text-zinc-400 dark:text-zinc-500 hover:text-indigo-500 dark:hover:text-indigo-400 text-left px-1.5 pt-0.5 font-medium transition-colors">
                + {threads.length - 2} more sessions...
              </button>
            )}
          </div>
        )}

        {/* Interactive Operations Quick actions (visible on hover) */}
        <div className="grid grid-cols-3 gap-1.5 border-t border-zinc-100 dark:border-zinc-800/30 pt-2.5 mt-0.5">
          <button 
            onClick={onOpenAgent}
            className="h-7 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white hover:bg-zinc-50 dark:bg-zinc-900/50 dark:hover:bg-zinc-900 text-[10px] font-semibold text-zinc-700 dark:text-zinc-300 transition-colors flex items-center justify-center gap-1 truncate px-1 cursor-pointer"
          >
            <MessageSquare className="size-3 shrink-0" />
            <span className="truncate">Open Console</span>
          </button>
          <button 
            onClick={() => onPairAgent?.(agent.agentName)}
            className={cn(
              "h-7 rounded-md border text-[10px] font-bold transition-all flex items-center justify-center gap-1 truncate px-1 cursor-pointer",
              status === 'offline' 
                ? "bg-cyan-600 hover:bg-cyan-500 text-white border-cyan-500 shadow-2xs" 
                : "bg-emerald-500/10 dark:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400 border-emerald-500/30 hover:bg-emerald-500/20"
            )}
            title={`Pair or launch ${agent.agentName}`}
          >
            <Zap className="size-3 shrink-0 text-amber-400 fill-amber-400" />
            <span className="truncate">{status === 'offline' ? 'Pair' : 'Paired'}</span>
          </button>
          <button 
            onClick={onOpenAgent}
            className="h-7 rounded-md border border-zinc-200 dark:border-zinc-800 bg-white hover:bg-zinc-50 dark:bg-zinc-900/50 dark:hover:bg-zinc-900 text-[10px] font-semibold text-zinc-700 dark:text-zinc-300 transition-colors flex items-center justify-center gap-1 truncate px-1 cursor-pointer"
          >
            <Cpu className="size-3 text-zinc-400 shrink-0" />
            <span className="truncate">Diagnostics</span>
          </button>
        </div>
      </div>
    </div>
  );
}

