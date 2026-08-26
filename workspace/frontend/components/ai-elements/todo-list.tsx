'use client';

import * as React from 'react';
import { ListChecks, Check, Circle, Dot, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { EventLine } from './event-line';

export type TodoStatus = 'completed' | 'in-progress' | 'pending' | 'cancelled';

export interface TodoItem {
  id: string;
  title: string;
  status: TodoStatus;
}

export interface TodoListProps {
  items: TodoItem[];
  title?: string;
  collapseOnComplete?: boolean;
  defaultExpanded?: boolean;
  className?: string;
}

/**
 * The agent's plan.
 *
 * The card, the `rounded-2xl`, the tinted header bar, the 16px progress bar and
 * the spinning loader on the active item are all gone. The progress that bar was
 * drawing is now the row's `meta` ("3/7"), which is the same information in a
 * form that does not need its own colour, its own height, or a transition.
 *
 * The in-progress item gets the shared shimmer instead of a spinner, so a plan
 * whose current step is running looks like a tool call that is running.
 */
export function TodoList({
  items,
  title = 'Plan',
  collapseOnComplete = false,
  defaultExpanded = true,
  className,
}: TodoListProps) {
  const completedCount = React.useMemo(
    () => items.filter((i) => i.status === 'completed').length,
    [items]
  );
  const totalCount = items.length;
  const isAllComplete = totalCount > 0 && completedCount === totalCount;

  return (
    <EventLine
      className={className}
      icon={<ListChecks />}
      label={title}
      meta={`${completedCount}/${totalCount}`}
      state={isAllComplete ? 'ok' : 'idle'}
      defaultOpen={defaultExpanded && !(isAllComplete && collapseOnComplete)}
    >
      <div className="flex flex-col py-0.5">
        {items.map((item, idx) => {
          const isCompleted = item.status === 'completed';
          const isInProgress = item.status === 'in-progress';
          const isCancelled = item.status === 'cancelled';

          return (
            <div
              key={item.id || idx}
              className={cn(
                'flex min-w-0 items-baseline gap-2 py-0.5 text-xs',
                isInProgress && 'event-running text-foreground',
                isCompleted && 'text-foreground-extra-muted',
                isCancelled && 'text-foreground-extra-muted',
                !isCompleted && !isInProgress && !isCancelled && 'text-foreground-muted'
              )}
            >
              <span className="shrink-0 translate-y-px [&>svg]:size-3">
                {isCompleted ? (
                  <Check />
                ) : isInProgress ? (
                  <Dot />
                ) : isCancelled ? (
                  <X />
                ) : (
                  <Circle className="opacity-50" />
                )}
              </span>
              <span className={cn('min-w-0 flex-1 truncate', isCancelled && 'line-through')}>
                {item.title}
              </span>
            </div>
          );
        })}
      </div>
    </EventLine>
  );
}
