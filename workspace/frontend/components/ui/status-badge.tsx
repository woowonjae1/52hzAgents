import * as React from 'react';
import { cn } from '@/lib/utils';

export type StatusBadgeVariant = 'success' | 'error' | 'warning' | 'muted' | 'info';

export interface StatusBadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: string;
  variant?: StatusBadgeVariant;
  showDot?: boolean;
}

export function StatusBadge({
  label,
  variant = 'muted',
  showDot = false,
  className,
  children,
  ...props
}: StatusBadgeProps) {
  const text = label || children;

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-normal transition-colors border',
        variant === 'success' && 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400',
        variant === 'error' && 'bg-red-500/10 border-red-500/20 text-red-600 dark:text-red-400',
        variant === 'warning' && 'bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400',
        variant === 'info' && 'bg-blue-500/10 border-blue-500/20 text-blue-600 dark:text-blue-400',
        variant === 'muted' && 'bg-surface3/40 border-border/80 text-muted-foreground',
        className
      )}
      {...props}
    >
      {showDot && (
        <span
          className={cn(
            'size-1.5 rounded-full shrink-0',
            variant === 'success' && 'bg-emerald-500',
            variant === 'error' && 'bg-red-500',
            variant === 'warning' && 'bg-amber-500',
            variant === 'info' && 'bg-blue-500',
            variant === 'muted' && 'bg-zinc-400'
          )}
        />
      )}
      <span>{text}</span>
    </div>
  );
}
