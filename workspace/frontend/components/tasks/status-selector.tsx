'use client';

import React, { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { TodoStatus } from '@/lib/types';
import { Check } from 'lucide-react';

export function BacklogStatusIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      className={cn('shrink-0 text-foreground-extra-muted', className)}
      aria-label="Pending / Backlog"
    >
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.5 2" />
    </svg>
  );
}

export function InProgressStatusIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      className={cn('shrink-0', className)}
      aria-label="In Progress"
    >
      <rect x="1" y="1" width="12" height="12" rx="6" stroke="#facc15" strokeWidth="1.5" />
      <path fill="#facc15" stroke="none" d="M 3.5,3.5 L3.5,0 A3.5,3.5 0 0,1 7.0000,3.5000 z" transform="translate(3.5,3.5)" />
    </svg>
  );
}

export function CompletedStatusIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      className={cn('shrink-0 text-emerald-500', className)}
      aria-label="Completed"
    >
      <circle cx="7" cy="7" r="6" fill="currentColor" />
      <path d="M4.5 7.2L6.2 8.9L9.5 5.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CancelledStatusIcon({ className }: { className?: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      className={cn('shrink-0 text-foreground-extra-muted', className)}
      aria-label="Cancelled"
    >
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4.5 4.5L9.5 9.5M9.5 4.5L4.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export interface StatusOption {
  id: TodoStatus;
  name: string;
  color: string;
  icon: (props: { className?: string }) => React.ReactNode;
}

export const ALL_STATUSES: StatusOption[] = [
  { id: 'pending', name: 'Todo', color: 'text-foreground-extra-muted', icon: BacklogStatusIcon },
  { id: 'in_progress', name: 'In Progress', color: 'text-yellow-500', icon: InProgressStatusIcon },
  { id: 'completed', name: 'Completed', color: 'text-emerald-500', icon: CompletedStatusIcon },
  { id: 'cancelled', name: 'Cancelled', color: 'text-foreground-extra-muted', icon: CancelledStatusIcon },
];

export function StatusGlyph({ status, className }: { status: TodoStatus; className?: string }) {
  const match = ALL_STATUSES.find((s) => s.id === status) || ALL_STATUSES[0];
  const Icon = match.icon;
  return <Icon className={className} />;
}

interface StatusSelectorProps {
  status: TodoStatus;
  onChange: (next: TodoStatus) => void;
  disabled?: boolean;
  size?: 'sm' | 'default';
  className?: string;
}

export function StatusSelector({
  status,
  onChange,
  disabled = false,
  size = 'default',
  className,
}: StatusSelectorProps) {
  const [open, setOpen] = useState(false);
  const current = ALL_STATUSES.find((s) => s.id === status) || ALL_STATUSES[0];
  const Icon = current.icon;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={`Status: ${current.name}`}
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
          Change status
        </div>
        <div className="flex flex-col gap-0.5">
          {ALL_STATUSES.map((item) => {
            const ItemIcon = item.icon;
            const isSelected = item.id === status;
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
