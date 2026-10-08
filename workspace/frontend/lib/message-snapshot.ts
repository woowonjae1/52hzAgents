'use client';

import type { WorkspaceMessage } from '@/lib/types';

/*
  THREAD SNAPSHOTS IN INDEXEDDB.

  chat-view.tsx keeps a module-level cache of recent threads so switching to
  one shows its messages at once. That cache lives in memory, so every app start
  (and every reload) began with an empty transcript and a skeleton while the
  first history request ran. This persists the tail of each recently viewed
  thread so the first open after a start is as instant as the hundredth.

  What is kept: the last SNAPSHOT_MESSAGES server-confirmed messages of the
  SNAPSHOT_THREADS most recently saved threads per workspace. A snapshot is a
  display seed, never the truth: the history request still runs on open, and
  the poll fetches everything `after` the snapshot's newest message, so a stale
  or partial snapshot is corrected within one round trip.

  IndexedDB rather than localStorage because localStorage is synchronous on the
  main thread and capped near 5 MB, and transcripts are the one thing here
  large enough to hit both. Every failure path resolves quietly: private
  windows, blocked storage and quota errors must cost the speed-up only.
*/

const DB_NAME = '52hz-thread-snapshots';
const DB_VERSION = 1;
const STORE = 'threads';

export const SNAPSHOT_MESSAGES = 30;
export const SNAPSHOT_THREADS = 20;

interface SnapshotRecord {
  key: string;
  workspaceId: string;
  sessionId: string;
  savedAt: number;
  messages: WorkspaceMessage[];
}

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'key' });
          store.createIndex('workspaceId', 'workspaceId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

function snapshotKey(workspaceId: string, sessionId: string) {
  return `${workspaceId}::${sessionId}`;
}

/** Only what the server has: optimistic and failed sends are this tab's business. */
function persistable(messages: WorkspaceMessage[]): WorkspaceMessage[] {
  return messages
    .filter((m) => !m.messageId.startsWith('optimistic-') && (!m.deliveryStatus || m.deliveryStatus === 'confirmed'))
    .slice(-SNAPSHOT_MESSAGES);
}

/** Every snapshot for a workspace, keyed by session id. Empty on any failure. */
export async function loadWorkspaceSnapshots(workspaceId: string): Promise<Map<string, WorkspaceMessage[]>> {
  const out = new Map<string, WorkspaceMessage[]>();
  const db = await openDb();
  if (!db) return out;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).index('workspaceId').getAll(workspaceId);
      req.onsuccess = () => {
        for (const rec of (req.result as SnapshotRecord[]) || []) {
          if (Array.isArray(rec.messages) && rec.messages.length > 0) out.set(rec.sessionId, rec.messages);
        }
        resolve(out);
      };
      req.onerror = () => resolve(out);
    } catch {
      resolve(out);
    }
  });
}

async function writeSnapshot(workspaceId: string, sessionId: string, messages: WorkspaceMessage[]) {
  const kept = persistable(messages);
  if (kept.length === 0) return;
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const record: SnapshotRecord = {
      key: snapshotKey(workspaceId, sessionId),
      workspaceId,
      sessionId,
      savedAt: Date.now(),
      messages: kept,
    };
    store.put(record);
    // Prune in the same transaction: keep the newest SNAPSHOT_THREADS of this workspace.
    const all = store.index('workspaceId').getAll(workspaceId);
    all.onsuccess = () => {
      const rows = ((all.result as SnapshotRecord[]) || []).sort((a, b) => b.savedAt - a.savedAt);
      for (const stale of rows.slice(SNAPSHOT_THREADS)) store.delete(stale.key);
    };
  } catch {
    // Quota or a closed connection: the snapshot is an optimisation only.
  }
}

/*
  Writes are debounced per thread. A busy thread changes its message list on
  every streamed chunk; the snapshot only needs the state it settles in.
*/
const SAVE_DELAY_MS = 1500;
const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; run: () => void }>();

export function saveThreadSnapshot(workspaceId: string | null | undefined, sessionId: string, messages: WorkspaceMessage[]) {
  if (!workspaceId || !sessionId) return;
  const key = snapshotKey(workspaceId, sessionId);
  const prev = pending.get(key);
  if (prev) clearTimeout(prev.timer);
  const run = () => {
    pending.delete(key);
    void writeSnapshot(workspaceId, sessionId, messages);
  };
  pending.set(key, { timer: setTimeout(run, SAVE_DELAY_MS), run });
}

/** Write every debounced snapshot now -- the page is going away. */
export function flushThreadSnapshots() {
  for (const { timer, run } of Array.from(pending.values())) {
    clearTimeout(timer);
    run();
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushThreadSnapshots);
}
