'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A hover card for a mark inside a chart.
 *
 * Charts here draw dozens to hundreds of marks, so one floating card owned by
 * the chart replaces a Radix tooltip per mark. The chart's container must be
 * `position: relative`; the anchor is the mark's top-centre in that container's
 * coordinates, which `anchorOf` computes from the hovered element.
 */
export interface ChartAnchor {
  x: number;
  y: number;
  /** Container width, so the card can be kept inside it. */
  width: number;
}

export function anchorOf(target: Element, container: Element): ChartAnchor {
  const t = target.getBoundingClientRect();
  const c = container.getBoundingClientRect();
  return { x: t.left - c.left + t.width / 2, y: t.top - c.top, width: c.width };
}

export function ChartTooltip({
  anchor,
  children,
  className,
}: {
  anchor: ChartAnchor | null;
  children: React.ReactNode;
  className?: string;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [cardWidth, setCardWidth] = React.useState(0);

  React.useLayoutEffect(() => {
    if (ref.current) setCardWidth(ref.current.offsetWidth);
  }, [anchor, children]);

  if (!anchor) return null;
  const half = cardWidth / 2;
  const x = cardWidth ? Math.min(Math.max(anchor.x, half), Math.max(half, anchor.width - half)) : anchor.x;

  return (
    <div
      ref={ref}
      role="tooltip"
      style={{ left: x, top: anchor.y }}
      className={cn(
        'pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-[calc(100%+6px)] whitespace-nowrap',
        'rounded-md border border-border bg-popover px-2 py-1.5 text-2xs text-popover-foreground shadow-sm',
        className,
      )}
    >
      {children}
    </div>
  );
}
