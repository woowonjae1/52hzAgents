'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import { timeAgo } from '@/lib/helpers';
import {
  Terminal,
  Brain,
  ShieldAlert,
  AlertCircle,
  MessageSquare,
  Filter,
  CheckCircle2,
  ChevronRight,
  Sparkles,
} from 'lucide-react';
import type { ONMEvent } from '@/lib/types';

export interface TimelineEventItem {
  id: string;
  time: Date;
  sender: string;
  channel: string;
  channelId: string;
  content: string;
  type: 'command' | 'success' | 'error' | 'thinking' | 'approval' | 'info';
}

interface ActivityTimelineProps {
  events: TimelineEventItem[];
  agents: string[];
  onOpenThread: (sessionId: string) => void;
  loading?: boolean;
  className?: string;
}

export function ActivityTimeline({
  events,
  agents,
  onOpenThread,
  loading = false,
  className,
}: ActivityTimelineProps) {
  const [selectedAgent, setSelectedAgent] = React.useState<string>('all');
  const [selectedType, setSelectedType] = React.useState<string>('all');

  // Filter events
  const filteredEvents = React.useMemo(() => {
    return events.filter((ev) => {
      if (selectedAgent !== 'all' && ev.sender.toLowerCase() !== selectedAgent.toLowerCase()) {
        return false;
      }
      if (selectedType === 'error' && ev.type !== 'error' && ev.type !== 'approval') return false;
      if (selectedType === 'thinking' && ev.type !== 'thinking') return false;
      if (selectedType === 'tool' && ev.type !== 'command' && ev.type !== 'success') return false;
      if (selectedType === 'chat' && ev.type !== 'info') return false;
      return true;
    });
  }, [events, selectedAgent, selectedType]);

  // Group events by time bucket (Just now < 1m, Recent < 10m, Earlier)
  const grouped = React.useMemo(() => {
    const now = Date.now();
    const justNow: TimelineEventItem[] = [];
    const recent: TimelineEventItem[] = [];
    const earlier: TimelineEventItem[] = [];

    filteredEvents.forEach((ev) => {
      const diffMs = now - ev.time.getTime();
      if (diffMs < 60 * 1000) {
        justNow.push(ev);
      } else if (diffMs < 10 * 60 * 1000) {
        recent.push(ev);
      } else {
        earlier.push(ev);
      }
    });

    return [
      { label: '刚刚 (Just now)', items: justNow },
      { label: '10分钟内 (Recent)', items: recent },
      { label: '更早活动 (Earlier)', items: earlier },
    ].filter((g) => g.items.length > 0);
  }, [filteredEvents]);

  return (
    <aside
      className={cn(
        'flex flex-col h-full bg-surface1/60 backdrop-blur-md border-l border-border/70 overflow-hidden',
        className
      )}
    >
      {/* Header */}
      <div className="p-3 border-b border-border/70 space-y-2 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-full bg-emerald-500 ring-2 ring-emerald-500/20 animate-pulse" />
            <span className="text-xs font-semibold tracking-tight text-foreground">
              实时协同流 (Activity Stream)
            </span>
          </div>
          <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
            {filteredEvents.length} / {events.length} 条
          </span>
        </div>

        {/* Filter Chips */}
        <div className="flex items-center gap-1.5 overflow-x-auto text-[10.5px] font-medium no-scrollbar pt-0.5">
          <button
            type="button"
            onClick={() => setSelectedType('all')}
            className={cn(
              'px-2 py-0.5 rounded-lg border transition-colors cursor-pointer shrink-0',
              selectedType === 'all'
                ? 'bg-primary text-primary-foreground border-transparent'
                : 'bg-surface2 text-muted-foreground hover:text-foreground border-border/50'
            )}
          >
            全部
          </button>
          <button
            type="button"
            onClick={() => setSelectedType('error')}
            className={cn(
              'px-2 py-0.5 rounded-lg border transition-colors cursor-pointer shrink-0',
              selectedType === 'error'
                ? 'bg-rose-600 text-white border-transparent'
                : 'bg-surface2 text-muted-foreground hover:text-foreground border-border/50'
            )}
          >
            ⚠️ 异常/审批
          </button>
          <button
            type="button"
            onClick={() => setSelectedType('thinking')}
            className={cn(
              'px-2 py-0.5 rounded-lg border transition-colors cursor-pointer shrink-0',
              selectedType === 'thinking'
                ? 'bg-violet-600 text-white border-transparent'
                : 'bg-surface2 text-muted-foreground hover:text-foreground border-border/50'
            )}
          >
            🧠 推理
          </button>
          <button
            type="button"
            onClick={() => setSelectedType('tool')}
            className={cn(
              'px-2 py-0.5 rounded-lg border transition-colors cursor-pointer shrink-0',
              selectedType === 'tool'
                ? 'bg-emerald-600 text-white border-transparent'
                : 'bg-surface2 text-muted-foreground hover:text-foreground border-border/50'
            )}
          >
            ⚡ 执行
          </button>
        </div>
      </div>

      {/* Timeline Stream */}
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-4">
        {loading && events.length === 0 ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-14 rounded-xl bg-surface2/60 animate-pulse border border-border/40" />
            ))}
          </div>
        ) : filteredEvents.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground space-y-1">
            <MessageSquare className="size-5 opacity-50" />
            <span className="text-xs">没有匹配的活动记录</span>
          </div>
        ) : (
          grouped.map((group, gIdx) => (
            <div key={gIdx} className="space-y-1.5">
              <div className="text-[10px] font-mono font-semibold uppercase tracking-wider text-muted-foreground px-1">
                {group.label}
              </div>

              <div className="space-y-1.5">
                {group.items.map((ev) => {
                  const isError = ev.type === 'error';
                  const isApproval = ev.type === 'approval';
                  const isThinking = ev.type === 'thinking';

                  return (
                    <button
                      key={ev.id}
                      type="button"
                      onClick={() => onOpenThread(ev.channelId)}
                      className={cn(
                        'w-full text-left flex items-start gap-2 p-2.5 rounded-xl border transition-all cursor-pointer shadow-2xs group',
                        isError
                          ? 'bg-rose-500/[0.04] border-rose-500/30 hover:border-rose-500/50'
                          : isApproval
                          ? 'bg-amber-500/[0.04] border-amber-500/30 hover:border-amber-500/50'
                          : 'bg-surface1 hover:bg-surface2 border-border/60 hover:border-border-accent'
                      )}
                    >
                      {/* Status Icon */}
                      <span className="mt-0.5 shrink-0">
                        {isError ? (
                          <AlertCircle className="size-3.5 text-rose-500" />
                        ) : isApproval ? (
                          <ShieldAlert className="size-3.5 text-amber-500 animate-pulse" />
                        ) : isThinking ? (
                          <Brain className="size-3.5 text-violet-500" />
                        ) : (
                          <Terminal className="size-3.5 text-emerald-500" />
                        )}
                      </span>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-1 text-[10.5px]">
                          <span className="font-semibold text-foreground group-hover:text-primary transition-colors truncate">
                            {ev.sender}
                          </span>
                          <span className="font-mono text-muted-foreground/70 text-[9.5px] shrink-0">
                            {timeAgo(ev.time.toISOString())}
                          </span>
                        </div>

                        <p className="text-[11.5px] text-foreground/85 line-clamp-2 mt-0.5 leading-snug">
                          {ev.content}
                        </p>

                        <div className="flex items-center justify-between gap-1 mt-1 text-[9.5px] font-mono text-muted-foreground/80">
                          <span className="truncate">#{ev.channel}</span>
                          <ChevronRight className="size-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
