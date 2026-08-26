'use client';

import { cn } from '@/lib/utils';
import { useElapsedFrom } from '@/lib/use-elapsed';

/**
 * The live edge of a transcript: the one row that says work is happening right
 * now, and how long it has been happening.
 *
 * Three parts, each saying something the other two do not:
 *   - the pixel grid — motion, so the row is findable without reading it
 *   - the label      — what kind of work (shimmering, the app's one running signal)
 *   - the clock      — how long, which is what the reader is deciding about
 *
 * This replaced three bouncing dots in a bordered, blurred, shadowed pill. The
 * dots carried no information: "still going" was already implied by the absence
 * of an answer. Worse, the pill was rendered in two places at once — inside the
 * step rail AND beside the avatar — so a single working agent announced itself
 * twice on adjacent lines, on top of the shimmer already running in the channel
 * header. There is now one of these per channel.
 */

/**
 * Chevron wavefront. `(column + |row - 1|) * 90ms` puts the middle row ahead of
 * the outer two, so the front reads as a `>` driving rightwards rather than as a
 * column sweeping across. 90ms a step against a 650ms cycle keeps two fronts on
 * the grid at once, which is what stops it looking like a stutter.
 */
const CELL_DELAYS = Array.from({ length: 9 }, (_, i) => {
  const row = Math.floor(i / 3);
  const column = i % 3;
  return (column + Math.abs(row - 1)) * 90;
});

function PixelGrid() {
  return (
    <span aria-hidden className="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]">
      {CELL_DELAYS.map((delay, index) => (
        <span
          key={index}
          // `bg-current` rather than a token: the grid then belongs to whatever
          // text colour it sits beside, including a destructive row, without a
          // second colour being chosen here.
          className="pixel-cell size-[4px] rounded-[1px] bg-current"
          style={{ opacity: 0.14, animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

export function WorkingIndicator({
  label = 'Working',
  /** Epoch ms the run began. Without it the clock is simply omitted. */
  startTime,
  className,
}: {
  label?: string;
  startTime?: number | null;
  className?: string;
}) {
  const elapsed = useElapsedFrom(startTime);

  return (
    <div
      className={cn('inline-flex items-baseline gap-2 text-foreground-muted', className)}
      role="status"
    >
      <span className="translate-y-[-1px] self-center">
        <PixelGrid />
      </span>
      <span className="event-running text-xs">{label}</span>
      {elapsed && (
        // `aria-hidden` on the number: it changes ten times a second, and a live
        // region announcing that would make the page unusable with a screen
        // reader. `role="status"` on the wrapper announces the label once, which
        // is the part worth hearing.
        <span aria-hidden className="font-mono text-3xs tabular-nums text-foreground-extra-muted">
          {elapsed}
        </span>
      )}
    </div>
  );
}
