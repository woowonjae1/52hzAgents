import * as React from 'react';
import { cn } from '@/lib/utils';

export interface SegmentedControlOption<T extends string = string> {
  value: T;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string = string> {
  options: SegmentedControlOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
  size?: 'xs' | 'sm' | 'md';
  hideLabels?: boolean;
  className?: string;
}

export function SegmentedControl<T extends string = string>({
  options,
  value,
  onValueChange,
  size = 'sm',
  hideLabels = false,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      className={cn(
        'inline-flex items-center p-0.5 rounded-lg bg-surface2 border border-border/60 select-none',
        size === 'xs' && 'h-7 gap-0.5',
        size === 'sm' && 'h-8 gap-1',
        size === 'md' && 'h-10 gap-1',
        className
      )}
    >
      {options.map((opt) => {
        const isSelected = opt.value === value;
        const Icon = opt.icon;

        return (
          <button
            key={opt.value}
            type="button"
            disabled={opt.disabled}
            onClick={() => onValueChange(opt.value)}
            className={cn(
              'relative flex items-center justify-center gap-1.5 rounded-md text-xs font-medium transition-all cursor-pointer',
              size === 'xs' && 'px-2 h-6 text-[11px]',
              size === 'sm' && 'px-2.5 h-7 text-xs',
              size === 'md' && 'px-3.5 h-9 text-xs',
              isSelected
                ? 'bg-surface0 text-foreground shadow-xs font-semibold'
                : 'text-muted-foreground hover:text-foreground hover:bg-surface1/50',
              opt.disabled && 'opacity-40 cursor-not-allowed'
            )}
          >
            {Icon && <Icon className="size-3.5 shrink-0 opacity-80" />}
            {(!hideLabels || !Icon) && <span>{opt.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
