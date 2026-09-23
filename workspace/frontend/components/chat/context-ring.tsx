'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { contextLevel } from '@/lib/use-agent-contexts';

const R = 7;
const C = 2 * Math.PI * R;

/**
 * A ring that fills as an agent's context window does.
 *
 * Grey until it matters: the status colour is spent only from 60% (amber) and
 * 85% (red), so a ring that turns colour is always worth a look. `pct` null
 * means the size or the window is unknown -- drawn as an empty track, never as
 * 0%, because "we don't know" and "empty" are different claims.
 */
export function ContextRing({
  pct,
  size = 16,
  className,
}: {
  pct: number | null;
  size?: number;
  className?: string;
}) {
  const level = contextLevel(pct);
  return (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      className={cn('-rotate-90 shrink-0', className)}
      aria-hidden
    >
      <circle
        cx="10"
        cy="10"
        r={R}
        fill="none"
        strokeWidth="2.5"
        className="stroke-border"
        strokeDasharray={level === 'unknown' ? '2 2.4' : undefined}
      />
      {pct !== null && pct > 0 && (
        <circle
          cx="10"
          cy="10"
          r={R}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={`${(Math.min(pct, 100) / 100) * C} ${C}`}
          className={cn(
            'transition-all duration-500',
            level === 'critical'
              ? 'stroke-status-danger'
              : level === 'warning'
                ? 'stroke-status-warning'
                : 'stroke-foreground-muted'
          )}
        />
      )}
    </svg>
  );
}
