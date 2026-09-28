'use client';

import * as React from 'react';
import {
  ArrowRight,
  CalendarClock,
  CircleAlert,
  CirclePause,
  GitMerge,
  MessageSquare,
  Repeat,
  RotateCw,
  ShieldAlert,
  Timer,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AgentAvatarStack } from '@/components/agents/agent-avatar';
import { useWorkspace, isUnusedSession } from '@/lib/workspace-context';
import { workspaceApi } from '@/lib/api';
import { toast } from '@/lib/toast';
import { formatCompactRelativeTime } from '@/lib/helpers';
import { basename } from '@/components/chat/project-folder-picker';
import { getSmartSessionTitle, extractSessionAgents } from '@/components/threads/thread-list';
import { respondToToolApproval, type PendingActionItem } from '@/components/mission/action-required-banner';
import type { RoutineItem, TimerItem, WorkspaceSession } from '@/lib/types';
import { HomePanel, HomeRow } from './home-panel';
import {
  isRoutinePendingApproval,
  routinePausedReason,
  useParallelAttention,
  usePendingToolApprovals,
} from './use-home-attention';

function useThreadTitle() {
  const { sessions, lastMessageBySession } = useWorkspace();
  return React.useCallback(
    (sessionId: string): string => {
      const s = sessions.find((x) => x.sessionId === sessionId);
      return s ? getSmartSessionTitle(s, lastMessageBySession[sessionId]) : sessionId;
    },
    [sessions, lastMessageBySession],
  );
}

// ── Needs your attention ─────────────────────────────────────────────────────

export function NeedsAttentionPanel({
  onOpenThread,
  onOpenAutomations,
}: {
  onOpenThread: (sessionId: string) => void;
  onOpenAutomations: () => void;
}) {
  const { sessions, routines } = useWorkspace();
  const threadTitle = useThreadTitle();
  const approvals = usePendingToolApprovals(sessions);
  const parallel = useParallelAttention(sessions);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [answered, setAnswered] = React.useState<Set<string>>(new Set());

  const openApprovals = approvals.items.filter((a) => !answered.has(a.id));
  const routinesToApprove = routines.filter(isRoutinePendingApproval);
  const pausedRoutines = routines.filter((r) => r.status === 'paused' && routinePausedReason(r));

  const answer = async (item: PendingActionItem, granted: boolean) => {
    setBusy(item.id);
    try {
      await respondToToolApproval(item, granted);
      setAnswered((prev) => new Set(prev).add(item.id));
      if (granted) toast.success(`Approved @${item.agentName}`);
      else toast.info(`Denied @${item.agentName}`);
      void approvals.refresh();
    } catch {
      toast.error(granted ? 'Approval failed' : 'Could not submit the denial');
    } finally {
      setBusy(null);
    }
  };

  const retryLane = async (batchId: string, agent: string) => {
    const key = `${batchId}:${agent}`;
    setBusy(key);
    try {
      await workspaceApi.retryParallelLane(batchId, agent);
      toast.success(`Retrying @${agent}'s lane`);
      void parallel.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? `Could not retry: ${e.message}` : 'Could not retry the lane');
    } finally {
      setBusy(null);
    }
  };

  const rows: React.ReactNode[] = [];

  for (const item of openApprovals) {
    rows.push(
      <HomeRow
        key={item.id}
        icon={<ShieldAlert className="size-3.5" />}
        title={`@${item.agentName} is waiting for approval`}
        detail={
          <>
            {item.command ? <span className="font-mono">$ {item.command}</span> : item.path || item.toolName || 'Tool call'}
            {' · '}
            {threadTitle(item.channelId)}
          </>
        }
        onClick={() => onOpenThread(item.channelId)}
        actions={
          <>
            <Button variant="ghost" size="sm" disabled={busy === item.id} onClick={() => answer(item, false)}>
              Deny
            </Button>
            <Button variant="outline" size="sm" disabled={busy === item.id} onClick={() => answer(item, true)}>
              Approve
            </Button>
          </>
        }
      />,
    );
  }

  for (const { session, batch } of parallel.items) {
    const run = batch.run;
    if (!run) continue;
    const title = getSmartSessionTitle(session, undefined);
    if (run.batch.status === 'review') {
      const toReview = run.lanes.filter((l) => l.status === 'done').length;
      rows.push(
        <HomeRow
          key={`review-${run.batch.id}`}
          icon={<GitMerge className="size-3.5" />}
          title="Parallel work is ready for review"
          detail={`${toReview} ${toReview === 1 ? 'lane' : 'lanes'} to merge or discard · ${threadTitle(session.sessionId) || title}`}
          onClick={() => onOpenThread(session.sessionId)}
          actions={
            <Button variant="outline" size="sm" onClick={() => onOpenThread(session.sessionId)}>
              Review
            </Button>
          }
        />,
      );
    }
    for (const lane of run.lanes.filter((l) => l.status === 'failed')) {
      const key = `${run.batch.id}:${lane.agent}`;
      rows.push(
        <HomeRow
          key={`lane-${key}`}
          icon={<CircleAlert className="size-3.5 text-destructive" />}
          title={`@${lane.agent}'s lane failed`}
          detail={`${lane.error || 'No error was reported'} · ${threadTitle(session.sessionId) || title}`}
          onClick={() => onOpenThread(session.sessionId)}
          actions={
            <Button variant="outline" size="sm" disabled={busy === key} onClick={() => retryLane(run.batch.id, lane.agent)}>
              <RotateCw className="size-3" />
              Retry
            </Button>
          }
        />,
      );
    }
  }

  for (const r of routinesToApprove) {
    rows.push(
      <HomeRow
        key={`routine-approve-${r.id}`}
        icon={<CalendarClock className="size-3.5" />}
        title={`Proposed automation: ${r.name}`}
        detail={`Suggested by ${r.createdBy ? `@${r.createdBy.replace(/^agent:/, '')}` : 'an agent'} · runs only after you approve it`}
        onClick={onOpenAutomations}
        actions={
          <Button variant="outline" size="sm" onClick={onOpenAutomations}>
            Review
          </Button>
        }
      />,
    );
  }

  for (const r of pausedRoutines) {
    rows.push(
      <HomeRow
        key={`routine-paused-${r.id}`}
        icon={<CirclePause className="size-3.5" />}
        title={`Automation paused: ${r.name}`}
        detail={routinePausedReason(r)}
        onClick={onOpenAutomations}
        actions={
          <Button variant="ghost" size="sm" onClick={onOpenAutomations}>
            Open
          </Button>
        }
      />,
    );
  }

  return (
    <HomePanel
      id="home-attention"
      title="Needs your attention"
      subtitle={
        rows.length === 0
          ? 'Approvals, parallel reviews and paused automations show up here.'
          : `${rows.length} ${rows.length === 1 ? 'item is' : 'items are'} waiting on you.`
      }
    >
      {rows.length === 0 ? (
        <p className="text-xs text-foreground-extra-muted">Nothing needs you right now.</p>
      ) : (
        <ul className="-mx-2 flex flex-col">{rows}</ul>
      )}
    </HomePanel>
  );
}

// ── Recent sessions ──────────────────────────────────────────────────────────

export function RecentSessionsPanel({ onOpenThread }: { onOpenThread: (sessionId: string) => void }) {
  const { sessions, agents, lastMessageBySession, activeSessionIds } = useWorkspace();

  const recent = React.useMemo(
    () =>
      sessions
        .filter(
          (s) =>
            s.status !== 'archived' &&
            s.status !== 'deleted' &&
            !isUnusedSession(s, lastMessageBySession),
        )
        .sort((a, b) => sessionTime(b) - sessionTime(a))
        .slice(0, 6),
    [sessions, lastMessageBySession],
  );

  return (
    <HomePanel
      id="home-recent"
      title="Recent sessions"
      subtitle={recent.length === 0 ? 'Sessions you start appear here.' : 'Pick up where you left off.'}
    >
      {recent.length === 0 ? (
        <p className="text-xs text-foreground-extra-muted">No sessions yet.</p>
      ) : (
        <ul className="-mx-2 flex flex-col">
          {recent.map((s) => {
            const last = lastMessageBySession[s.sessionId];
            const title = getSmartSessionTitle(s, last);
            const who = extractSessionAgents(s, agents, last, title);
            const running = activeSessionIds.has(s.sessionId);
            return (
              <HomeRow
                key={s.sessionId}
                icon={
                  who.length > 0 ? (
                    <AgentAvatarStack agents={who} max={2} size={16} />
                  ) : (
                    <MessageSquare className="size-3.5" />
                  )
                }
                title={title}
                detail={
                  <>
                    {running && <span className="event-running me-1.5">Working</span>}
                    {s.workingDir ? basename(s.workingDir) : 'Direct chat'}
                    {who.length > 0 && ` · ${who.map((a) => `@${a.name}`).join(', ')}`}
                  </>
                }
                meta={formatCompactRelativeTime(sessionTime(s))}
                onClick={() => onOpenThread(s.sessionId)}
              />
            );
          })}
        </ul>
      )}
    </HomePanel>
  );
}

function sessionTime(s: WorkspaceSession): number {
  return s.lastEventAt || (s.createdAt ? new Date(s.createdAt).getTime() || 0 : 0);
}

// ── Upcoming ─────────────────────────────────────────────────────────────────

type Upcoming =
  | { kind: 'routine'; at: number; routine: RoutineItem }
  | { kind: 'timer'; at: number; timer: TimerItem };

function formatUntil(at: number, now: number): string {
  const diff = at - now;
  if (diff < 60_000) return 'now';
  const min = Math.round(diff / 60_000);
  if (min < 60) return `in ${min}m`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `in ${hours}h`;
  const d = new Date(at);
  return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })}`;
}

function describeSchedule(r: RoutineItem): string {
  if (r.scheduleIntervalMinutes) {
    const m = r.scheduleIntervalMinutes;
    return m % 60 === 0 ? `Every ${m / 60}h` : `Every ${m} min`;
  }
  const time = `${String(r.scheduleHour).padStart(2, '0')}:${String(r.scheduleMinute).padStart(2, '0')}`;
  const days = r.scheduleDays;
  if (!days || days.length === 0 || days.length === 7) return `Daily ${time}`;
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${days.map((d) => names[d] ?? d).join(', ')} ${time}`;
}

export function UpcomingPanel({
  onOpenAutomations,
  onOpenThread,
}: {
  onOpenAutomations: () => void;
  onOpenThread: (sessionId: string) => void;
}) {
  const { routines, timers, sessions } = useWorkspace();
  const threadTitle = useThreadTitle();
  // Re-read the clock with the data rather than on a ticker: "in 3h" does not
  // need to move while you look at it, and the lists refresh over SSE anyway.
  const now = Date.now();

  const upcoming = React.useMemo(() => {
    const list: Upcoming[] = [];
    for (const r of routines) {
      if (r.status !== 'active') continue;
      const at = new Date(r.nextFiresAt).getTime();
      if (at) list.push({ kind: 'routine', at, routine: r });
    }
    for (const t of timers) {
      if (t.status !== 'active') continue;
      const at = new Date(t.firesAt).getTime();
      if (at) list.push({ kind: 'timer', at, timer: t });
    }
    return list.sort((a, b) => a.at - b.at).slice(0, 5);
  }, [routines, timers]);

  const hasThread = (id: string) => sessions.some((s) => s.sessionId === id);

  return (
    <HomePanel
      id="home-upcoming"
      title="Upcoming"
      subtitle={upcoming.length === 0 ? 'Nothing is scheduled.' : 'Scheduled work, soonest first.'}
      action={
        <Button variant="ghost" size="sm" onClick={onOpenAutomations}>
          Automations
          <ArrowRight className="size-3" />
        </Button>
      }
    >
      {upcoming.length === 0 ? (
        <p className="text-xs text-foreground-extra-muted">
          Ask an agent to do something on a schedule, or add one in Automations.
        </p>
      ) : (
        <ul className="-mx-2 flex flex-col">
          {upcoming.map((u) =>
            u.kind === 'routine' ? (
              <HomeRow
                key={`r-${u.routine.id}`}
                icon={<Repeat className="size-3.5" />}
                title={u.routine.name}
                detail={`${describeSchedule(u.routine)}${u.routine.channelName ? ` · ${threadTitle(u.routine.channelName)}` : ''}`}
                meta={formatUntil(u.at, now)}
                onClick={onOpenAutomations}
              />
            ) : (
              <HomeRow
                key={`t-${u.timer.id}`}
                icon={<Timer className="size-3.5" />}
                title={u.timer.message || 'Timer'}
                detail={`One-off timer${u.timer.channelName ? ` · ${threadTitle(u.timer.channelName)}` : ''}`}
                meta={formatUntil(u.at, now)}
                onClick={() =>
                  u.timer.channelName && hasThread(u.timer.channelName)
                    ? onOpenThread(u.timer.channelName)
                    : onOpenAutomations()
                }
              />
            ),
          )}
        </ul>
      )}
    </HomePanel>
  );
}
