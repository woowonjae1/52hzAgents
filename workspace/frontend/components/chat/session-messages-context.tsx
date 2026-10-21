'use client';

import * as React from 'react';
import { useEffect, useRef } from 'react';
import { useWorkspace, isDraftSessionId } from '@/lib/workspace-context';
import { useMessagePolling } from '@/hooks/use-polling';
import { loadWorkspaceSnapshots, saveThreadSnapshot, SNAPSHOT_THREADS } from '@/lib/message-snapshot';
import { workspaceApi } from '@/lib/api';
import { deduplicateAndSortMessages, eventToMessage, stripAddressPrefix } from '@/lib/types';
import type { WorkspaceMessage } from '@/lib/types';

// Module-level message cache — survives component re-renders/unmounts.
// Keyed by sessionId, stores the last known messages for instant thread switching.
export const messageCache = new Map<string, WorkspaceMessage[]>();
// Matches SNAPSHOT_THREADS so every thread restored from IndexedDB fits.
export const CACHE_MAX_SESSIONS = SNAPSHOT_THREADS;
// Which workspace cacheMessages persists snapshots under; set by the provider.
let snapshotWorkspaceId: string | null = null;
// Track last seen message ID per cached session for incremental refresh
export const cacheLastSeenId = new Map<string, string>();

export function parseDMSession(sessionId: string | null): [string, string] | null {
  if (!sessionId?.startsWith('dm:')) return null;
  const parts = sessionId.slice(3).split(',', 2);
  if (parts.length === 2) return [parts[0], parts[1]];
  return null;
}

export function normalizeAgentAddress(address: string): string {
  return stripAddressPrefix(address);
}

export function messagesForSession(sessionId: string, msgs: WorkspaceMessage[]): WorkspaceMessage[] {
  const dmPair = parseDMSession(sessionId);
  return msgs.flatMap((msg) => {
    const belongsToSession = dmPair
      ? msg.sessionId === sessionId ||
        dmPair.includes(msg.sessionId) ||
        dmPair.map(normalizeAgentAddress).includes(normalizeAgentAddress(msg.sessionId))
      : msg.sessionId === sessionId;
    if (!belongsToSession) return [];
    return dmPair ? [{ ...msg, sessionId }] : [msg];
  });
}

export function cacheMessages(sessionId: string, msgs: WorkspaceMessage[]) {
  const scopedMessages = deduplicateAndSortMessages(messagesForSession(sessionId, msgs));
  if (scopedMessages.length === 0) {
    // Never overwrite an existing populated cache with empty during session transitions
    return;
  }
  // Delete first so a refresh moves the thread to the newest end of the
  // eviction order instead of leaving it where it was first inserted.
  messageCache.delete(sessionId);
  messageCache.set(sessionId, scopedMessages);
  cacheLastSeenId.set(sessionId, scopedMessages[scopedMessages.length - 1].messageId);
  saveThreadSnapshot(snapshotWorkspaceId, sessionId, scopedMessages);
  // Evict oldest entries if cache grows too large
  if (messageCache.size > CACHE_MAX_SESSIONS) {
    const oldest = messageCache.keys().next().value;
    if (oldest) {
      messageCache.delete(oldest);
      cacheLastSeenId.delete(oldest);
    }
  }
}

const PREFETCH_COUNT = 6;
const CACHE_REFRESH_INTERVAL = 5_000; // refresh caches every 5s

/** Fetch recent messages for a session (cache prefetch). */
async function fetchSessionMessages(sessionId: string): Promise<WorkspaceMessage[]> {
  try {
    const result = await workspaceApi.loadMessageHistory(sessionId, { limit: 50 });
    // Events come newest-first from sort=desc, reverse for chronological display
    return messagesForSession(sessionId, result.events.map(eventToMessage)).reverse();
  } catch {
    return [];
  }
}

/** Incrementally refresh a cached session — fetch only new messages since last seen. */
async function refreshCachedSession(sessionId: string): Promise<void> {
  const lastId = cacheLastSeenId.get(sessionId);
  if (!lastId) {
    // No cache yet — do full fetch
    const msgs = await fetchSessionMessages(sessionId);
    cacheMessages(sessionId, msgs);
    return;
  }
  try {
    const result = await workspaceApi.pollMessages(sessionId, lastId);
    const scopedMessages = messagesForSession(sessionId, result.messages);
    if (scopedMessages.length > 0) {
      const existing = messageCache.get(sessionId) || [];
      const existingIds = new Set(existing.map((m) => m.messageId));
      const unique = scopedMessages.filter((m) => !existingIds.has(m.messageId));
      if (unique.length > 0) {
        cacheMessages(sessionId, [...existing, ...unique]);
      }
    }
  } catch {
    // Best-effort
  }
}

export type SessionMessagesValue = ReturnType<typeof useMessagePolling>;
const SessionMessagesContext = React.createContext<SessionMessagesValue | null>(null);

export function SessionMessagesProvider({ children }: { children: React.ReactNode }) {
  const { currentSessionId, workspaceId, sessions } = useWorkspace();
  const currentSessionIdRef = useRef(currentSessionId);
  currentSessionIdRef.current = currentSessionId;

  // Cached messages for this session, read once per session switch.
  const initialMessagesRef = useRef<WorkspaceMessage[] | undefined>(undefined);
  const initialMessagesSessionRef = useRef<string | null>(null);
  if (currentSessionId !== initialMessagesSessionRef.current) {
    initialMessagesRef.current = currentSessionId
      ? messagesForSession(currentSessionId, messageCache.get(currentSessionId) || [])
      : undefined;
    initialMessagesSessionRef.current = currentSessionId;
  }

  const value = useMessagePolling({
    // A draft has nothing on the server to poll (see isDraftSessionId).
    sessionId: isDraftSessionId(currentSessionId) ? null : currentSessionId,
    initialMessages: initialMessagesRef.current,
  });

  /*
    Restore the persisted thread snapshots (lib/message-snapshot.ts) into the
    in-memory cache, so the first switch to any recent thread after a start is
    instant. The thread already open when they arrive is seeded through
    seedIfEmpty, which does nothing if its real history beat IndexedDB to it.
  */
  const { seedIfEmpty } = value;
  useEffect(() => {
    snapshotWorkspaceId = workspaceId ?? null;
    if (!workspaceId) return;
    let cancelled = false;
    void loadWorkspaceSnapshots(workspaceId).then((snapshots) => {
      if (cancelled || snapshotWorkspaceId !== workspaceId) return;
      for (const [sessionId, msgs] of snapshots) {
        // A live entry is fresher than anything on disk.
        if (messageCache.has(sessionId)) continue;
        messageCache.set(sessionId, msgs);
        cacheLastSeenId.set(sessionId, msgs[msgs.length - 1].messageId);
      }
      while (messageCache.size > CACHE_MAX_SESSIONS) {
        const oldest = messageCache.keys().next().value;
        if (oldest === undefined) break;
        messageCache.delete(oldest);
        cacheLastSeenId.delete(oldest);
      }
      const open = currentSessionIdRef.current;
      const snapshot = open && !isDraftSessionId(open) ? snapshots.get(open) : undefined;
      if (open && snapshot) seedIfEmpty(open, snapshot);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, seedIfEmpty]);

  // Continuously refresh message caches for top recent sessions in the background.
  // This ensures clicking any recent thread shows messages instantly and up-to-date.
  useEffect(() => {
    if (!sessions || sessions.length === 0) return;

    const getTopSessions = () =>
      [...sessions]
        .filter((s) => s.status === 'active')
        .sort((a, b) => {
          const aTime = a.lastEventAt || (a.createdAt ? new Date(a.createdAt).getTime() : 0);
          const bTime = b.lastEventAt || (b.createdAt ? new Date(b.createdAt).getTime() : 0);
          return bTime - aTime;
        })
        .slice(0, PREFETCH_COUNT);

    // Initial fetch — staggered
    const initial = getTopSessions();
    initial.forEach((s, i) => {
      if (!messageCache.has(s.sessionId)) {
        setTimeout(() => {
          fetchSessionMessages(s.sessionId).then((msgs) => {
            if (msgs.length > 0) cacheMessages(s.sessionId, msgs);
          });
        }, i * 300);
      }
    });

    // Periodic incremental refresh — skip the session the user is currently viewing
    // (useMessagePolling handles that one)
    const interval = setInterval(async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const top = getTopSessions();
      for (const s of top) {
        if (s.sessionId === currentSessionIdRef.current) continue;
        await refreshCachedSession(s.sessionId);
      }
    }, CACHE_REFRESH_INTERVAL);

    return () => clearInterval(interval);
  }, [sessions]);

  return (
    <SessionMessagesContext.Provider value={value}>{children}</SessionMessagesContext.Provider>
  );
}

/**
 * The shared transcript for the current session. Throws rather than falling
 * back to its own poll: a silent second stream is the exact bug this replaced,
 * and it is invisible until someone profiles the network tab.
 */
export function useSessionMessages(): SessionMessagesValue {
  const ctx = React.useContext(SessionMessagesContext);
  if (!ctx) throw new Error('useSessionMessages must be used inside <SessionMessagesProvider>');
  return ctx;
}
