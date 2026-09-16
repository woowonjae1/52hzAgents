'use client';

import * as React from 'react';

/**
 * WHICH THREADS HAVE MOVED SINCE YOU LOOKED.
 *
 * ChatGPT does not need this: one person types, one assistant answers, and it
 * answers while you are watching. This app is the other shape — eight agents
 * replying on their own schedule, routines firing overnight, a pipeline
 * finishing twenty minutes after you walked away. Come back to the sidebar and
 * every row looks exactly as it did, because the only thing that changed is a
 * relative timestamp that says "just now" for the thread you were last typing
 * in as readily as for the one an agent just finished.
 *
 * So: remember when each thread was last on screen, and mark the ones whose
 * newest activity is newer than that.
 *
 * WHY LOCALSTORAGE AND NOT THE SERVER. Read state is per-person and per-device
 * and nothing else consumes it; a column on the session record would have to
 * be scoped to a user this workspace does not really have yet. If it ever
 * becomes shared, this module is the one place that changes.
 *
 * WHAT DOES NOT COUNT AS UNREAD:
 *  - your own message. Sending something must not light up the row you sent it
 *    from, which is the failure everyone's first version of this has.
 *  - the thread you are currently looking at. It is marked seen continuously
 *    while it is open, so a reply arriving under your eyes never flashes.
 */

const KEY = 'thread-last-seen-v1';

type SeenMap = Record<string, number>;

function read(): SeenMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? (parsed as SeenMap) : {};
  } catch {
    return {};
  }
}

function write(map: SeenMap) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(map));
  } catch {}
}

export function useThreadSeen(currentSessionId: string | null | undefined) {
  const [seen, setSeen] = React.useState<SeenMap>(() => read());

  const markSeen = React.useCallback((sessionId: string, at = Date.now()) => {
    setSeen((prev) => {
      // Never move the mark backwards, and do not re-render for a no-op — this
      // runs on every activity tick of the open thread.
      if ((prev[sessionId] ?? 0) >= at) return prev;
      const next = { ...prev, [sessionId]: at };
      write(next);
      return next;
    });
  }, []);

  /*
    The open thread is seen NOW, continuously.

    Marking once on open is not enough: a reply that lands while you are
    reading would then be newer than the mark and the row you are looking at
    would show a dot. The interval is cheap (one localStorage write every ten
    seconds, and only when the value actually moves) and it also covers the
    window being left open on a thread while agents work.
  */
  React.useEffect(() => {
    if (!currentSessionId) return;
    markSeen(currentSessionId);
    const id = setInterval(() => markSeen(currentSessionId), 10_000);
    return () => {
      clearInterval(id);
      // One last mark on the way out, so the activity that arrived between the
      // final tick and the switch does not come back as unread.
      markSeen(currentSessionId);
    };
  }, [currentSessionId, markSeen]);

  /**
   * `lastActivityMs` is the newest thing that happened in the thread;
   * `lastSenderIsSelf` suppresses the mark for your own messages.
   */
  const isUnread = React.useCallback(
    (sessionId: string, lastActivityMs: number, lastSenderIsSelf: boolean): boolean => {
      if (!lastActivityMs || lastSenderIsSelf) return false;
      if (sessionId === currentSessionId) return false;
      const at = seen[sessionId];
      // A thread first seen in this listing has no mark. Treating that as
      // unread would light up the entire sidebar on first run, so an unknown
      // thread counts as read and starts tracking from now.
      if (at === undefined) return false;
      return lastActivityMs > at;
    },
    [seen, currentSessionId],
  );

  /** Called on first sight of a thread list, so future activity is measurable. */
  const primeUnknown = React.useCallback(
    (sessionIds: string[]) => {
      setSeen((prev) => {
        let changed = false;
        const next = { ...prev };
        const now = Date.now();
        for (const id of sessionIds) {
          if (next[id] === undefined) {
            next[id] = now;
            changed = true;
          }
        }
        if (!changed) return prev;
        write(next);
        return next;
      });
    },
    [],
  );

  return { isUnread, markSeen, primeUnknown };
}
