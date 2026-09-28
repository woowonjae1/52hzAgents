'use client';

import * as React from 'react';
import { workspaceApi } from '@/lib/api';
import { eventToMessage, stripAddressPrefix, type ONMEvent, type WorkspaceSession } from '@/lib/types';
import { useVisibilityPolling } from '@/lib/use-visibility-polling';
import type { TimelineEventItem } from './activity-timeline';

/** Events shown in the feed -- after reply previews are dropped. */
const FEED_SIZE = 40;

/*
  The cross-thread activity feed, shared by the Agents view and Home.

  THE FEED WAS FULL OF ONE REPLY, CUT INTO TOKENS.

  Most adapters stream the answer as it is written, one `thinking` message per
  delta with `reply_preview` set; the finished reply then lands as a message of
  its own. Taking the last 40 raw messages filled the feed with fragments of a
  single answer, newest first. Previews are dropped (the reply they preview is
  in the feed as itself), and more is fetched than is shown, because the limit
  is spent before the filter runs.

  Agent replies were also typed 'command', so every answer wore the terminal
  icon. A tool call is the message that carries `tool_name`; a reply is a reply.
*/
export function useActivityFeed(sessions: WorkspaceSession[], intervalMs = 5000) {
  const [events, setEvents] = React.useState<TimelineEventItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const sessionsRef = React.useRef(sessions);
  sessionsRef.current = sessions;

  const refresh = React.useCallback(async () => {
    const titleFor = (channel: string) =>
      sessionsRef.current.find((s) => s.sessionId === channel)?.title || channel;
    try {
      const res = await workspaceApi.pollEvents({ type: 'workspace.message', sort: 'desc', limit: 160 });
      const lines: TimelineEventItem[] = [];
      // Some adapters post the same reasoning twice (streamed, then again at
      // block end). The same text from the same speaker in the same thread is
      // one event.
      const seen = new Set<string>();
      for (let idx = 0; idx < res.events.length && lines.length < FEED_SIZE; idx++) {
        const ev = res.events[idx] as ONMEvent;
        const m = eventToMessage(ev);
        if (m.messageType === 'thinking' && m.metadata?.reply_preview) continue;
        const channel = (ev.target || '').replace(/^channel\//, '');
        const dedupKey = `${m.senderName || ev.source}|${channel}|${(m.content || '').trim()}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        let type: TimelineEventItem['type'] = 'info';
        if (m.messageType === 'thinking') type = m.metadata?.tool_name ? 'command' : 'thinking';
        else if (m.metadata?.tool_approval_request) type = 'approval';
        else if (m.messageType === 'status') type = /failed|error|stopped|denied/i.test(m.content) ? 'error' : 'success';
        lines.push({
          id: m.messageId || ev.event_id || `activity-${idx}-${ev.timestamp || Date.now()}`,
          time: m.createdAt ? new Date(m.createdAt) : new Date(ev.timestamp),
          sender: m.senderName || stripAddressPrefix(ev.source),
          channel: titleFor(channel),
          channelId: channel,
          content: m.content,
          type,
        });
      }
      setEvents(lines);
    } catch {
      /* keep the last feed */
    } finally {
      setLoading(false);
    }
  }, []);

  useVisibilityPolling(refresh, intervalMs);
  return { events, loading, refresh };
}
