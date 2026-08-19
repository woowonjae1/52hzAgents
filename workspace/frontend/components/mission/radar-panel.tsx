'use client';

import { useMemo, useState, useEffect } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { timeAgo } from '@/lib/helpers';
import { cn } from '@/lib/utils';
import { Users, Hash, Wrench, Radio, Cpu, MessageSquare, Plus } from 'lucide-react';
import type { WorkspaceAgent, WorkspaceSession } from '@/lib/types';

type Status = 'working' | 'ready' | 'offline';

interface PanelAgent {
  agent: WorkspaceAgent;
  status: Status;
  threads: WorkspaceSession[];
  focusThread: WorkspaceSession | null;
  activity: { content: string; senderName: string; isStatus?: boolean } | null;
}

const STATUS_COLOR: Record<Status, { dot: string; ring: string; text: string; label: string; pill: string; icon: string }> = {
  working: {
    dot: 'bg-amber-500 dark:bg-amber-400',
    ring: 'ring-amber-500/25 dark:ring-amber-400/25',
    text: 'text-amber-700 dark:text-amber-400',
    label: 'Working',
    pill: 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-400',
    icon: 'text-amber-600 dark:text-amber-400',
  },
  ready: {
    dot: 'bg-emerald-500 dark:bg-emerald-400',
    ring: 'ring-emerald-500/25 dark:ring-emerald-400/25',
    text: 'text-emerald-700 dark:text-emerald-400',
    label: 'Online',
    pill: 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/25 dark:bg-emerald-400/10 dark:text-emerald-400',
    icon: 'text-emerald-600 dark:text-emerald-400',
  },
  offline: {
    dot: 'bg-foreground-extra-muted',
    ring: 'ring-foreground-extra-muted/20',
    text: 'text-foreground-muted',
    label: 'Offline',
    pill: 'border-border bg-surface2 text-foreground-muted',
    icon: 'text-foreground-extra-muted',
  },
};

const MICRO_LABEL = 'text-[10px] font-medium uppercase tracking-wider text-foreground-extra-muted';

function stripMarkdown(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '[code]').replace(/\*\*/g, '').replace(/`{1,3}/g, '').replace(/\n+/g, ' ').trim();
}

/**
 * AgentsPanel — the compact, side-rail agent inspector.
 *
 * Lets you pick one agent and inspect its real status, current activity, and
 * threads without leaving the thread you're chatting in. (Exported as
 * `RadarPanel` for backwards-compatible imports.)
 */
export function RadarPanel() {
  const { agents, sessions, lastMessageBySession, activeSessionIds, workingAgentNames, setCurrentSessionId } = useWorkspace();
  const { setViewMode } = useLayout();
  const reduceMotion = useReducedMotion();

  const panelAgents = useMemo<PanelAgent[]>(() => {
    const activeThreads = sessions.filter((s) => s.status === 'active' && !s.sessionId.startsWith('routine:'));
    return agents.map((agent) => {
      const threads = activeThreads
        .filter((s) => s.participants.includes(agent.agentName) || s.master === agent.agentName)
        .sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0));
      // Busy channel ≠ busy agent: every member of an active channel used to
      // read "working" even though only the routed agent answers.
      const isWorking = workingAgentNames.has(agent.agentName);
      const workingThread = isWorking ? threads.find((t) => activeSessionIds.has(t.sessionId)) || null : null;
      const focusThread = workingThread || threads[0] || null;
      const status: Status = agent.status !== 'online' ? 'offline' : isWorking ? 'working' : 'ready';
      const activity = focusThread ? lastMessageBySession[focusThread.sessionId] || null : null;
      return { agent, status, threads, focusThread, activity };
    });
  }, [agents, sessions, lastMessageBySession, activeSessionIds, workingAgentNames]);

  const [selected, setSelected] = useState<string | null>(null);
  // Default to the first agent; keep selection valid as agents change.
  useEffect(() => {
    if (panelAgents.length === 0) { setSelected(null); return; }
    if (!selected || !panelAgents.some((r) => r.agent.agentName === selected)) {
      setSelected(panelAgents[0].agent.agentName);
    }
  }, [panelAgents, selected]);

  const current = panelAgents.find((r) => r.agent.agentName === selected) || null;

  const openThread = (sessionId: string) => {
    setViewMode('threads');
    setCurrentSessionId(sessionId);
  };

  if (agents.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-surface1 px-6 text-center">
        <div className="flex size-11 items-center justify-center rounded-full bg-surface2">
          <Users className="size-5 text-foreground-muted" />
        </div>
        <p className="mt-3 text-sm font-semibold tracking-tight text-foreground">No agents to inspect</p>
        <p className="mt-1 max-w-[32ch] text-sm text-foreground-muted">
          Connect an agent and its live status will show up in this rail.
        </p>
        <button
          onClick={() => setViewMode('connect')}
          className="mt-4 inline-flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-primary px-3.5 text-xs font-medium text-primary-foreground shadow-sm transition-all duration-200 hover:bg-primary/90 hover:shadow-md active:scale-[0.98]"
        >
          <Plus className="size-3.5" />
          Connect agent
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-surface1">
      {/* Header */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 pl-4 pr-12">
        <Users className="size-4 text-foreground-muted" />
        <span className="text-sm font-semibold tracking-tight text-foreground">Agents</span>
        <span className="ml-auto rounded-full bg-surface2 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-foreground-muted">
          {panelAgents.length}
        </span>
      </div>

      {/* Agent selector list */}
      <div className="max-h-44 shrink-0 space-y-0.5 overflow-y-auto border-b border-border/70 p-2">
        {panelAgents.map((r, idx) => {
          const isSel = r.agent.agentName === selected;
          const c = STATUS_COLOR[r.status];
          return (
            <motion.button
              key={r.agent.agentName}
              onClick={() => setSelected(r.agent.agentName)}
              initial={reduceMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: 'easeOut', delay: Math.min(idx, 12) * 0.03 }}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-1.5 text-left transition-all duration-200',
                isSel
                  ? 'border-border/70 bg-surface2 shadow-sm'
                  : 'border-transparent hover:bg-surface2/60',
              )}
            >
              <span className={cn('size-1.5 shrink-0 rounded-full ring-2', c.dot, c.ring, r.status === 'working' && 'motion-safe:animate-pulse')} />
              <span
                className={cn(
                  'flex-1 truncate text-xs',
                  isSel ? 'font-semibold text-foreground' : 'font-medium text-foreground-muted',
                )}
              >
                {r.agent.agentName}
              </span>
              <span className={cn('shrink-0 text-[10px] font-medium uppercase tracking-wider', c.text)}>{c.label}</span>
            </motion.button>
          );
        })}
      </div>

      {/* Focused single agent */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {current ? (
          <motion.div
            key={current.agent.agentName}
            className="space-y-4"
            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
          >
            {/* Identity */}
            <div className="flex items-center gap-3">
              <AgentAvatar name={current.agent.agentName} size={40} status={current.agent.status} showStatus />
              <div className="min-w-0 flex-1">
                {current.agent.agentType && <p className={cn(MICRO_LABEL, 'truncate')}>{current.agent.agentType}</p>}
                <p className="mt-0.5 truncate text-sm font-semibold tracking-tight text-foreground">
                  {current.agent.agentName}
                </p>
              </div>
              <span
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider',
                  STATUS_COLOR[current.status].pill,
                )}
              >
                <span
                  className={cn(
                    'size-1.5 rounded-full ring-2',
                    STATUS_COLOR[current.status].dot,
                    STATUS_COLOR[current.status].ring,
                    current.status === 'working' && 'motion-safe:animate-pulse',
                  )}
                />
                {STATUS_COLOR[current.status].label}
              </span>
            </div>

            {/* Current activity — same work-stream card as the Overview roster */}
            <div
              className={cn(
                'rounded-xl border p-3 transition-colors duration-200',
                current.status === 'working'
                  ? 'border-amber-500/20 bg-amber-500/[0.06] dark:border-amber-400/20 dark:bg-amber-400/[0.08]'
                  : 'border-border/70 bg-surface2/50',
              )}
            >
              <div className="flex items-center gap-1.5">
                {current.status === 'working' ? (
                  <Wrench className={cn('size-3 shrink-0', STATUS_COLOR[current.status].icon)} />
                ) : current.status === 'ready' ? (
                  <Radio className={cn('size-3 shrink-0', STATUS_COLOR[current.status].icon)} />
                ) : (
                  <Cpu className={cn('size-3 shrink-0', STATUS_COLOR[current.status].icon)} />
                )}
                <p className={cn(MICRO_LABEL, current.status === 'working' && 'text-amber-700 dark:text-amber-400')}>
                  {current.status === 'working' ? 'Current activity' : current.status === 'ready' ? 'Standby' : 'Not connected'}
                </p>
              </div>
              {current.activity ? (
                <p
                  className={cn(
                    'mt-1.5 line-clamp-3 min-w-0 text-sm leading-relaxed',
                    current.status === 'working'
                      ? 'font-medium text-amber-800 dark:text-amber-300'
                      : 'text-foreground-muted',
                  )}
                >
                  {stripMarkdown(current.activity.content).slice(0, 240) || 'Idle'}
                </p>
              ) : (
                <p className="mt-1.5 text-sm leading-relaxed text-foreground-extra-muted">
                  {current.status === 'offline' ? 'Agent is offline' : 'Standby — awaiting a task'}
                </p>
              )}
            </div>

            {/* Threads */}
            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <MessageSquare className="size-3 text-foreground-extra-muted" />
                <span className={MICRO_LABEL}>Channels</span>
                <span className="rounded-full bg-surface2 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-foreground-muted">
                  {current.threads.length}
                </span>
              </div>
              {current.threads.length === 0 ? (
                <p className="text-xs text-foreground-extra-muted">No threads yet</p>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {current.threads.map((t, idx) => (
                    <motion.button
                      key={t.sessionId}
                      onClick={() => openThread(t.sessionId)}
                      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.25, ease: 'easeOut', delay: Math.min(idx, 12) * 0.03 }}
                      className="group/thread -mx-1 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface2"
                    >
                      <Hash className="size-3 shrink-0 text-foreground-extra-muted" />
                      <span className="flex-1 truncate text-xs font-medium text-foreground-muted transition-colors group-hover/thread:text-foreground">
                        {t.title || 'Untitled'}
                      </span>
                      {t.lastEventAt && (
                        <span className="shrink-0 text-[10px] tabular-nums text-foreground-extra-muted">
                          {timeAgo(new Date(t.lastEventAt).toISOString())}
                        </span>
                      )}
                    </motion.button>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        ) : null}
      </div>
    </div>
  );
}
