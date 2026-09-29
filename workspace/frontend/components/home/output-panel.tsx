'use client';

import * as React from 'react';
import { ChevronDown, RotateCw } from 'lucide-react';
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
import { OutputDayLists } from './output-day-lists';

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

/** Below this panel width the stats move under the calendar instead of beside it. */
const SIDE_STATS_MIN = 820;
const SIDE_STATS_WIDTH = 220;
const SIDE_GAP = 28;
const MIN_CELL = 10;
const MAX_CELL = 15;

/**
 * Fits the calendar to the width it actually has: as many weeks as fit at the
 * smallest cell, up to a year, then cells grown to use the remaining width, so
 * a wide panel is filled rather than left with an empty strip on the right.
 */
function useCalendarFit(ref: React.RefObject<HTMLElement | null>, active: boolean) {
  const [fit, setFit] = React.useState({ weeks: 20, cell: HEAT_CELL, side: false });
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const measure = () => {
      const width = el.clientWidth;
      const side = width >= SIDE_STATS_MIN;
      const room = (side ? width - SIDE_STATS_WIDTH - SIDE_GAP : width) - HEAT_LABEL_WIDTH + HEAT_GAP;
      const weeks = Math.max(MIN_WEEKS, Math.min(FETCH_WEEKS, Math.floor(room / (MIN_CELL + HEAT_GAP))));
      const cell = Math.max(MIN_CELL, Math.min(MAX_CELL, Math.floor(room / weeks) - HEAT_GAP));
      setFit((prev) => (prev.weeks === weeks && prev.cell === cell && prev.side === side ? prev : { weeks, cell, side }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, active]);
  return fit;
}

const OPEN_KEY = 'home.output.open';

/** Collapsed unless the viewer opened it before; storage may be blocked. */
function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeOpen(open: boolean) {
  try {
    window.localStorage.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {
    /* per-viewer convenience only */
  }
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
  // Read after mount so the server render and the first client render agree.
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => setOpen(readOpen()), []);
  const { weeks, cell, side } = useCalendarFit(measureRef, open);

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

  const summary = React.useMemo(() => {
    let total = 0;
    let byAgents = 0;
    let activeDays = 0;
    let shownDays = 0;
    let busiest: HeatCalendarDay | null = null;
    for (const d of days) {
      if (d.future) continue;
      shownDays += 1;
      const s = statsByDay.get(d.key);
      if (!s) continue;
      total += s.total;
      activeDays += 1;
      for (const n of s.byAgent.values()) byAgents += n;
      if (!busiest || d.count > busiest.count) busiest = d;
    }
    const weekStart = addDays(today, -((today.getDay() + 6) % 7)).getTime();
    const monthStart = addDays(today, -29).getTime();
    const shownFrom = days[0]?.date.getTime() ?? 0;
    let thisWeek = 0;
    let last30 = 0;
    const repoCounts = new Map<string, number>();
    for (const c of data?.commits ?? []) {
      if (c.time >= weekStart) thisWeek += 1;
      if (c.time >= monthStart) last30 += 1;
      if (c.time >= shownFrom) repoCounts.set(c.repo, (repoCounts.get(c.repo) ?? 0) + 1);
    }
    const repos = (data?.repos ?? [])
      .filter((r) => !r.error)
      .map((r) => ({ name: r.name, path: r.path, count: repoCounts.get(r.name) ?? 0 }))
      .sort((a, b) => b.count - a.count);
    return { total, byAgents, activeDays, shownDays, busiest, thisWeek, last30, repos };
  }, [days, statsByDay, data, today]);

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
  const unreadable = repos.filter((r) => r.error).length;
  const selectedDate = keyToDate(selectedKey);
  const selectedStats = statsByDay.get(selectedKey);

  const dayLabel = isToday
    ? 'Today'
    : selectedDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const dayDiff = (dayTurns ?? []).reduce(
    (acc, t) => ({ add: acc.add + t.additions, del: acc.del + t.deletions }),
    { add: 0, del: 0 },
  );

  const toggle = () => {
    const next = !open;
    setOpen(next);
    writeOpen(next);
    // Collapsed, the summary line is about today; a day picked in the calendar
    // would leave it describing something else.
    if (!next) setSelectedKey(dayKey(today));
  };

  // Collapsed: today only, from data already fetched for the calendar and lanes.
  const todayTurns = isToday ? dayTurns : null;
  const collapsedSubtitle = noRepos
    ? 'No git repository is linked to this workspace yet.'
    : data === null
      ? 'Loading today…'
      : `Today: ${plural(statsByDay.get(dayKey(today))?.total ?? 0, 'commit')}${todayTurns ? ` · ${plural(todayTurns.length, 'turn')}` : ''}.`;

  return (
    <HomePanel
      id="home-output"
      className={className}
      title="Output"
      subtitle={
        !open
          ? collapsedSubtitle
          : data === null || noRepos
            ? 'Commits in your project repositories, and what each agent did.'
            : `${plural(summary.total, 'commit')} in the last ${weeks} weeks${summary.byAgents ? `, ${summary.byAgents} made during agent turns` : ''}.`
      }
      action={
        <div className="flex items-center gap-0.5">
          {open && (
            <Hint label="Refresh">
              <Button variant="ghost" size="icon" className="size-7" onClick={refresh} disabled={refreshing} aria-label="Refresh output">
                <RotateCw className={cn('size-3.5', refreshing && 'animate-spin')} />
              </Button>
            </Hint>
          )}
          <Hint label={open ? 'Collapse' : 'Show calendar and timeline'}>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={toggle}
              aria-expanded={open}
              aria-controls="home-output-body"
              aria-label={open ? 'Collapse output' : 'Expand output'}
            >
              <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
            </Button>
          </Hint>
        </div>
      }
    >
      {open ? (
        <div id="home-output-body">
          <div ref={measureRef} className="min-w-0">
            {noRepos ? (
              <p className="rounded-lg border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
                No git repository is linked to this workspace yet. Pick a project folder when you start a session and its
                commits show up here.
              </p>
            ) : (
              <div
                className={cn('flex min-w-0', side ? 'flex-row items-start justify-between' : 'flex-col gap-4')}
                style={side ? { gap: SIDE_GAP } : undefined}
              >
                <HeatCalendar days={days} unit="commit" cellSize={cell} selectedKey={selectedKey} onSelect={onSelect} className="min-w-0">
                  <HeatCalendarGrid>
                    <HeatCalendarTooltip>{(day) => <DayTooltip day={day} stats={statsByDay.get(day.key)} />}</HeatCalendarTooltip>
                  </HeatCalendarGrid>
                  <HeatCalendarLegend>
                    {error ? (
                      <span className="text-status-danger">{error}</span>
                    ) : unreadable > 0 ? (
                      <span>
                        {unreadable} {unreadable === 1 ? 'repository' : 'repositories'} could not be read
                      </span>
                    ) : null}
                  </HeatCalendarLegend>
                </HeatCalendar>
                {data !== null && <OutputStats side={side} summary={summary} onSelectDay={setSelectedKey} />}
              </div>
            )}
          </div>

          <div className="mt-5 border-t border-border pt-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
                <h3 className="text-sm font-semibold tracking-tight text-foreground">{dayLabel}</h3>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {dayTurns ? plural(dayTurns.length, 'turn') : '…'} · {plural(selectedStats?.total ?? 0, 'commit')}
                  {(dayDiff.add > 0 || dayDiff.del > 0) && (
                    <span className="ms-2 font-mono">
                      <span className="text-status-success">+{dayDiff.add}</span>{' '}
                      <span className="text-status-danger">−{dayDiff.del}</span>
                    </span>
                  )}
                </span>
              </div>
              {!isToday && (
                <Button variant="ghost" size="sm" className="h-6 px-2 text-2xs" onClick={() => setSelectedKey(dayKey(today))}>
                  Back to today
                </Button>
              )}
            </div>
            {dayTurns === null ? (
              <div className="h-24 animate-pulse rounded-md bg-foreground/[0.04]" />
            ) : (
              <>
                <AgentDayTimeline
                  dayStart={dayStart}
                  turns={dayTurns}
                  commits={dayCommits}
                  now={now}
                  onOpenThread={onOpenThread}
                  sessionLabel={sessionLabel}
                />
                {(dayTurns.length > 0 || dayCommits.length > 0) && (
                  <OutputDayLists
                    className="mt-5"
                    commits={dayCommits}
                    turns={dayTurns}
                    now={now}
                    sessionLabel={sessionLabel}
                    onOpenThread={onOpenThread}
                  />
                )}
              </>
            )}
          </div>
        </div>
      ) : undefined}
    </HomePanel>
  );
}

interface Summary {
  total: number;
  byAgents: number;
  activeDays: number;
  shownDays: number;
  busiest: HeatCalendarDay | null;
  thisWeek: number;
  last30: number;
  repos: { name: string; path: string; count: number }[];
}

function Stat({
  label,
  value,
  detail,
  onClick,
}: {
  label: string;
  value: React.ReactNode;
  detail?: React.ReactNode;
  onClick?: () => void;
}) {
  const body = (
    <>
      <span className="block text-2xs text-muted-foreground">{label}</span>
      <span className="mt-0.5 block text-lg font-semibold leading-tight tabular-nums text-foreground">{value}</span>
      {detail && <span className="block truncate text-2xs text-foreground-extra-muted">{detail}</span>}
    </>
  );
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className="min-w-0 rounded-md text-left outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
    >
      {body}
    </button>
  ) : (
    <div className="min-w-0">{body}</div>
  );
}

/** Numbers read off the same commits the calendar draws; nothing here is estimated. */
function OutputStats({
  side,
  summary,
  onSelectDay,
}: {
  side: boolean;
  summary: Summary;
  onSelectDay: (key: string) => void;
}) {
  const maxRepo = Math.max(1, ...summary.repos.map((r) => r.count));
  const busiest = summary.busiest;
  return (
    <div className={cn('min-w-0', side ? 'shrink-0' : 'w-full')} style={side ? { width: SIDE_STATS_WIDTH } : undefined}>
      <div className={cn('grid gap-x-4 gap-y-3', side ? 'grid-cols-2' : 'grid-cols-2 @xl:grid-cols-4')}>
        <Stat label="This week" value={summary.thisWeek} />
        <Stat label="Last 30 days" value={summary.last30} />
        <Stat label="Active days" value={summary.activeDays} detail={`of ${summary.shownDays}`} />
        <Stat
          label="Busiest day"
          value={busiest ? busiest.count : '–'}
          detail={busiest ? busiest.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : undefined}
          onClick={busiest ? () => onSelectDay(busiest.key) : undefined}
        />
      </div>
      {summary.repos.length > 0 && (
        <div className="mt-4">
          <div className="mb-1.5 text-2xs text-muted-foreground">By repository</div>
          <ul className={cn('grid gap-y-1.5', !side && 'gap-x-6 @xl:grid-cols-2')}>
            {summary.repos.map((r) => (
              <li key={r.path} className="text-xs">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-foreground">{r.name}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{r.count}</span>
                </div>
                <div className="mt-0.5 h-1 rounded-full bg-foreground/[0.06]">
                  <div className="h-full rounded-full bg-foreground/45" style={{ width: `${(r.count / maxRepo) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
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
