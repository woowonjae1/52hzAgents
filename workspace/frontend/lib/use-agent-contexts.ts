'use client';

import * as React from 'react';
import { workspaceApi } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace-context';
import type { AgentContext } from '@/lib/types';

/*
  ONE FETCH FOR THE WHOLE PAGE.

  The composer ring and every agent card on the dashboard read the same rows,
  and the dashboard can hold twenty cards. Each calling its own endpoint on its
  own timer would be twenty requests for one table, so the rows live in a
  module-level store: the first subscriber starts a poll, the last one to leave
  stops it, and everyone in between reads the same snapshot.
*/

const POLL_MS = 20_000;

type Listener = (rows: AgentContext[]) => void;

let currentWorkspace: string | null = null;
let rows: AgentContext[] = [];
const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;

function refresh(): Promise<void> {
  if (!currentWorkspace) return Promise.resolve();
  if (typeof document !== 'undefined' && document.hidden) return Promise.resolve();
  if (inflight) return inflight;
  const ws = currentWorkspace;
  inflight = (async () => {
    try {
      workspaceApi.setWorkspaceId(ws);
      const next = await workspaceApi.getAgentContexts();
      if (ws !== currentWorkspace) return;
      rows = next;
      listeners.forEach((l) => l(rows));
    } catch {
      // Keep the last snapshot: a failed poll is not "no context".
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function onVisible() {
  if (!document.hidden) void refresh();
}

function subscribe(workspaceId: string, l: Listener) {
  if (workspaceId !== currentWorkspace) {
    currentWorkspace = workspaceId;
    rows = [];
  }
  listeners.add(l);
  if (listeners.size === 1) {
    timer = setInterval(() => void refresh(), POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
  }
  void refresh();
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) {
      if (timer) clearInterval(timer);
      timer = null;
      document.removeEventListener('visibilitychange', onVisible);
    }
  };
}

/** Every agent-context row in the workspace, newest first. */
export function useAgentContexts(): { rows: AgentContext[]; refresh: () => Promise<void> } {
  const { workspaceId } = useWorkspace();
  const [snapshot, setSnapshot] = React.useState<AgentContext[]>(rows);
  React.useEffect(() => {
    if (!workspaceId) return;
    setSnapshot(workspaceId === currentWorkspace ? rows : []);
    return subscribe(workspaceId, setSnapshot);
  }, [workspaceId]);
  return { rows: snapshot, refresh };
}

/** Share of the window in use, 0–100; null when either number is unknown. */
export function contextPercent(c: Pick<AgentContext, 'promptTokens' | 'contextWindow'>): number | null {
  if (!c.contextWindow || c.contextWindow <= 0 || !c.promptTokens) return null;
  return Math.min(100, Math.round((c.promptTokens / c.contextWindow) * 100));
}

/**
 * Colour is spent only on real risk: grey below 60%, amber from 60, red from 85.
 * Same boundaries the context popover has always used.
 */
export function contextLevel(pct: number | null): 'unknown' | 'calm' | 'warning' | 'critical' {
  if (pct === null) return 'unknown';
  return pct >= 85 ? 'critical' : pct >= 60 ? 'warning' : 'calm';
}

export function fmtTokens(n: number): string {
  if (!n || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}
