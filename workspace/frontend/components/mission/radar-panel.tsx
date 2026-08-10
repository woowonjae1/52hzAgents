'use client';

import { useMemo, useState, useEffect } from 'react';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { timeAgo } from '@/lib/helpers';
import { cn } from '@/lib/utils';
import { Users, Hash, Wrench, Radio, Cpu, MessageSquare } from 'lucide-react';
import type { WorkspaceAgent, WorkspaceSession } from '@/lib/types';

type Status = 'working' | 'ready' | 'offline';

interface PanelAgent {
  agent: WorkspaceAgent;
  status: Status;
  threads: WorkspaceSession[];
  focusThread: WorkspaceSession | null;
  activity: { content: string; senderName: string; isStatus?: boolean } | null;
}

const STATUS_COLOR: Record<Status, { dot: string; text: string; label: string }> = {
  working: { dot: 'bg-status-warning', text: 'text-status-warning', label: 'Working' },
  ready: { dot: 'bg-status-success', text: 'text-status-success', label: 'Online' },
  offline: { dot: 'bg-foreground-extra-muted', text: 'text-foreground-extra-muted', label: 'Offline' },
};

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
  const { agents, sessions, lastMessageBySession, activeSessionIds, setCurrentSessionId } = useWorkspace();
  const { setViewMode } = useLayout();

  const panelAgents = useMemo<PanelAgent[]>(() => {
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
      <div className="h-full flex flex-col items-center justify-center text-center px-6 bg-card">
        <Users className="size-8 text-foreground-extra-muted mb-3" />
        <p className="text-sm text-foreground-muted">No agents to inspect yet.</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-card overflow-hidden">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-2 pl-4 pr-12 h-11 border-b border-border/60/60">
        <Users className="size-4 text-foreground-muted" />
        <span className="text-sm font-semibold text-foreground">Agents</span>
        <span className="text-[11px] text-foreground-extra-muted ml-auto tabular-nums">{panelAgents.length}</span>
      </div>

      {/* Agent selector list */}
      <div className="shrink-0 max-h-44 overflow-y-auto border-b border-border/60/60 p-1.5">
        {panelAgents.map((r) => {
          const isSel = r.agent.agentName === selected;
          const c = STATUS_COLOR[r.status];
          return (
            <button
              key={r.agent.agentName}
              onClick={() => setSelected(r.agent.agentName)}
              className={cn(
                'w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg text-left transition-colors',
                isSel ? 'bg-surface2/60' : 'hover:bg-surface1 dark:hover:bg-primary/30',
              )}
            >
              <span className={cn('size-1.5 rounded-full shrink-0', c.dot, r.status === 'working' && 'animate-pulse')} />
              <span className={cn('text-xs truncate flex-1', isSel ? 'font-semibold text-foreground' : 'font-medium text-foreground-muted')}>
                {r.agent.agentName}
              </span>
              <span className={cn('text-[10px] font-medium shrink-0', c.text)}>{c.label}</span>
            </button>
          );
        })}
      </div>

      {/* Focused single agent */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4">
        {current ? (
          <div className="space-y-3">
            {/* Identity */}
            <div className="flex items-center gap-3">
              <AgentAvatar name={current.agent.agentName} size={40} status={current.agent.status} showStatus />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-foreground truncate">{current.agent.agentName}</div>
                <div className="flex items-center gap-2 mt-0.5">
                  {current.agent.agentType && (
                    <span className="text-[11px] text-foreground-extra-muted">{current.agent.agentType}</span>
                  )}
                  <span className={cn('flex items-center gap-1 text-[10px] font-semibold', STATUS_COLOR[current.status].text)}>
                    <span className={cn('size-1.5 rounded-full', STATUS_COLOR[current.status].dot, current.status === 'working' && 'animate-pulse')} />
                    {STATUS_COLOR[current.status].label}
                  </span>
                </div>
              </div>
            </div>

            {/* Current activity */}
            <div className={cn('rounded-lg px-3 py-2.5 flex items-start gap-2 text-xs border', current.status === 'working' ? 'bg-status-warning/5 border-status-warning/15' : 'bg-surface1/30 border-border/50')}>
              {current.status === 'working' ? <Wrench className="size-3.5 shrink-0 mt-0.5 text-status-warning" /> : current.status === 'ready' ? <Radio className="size-3.5 shrink-0 mt-0.5 text-status-success" /> : <Cpu className="size-3.5 shrink-0 mt-0.5 text-foreground-extra-muted" />}
              {current.activity ? (
                <p className={cn('line-clamp-3 min-w-0', current.status === 'working' ? 'text-status-warning' : 'text-foreground-muted')}>
                  {stripMarkdown(current.activity.content).slice(0, 240) || 'Idle'}
                </p>
              ) : (
                <p className="text-foreground-extra-muted">{current.status === 'offline' ? 'Agent is offline' : 'Standby — awaiting a task'}</p>
              )}
            </div>

            {/* Threads */}
            <div>
              <div className="flex items-center gap-1 text-[11px] font-semibold text-foreground-extra-muted mb-1.5">
                <MessageSquare className="size-3" /> Threads · {current.threads.length}
              </div>
              {current.threads.length === 0 ? (
                <p className="text-[11px] text-foreground-extra-muted">No threads yet</p>
              ) : (
                <div className="flex flex-col gap-0.5">
                  {current.threads.map((t) => (
                    <button
                      key={t.sessionId}
                      onClick={() => openThread(t.sessionId)}
                      className="flex items-center gap-1.5 px-2 py-1.5 -mx-1 rounded-md hover:bg-surface2/40 transition-colors text-left"
                    >
                      <Hash className="size-3 shrink-0 text-foreground-extra-muted" />
                      <span className="text-xs text-foreground-muted truncate flex-1">{t.title || 'Untitled'}</span>
                      {t.lastEventAt && <span className="text-[9px] text-foreground-extra-muted shrink-0">{timeAgo(new Date(t.lastEventAt).toISOString())}</span>}
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