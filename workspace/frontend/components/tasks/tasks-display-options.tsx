'use client';

import React, { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { LayoutList, LayoutGrid, SlidersHorizontal, RotateCcw } from 'lucide-react';

export type TaskViewType = 'list' | 'board';
export type TaskGroupingKey = 'status' | 'assignee' | 'channel' | 'none';
export type TaskOrderingKey = 'position' | 'priority' | 'created';

export interface TasksDisplaySettings {
  viewType: TaskViewType;
  grouping: TaskGroupingKey;
  ordering: TaskOrderingKey;
  showCompleted: boolean;
}

interface TasksDisplayOptionsProps {
  settings: TasksDisplaySettings;
  onChange: (updated: Partial<TasksDisplaySettings>) => void;
  onReset: () => void;
  className?: string;
}

export function TasksDisplayOptions({
  settings,
  onChange,
  onReset,
  className,
}: TasksDisplayOptionsProps) {
  const [open, setOpen] = useState(false);

  const isDefault =
    settings.viewType === 'list' &&
    settings.grouping === 'status' &&
    settings.ordering === 'position' &&
    settings.showCompleted === true;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn('relative h-8 px-2.5 gap-1.5 text-xs font-medium bg-surface1/60 hover:bg-surface2', className)}
        >
          <SlidersHorizontal className="size-3.5 text-foreground-muted" />
          <span>Display</span>
          {!isDefault && (
            <span
              className="absolute -top-1 -right-1 size-2 rounded-full bg-status-warning ring-2 ring-background"
              aria-label="Custom display filters active"
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-72 p-3 rounded-xl border border-border bg-surface1 text-foreground shadow-2xl space-y-3"
      >
        {/* List / Board Switch */}
        <div className="flex items-center justify-between pb-2 border-b border-border/60">
          <span className="text-xs font-semibold text-foreground-extra-muted uppercase tracking-wider">
            Layout
          </span>
          <div className="grid grid-cols-2 gap-1 p-0.5 bg-surface2/80 rounded-lg border border-border/60">
            <button
              type="button"
              onClick={() => onChange({ viewType: 'list' })}
              className={cn(
                'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors',
                settings.viewType === 'list'
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-foreground-muted hover:text-foreground'
              )}
            >
              <LayoutList className="size-3.5" />
              List
            </button>
            <button
              type="button"
              onClick={() => onChange({ viewType: 'board' })}
              className={cn(
                'flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors',
                settings.viewType === 'board'
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-foreground-muted hover:text-foreground'
              )}
            >
              <LayoutGrid className="size-3.5" />
              Board
            </button>
          </div>
        </div>

        {/* Grouping */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-foreground-muted">Grouping</label>
          <div className="grid grid-cols-2 gap-1">
            {[
              { id: 'status', label: 'Status' },
              { id: 'assignee', label: 'Assignee' },
              { id: 'channel', label: 'Channel' },
              { id: 'none', label: 'None' },
            ].map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => onChange({ grouping: g.id as TaskGroupingKey })}
                className={cn(
                  'px-2 py-1.5 rounded-md text-xs font-medium text-left border transition-colors',
                  settings.grouping === g.id
                    ? 'border-primary/40 bg-surface2 text-foreground font-semibold'
                    : 'border-transparent text-foreground-muted hover:bg-surface2/60'
                )}
              >
                {g.label}
              </button>
            ))}
          </div>
        </div>

        {/* Ordering */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-foreground-muted">Ordering</label>
          <div className="grid grid-cols-3 gap-1">
            {[
              { id: 'position', label: 'Default' },
              { id: 'priority', label: 'Priority' },
              { id: 'created', label: 'Created' },
            ].map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => onChange({ ordering: o.id as TaskOrderingKey })}
                className={cn(
                  'px-2 py-1 rounded-md text-xs font-medium text-center border transition-colors',
                  settings.ordering === o.id
                    ? 'border-primary/40 bg-surface2 text-foreground font-semibold'
                    : 'border-transparent text-foreground-muted hover:bg-surface2/60'
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {/* Completed tasks toggle */}
        <div className="flex items-center justify-between pt-2 border-t border-border/60">
          <div className="space-y-0.5">
            <span className="text-xs font-medium text-foreground">Show completed</span>
            <p className="text-3xs text-foreground-extra-muted">Include done and cancelled tasks</p>
          </div>
          <Switch
            checked={settings.showCompleted}
            onCheckedChange={(checked) => onChange({ showCompleted: checked })}
          />
        </div>

        {/* Reset button if not default */}
        {!isDefault && (
          <div className="pt-2 border-t border-border/60 flex justify-end">
            <button
              type="button"
              onClick={onReset}
              className="inline-flex items-center gap-1 text-xs text-foreground-muted hover:text-foreground transition-colors"
            >
              <RotateCcw className="size-3" />
              Reset defaults
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
