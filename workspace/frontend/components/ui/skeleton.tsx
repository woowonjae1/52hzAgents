'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A PLACEHOLDER SHAPED LIKE THE THING THAT IS COMING.
 *
 * This app had 82 spinners and one skeleton. A centred spinner is a web
 * pattern: it tells you "something is happening somewhere" and throws away
 * every bit of structure the pane is about to have, so the content arrives as
 * a jump-cut. Native list views draw the rows first and fill them in, which is
 * why a Finder window or a mail client never appears to flash.
 *
 * `motion-reduce:animate-none` because a pulsing block is exactly the kind of
 * ambient movement that reduced-motion asks to stop.
 */
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden
      className={cn(
        'animate-pulse rounded-md bg-surface2 motion-reduce:animate-none',
        className,
      )}
      {...props}
    />
  );
}

/**
 * The list case, which is most of them: N rows of an icon, a title and a
 * shorter subtitle. `widths` varies the title length so the block does not
 * read as a striped pattern — real lists are ragged.
 */
export function SkeletonRows({
  rows = 6,
  className,
  showAvatar = true,
  showSubtitle = true,
}: {
  rows?: number;
  className?: string;
  showAvatar?: boolean;
  showSubtitle?: boolean;
}) {
  const widths = ['72%', '54%', '84%', '46%', '66%', '78%', '58%', '70%'];
  return (
    <div className={cn('space-y-1', className)} aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-2.5 px-2 py-2">
          {showAvatar && <Skeleton className="size-7 rounded-lg shrink-0" />}
          <div className="flex-1 min-w-0 space-y-1.5">
            <Skeleton className="h-2.5" style={{ width: widths[i % widths.length] }} />
            {showSubtitle && (
              <Skeleton
                className="h-2 opacity-60"
                style={{ width: `${30 + ((i * 13) % 25)}%` }}
              />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Card grids — skills, knowledge, monitor tiles. */
export function SkeletonCards({
  count = 6,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div className={cn('grid gap-3 sm:grid-cols-2 lg:grid-cols-3', className)} aria-hidden>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-xl border border-border bg-card p-4 space-y-3">
          <div className="flex items-center gap-2.5">
            <Skeleton className="size-8 rounded-lg shrink-0" />
            <Skeleton className="h-2.5 flex-1" style={{ width: '60%' }} />
          </div>
          <Skeleton className="h-2" />
          <Skeleton className="h-2 w-2/3 opacity-60" />
        </div>
      ))}
    </div>
  );
}
