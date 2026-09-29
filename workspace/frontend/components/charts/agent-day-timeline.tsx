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

  A turn whose agent never reported back has a start and no end. It is drawn as
  a hollow marker at its start -- stretching it to when the server gave up on
  it would draw work that may never have happened.
*/

const DAY_MS = 24 * 60 * 60 * 1000;
const HOURS = [0, 6, 12, 18, 24];

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

function clock(ms: number) {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function duration(ms: number) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
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
  const dayEnd = dayStart + DAY_MS;
  const nowInDay = now >= dayStart && now < dayEnd;

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

  const pct = (ms: number) => `${(Math.min(Math.max(ms - dayStart, 0), DAY_MS) / DAY_MS) * 100}%`;
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

  return (
    <div ref={containerRef} className={cn('relative', className)} onMouseLeave={() => setHover(null)}>
      <ul className="flex flex-col gap-1.5">
        {lanes.map((l) => {
          const color = l.agent ? deriveIdentityColor(l.agent) : undefined;
          return (
            <li key={l.agent ?? '__commits'} className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-3 @md:grid-cols-[5.5rem_minmax(0,1fr)_7.5rem]">
              <span className="flex min-w-0 items-center gap-1.5 text-xs">
                {color ? (
                  <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                ) : (
                  <span aria-hidden className="size-1.5 shrink-0" />
                )}
                <span className={cn('truncate', l.agent ? 'text-foreground' : 'text-muted-foreground')}>
                  {l.agent ? `@${l.agent}` : 'Commits'}
                </span>
              </span>

              <div className="relative h-6 rounded-sm bg-foreground/[0.04]">
                {HOURS.slice(1, -1).map((h) => (
                  <span key={h} aria-hidden className="absolute inset-y-0 w-px bg-border/70" style={{ left: `${(h / 24) * 100}%` }} />
                ))}
                {nowInDay && (
                  <span aria-hidden className="absolute inset-y-0 w-px bg-foreground/35" style={{ left: pct(now) }} />
                )}

                {l.turns.map((turn) => {
                  const label = `@${turn.agent_name} in ${sessionLabel(turn.channel_name)}, from ${clock(turn.started_at)}`;
                  if (turn.end_unknown) {
                    return (
                      <button
                        key={turn.id}
                        type="button"
                        aria-label={`${label}, end not reported`}
                        onClick={() => onOpenThread?.(turn.channel_name)}
                        onMouseEnter={(e) => showTurn(turn, e.currentTarget)}
                        onFocus={(e) => showTurn(turn, e.currentTarget)}
                        onBlur={() => setHover(null)}
                        className="absolute top-1.5 h-3 w-1.5 rounded-[2px] border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        style={{ left: pct(turn.started_at), borderColor: color }}
                      />
                    );
                  }
                  const end = turn.finished_at ?? now;
                  return (
                    <button
                      key={turn.id}
                      type="button"
                      aria-label={`${label} to ${turn.finished_at ? clock(end) : 'now'}`}
                      onClick={() => onOpenThread?.(turn.channel_name)}
                      onMouseEnter={(e) => showTurn(turn, e.currentTarget)}
                      onFocus={(e) => showTurn(turn, e.currentTarget)}
                      onBlur={() => setHover(null)}
                      className={cn(
                        'absolute top-1.5 h-3 min-w-[3px] rounded-[2px] outline-none transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-ring',
                        turn.finished_at ? 'opacity-80' : 'opacity-60',
                      )}
                      style={{
                        left: pct(turn.started_at),
                        width: `calc(${pct(end)} - ${pct(turn.started_at)})`,
                        backgroundColor: color,
                      }}
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
                    className="absolute inset-y-0 w-[5px] -translate-x-1/2 outline-none focus-visible:ring-2 focus-visible:ring-ring before:absolute before:inset-y-0.5 before:left-1/2 before:w-[1.5px] before:-translate-x-1/2 before:rounded-full before:bg-foreground"
                    style={{ left: pct(commit.time) }}
                  />
                ))}
              </div>

              <span className="hidden truncate text-right text-2xs tabular-nums text-foreground-extra-muted @md:block">
                {l.agent ? (
                  <>
                    {l.turns.length} {l.turns.length === 1 ? 'turn' : 'turns'}
                    {(l.additions > 0 || l.deletions > 0) && (
                      <span className="ms-1.5 font-mono">
                        +{l.additions} −{l.deletions}
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

      <div aria-hidden className="mt-1 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 @md:grid-cols-[5.5rem_minmax(0,1fr)_7.5rem]">
        <span />
        <div className="relative h-3 text-2xs tabular-nums text-foreground-extra-muted">
          {HOURS.map((h) => (
            <span
              key={h}
              className={cn('absolute top-0', h === 0 ? '' : h === 24 ? '-translate-x-full' : '-translate-x-1/2')}
              style={{ left: `${(h / 24) * 100}%` }}
            >
              {String(h).padStart(2, '0')}
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
