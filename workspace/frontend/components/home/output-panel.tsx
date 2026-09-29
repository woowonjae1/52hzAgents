'use client';

import * as React from 'react';
import { RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Hint } from '@/components/ui/hint';
import { AgentDayTimeline } from '@/components/charts/agent-day-timeline';
import {
  HEAT_CELL,
  HEAT_GAP,
  HEAT_LABEL_WIDTH,
  HeatCalendar,
  HeatCalendarGrid,
  HeatCalendarLegend,
  HeatCalendarTooltip,
  plural,
  type HeatCalendarDay,
} from '@/components/charts/heat-calendar';
import { workspaceApi } from '@/lib/api';
import type { ActivityCommit, ActivityCommitsResponse, ActivityTurn } from '@/lib/generated/api-types';
import { useVisibilityPolling } from '@/lib/use-visibility-polling';
import { useWorkspace } from '@/lib/workspace-context';
import { cn } from '@/lib/utils';
import { HomePanel } from './home-panel';

/*
  OUTPUT: what got made, and who made it.

  The calendar counts commits in the workspace's own repositories, read from
  local git by the server. The lanes below it show one day of agent turns with
  that day's commits dropped onto them, so "a busy day" can be opened into
  "which agent, when, in which session".

  Days are the viewer's local days: the server returns raw timestamps and both
  bucketing and the day range sent for turns are computed here.
*/

const FETCH_WEEKS = 53;
const MIN_WEEKS = 8;
const COMMITS_POLL_MS = 120_000;
const TURNS_POLL_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function dayKey(d: Date) {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

function keyToDate(key: string) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** How many week columns fit in `width`, measured from the element itself. */
function useFitWeeks(ref: React.RefObject<HTMLElement | null>) {
  const [weeks, setWeeks] = React.useState(20);
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const fit = Math.floor((el.clientWidth - HEAT_LABEL_WIDTH + HEAT_GAP) / (HEAT_CELL + HEAT_GAP));
      setWeeks(Math.max(MIN_WEEKS, Math.min(FETCH_WEEKS, fit)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return weeks;
}

interface DayStats {
  total: number;
  byAgent: Map<string, number>;
  shared: number;
}

export function OutputPanel({ onOpenThread, className }: { onOpenThread?: (sessionId: string) => void; className?: string }) {
  const { workspace, sessions } = useWorkspace();
  const sessionTitles = React.useMemo(() => new Map(sessions.map((x) => [x.sessionId, x.title])), [sessions]);
  const sessionLabel = React.useCallback(
    (name: string) => sessionTitles.get(name)?.trim() || `#${name}`,
    [sessionTitles],
  );
  const workspaceId = workspace?.workspaceId;
  const measureRef = React.useRef<HTMLDivElement>(null);
  const weeks = useFitWeeks(measureRef);

  const [data, setData] = React.useState<ActivityCommitsResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());
  const today = React.useMemo(() => startOfDay(new Date(now)), [now]);
  const [selectedKey, setSelectedKey] = React.useState(() => dayKey(new Date()));

  // The workspace a response belongs to. A reply that lands after the user
  // switched workspace is dropped instead of painting the old repos.
  const liveWorkspace = React.useRef(workspaceId);
  liveWorkspace.current = workspaceId;

  const loadCommits = React.useCallback(
    async (refresh = false) => {
      if (!workspaceId) return;
      try {
        const res = await workspaceApi.getActivityCommits(FETCH_WEEKS, refresh);
        if (liveWorkspace.current !== workspaceId) return;
        setData(res);
        setError(null);
      } catch (e) {
        if (liveWorkspace.current !== workspaceId) return;
        setError(e instanceof Error ? e.message : 'Could not read commits');
      }
      setNow(Date.now());
    },
    [workspaceId],
  );
  // Loaded per workspace here, and only refreshed by the poll: the polling
  // hook does not re-run when its callback changes, so it cannot be what
  // notices a workspace switch.
  React.useEffect(() => {
    setData(null);
    setError(null);
    void loadCommits();
  }, [loadCommits]);
  useVisibilityPolling(() => loadCommits(), COMMITS_POLL_MS, { enabled: !!workspaceId, immediate: false });

  // ── Turns for the selected day ──
  const dayStart = keyToDate(selectedKey).getTime();
  const dayEnd = addDays(keyToDate(selectedKey), 1).getTime();
  const isToday = selectedKey === dayKey(today);
  const [turns, setTurns] = React.useState<{ key: string; turns: ActivityTurn[] } | null>(null);
  const loadTurns = React.useCallback(async () => {
    if (!workspaceId) return;
    try {
      const res = await workspaceApi.getActivityTurns(dayStart, dayEnd);
      if (liveWorkspace.current !== workspaceId) return;
      setTurns({ key: `${workspaceId}/${selectedKey}`, turns: res.turns });
    } catch {
      if (liveWorkspace.current !== workspaceId) return;
      setTurns({ key: `${workspaceId}/${selectedKey}`, turns: [] });
    }
    setNow(Date.now());
  }, [workspaceId, dayStart, dayEnd, selectedKey]);
  React.useEffect(() => {
    void loadTurns();
  }, [loadTurns]);
  useVisibilityPolling(loadTurns, TURNS_POLL_MS, { enabled: !!workspaceId && isToday, immediate: false });

  // ── Calendar ──
  const statsByDay = React.useMemo(() => {
    const map = new Map<string, DayStats>();
    for (const c of data?.commits ?? []) {
      const key = dayKey(new Date(c.time));
      let s = map.get(key);
      if (!s) {
        s = { total: 0, byAgent: new Map(), shared: 0 };
        map.set(key, s);
      }
      s.total += 1;
      if (c.agent) s.byAgent.set(c.agent, (s.byAgent.get(c.agent) ?? 0) + 1);
      else if (c.shared) s.shared += 1;
    }
    return map;
  }, [data]);

  const days = React.useMemo<HeatCalendarDay[]>(() => {
    const mondayOffset = (today.getDay() + 6) % 7;
    const start = addDays(today, -mondayOffset - (weeks - 1) * 7);
    const out: HeatCalendarDay[] = [];
    for (let i = 0; i < weeks * 7; i++) {
      const date = addDays(start, i);
      const key = dayKey(date);
      out.push({ key, date, count: statsByDay.get(key)?.total ?? 0, future: date > today });
    }
    return out;
  }, [today, weeks, statsByDay]);

  const rangeTotals = React.useMemo(() => {
    let total = 0;
    let byAgents = 0;
    for (const d of days) {
      const s = statsByDay.get(d.key);
      if (!s) continue;
      total += s.total;
      for (const n of s.byAgent.values()) byAgents += n;
    }
    return { total, byAgents };
  }, [days, statsByDay]);

  const dayCommits = React.useMemo<ActivityCommit[]>(
    () => (data?.commits ?? []).filter((c) => c.time >= dayStart && c.time < dayEnd),
    [data, dayStart, dayEnd],
  );
  const dayTurns = turns?.key === `${workspaceId}/${selectedKey}` ? turns.turns : null;

  const onSelect = React.useCallback((day: HeatCalendarDay) => setSelectedKey(day.key), []);

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([loadCommits(true), loadTurns()]);
    setRefreshing(false);
  };

  const repos = data?.repos ?? [];
  const noRepos = data !== null && repos.length === 0;
  const readableRepos = repos.filter((r) => !r.error);
  const selectedDate = keyToDate(selectedKey);
  const selectedStats = statsByDay.get(selectedKey);

  return (
    <HomePanel
      id="home-output"
      className={className}
      title="Output"
      subtitle={
        data === null || noRepos
          ? 'Commits in your project repositories, and what each agent did.'
          : `${plural(rangeTotals.total, 'commit')} in ${weeks} weeks${rangeTotals.byAgents ? `, ${rangeTotals.byAgents} made during agent turns` : ''}.`
      }
      action={
        <Hint label="Refresh">
          <Button variant="ghost" size="icon" className="size-7" onClick={refresh} disabled={refreshing} aria-label="Refresh output">
            <RotateCw className={cn('size-3.5', refreshing && 'animate-spin')} />
          </Button>
        </Hint>
      }
    >
      <div ref={measureRef} className="min-w-0">
        {noRepos ? (
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
            No git repository is linked to this workspace yet. Pick a project folder when you start a session and its
            commits show up here.
          </p>
        ) : (
          <HeatCalendar days={days} unit="commit" selectedKey={selectedKey} onSelect={onSelect}>
            <HeatCalendarGrid>
              <HeatCalendarTooltip>{(day) => <DayTooltip day={day} stats={statsByDay.get(day.key)} />}</HeatCalendarTooltip>
            </HeatCalendarGrid>
            <HeatCalendarLegend>
              {error ? (
                <span className="text-status-danger">{error}</span>
              ) : readableRepos.length > 0 ? (
                <span>
                  From {readableRepos.map((r) => r.name).join(', ')}
                  {repos.length > readableRepos.length && ` · ${repos.length - readableRepos.length} unreadable`}
                </span>
              ) : null}
            </HeatCalendarLegend>
          </HeatCalendar>
        )}
      </div>

      <div className="mt-4 border-t border-border pt-3">
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h3 className="text-xs font-medium text-foreground">
            {isToday ? 'Today' : selectedDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
          </h3>
          <span className="text-2xs tabular-nums text-foreground-extra-muted">
            {dayTurns ? plural(dayTurns.length, 'turn') : '…'} · {plural(selectedStats?.total ?? 0, 'commit')}
            {!isToday && (
              <button
                type="button"
                className="ms-2 underline underline-offset-2 hover:text-foreground"
                onClick={() => setSelectedKey(dayKey(today))}
              >
                Back to today
              </button>
            )}
          </span>
        </div>
        {dayTurns === null ? (
          <div className="h-16 animate-pulse rounded-md bg-foreground/[0.04]" />
        ) : (
          <AgentDayTimeline dayStart={dayStart} turns={dayTurns} commits={dayCommits} now={now} onOpenThread={onOpenThread} sessionLabel={sessionLabel} />
        )}
      </div>
    </HomePanel>
  );
}

function DayTooltip({ day, stats }: { day: HeatCalendarDay; stats?: DayStats }) {
  const date = day.date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const agents = stats ? [...stats.byAgent.entries()].sort((a, b) => b[1] - a[1]) : [];
  const credited = agents.reduce((n, [, c]) => n + c, 0);
  const rest = (stats?.total ?? 0) - credited - (stats?.shared ?? 0);
  return (
    <>
      <div>
        <span className="font-medium text-foreground">{plural(day.count, 'commit')}</span>{' '}
        <span className="text-muted-foreground">on {date}</span>
      </div>
      {stats && stats.total > 0 && (agents.length > 0 || stats.shared > 0) && (
        <div className="mt-0.5 text-muted-foreground">
          {[
            ...agents.map(([name, n]) => `@${name} ${n}`),
            stats.shared > 0 ? `shared ${stats.shared}` : null,
            rest > 0 ? `other ${rest}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      )}
    </>
  );
}
