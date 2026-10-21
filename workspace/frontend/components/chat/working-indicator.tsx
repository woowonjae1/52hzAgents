'use client';

import { cn } from '@/lib/utils';
import { useElapsedFrom } from '@/lib/use-elapsed';
import { useReducedMotion } from 'motion/react';

/**
 * 52Hz Sonic Resonance Waveform:
 * 5 vertical harmonic bars that undulate with phase offsets, evoking
 * a deep-sea acoustic frequency pulse for 52hzAgents.
 * Respects prefers-reduced-motion both via CSS and React motion hook.
 */
function SonarWave({ className }: { className?: string }) {
  const shouldReduceMotion = useReducedMotion();

  return (
    <span
      aria-hidden
      className={cn('inline-flex items-center gap-[2px] h-3.5 px-0.5 select-none', className)}
    >
      {[0.4, 0.75, 1.0, 0.75, 0.4].map((height, i) => (
        <span
          key={i}
          className={cn(
            'w-[2px] rounded-full bg-brand',
            !shouldReduceMotion && 'animate-sonar-bar'
          )}
          style={{
            height: shouldReduceMotion ? '8px' : `${Math.round(height * 11)}px`,
            animationDelay: shouldReduceMotion ? undefined : `${i * 120}ms`,
          }}
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
        <SonarWave />
      </span>
      <span className="event-running text-xs font-medium">{label}</span>
      {elapsed && (
        <span aria-hidden className="font-mono text-3xs tabular-nums text-foreground-extra-muted">
          {elapsed}
        </span>
      )}
    </div>
  );
}
