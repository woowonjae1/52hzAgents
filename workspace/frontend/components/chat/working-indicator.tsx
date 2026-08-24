'use client';

import { cn } from '@/lib/utils';

/**
 * The "agent is working" indicator: three dots that travel once as a wave and
 * then hold, rather than bouncing continuously. Motion lives in `.fluid-dot`
 * (styles/globals.css), including the reduced-motion fallback.
 *
 * The stagger is deliberately a fraction of the 1.4s cycle: at 0.16s a step the
 * three peaks land inside the cycle's active phase, so the wave reads as one
 * gesture instead of three unrelated pulses.
 */
export function WorkingIndicator({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-surface2/60 border border-border/40 text-foreground shadow-2xs backdrop-blur-xs',
        className
      )}
      role="status"
      aria-label="Thinking"
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="fluid-dot size-1.5 rounded-full bg-current inline-block"
          style={{ animationDelay: `${i * 0.16}s` }}
        />
      ))}
    </div>
  );
}
