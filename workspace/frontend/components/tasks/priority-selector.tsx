'use client';

import React, { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { TodoPriority } from '@/lib/types';
import { Check } from 'lucide-react';

export interface PriorityOption {
  id: TodoPriority;
  name: string;
  color: string;
  icon: (props: { className?: string }) => React.ReactNode;
}

export function UrgentPriorityIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={cn('text-status-danger shrink-0', className)}
      aria-label="Urgent Priority"
    >
      <path d="M3 1C1.91067 1 1 1.91067 1 3V13C1 14.0893 1.91067 15 3 15H13C14.0893 15 15 14.0893 15 13V3C15 1.91067 14.0893 1 13 1H3ZM7 4L9 4L8.75391 8.99836H7.25L7 4ZM9 11C9 11.5523 8.55228 12 8 12C7.44772 12 7 11.5523 7 11C7 10.4477 7.44772 10 8 10C8.55228 10 9 10.4477 9 11Z" />
    </svg>
  );
}

export function HighPriorityIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={cn('text-foreground shrink-0', className)}
      aria-label="High Priority"
    >
      <rect x="2" y="10" width="3" height="4" rx="0.5" />
      <rect x="6.5" y="6" width="3" height="8" rx="0.5" />
      <rect x="11" y="2" width="3" height="12" rx="0.5" />
    </svg>
  );
}

export function MediumPriorityIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={cn('text-foreground-muted shrink-0', className)}
      aria-label="Medium Priority"
    >
      <rect x="2" y="10" width="3" height="4" rx="0.5" />
      <rect x="6.5" y="6" width="3" height="8" rx="0.5" />
      <rect x="11" y="2" width="3" height="12" rx="0.5" className="opacity-25" />
    </svg>
  );
}

export function LowPriorityIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="currentColor"
      className={cn('text-foreground-extra-muted shrink-0', className)}
      aria-label="Low Priority"
    >
      <rect x="2" y="10" width="3" height="4" rx="0.5" />
      <rect x="6.5" y="6" width="3" height="8" rx="0.5" className="opacity-25" />
      <rect x="11" y="2" width="3" height="12" rx="0.5" className="opacity-25" />
    </svg>
  );
}

export function NoPriorityIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeDasharray="2 2"
      className={cn('text-foreground-extra-muted shrink-0', className)}
      aria-label="No Priority"
    >
      <circle cx="8" cy="8" r="6" />
    </svg>
  );
}

export const PRIORITIES: PriorityOption[] = [
  { id: 'urgent', name: 'Urgent', color: 'text-status-danger', icon: UrgentPriorityIcon },
  { id: 'high', name: 'High', color: 'text-foreground', icon: HighPriorityIcon },
  { id: 'medium', name: 'Medium', color: 'text-foreground-muted', icon: MediumPriorityIcon },
  { id: 'low', name: 'Low', color: 'text-foreground-extra-muted', icon: LowPriorityIcon },
  { id: 'none', name: 'No priority', color: 'text-foreground-extra-muted', icon: NoPriorityIcon },
];

export function PriorityGlyph({ priority, className }: { priority?: TodoPriority; className?: string }) {
  const match = PRIORITIES.find((p) => p.id === (priority || 'none')) || PRIORITIES[4];
  const Icon = match.icon;
  return <Icon className={className} />;
}

interface PrioritySelectorProps {
  priority?: TodoPriority;
  onChange: (next: TodoPriority) => void;
  disabled?: boolean;
  size?: 'sm' | 'default';
  className?: string;
}

export function PrioritySelector({
  priority = 'none',
  onChange,
  disabled = false,
  size = 'default',
  className,
}: PrioritySelectorProps) {
  const [open, setOpen] = useState(false);
  const current = PRIORITIES.find((p) => p.id === priority) || PRIORITIES[4];
  const Icon = current.icon;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={`Priority: ${current.name}`}
          className={cn(
            'inline-flex items-center justify-center rounded-md transition-colors hover:bg-surface3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            size === 'sm' ? 'size-6' : 'size-7',
            disabled && 'pointer-events-none opacity-60',
            className
          )}
        >
          <Icon className={size === 'sm' ? 'size-3.5' : 'size-4'} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-44 p-1 rounded-lg border border-border bg-surface1 text-foreground shadow-lg"
      >
        <div className="px-2 py-1 text-2xs font-semibold text-foreground-extra-muted uppercase tracking-wider">
          Set priority
        </div>
        <div className="flex flex-col gap-0.5">
          {PRIORITIES.map((item) => {
            const ItemIcon = item.icon;
            const isSelected = item.id === priority;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  onChange(item.id);
                  setOpen(false);
                }}
                className={cn(
                  'flex items-center gap-2.5 px-2 py-1.5 rounded-md text-xs font-medium text-left transition-colors hover:bg-surface2',
                  isSelected ? 'text-foreground bg-surface2/60' : 'text-foreground-muted'
                )}
              >
                <ItemIcon className="size-3.5" />
                <span className="flex-1">{item.name}</span>
                {isSelected && <Check className="size-3.5 text-foreground shrink-0" />}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
