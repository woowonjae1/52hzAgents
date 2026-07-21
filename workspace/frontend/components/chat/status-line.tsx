'use client';

import { useMemo } from 'react';
import { useWorkspace } from '@/lib/workspace-context';
import { cn } from '@/lib/utils';
import { Crown, GitBranch, Users, Circle } from 'lucide-react';

/**
 * StatusLine — the persistent bottom status bar (Codex / Claude Code signature).
 * Always-on context for the active thread: connection, workspace, orchestration
 * mode, master/operator, and live agent counts. Monospace, dense, unobtrusive.
 */
export function StatusLine() {
  const { workspace, agents, sessions, currentSessionId, activeSessionIds } = useWorkspace();

  const session = useMemo(
    () => sessions.find((s) => s.sessionId === currentSessionId) || null,
    [sessions, currentSessionId],
  );

  const onlineCount = agents.filter((a) => a.status === 'online').length;
  const working = currentSessionId ? activeSessionIds.has(currentSessionId) : false;
  const participants = session?.participants?.length ?? 0;
  const mode = session?.orchestrationMode || 'dynamic';
  const master = session?.master || null;

  return (
    <div className="shrink-0 flex items-center gap-3 h-6 px-3 border-t border-zinc-200/70 dark:border-zinc-800/70 bg-zinc-50/80 dark:bg-zinc-900/50 font-mono text-[10px] text-zinc-500 dark:text-zinc-500 select-none overflow-x-auto">
      {/* Connection / activity */}
      <span className={cn('flex items-center gap-1.5 shrink-0', working ? 'text-amber-500' : 'text-emerald-500')}>
        <Circle className={cn('size-2 fill-current', working && 'animate-pulse')} />
        {working ? 'working' : 'live'}
      </span>

      <Sep />

      {/* Workspace */}
      {workspace && <span className="shrink-0 text-zinc-600 dark:text-zinc-400">{workspace.slug}</span>}

      {session && (
        <>
          <Sep />
          {/* Orchestration mode */}
          <span className="flex items-center gap-1 shrink-0">
            <GitBranch className="size-3" />
            {mode}
          </span>
          {/* Master / operator */}
          {master && (
            <>
              <Sep />
              <span className="flex items-center gap-1 shrink-0 text-zinc-600 dark:text-zinc-400">
                <Crown className="size-3 text-amber-500/80" />
                {master}
              </span>
            </>
          )}
          {/* Participants in thread */}
          <Sep />
          <span className="flex items-center gap-1 shrink-0">
            <Users className="size-3" />
            {participants} in thread
          </span>
        </>
      )}

      {/* Right: agents online */}
      <span className="ml-auto shrink-0 tabular-nums">
        {onlineCount}/{agents.length} agents online
      </span>
    </div>
  );
}

function Sep() {
  return <span className="text-zinc-300 dark:text-zinc-700 shrink-0 select-none">·</span>;
}
