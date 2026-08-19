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
  BookOpen,
  ChevronRight,
  User,
  Bot,
} from 'lucide-react';

export interface TimelineEventItem {
  id: string;
  time: Date;
  sender: string;
  channel: string;
  channelId: string;
  content: string;
  type: 'command' | 'success' | 'error' | 'thinking' | 'approval' | 'knowledge' | 'info';
  isHuman?: boolean;
}

interface ActivityTimelineProps {
  events: TimelineEventItem[];
  agents: string[];
  onOpenThread: (sessionId: string) => void;
  loading?: boolean;
  className?: string;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '[代码块]')
    .replace(/\*\*/g, '')
    .replace(/`{1,3}/g, '')
    .replace(/\n+/g, ' ')
    .trim();
}

export function ActivityTimeline({
  events,
  onOpenThread,
  loading = false,
  className,
}: ActivityTimelineProps) {
  const [selectedType, setSelectedType] = React.useState<string>('all');

  // Filter out noisy idle / empty status events
  const cleanedEvents = React.useMemo(() => {
    return events
      .filter((ev) => {
        const raw = ev.content.trim().toLowerCase();
        // Discard plain idle noise
        if (raw === 'idle' || raw === 'standby' || raw === 'agent status: idle') return false;
        // Discard empty thinking
        if (ev.type === 'thinking' && (!raw || raw === 'thinking' || raw === 'thinking...')) return false;
        return true;
      })
      .map((ev) => {
        let detectedType = ev.type;
        const text = ev.content;
        if (text.includes('@knowledge') || text.includes('知识库') || text.includes('knowledge:')) {
          detectedType = 'knowledge';
        } else if (text.startsWith('$') || text.includes('exec') || text.includes('tool:') || ev.type === 'command') {
          detectedType = 'command';
        }
        return {
          ...ev,
          type: detectedType,
          isHuman: ev.sender.toLowerCase().includes('user') || ev.sender.toLowerCase().includes('guest') || ev.sender.toLowerCase().includes('human'),
        };
      });
  }, [events]);

  const filteredEvents = React.useMemo(() => {
    return cleanedEvents.filter((ev) => {
      if (selectedType === 'issues' && ev.type !== 'error' && ev.type !== 'approval') return false;
      if (selectedType === 'knowledge' && ev.type !== 'knowledge') return false;
      if (selectedType === 'tools' && ev.type !== 'command' && ev.type !== 'success') return false;
      if (selectedType === 'chat' && ev.type !== 'info' && ev.type !== 'knowledge') return false;
      return true;
    });
  }, [cleanedEvents, selectedType]);

  // Group consecutive messages by same sender in same channel
  const groupedTimeline = React.useMemo(() => {
    const groups: {
      key: string;
      sender: string;
      isHuman: boolean;
      channel: string;
      channelId: string;
      time: Date;
      items: TimelineEventItem[];
    }[] = [];

    filteredEvents.forEach((ev) => {
      const prev = groups[groups.length - 1];
      const timeDiff = prev ? Math.abs(prev.time.getTime() - ev.time.getTime()) : Infinity;

      if (
        prev &&
        prev.sender === ev.sender &&
        prev.channelId === ev.channelId &&
        timeDiff < 2 * 60 * 1000 // within 2 minutes
      ) {
        prev.items.push(ev);
      } else {
        groups.push({
          key: ev.id,
          sender: ev.sender,
          isHuman: Boolean(ev.isHuman),
          channel: ev.channel,
          channelId: ev.channelId,
          time: ev.time,
          items: [ev],
        });
      }
    });

    return groups;
  }, [filteredEvents]);

  return (
    <aside
      className={cn(
        'flex flex-col h-full bg-surface1/40 backdrop-blur-md border-l border-border/25 overflow-hidden',
        className
      )}
    >
      {/* Header */}
      <div className="p-3.5 space-y-2.5 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="size-1.5 rounded-full bg-emerald-500 ring-2 ring-emerald-500/20 animate-pulse" />
            <span className="text-xs font-semibold tracking-tight text-foreground">
              实时协同流
            </span>
          </div>
          <span className="text-[10.5px] font-mono text-muted-foreground tabular-nums">
            {groupedTimeline.length} 组动态
          </span>
        </div>

        {/* Filter Chips */}
        <div className="flex items-center gap-1.5 overflow-x-auto text-[11px] font-medium no-scrollbar">
          <button
            type="button"
            onClick={() => setSelectedType('all')}
            className={cn(
              'px-2 py-0.5 rounded-lg transition-colors cursor-pointer shrink-0',
              selectedType === 'all'
                ? 'bg-primary text-primary-foreground'
                : 'bg-surface2 text-muted-foreground hover:text-foreground'
            )}
          >
            全部
          </button>
          <button
            type="button"
            onClick={() => setSelectedType('knowledge')}
            className={cn(
              'px-2 py-0.5 rounded-lg transition-colors cursor-pointer shrink-0',
              selectedType === 'knowledge'
                ? 'bg-amber-600 text-white'
                : 'bg-surface2 text-muted-foreground hover:text-foreground'
            )}
          >
            知识库
          </button>
          <button
            type="button"
            onClick={() => setSelectedType('tools')}
            className={cn(
              'px-2 py-0.5 rounded-lg transition-colors cursor-pointer shrink-0',
              selectedType === 'tools'
                ? 'bg-emerald-600 text-white'
                : 'bg-surface2 text-muted-foreground hover:text-foreground'
            )}
          >
            工具调用
          </button>
          <button
            type="button"
            onClick={() => setSelectedType('issues')}
            className={cn(
              'px-2 py-0.5 rounded-lg transition-colors cursor-pointer shrink-0',
              selectedType === 'issues'
                ? 'bg-rose-600 text-white'
                : 'bg-surface2 text-muted-foreground hover:text-foreground'
            )}
          >
            待批与异常
          </button>
        </div>
      </div>

      {/* Timeline Stream */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3 space-y-2.5">
        {loading && events.length === 0 ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-16 rounded-xl bg-surface2/40 animate-pulse" />
            ))}
          </div>
        ) : groupedTimeline.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground space-y-1">
            <MessageSquare className="size-5 opacity-30" />
            <span className="text-xs">暂无活动记录</span>
          </div>
        ) : (
          groupedTimeline.map((group) => {
            return (
              <div
                key={group.key}
                onClick={() => onOpenThread(group.channelId)}
                className="group p-2.5 rounded-xl bg-surface1/60 hover:bg-surface2/80 border border-border/20 hover:border-border/50 transition-all cursor-pointer shadow-2xs space-y-1.5"
              >
                {/* Group Sender Header */}
                <div className="flex items-center justify-between gap-1 text-[11px]">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className={cn(
                        'size-4 rounded-md flex items-center justify-center text-[10px] shrink-0',
                        group.isHuman
                          ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
                          : 'bg-violet-500/10 text-violet-600 dark:text-violet-400'
                      )}
                    >
                      {group.isHuman ? <User className="size-2.5" /> : <Bot className="size-2.5" />}
                    </span>
                    <span className="font-semibold text-foreground truncate">
                      {group.sender}
                    </span>
                    <span className="text-[10px] font-mono text-muted-foreground/80 truncate">
                      #{group.channel}
                    </span>
                  </div>

                  <span className="font-mono text-muted-foreground/70 text-[9.5px] shrink-0">
                    {timeAgo(group.time.toISOString())}
                  </span>
                </div>

                {/* Sub-items in this conversation turn */}
                <div className="space-y-1 pl-5 text-[11.5px]">
                  {group.items.map((item) => {
                    const isKnowledge = item.type === 'knowledge';
                    const isTool = item.type === 'command' || item.type === 'success';
                    const isError = item.type === 'error';
                    const isApproval = item.type === 'approval';

                    return (
                      <div key={item.id} className="flex items-start gap-1.5 leading-snug text-foreground/85">
                        <span className="mt-0.5 shrink-0">
                          {isKnowledge ? (
                            <BookOpen className="size-3 text-amber-500" />
                          ) : isTool ? (
                            <Terminal className="size-3 text-emerald-500" />
                          ) : isApproval ? (
                            <ShieldAlert className="size-3 text-amber-500 animate-pulse" />
                          ) : isError ? (
                            <AlertCircle className="size-3 text-rose-500" />
                          ) : (
                            <MessageSquare className="size-3 text-blue-500/70" />
                          )}
                        </span>
                        <p className="min-w-0 flex-1 line-clamp-3">
                          {stripMarkdown(item.content)}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}
