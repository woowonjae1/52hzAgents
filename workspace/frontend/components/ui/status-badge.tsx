import * as React from 'react';
import { cn } from '@/lib/utils';

export type StatusBadgeVariant = 'success' | 'error' | 'warning' | 'merged' | 'muted' | 'info';

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: string;
  variant?: StatusBadgeVariant;
  showDot?: boolean;
  /**
   * Use the muted status tier. Pick this when the same badge repeats on every row
   * of a dense list — at full strength the list itself becomes the loudest thing
   * on screen. The full tier is for a surface whose job is to report the status.
   */
  dense?: boolean;
}

/**
 * Paseo status badge: a 10%-alpha fill of the status hue with an optional dot.
 *
 * Colours come from the normalized status tokens, not raw Tailwind palette steps.
 * Every hue in a tier shares one lightness and one chroma fraction, which is what
 * makes four different hues read as one family — substituting `emerald-500` and
 * friends here reintroduces exactly the uneven loudness that scale exists to fix.
 */
export function StatusBadge({
  label,
  variant = 'muted',
  showDot = false,
  dense = false,
  className,
  children,
  ...props
}: StatusBadgeProps) {
  const text = label || children;

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-normal transition-colors border',
        variant === 'success' && (dense
          ? 'bg-status-muted-success/10 border-status-muted-success/20 text-status-muted-success'
          : 'bg-status-success/10 border-status-success/20 text-status-success'),
        variant === 'error' && (dense
          ? 'bg-status-muted-danger/10 border-status-muted-danger/20 text-status-muted-danger'
          : 'bg-status-danger/10 border-status-danger/20 text-status-danger'),
        variant === 'warning' && (dense
          ? 'bg-status-muted-warning/10 border-status-muted-warning/20 text-status-muted-warning'
          : 'bg-status-warning/10 border-status-warning/20 text-status-warning'),
        variant === 'merged' && (dense
          ? 'bg-status-muted-merged/10 border-status-muted-merged/20 text-status-muted-merged'
          : 'bg-status-merged/10 border-status-merged/20 text-status-merged'),
        variant === 'info' && 'bg-accent/10 border-accent/20 text-accent-bright',
        variant === 'muted' && 'bg-surface3/40 border-border/80 text-foreground-muted',
        className
      )}
      {...props}
    >
      {showDot && (
        <span
          className={cn(
            'size-1.5 rounded-full shrink-0',
            variant === 'success' && (dense ? 'bg-status-muted-success' : 'bg-status-success'),
            variant === 'error' && (dense ? 'bg-status-muted-danger' : 'bg-status-danger'),
            variant === 'warning' && (dense ? 'bg-status-muted-warning' : 'bg-status-warning'),
            variant === 'merged' && (dense ? 'bg-status-muted-merged' : 'bg-status-merged'),
            variant === 'info' && 'bg-accent',
            variant === 'muted' && 'bg-foreground-extra-muted'
          )}
        />
      )}
      <span>{text}</span>
    </div>
  );
}
