'use client';

import * as React from 'react';
import { workspaceApi } from '@/lib/api';
import type { ParallelBatch } from '@/lib/api/orchestration';
import { eventToMessage, type RoutineItem, type WorkspaceSession } from '@/lib/types';
import { useVisibilityPolling } from '@/lib/use-visibility-polling';
import {
  pendingApprovalsFromMessages,
  type PendingActionItem,
} from '@/components/mission/action-required-banner';

/*
  WHAT THE HOME PAGE ASKS THE SERVER FOR, AND WHY IT IS THIS SMALL.

  Home is the landing view, so whatever it polls is paid on every app start.
  Nothing here invents a new endpoint or a new notion of "needs attention":
  each source is something the app already tracks somewhere else --
  - tool approvals: the same unanswered `tool_approval_request` scan the Agents
    view runs (pendingApprovalsFromMessages), over the 20 newest threads;
  - parallel batches: GET /v1/parallel-batch, only for threads whose mode is
    Parallel, which is the only place a batch can exist;
  - routines: already in workspace context, no request at all.
*/

function liveThreads(sessions: WorkspaceSession[]): WorkspaceSession[] {
  return sessions
    .filter((s) => s.status !== 'archived' && s.status !== 'deleted')
    .sort((a, b) => (b.lastEventAt || 0) - (a.lastEventAt || 0));
}

export function usePendingToolApprovals(sessions: WorkspaceSession[]) {
  const [items, setItems] = React.useState<PendingActionItem[]>([]);
  const sessionsRef = React.useRef(sessions);
  sessionsRef.current = sessions;

  const scan = React.useCallback(async () => {
    const threads = liveThreads(sessionsRef.current).slice(0, 20);
    if (threads.length === 0) {
      setItems([]);
      return;
    }
    const found = await Promise.all(
      threads.map(async (s) => {
        try {
          const res = await workspaceApi.loadMessageHistory(s.sessionId, { limit: 12 });
          return pendingApprovalsFromMessages(s, (res.events || []).map(eventToMessage));
        } catch {
          return [];
        }
      }),
    );
    setItems(found.flat().sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime()));
  }, []);

  useVisibilityPolling(scan, 15_000);
  return { items, refresh: scan };
}

export interface ParallelAttention {
  session: WorkspaceSession;
  batch: ParallelBatch;
}

/** Batches waiting on Merge/Discard, and batches with a failed lane. */
export function useParallelAttention(sessions: WorkspaceSession[]) {
  const [items, setItems] = React.useState<ParallelAttention[]>([]);
  const sessionsRef = React.useRef(sessions);
  sessionsRef.current = sessions;

  const scan = React.useCallback(async () => {
    const threads = liveThreads(sessionsRef.current)
      .filter((s) => s.orchestrationMode === 'parallel')
      .slice(0, 12);
    if (threads.length === 0) {
      setItems([]);
      return;
    }
    const found = await Promise.all(
      threads.map(async (session) => {
        try {
          const batch = await workspaceApi.getParallelBatch(session.sessionId);
          const run = batch.run;
          if (!run) return null;
          const inReview = run.batch.status === 'review';
          const failed = run.lanes.some((l) => l.status === 'failed');
          return inReview || failed ? { session, batch } : null;
        } catch {
          return null;
        }
      }),
    );
    setItems(found.filter((x): x is ParallelAttention => x !== null));
  }, []);

  useVisibilityPolling(scan, 20_000);
  return { items, refresh: scan };
}

/*
  `paused_reason` / `pending_approval` are being added to routines by a
  parallel change (agent-proposed routines, auto-pause after repeated
  failures). Read both spellings so this works whichever way the mapper lands,
  without widening the shared RoutineItem type from here.
*/
export function routinePausedReason(r: RoutineItem): string | null {
  const loose = r as RoutineItem & { pausedReason?: string | null; paused_reason?: string | null };
  const reason = loose.pausedReason ?? loose.paused_reason ?? null;
  return reason && reason.trim() ? reason.trim() : null;
}

export function isRoutinePendingApproval(r: RoutineItem): boolean {
  return r.status === 'pending_approval';
}
