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
  /**
   * True when this card is a catalog entry the workspace has no agent for yet —
   * an offer to connect, not a real agent. Distinguishes the `custom` offer from
   * an actual agent someone happened to name "custom".
   */
  isCatalogPlaceholder?: boolean;
}

/**
 * Status is the only place colour is allowed in this surface: everything else
 * is the neutral surface/foreground token ramp, so a single amber or emerald dot reads
 * as a signal instead of decoration.
 */
const STATUS_META: Record<
  StationStatus,
  { label: string; dot: string; ring: string; pill: string; icon: string; streamLabel: string }
> = {
  working: {
    label: 'Working',
    dot: 'bg-amber-500 dark:bg-amber-400',
    ring: 'ring-amber-500/25 dark:ring-amber-400/25',
    pill: 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-400',
    icon: 'text-amber-600 dark:text-amber-400',
    streamLabel: 'Current activity',
  },
  ready: {
    label: 'Online',
    dot: 'bg-emerald-500 dark:bg-emerald-400',
    ring: 'ring-emerald-500/25 dark:ring-emerald-400/25',
    pill: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/25 dark:bg-emerald-400/10 dark:text-emerald-400',
    icon: 'text-emerald-600 dark:text-emerald-400',
    streamLabel: 'Standby',
  },
  offline: {
    label: 'Offline',
    dot: 'bg-foreground-extra-muted',
    ring: 'ring-foreground-extra-muted/20',
    pill: 'border-border bg-surface2 text-foreground-muted',
    icon: 'text-foreground-extra-muted',
    streamLabel: 'Not connected',
  },
};

const MICRO_LABEL = 'text-[10px] font-medium uppercase tracking-wider text-foreground-extra-muted';

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
 *
 * Visually it is one parallel work stream: a micro-label naming the runtime, a
 * live status, and the one line of "what is it doing right now".
 */
export function AgentStation({ data, onOpenAgent, onOpenThread, onPairAgent }: AgentStationProps) {
  const { agent, status, threads, activity, skillCount, tokenCount, isCatalogPlaceholder } = data;
  const meta = STATUS_META[status];
  const isWorking = status === 'working';
  const activeThreadCount = threads.length;
  // The `custom` card stands for "some other agent" rather than a runtime, so
  // its button opens the configuration form instead of launching anything.
  // There is also nothing to Open until a real agent exists behind it — opening
  // it would put the user in a chat with an agent that was never configured.
  const isCustomPlaceholder = isCatalogPlaceholder === true && agent.agentName.toLowerCase() === 'custom';

  return (
    <div
      className={cn(
        'group relative flex h-full flex-col overflow-hidden rounded-xl border shadow-sm transition-all duration-200',
        'border-border/70 bg-surface1 hover:border-border-accent hover:shadow-md',
        status === 'offline' && 'bg-surface1/70',
      )}
    >
      {/* Live top edge: a single hairline, amber only while the agent works */}
      <div
        className={cn(
          'h-0.5 w-full shrink-0 transition-colors duration-200',
          isWorking
            ? 'bg-gradient-to-r from-amber-500/0 via-amber-500/70 to-amber-500/0 dark:via-amber-400/70 motion-safe:animate-pulse'
            : 'bg-transparent',
        )}
      />

      {/* Identity — micro-label above the name, click opens the agent's stream */}
      <button onClick={onOpenAgent} className="flex w-full items-center gap-3 px-4 pb-3 pt-4 text-left">
        <AgentAvatar name={agent.agentName} agentType={agent.agentType} size={36} status={agent.status} showStatus />
        <div className="min-w-0 flex-1">
          <p className={cn(MICRO_LABEL, 'truncate')}>{agent.agentType || 'Agent'}</p>
          <p className="mt-0.5 truncate text-sm font-semibold tracking-tight text-foreground">
            {agent.agentName}
          </p>
        </div>
        <span
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5',
            'text-[10px] font-medium uppercase tracking-wider',
            meta.pill,
          )}
        >
          <span className={cn('size-1.5 rounded-full ring-2', meta.dot, meta.ring, isWorking && 'motion-safe:animate-pulse')} />
          {meta.label}
        </span>
      </button>

      {/* Work stream — the live "what is it doing right now" line */}
      <div className="px-4 pb-4">
        <div
          className={cn(
            'min-h-[78px] rounded-lg border p-3 transition-colors duration-200',
            isWorking
              ? 'border-amber-500/20 bg-amber-500/[0.06] dark:border-amber-400/20 dark:bg-amber-400/[0.08]'
              : 'border-border/70 bg-surface2/50',
          )}
        >
          <div className="flex items-center gap-1.5">
            {isWorking ? (
              <Wrench className={cn('size-3 shrink-0', meta.icon)} />
            ) : status === 'ready' ? (
              <Radio className={cn('size-3 shrink-0', meta.icon)} />
            ) : (
              <Cpu className={cn('size-3 shrink-0', meta.icon)} />
            )}
            <p className={cn(MICRO_LABEL, isWorking && 'text-amber-700 dark:text-amber-400')}>{meta.streamLabel}</p>
          </div>
          {activity ? (
            <p
              className={cn(
                'mt-1.5 line-clamp-2 min-w-0 text-sm leading-relaxed',
                isWorking ? 'font-medium text-amber-800 dark:text-amber-300' : 'text-foreground-muted',
              )}
            >
              {stripMarkdown(activity.content).slice(0, 160) || (isWorking ? 'Working…' : 'Idle')}
            </p>
          ) : (
            <p className="mt-1.5 text-sm leading-relaxed text-foreground-extra-muted">
              {status === 'offline' ? 'Agent is offline' : status === 'ready' ? 'Standby — awaiting a task' : 'Warming up…'}
            </p>
          )}
        </div>
      </div>

      {/* Footer — threads this agent drives + skill/token summary */}
      <div className="mt-auto flex flex-col gap-2.5 border-t border-border/70 px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <span className={cn(MICRO_LABEL, 'flex items-center gap-1.5')}>
            <MessageSquare className="size-3" />
            Channels · <span className="tabular-nums">{activeThreadCount}</span>
          </span>
          <div className="flex items-center gap-2.5 text-[10px] font-medium text-foreground-muted">
            <span className="flex items-center gap-1">
              <Zap className="size-3" />
              <span className="tabular-nums">{skillCount}</span> skill{skillCount === 1 ? '' : 's'}
            </span>
            {tokenCount ? (
              <span className="tabular-nums" title="Tokens this agent reported in recent messages">
                {fmtTokens(tokenCount)} tok
              </span>
            ) : null}
          </div>
        </div>

        {threads.length === 0 ? (
          <p className="text-xs text-foreground-extra-muted">No threads yet</p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {threads.slice(0, 2).map((t) => {
              const live = data.focusThread?.sessionId === t.sessionId && isWorking;
              return (
                <button
                  key={t.sessionId}
                  onClick={() => onOpenThread(t.sessionId)}
                  className="group/thread -mx-1.5 flex items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-surface2"
                >
                  <Hash className={cn('size-3 shrink-0', live ? 'text-amber-600 dark:text-amber-400' : 'text-foreground-extra-muted')} />
                  <span className="flex-1 truncate text-xs font-medium text-foreground-muted transition-colors group-hover/thread:text-foreground">
                    {t.title || 'Untitled'}
                  </span>
                  {t.lastEventAt && (
                    <span className="shrink-0 text-[10px] tabular-nums text-foreground-extra-muted">
                      {timeAgo(new Date(t.lastEventAt).toISOString())}
                    </span>
                  )}
                </button>
              );
            })}
            {threads.length > 2 && (
              <button
                onClick={onOpenAgent}
                className="px-1.5 pt-0.5 text-left text-[10px] font-medium text-foreground-extra-muted transition-colors hover:text-foreground-muted"
              >
                + {threads.length - 2} more thread{threads.length - 2 === 1 ? '' : 's'}
              </button>
            )}
          </div>
        )}

        {/* Quick actions */}
        <div
          className={cn(
            'mt-0.5 grid gap-2 border-t border-border/70 pt-2.5',
            isCustomPlaceholder ? 'grid-cols-1' : 'grid-cols-2',
          )}
        >
          {!isCustomPlaceholder && (
            <button
              onClick={onOpenAgent}
              className="flex h-8 cursor-pointer items-center justify-center gap-1.5 truncate rounded-lg border border-border bg-surface1 px-2 text-xs font-medium text-foreground transition-colors hover:bg-surface2"
            >
              <MessageSquare className="size-3 shrink-0 text-foreground-extra-muted" />
              <span className="truncate">Open</span>
            </button>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onPairAgent?.();
            }}
            disabled={status !== 'offline'}
            className={cn(
              'flex h-8 items-center justify-center gap-1.5 truncate rounded-lg border px-2 text-xs font-medium transition-colors',
              status === 'offline'
                ? 'cursor-pointer border-primary bg-primary text-primary-foreground hover:bg-primary/90'
                : 'cursor-default border-emerald-500/25 bg-emerald-500/5 text-emerald-700 dark:border-emerald-400/25 dark:bg-emerald-400/5 dark:text-emerald-400',
            )}
            title={
              status !== 'offline'
                ? `${agent.agentName} is connected`
                : isCustomPlaceholder
                  ? 'Choose which agent to connect'
                  : `Launch or pair ${agent.agentName}`
            }
          >
            <span className="truncate">
              {status !== 'offline' ? 'Connected' : isCustomPlaceholder ? 'Configure' : 'Connect'}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
