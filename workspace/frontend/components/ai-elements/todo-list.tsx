'use client';

import * as React from 'react';
import {
  ListChecks,
  CheckCircle2,
  Circle,
  Loader2,
  XCircle,
  ChevronDown,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '@/lib/utils';

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

export function TodoList({
  items,
  title = '执行计划',
  collapseOnComplete = false,
  defaultExpanded = true,
  className,
}: TodoListProps) {
  const [isExpanded, setIsExpanded] = React.useState(defaultExpanded);

  const completedCount = React.useMemo(
    () => items.filter((i) => i.status === 'completed').length,
    [items]
  );
  const totalCount = items.length;
  const isAllComplete = totalCount > 0 && completedCount === totalCount;

  React.useEffect(() => {
    if (isAllComplete && collapseOnComplete) {
      setIsExpanded(false);
    }
  }, [isAllComplete, collapseOnComplete]);

  return (
    <div
      className={cn(
        'w-full max-w-xl rounded-2xl border border-border/70 overflow-hidden bg-surface1/95 backdrop-blur-md shadow-2xs transition-all text-xs',
        className
      )}
    >
      {/* Header with Title and Progress */}
      <div
        onClick={() => setIsExpanded((prev) => !prev)}
        className="flex items-center justify-between gap-3 px-3.5 py-2.5 bg-surface2/60 hover:bg-surface2 transition-colors cursor-pointer select-none border-b border-border/40"
      >
        <div className="flex items-center gap-2 min-w-0">
          <ListChecks className="size-4 text-primary shrink-0" />
          <span className="font-semibold text-foreground truncate">{title}</span>
          <span className="text-[11px] font-mono text-muted-foreground tabular-nums">
            ({completedCount}/{totalCount})
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Progress Mini Bar */}
          <div className="w-16 h-1.5 rounded-full bg-surface3 overflow-hidden">
            <div
              className={cn(
                'h-full transition-all duration-300 rounded-full',
                isAllComplete ? 'bg-emerald-500' : 'bg-primary'
              )}
              style={{
                width: `${totalCount > 0 ? (completedCount / totalCount) * 100 : 0}%`,
              }}
            />
          </div>

          <ChevronDown
            className={cn(
              'size-3.5 text-muted-foreground transition-transform duration-200',
              !isExpanded && '-rotate-90'
            )}
          />
        </div>
      </div>

      {/* Todo Items List */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="divide-y divide-border/20 p-1.5 space-y-0.5"
          >
            {items.map((item, idx) => {
              const isCompleted = item.status === 'completed';
              const isInProgress = item.status === 'in-progress';
              const isCancelled = item.status === 'cancelled';

              return (
                <div
                  key={item.id || idx}
                  className={cn(
                    'flex items-center gap-2.5 px-2.5 py-1.5 rounded-xl transition-colors',
                    isInProgress && 'bg-primary/[0.06] text-foreground font-medium',
                    isCompleted && 'text-muted-foreground',
                    !isCompleted && !isInProgress && 'text-foreground/90'
                  )}
                >
                  {/* Status Icon */}
                  <div className="shrink-0">
                    {isCompleted ? (
                      <CheckCircle2 className="size-3.5 text-emerald-500" />
                    ) : isInProgress ? (
                      <Loader2 className="size-3.5 text-primary animate-spin" />
                    ) : isCancelled ? (
                      <XCircle className="size-3.5 text-muted-foreground opacity-50" />
                    ) : (
                      <Circle className="size-3.5 text-muted-foreground/60" />
                    )}
                  </div>

                  {/* Title */}
                  <span
                    className={cn(
                      'flex-1 text-[12px] truncate',
                      isCompleted && 'line-through opacity-70',
                      isCancelled && 'line-through opacity-40'
                    )}
                  >
                    {item.title}
                  </span>

                  {/* Tag */}
                  {isInProgress && (
                    <span className="text-[10px] px-1.5 py-0.2 rounded-md bg-primary/15 text-primary font-mono shrink-0">
                      进行中
                    </span>
                  )}
                </div>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
