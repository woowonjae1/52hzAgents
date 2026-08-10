'use client';

import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/helpers';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { Cpu, Hash, MessageSquare, Radio, Wrench, Zap } from 'lucide-react';
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

const STATUS_META: Record<StationStatus, { label: string; dot: string; text: string; border: string }> = {
  working: {
    label: 'Working',
    dot: 'bg-status-warning',
    text: 'text-status-warning',
    border: 'border-status-warning/30',
  },
  ready: {
    label: 'Online',
    dot: 'bg-status-success',
    text: 'text-status-success',
    border: 'border-border',
  },
  offline: {
    label: 'Offline',
    dot: 'bg-foreground-extra-muted',
    text: 'text-foreground-extra-muted',
    border: 'border-border opacity-75',
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

function fmtTokens(n: number): string {
  return n > 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

interface AgentStationProps {
  data: StationData;
  onOpenAgent: () => void;
  onOpenThread: (sessionId: string) => void;
  onPairAgent?: () => void;
}

/**
 * A single agent card in the Overview. Agent-first: it aggregates one agent's
 * real status, current activity, the threads it drives, and its skill loadout.
 * Only real data is shown — no synthetic latency or health metrics.
 */
export function AgentStation({ data, onOpenAgent, onOpenThread, onPairAgent }: AgentStationProps) {
  const { agent, status, threads, activity, skillCount, tokenCount } = data;
  const meta = STATUS_META[status];
  const isWorking = status === 'working';
  const activeThreadCount = threads.length;

  return (
    <div
      className={cn(
        'group relative flex flex-col rounded-xl border bg-card overflow-hidden transition-colors',
        'hover:border-border-accent',
        meta.border,
      )}
    >
      {/* Live top edge: subtle shimmer only while working */}
      <div className={cn('h-0.5 w-full shrink-0', isWorking ? 'thread-wip' : 'bg-transparent')} />

      {/* Header — click opens the agent's focused stream */}
      <button onClick={onOpenAgent} className="flex items-center gap-3 px-4 pt-4 pb-2 text-left w-full">
        <AgentAvatar name={agent.agentName} agentType={agent.agentType} size={36} status={agent.status} showStatus />
        <div className="flex-1 min-w-0">
          <span className="text-sm font-semibold text-foreground truncate block">{agent.agentName}</span>
          {agent.agentType && (
            <span className="text-[11px] font-semibold text-foreground-extra-muted truncate block mt-0.5">
              {agent.agentType}
            </span>
          )}
        </div>
        {/* Status pill */}
        <span className={cn('flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-surface2/60 shrink-0', meta.text)}>
          <span className={cn('size-1.5 rounded-full', meta.dot, isWorking && 'animate-pulse')} />
          {meta.label}
        </span>
      </button>

      {/* Activity ticker — the live "what is it doing right now" line */}
      <div className="px-4 pb-3">
        <div
          className={cn(
            'rounded-lg px-3 py-2.5 min-h-[50px] flex items-start gap-2 text-xs border transition-colors',
            isWorking
              ? 'bg-status-warning/5 border-status-warning/15'
              : 'bg-surface1/30 border-border/50',
          )}
        >
          {isWorking ? (
            <Wrench className="size-3.5 shrink-0 mt-0.5 text-status-warning" />
          ) : status === 'ready' ? (
            <Radio className="size-3.5 shrink-0 mt-0.5 text-status-success" />
          ) : (
            <Cpu className="size-3.5 shrink-0 mt-0.5 text-foreground-extra-muted" />
          )}
          {activity ? (
            <p className={cn('line-clamp-2 min-w-0 leading-normal', isWorking ? 'text-status-warning font-medium' : 'text-foreground-muted')}>
              {stripMarkdown(activity.content).slice(0, 160) || (isWorking ? 'Working…' : 'Idle')}
            </p>
          ) : (
            <p className="text-foreground-extra-muted">
              {status === 'offline' ? 'Agent is offline' : status === 'ready' ? 'Standby — awaiting a task' : 'Warming up…'}
            </p>
          )}
        </div>
      </div>

      {/* Footer — threads this agent drives + skill/token summary */}
      <div className="mt-auto border-t border-border/50 bg-surface1/40 px-4 py-3 flex flex-col gap-2.5">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1 text-[11px] font-semibold text-foreground-extra-muted">
            <MessageSquare className="size-3" />
            Threads · {activeThreadCount}
          </span>
          <div className="flex items-center gap-2 text-[9px] font-semibold text-foreground-extra-muted">
            <span className="flex items-center gap-1">
              <Zap className="size-3" />
              {skillCount} skill{skillCount === 1 ? '' : 's'}
            </span>
            {tokenCount ? (
              <span className="tabular-nums" title="Tokens this agent reported in recent messages">{fmtTokens(tokenCount)} tok</span>
            ) : null}
          </div>
        </div>
        {threads.length === 0 ? (
          <p className="text-[10px] text-foreground-extra-muted">No threads yet</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {threads.slice(0, 2).map((t) => {
              const live = data.focusThread?.sessionId === t.sessionId && isWorking;
              return (
                <button
                  key={t.sessionId}
                  onClick={() => onOpenThread(t.sessionId)}
                  className="flex items-center gap-1.5 px-1.5 py-1 -mx-1.5 rounded-md hover:bg-surface2/40 transition-colors text-left group/thread"
                >
                  <Hash className={cn('size-3 shrink-0', live ? 'text-status-warning' : 'text-foreground-extra-muted')} />
                  <span className="text-[10px] text-foreground-muted truncate flex-1 group-hover/thread:text-foreground dark:group-hover/thread:text-primary-foreground font-medium">
                    {t.title || 'Untitled'}
                  </span>
                  {t.lastEventAt && (
                    <span className="text-[9px] text-foreground-extra-muted shrink-0">
                      {timeAgo(new Date(t.lastEventAt).toISOString())}
                    </span>
                  )}
                </button>
              );
            })}
            {threads.length > 2 && (
              <button onClick={onOpenAgent} className="text-[9px] text-foreground-extra-muted hover:text-foreground-muted text-left px-1.5 pt-0.5 font-medium transition-colors">
                + {threads.length - 2} more thread{threads.length - 2 === 1 ? '' : 's'}
              </button>
            )}
          </div>
        )}

        {/* Quick actions */}
        <div className="grid grid-cols-2 gap-1.5 border-t border-border/60/40 pt-2.5 mt-0.5">
          <button
            onClick={onOpenAgent}
            className="h-7 rounded-md border border-border bg-surface2 hover:bg-surface3 text-[10px] font-semibold text-foreground transition-colors flex items-center justify-center gap-1 truncate px-1 cursor-pointer"
          >
            <MessageSquare className="size-3 shrink-0 text-foreground-muted" />
            <span className="truncate">Open</span>
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onPairAgent?.();
            }}
            disabled={status !== 'offline'}
            className={cn(
              'h-7 rounded-md border text-[10px] font-semibold transition-colors flex items-center justify-center gap-1 truncate px-1',
              status === 'offline'
                ? 'bg-primary text-primary-foreground border-primary hover:bg-primary/90 cursor-pointer'
                : 'bg-transparent text-status-success border-status-success/30 cursor-default',
            )}
            title={status === 'offline' ? `Launch or pair ${agent.agentName}` : `${agent.agentName} is connected`}
          >
            <span className="truncate">{status === 'offline' ? 'Connect' : 'Connected'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
