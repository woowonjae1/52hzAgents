'use client';

import { cn } from '@/lib/utils';

/**
 * Option 3: Modern Fluid Bouncing Glowing Dots indicator.
 * 3 micro-orbs moving with smooth cubic-bezier physics and gentle breathing glow.
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
          style={{ animationDelay: `${i * 0.18}s` }}
        />
      ))}
    </div>
  );
}
