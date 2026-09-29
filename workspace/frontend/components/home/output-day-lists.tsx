'use client';

import * as React from 'react';
import { clock, duration } from '@/components/charts/agent-day-timeline';
import type { ActivityCommit, ActivityTurn } from '@/lib/generated/api-types';
import { deriveIdentityColor } from '@/lib/identity-colors';
import { cn } from '@/lib/utils';

/*
  The selected day as text. The lanes above show when; these say what -- the
  commit messages and the sessions -- so a day can be read without hovering
  over marks a few pixels wide.
*/

const COLLAPSED = 6;

function AgentTag({ name }: { name: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: deriveIdentityColor(name) }} />
      <span className="truncate">@{name}</span>
    </span>
  );
}

function ListSection<T>({
  title,
  items,
  empty,
  render,
}: {
  title: string;
  items: T[];
  empty: string;
  render: (item: T) => React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const shown = open ? items : items.slice(0, COLLAPSED);
  return (
    <section className="min-w-0">
      <h4 className="mb-1 flex items-baseline justify-between text-2xs font-medium text-muted-foreground">
        {title}
        <span className="tabular-nums text-foreground-extra-muted">{items.length}</span>
      </h4>
      {items.length === 0 ? (
        <p className="py-2 text-xs text-foreground-extra-muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-border/60">{shown.map(render)}</ul>
      )}
      {items.length > COLLAPSED && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="mt-1 text-2xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {open ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </section>
  );
}

export function OutputDayLists({
  commits,
  turns,
  now,
  sessionLabel,
  onOpenThread,
  className,
}: {
  commits: ActivityCommit[];
  turns: ActivityTurn[];
  now: number;
  sessionLabel: (channelName: string) => string;
  onOpenThread?: (channelName: string) => void;
  className?: string;
}) {
  const sortedCommits = React.useMemo(() => [...commits].sort((a, b) => b.time - a.time), [commits]);
  const sortedTurns = React.useMemo(() => [...turns].sort((a, b) => b.started_at - a.started_at), [turns]);

  return (
    <div className={cn('grid grid-cols-1 gap-x-6 gap-y-4 @3xl:grid-cols-2', className)}>
      <ListSection
        title="Commits"
        items={sortedCommits}
        empty="No commits on this day."
        render={(c) => (
          <li key={c.hash} className="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-2 py-1.5 text-xs">
            <span className="pt-px font-mono text-2xs tabular-nums text-muted-foreground">{clock(c.time)}</span>
            <span className="min-w-0">
              <span className="block truncate text-foreground">{c.subject || '(no message)'}</span>
              <span className="mt-0.5 flex min-w-0 items-center gap-2 text-2xs text-muted-foreground">
                <span className="truncate">{c.repo}</span>
                <span className="shrink-0 font-mono text-foreground-extra-muted">{c.hash.slice(0, 7)}</span>
                {c.agent ? (
                  <span className="ms-auto min-w-0 shrink">
                    <AgentTag name={c.agent} />
                  </span>
                ) : c.shared ? (
                  <span className="ms-auto shrink-0">several agents</span>
                ) : null}
              </span>
            </span>
          </li>
        )}
      />
      <ListSection
        title="Agent turns"
        items={sortedTurns}
        empty="No agent turns on this day."
        render={(t) => {
          const time = t.end_unknown
            ? `${clock(t.started_at)}, end not reported`
            : t.finished_at
              ? duration(t.finished_at - t.started_at)
              : `running ${duration(now - t.started_at)}`;
          return (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => onOpenThread?.(t.channel_name)}
                className="grid w-full grid-cols-[2.75rem_minmax(0,1fr)] gap-2 rounded-sm py-1.5 text-left text-xs outline-none hover:bg-surface2/60 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="pt-px font-mono text-2xs tabular-nums text-muted-foreground">{clock(t.started_at)}</span>
                <span className="min-w-0">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 shrink-0 font-medium text-foreground">
                      <AgentTag name={t.agent_name} />
                    </span>
                    <span className="truncate text-muted-foreground">{sessionLabel(t.channel_name)}</span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-2 text-2xs tabular-nums text-muted-foreground">
                    <span>{time}</span>
                    {t.file_count > 0 && (
                      <span className="font-mono">
                        <span className="text-status-success">+{t.additions}</span>{' '}
                        <span className="text-status-danger">−{t.deletions}</span>
                        <span className="text-foreground-extra-muted">
                          {' '}
                          · {t.file_count} {t.file_count === 1 ? 'file' : 'files'}
                        </span>
                      </span>
                    )}
                  </span>
                </span>
              </button>
            </li>
          );
        }}
      />
    </div>
  );
}
