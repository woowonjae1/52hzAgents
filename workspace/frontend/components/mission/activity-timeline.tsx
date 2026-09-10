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

/*
 * ALSO STRIPS LEADING EMOJI, because in this feed they come from the SERVER.
 *
 * The frontend's own emoji were removed, but the Council Supervisor's messages
 * arrive already decorated -- a warning sign before "[Council Alert] Challenger
 * Timeout", a classical-building glyph before "Council Session Initiated" --
 * so the activity feed was the one surface still showing them, and the fix
 * cannot live at a call site the frontend controls.
 *
 * Only a LEADING run is removed, and only pictographs. An emoji inside a
 * sentence is content a person or an agent wrote on purpose; a badge glued to
 * the front of a status line is the sender styling our UI for us.
 */
const LEADING_EMOJI =
  /^(?:[\u{1F300}-\u{1FAFF}\u{1F900}-\u{1F9FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]|\uFE0F|\u200D)+\s*/u;

function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '[code block]')
    .replace(/\*\*/g, '')
    .replace(/`{1,3}/g, '')
    .replace(/\n+/g, ' ')
    .replace(LEADING_EMOJI, '')
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
        'flex flex-col h-full bg-surface1 border-l border-border/60 overflow-hidden',
        className
      )}
    >
      {/* Title bar — `.app-header` so this panel's first divider sits on the
          same baseline as the main pane's and the sidebar's. */}
      <div className="app-header px-3.5 bg-surface1">
        <span className="text-xs font-semibold tracking-tight text-foreground">
          Live activity
        </span>
      </div>

      <div className="px-3.5 py-2.5 shrink-0">
        {/* Filter Chips */}
        <div className="flex items-center gap-1.5 overflow-x-auto text-2xs font-medium no-scrollbar">
          <button
            type="button"
            onClick={() => setSelectedType('all')}
            className={cn(
              'px-2 py-0.5 rounded-lg transition-colors cursor-pointer shrink-0',
              selectedType === 'all'
                ? 'bg-surface3 text-foreground'
                : 'bg-surface2 text-muted-foreground hover:text-foreground'
            )}
          >
            All
          </button>
          <button
            type="button"
            onClick={() => setSelectedType('knowledge')}
            className={cn(
              'px-2 py-0.5 rounded-lg transition-colors cursor-pointer shrink-0',
              selectedType === 'knowledge'
                ? 'bg-surface3 text-foreground'
                : 'bg-surface2 text-muted-foreground hover:text-foreground'
            )}
          >
            Knowledge
          </button>
          <button
            type="button"
            onClick={() => setSelectedType('tools')}
            className={cn(
              'px-2 py-0.5 rounded-lg transition-colors cursor-pointer shrink-0',
              selectedType === 'tools'
                ? 'bg-surface3 text-foreground'
                : 'bg-surface2 text-muted-foreground hover:text-foreground'
            )}
          >
            Tool calls
          </button>
          <button
            type="button"
            onClick={() => setSelectedType('issues')}
            className={cn(
              'px-2 py-0.5 rounded-lg transition-colors cursor-pointer shrink-0',
              selectedType === 'issues'
                ? 'bg-surface3 text-foreground'
                : 'bg-surface2 text-muted-foreground hover:text-foreground'
            )}
          >
            Blocked
          </button>
        </div>
      </div>

      {/* Timeline Stream */}
      <div className="flex-1 min-h-0 overflow-y-auto pb-3 divide-y divide-border/60">
        {loading && events.length === 0 ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-16 rounded-xl bg-surface2/40 animate-pulse" />
            ))}
          </div>
        ) : groupedTimeline.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground space-y-1">
            <MessageSquare className="size-5 opacity-30" />
            <span className="text-xs">No activity yet</span>
          </div>
        ) : (
          /* One hairline between rows, in place of a box around each. */
          groupedTimeline.map((group) => {
            return (
              <div
                key={group.key}
                onClick={() => onOpenThread(group.channelId)}
                /*
                  A FEED ROW IS A ROW, NOT A CARD.

                  This was `rounded-xl` + `bg-surface1/60` + `border
                  border-border/60` + `shadow-xs` on EVERY entry, so a
                  chronological list of six things rendered as six stacked
                  bordered boxes -- which is most of what "too many dividers"
                  means on this screen. A border, a fill and a shadow are three
                  simultaneous answers to one question ("where does this item
                  end?"), and stacked vertically they read as six unrelated
                  panels rather than one stream in time order.

                  The same decision is already written down in `EventLine`: a
                  fill alone is enough separation, and adding a border is what
                  turns a chip into a card. Here even the resting fill goes --
                  the rows are separated by their own rhythm (`divide-y` on the
                  list, one hairline instead of four sides), and the fill
                  arrives on hover to say "this one is clickable".
                */
                className="group px-3.5 py-2.5 hover:bg-surface2/60 transition-colors cursor-pointer space-y-1.5"
              >
                {/* Group Sender Header */}
                <div className="flex items-center justify-between gap-1 text-2xs">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className={cn(
                        'size-4 rounded-md flex items-center justify-center text-3xs shrink-0',
                        group.isHuman
                          ? 'bg-surface2/10 text-foreground-muted'
                          : 'bg-status-merged/10 text-status-merged'
                      )}
                    >
                      {group.isHuman ? <User className="size-2.5" /> : <Bot className="size-2.5" />}
                    </span>
                    <span className="font-semibold text-foreground truncate">
                      {group.sender}
                    </span>
                    <span className="text-3xs font-mono text-muted-foreground/80 truncate">
                      #{group.channel}
                    </span>
                  </div>

                  <span className="font-mono text-muted-foreground/70 text-3xs shrink-0">
                    {timeAgo(group.time.toISOString())}
                  </span>
                </div>

                {/* Sub-items in this conversation turn */}
                <div className="space-y-1 pl-5 text-2xs">
                  {group.items.map((item) => {
                    const isKnowledge = item.type === 'knowledge';
                    const isTool = item.type === 'command' || item.type === 'success';
                    const isError = item.type === 'error';
                    const isApproval = item.type === 'approval';

                    return (
                      <div key={item.id} className="flex items-start gap-1.5 leading-snug text-foreground/85">
                        <span className="mt-0.5 shrink-0">
                          {isKnowledge ? (
                            <BookOpen className="size-3 text-status-warning" />
                          ) : isTool ? (
                            <Terminal className="size-3 text-status-success" />
                          ) : isApproval ? (
                            <ShieldAlert className="size-3 text-status-warning" />
                          ) : isError ? (
                            <AlertCircle className="size-3 text-status-danger" />
                          ) : (
                            <MessageSquare className="size-3 text-foreground-muted/70" />
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
