'use client';

import * as React from 'react';
import type { ActivityCommit, ActivityTurn } from '@/lib/generated/api-types';
import { deriveIdentityColor } from '@/lib/identity-colors';
import { cn } from '@/lib/utils';
import { anchorOf, ChartTooltip, type ChartAnchor } from './chart-tooltip';

/*
  One day of agent work, one lane per agent.

  A bar is a turn, from dispatch to the agent reporting back, so its length is
  how long the agent worked. A tick is a commit, drawn in the lane of the agent
  whose turn contained it; commits no single agent can be credited with sit in
  a separate "Commits" lane rather than being handed to anyone.

  The axis spans the hours that had activity, not the whole day: most turns
  last seconds to minutes, and on a 24-hour axis they are slivers nobody can
  point at. A turn whose agent never reported back has a start and no end, so
  it is a dot at its start rather than a bar to when the server gave up on it.
*/

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MIN_SPAN_HOURS = 3;
const PAD_MS = 20 * 60 * 1000;
const LABEL_PX = 52;

type Hover =
  | { kind: 'turn'; turn: ActivityTurn; anchor: ChartAnchor }
  | { kind: 'commit'; commit: ActivityCommit; anchor: ChartAnchor };

interface Lane {
  agent: string | null;
  turns: ActivityTurn[];
  commits: ActivityCommit[];
  additions: number;
  deletions: number;
}

export function clock(ms: number) {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function duration(ms: number) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

/** The part of the day worth drawing: every mark, padded and snapped to whole hours. */
function visibleRange(dayStart: number, times: number[]) {
  if (times.length === 0) return { fromH: 0, toH: 24 };
  const lo = Math.max(0, Math.min(...times) - dayStart - PAD_MS);
  const hi = Math.min(DAY_MS, Math.max(...times) - dayStart + PAD_MS);
  let fromH = Math.floor(lo / HOUR_MS);
  let toH = Math.ceil(hi / HOUR_MS);
  while (toH - fromH < MIN_SPAN_HOURS) {
    if (toH < 24) toH += 1;
    else fromH -= 1;
  }
  return { fromH, toH };
}

export function AgentDayTimeline({
  dayStart,
  turns,
  commits,
  now,
  onOpenThread,
  sessionLabel = (name) => `#${name}`,
  className,
}: {
  /** Local midnight of the day shown, unix ms. */
  dayStart: number;
  turns: ActivityTurn[];
  /** This day's commits only. */
  commits: ActivityCommit[];
  now: number;
  onOpenThread?: (channelName: string) => void;
  /** How to name a turn's session; channel names are ids, so callers map them to titles. */
  sessionLabel?: (channelName: string) => string;
  className?: string;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [hover, setHover] = React.useState<Hover | null>(null);
  const [width, setWidth] = React.useState(600);
  React.useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const dayEnd = dayStart + DAY_MS;
  const endOf = React.useCallback((turn: ActivityTurn) => turn.finished_at ?? Math.min(now, dayEnd), [now, dayEnd]);

  const lanes = React.useMemo(() => {
    const byAgent = new Map<string, Lane>();
    const lane = (agent: string) => {
      let l = byAgent.get(agent);
      if (!l) {
        l = { agent, turns: [], commits: [], additions: 0, deletions: 0 };
        byAgent.set(agent, l);
      }
      return l;
    };
    for (const turn of turns) {
      const l = lane(turn.agent_name);
      l.turns.push(turn);
      l.additions += turn.additions;
      l.deletions += turn.deletions;
    }
    const loose: Lane = { agent: null, turns: [], commits: [], additions: 0, deletions: 0 };
    for (const commit of commits) {
      if (commit.agent) lane(commit.agent).commits.push(commit);
      else loose.commits.push(commit);
    }
    const ordered = [...byAgent.values()].sort(
      (a, b) => b.turns.length - a.turns.length || (a.agent ?? '').localeCompare(b.agent ?? ''),
    );
    if (loose.commits.length) ordered.push(loose);
    return ordered;
  }, [turns, commits]);

  const { fromH, toH } = React.useMemo(() => {
    const times: number[] = [];
    for (const t of turns) {
      times.push(t.started_at);
      if (!t.end_unknown) times.push(endOf(t));
    }
    for (const c of commits) times.push(c.time);
    return visibleRange(dayStart, times);
  }, [turns, commits, dayStart, endOf]);

  const from = dayStart + fromH * HOUR_MS;
  const span = (toH - fromH) * HOUR_MS;
  // As many hour labels as fit without touching: a label is ~5ch, and the
  // track is the container minus the name column (and the totals column when
  // it is shown).
  const trackWidth = Math.max(120, width - (width >= 576 ? 104 + 128 + 24 : 104 + 12));
  const maxLabels = Math.max(2, Math.floor(trackWidth / LABEL_PX));
  const step = [1, 2, 3, 4, 6, 12].find((n) => (toH - fromH) / n + 1 <= maxLabels) ?? 12;
  const ticks: number[] = [];
  for (let h = fromH; h <= toH; h += step) ticks.push(h);
  const pos = (ms: number) => (Math.min(Math.max(ms - from, 0), span) / span) * 100;
  const nowVisible = now > from && now < from + span;

  const anchor = (el: Element) => (containerRef.current ? anchorOf(el, containerRef.current) : null);
  const showTurn = (turn: ActivityTurn, el: Element) => {
    const a = anchor(el);
    if (a) setHover({ kind: 'turn', turn, anchor: a });
  };
  const showCommit = (commit: ActivityCommit, el: Element) => {
    const a = anchor(el);
    if (a) setHover({ kind: 'commit', commit, anchor: a });
  };

  if (lanes.length === 0) {
    return (
      <p className={cn('py-6 text-center text-xs text-muted-foreground', className)}>
        No agent turns or commits on this day.
      </p>
    );
  }

  const cols = 'grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-3 @xl:grid-cols-[6.5rem_minmax(0,1fr)_8rem]';

  return (
    <div ref={containerRef} className={cn('relative', className)} onMouseLeave={() => setHover(null)}>
      <ul className="flex flex-col gap-1">
        {lanes.map((l) => {
          const color = l.agent ? deriveIdentityColor(l.agent) : undefined;
          return (
            <li key={l.agent ?? '__commits'} className={cols}>
              <span className="flex min-w-0 items-center gap-2 text-xs">
                <span
                  aria-hidden
                  className={cn('size-2 shrink-0 rounded-full', !color && 'bg-foreground/60')}
                  style={color ? { backgroundColor: color } : undefined}
                />
                <span className={cn('truncate', l.agent ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                  {l.agent ? `@${l.agent}` : 'Commits'}
                </span>
              </span>

              <div className="relative h-7 rounded-md bg-foreground/[0.05]">
                {ticks.slice(1, -1).map((h) => (
                  <span
                    key={h}
                    aria-hidden
                    className="absolute inset-y-0 w-px bg-border"
                    style={{ left: `${((h - fromH) / (toH - fromH)) * 100}%` }}
                  />
                ))}
                {nowVisible && (
                  <span aria-hidden className="absolute inset-y-0 w-px bg-status-warning/70" style={{ left: `${pos(now)}%` }} />
                )}

                {l.turns.map((turn) => {
                  const label = `@${turn.agent_name} in ${sessionLabel(turn.channel_name)}, from ${clock(turn.started_at)}`;
                  const events = {
                    onClick: () => onOpenThread?.(turn.channel_name),
                    onMouseEnter: (e: React.MouseEvent) => showTurn(turn, e.currentTarget),
                    onFocus: (e: React.FocusEvent) => showTurn(turn, e.currentTarget),
                    onBlur: () => setHover(null),
                  };
                  if (turn.end_unknown) {
                    return (
                      <button
                        key={turn.id}
                        type="button"
                        aria-label={`${label}, end not reported`}
                        {...events}
                        className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card outline-none focus-visible:ring-ring"
                        style={{ left: `${pos(turn.started_at)}%`, backgroundColor: color }}
                      />
                    );
                  }
                  const left = pos(turn.started_at);
                  return (
                    <button
                      key={turn.id}
                      type="button"
                      aria-label={`${label} to ${turn.finished_at ? clock(endOf(turn)) : 'now'}`}
                      {...events}
                      className={cn(
                        'absolute top-2 h-3 min-w-1 rounded-sm outline-none transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring',
                        turn.finished_at ? 'opacity-90' : 'opacity-60',
                      )}
                      style={{ left: `${left}%`, width: `${pos(endOf(turn)) - left}%`, backgroundColor: color }}
                    />
                  );
                })}

                {l.commits.map((commit) => (
                  <button
                    key={commit.hash}
                    type="button"
                    aria-label={`Commit ${commit.hash.slice(0, 7)} at ${clock(commit.time)}: ${commit.subject}`}
                    onMouseEnter={(e) => showCommit(commit, e.currentTarget)}
                    onFocus={(e) => showCommit(commit, e.currentTarget)}
                    onBlur={() => setHover(null)}
                    className="absolute inset-y-0 w-2 -translate-x-1/2 outline-none focus-visible:ring-2 focus-visible:ring-ring before:absolute before:inset-y-1 before:left-1/2 before:w-0.5 before:-translate-x-1/2 before:rounded-full before:bg-foreground/80 hover:before:bg-foreground"
                    style={{ left: `${pos(commit.time)}%` }}
                  />
                ))}
              </div>

              <span className="hidden truncate text-right text-2xs tabular-nums text-muted-foreground @xl:block">
                {l.agent ? (
                  <>
                    {l.turns.length} {l.turns.length === 1 ? 'turn' : 'turns'}
                    {(l.additions > 0 || l.deletions > 0) && (
                      <span className="ms-1.5 font-mono">
                        <span className="text-status-success">+{l.additions}</span>{' '}
                        <span className="text-status-danger">−{l.deletions}</span>
                      </span>
                    )}
                  </>
                ) : (
                  `${l.commits.length} unattributed`
                )}
              </span>
            </li>
          );
        })}
      </ul>

      <div aria-hidden className={cn(cols, 'mt-1.5')}>
        <span />
        <div className="relative h-4 text-2xs tabular-nums text-muted-foreground">
          {ticks.map((h, i) => (
            <span
              key={h}
              className={cn(
                'absolute top-0',
                i === 0 ? '' : i === ticks.length - 1 && h === toH ? '-translate-x-full' : '-translate-x-1/2',
              )}
              style={{ left: `${((h - fromH) / (toH - fromH)) * 100}%` }}
            >
              {String(h).padStart(2, '0')}:00
            </span>
          ))}
        </div>
      </div>

      {hover?.kind === 'turn' && (
        <ChartTooltip anchor={hover.anchor}>
          <div className="font-medium text-foreground">
            @{hover.turn.agent_name} <span className="font-normal text-muted-foreground">in {sessionLabel(hover.turn.channel_name)}</span>
          </div>
          <div className="mt-0.5 tabular-nums text-muted-foreground">
            {hover.turn.end_unknown
              ? `Started ${clock(hover.turn.started_at)} · end not reported`
              : hover.turn.finished_at
                ? `${clock(hover.turn.started_at)}–${clock(hover.turn.finished_at)} · ${duration(hover.turn.finished_at - hover.turn.started_at)}`
                : `Since ${clock(hover.turn.started_at)} · running`}
          </div>
          {hover.turn.file_count > 0 && (
            <div className="mt-0.5 font-mono tabular-nums text-muted-foreground">
              +{hover.turn.additions} −{hover.turn.deletions} · {hover.turn.file_count} {hover.turn.file_count === 1 ? 'file' : 'files'}
            </div>
          )}
          {hover.turn.contended && <div className="mt-0.5 text-muted-foreground">Another agent was editing the same folder</div>}
        </ChartTooltip>
      )}
      {hover?.kind === 'commit' && (
        <ChartTooltip anchor={hover.anchor} className="max-w-72 whitespace-normal">
          <div className="truncate font-medium text-foreground">{hover.commit.subject || '(no message)'}</div>
          <div className="mt-0.5 tabular-nums text-muted-foreground">
            <span className="font-mono">{hover.commit.hash.slice(0, 7)}</span> · {hover.commit.repo} · {clock(hover.commit.time)}
            {hover.commit.shared && ' · several agents were working'}
          </div>
        </ChartTooltip>
      )}
    </div>
  );
}
