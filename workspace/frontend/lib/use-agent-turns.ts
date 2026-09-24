'use client';

import * as React from 'react';
import { workspaceApi } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace-context';
import { turnForWorkspace, type AgentTurnEventDetail } from '@/lib/agent-turn-event';

/*
  WHETHER AN AGENT IS MID-TURN, IN ITS OWN WORDS.

  The adapter reports `running` when a turn starts and `idle` / `error` when it
  ends, per channel; the backend turns a `running` row into `error` when the
  agent behind it goes offline or restarts. That replaces guessing from which
  message came last -- a crash used to leave a trailing thinking event and the
  agent looked busy forever.

  Same shape as use-agent-contexts: one module-level store, polled while
  anything is subscribed, plus the `workspace.agent.turn.updated` state event
  (relayed by the workspace SSE handler as a window event) applied immediately.
*/

export type AgentTurnState = 'idle' | 'running' | 'error';

export interface AgentTurn {
  agentName: string;
  channelName: string;
  state: AgentTurnState;
  /** Why the turn failed; '' unless state is 'error'. */
  error: string;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
}

/** Window event the workspace SSE handler dispatches for each turn update. */
export const AGENT_TURN_EVENT = 'wwj:agent-turn-updated';

const POLL_MS = 15_000;

type Listener = (rows: AgentTurn[]) => void;

let currentWorkspace: string | null = null;
let rows: AgentTurn[] = [];
const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;

export function mapAgentTurn(r: Record<string, unknown>): AgentTurn {
  const s = String(r.state || '');
  return {
    agentName: String(r.agent_name || ''),
    channelName: String(r.channel_name || ''),
    state: (s === 'running' || s === 'error' ? s : 'idle') as AgentTurnState,
    error: String(r.error || ''),
    startedAt: (r.started_at as string | null) ?? null,
    endedAt: (r.ended_at as string | null) ?? null,
    updatedAt: String(r.updated_at || ''),
  };
}

function emit() {
  listeners.forEach((l) => l(rows));
}

function refresh(): Promise<void> {
  if (!currentWorkspace) return Promise.resolve();
  if (typeof document !== 'undefined' && document.hidden) return Promise.resolve();
  if (inflight) return inflight;
  const ws = currentWorkspace;
  inflight = (async () => {
    try {
      workspaceApi.setWorkspaceId(ws);
      const res = await workspaceApi.request<{ turns?: Array<Record<string, unknown>> }>(
        `/v1/workspaces/${encodeURIComponent(ws)}/agent-turns`
      );
      if (ws !== currentWorkspace) return;
      rows = (res?.turns || []).map(mapAgentTurn);
      emit();
    } catch {
      // Keep the last snapshot: a failed poll is not "nobody is working".
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function applyEvent(ev: Event) {
  const turn = turnForWorkspace((ev as CustomEvent).detail as AgentTurnEventDetail | undefined, currentWorkspace);
  if (!turn) return;
  const t = mapAgentTurn(turn);
  if (!t.agentName || !t.channelName) return;
  const rest = rows.filter((r) => !(r.agentName === t.agentName && r.channelName === t.channelName));
  rows = [t, ...rest];
  emit();
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
    window.addEventListener(AGENT_TURN_EVENT, applyEvent);
  }
  void refresh();
  return () => {
    listeners.delete(l);
    if (listeners.size === 0) {
      if (timer) clearInterval(timer);
      timer = null;
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(AGENT_TURN_EVENT, applyEvent);
    }
  };
}

/** Every reported (agent, channel) turn in the workspace, newest first. */
export function useAgentTurns(): { rows: AgentTurn[]; refresh: () => Promise<void> } {
  const { workspaceId } = useWorkspace();
  const [snapshot, setSnapshot] = React.useState<AgentTurn[]>(rows);
  React.useEffect(() => {
    if (!workspaceId) return;
    setSnapshot(workspaceId === currentWorkspace ? rows : []);
    return subscribe(workspaceId, setSnapshot);
  }, [workspaceId]);
  return { rows: snapshot, refresh };
}

export interface AgentTurnSummary {
  /** The agent has reported at least one turn; if false, fall back to heuristics. */
  reported: boolean;
  /** Turns in flight, most recently started first. */
  running: AgentTurn[];
  /** The agent's most recently updated turn. */
  latest: AgentTurn | null;
}

export function summarizeAgentTurns(all: AgentTurn[], agentName: string): AgentTurnSummary {
  const key = agentName.toLowerCase();
  const mine = all.filter((r) => r.agentName.toLowerCase() === key);
  const ts = (s: string | null) => (s ? new Date(s).getTime() || 0 : 0);
  const running = mine
    .filter((r) => r.state === 'running')
    .sort((a, b) => ts(b.startedAt) - ts(a.startedAt));
  const latest = mine.reduce<AgentTurn | null>((acc, r) => (!acc || ts(r.updatedAt) > ts(acc.updatedAt) ? r : acc), null);
  return { reported: mine.length > 0, running, latest };
}
