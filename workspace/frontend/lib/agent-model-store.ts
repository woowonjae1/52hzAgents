'use client';

/**
 * One place that knows which model each agent is running.
 *
 * THREE SURFACES CHANGE AN AGENT'S MODEL and they all write the same control
 * event: the composer chip (`components/chat/agent-model-switcher.tsx`), the
 * Mission Control station (`components/mission/agent-station.tsx`), and the
 * agent profile panel (`components/agents/agent-profile-panel.tsx`). The server
 * was never the problem — `sendAgentControl(name, 'set_model', …)` is the same
 * call in all three. The problem was that each one kept its OWN `useState`
 * copy of "current model", fetched on its own schedule, so switching in one
 * place left the other two showing the old value until their next poll. Three
 * controls disagreeing about the same fact is what read as a conflict.
 *
 * So the fact lives here instead, outside React, and every surface subscribes.
 * A switch anywhere is visible everywhere on the next frame.
 *
 * This is deliberately NOT in `workspace-context`: that provider hands ~90
 * values to 46 consumers off one memo, so adding a field there means every
 * model switch re-renders the whole app. `useSyncExternalStore` re-renders only
 * the components that read this.
 */

import { useSyncExternalStore } from 'react';

export interface AgentModelOption {
  id: string;
  name: string;
  shortName: string;
  provider?: string;
}

/**
 * The adapter reports its model list as either a JSON array or a comma-separated
 * string, and either form may carry `provider/model` ids.
 *
 * Lives here rather than in the switcher component because all three surfaces
 * parse the same payload; the switcher re-exports it so existing imports keep
 * working.
 */
export function parseReportedModels(raw?: string | null): AgentModelOption[] {
  if (!raw) return [];
  const toOption = (id: string, name?: string): AgentModelOption => {
    const trimmed = id.trim();
    const slash = trimmed.indexOf('/');
    const provider = slash > 0 ? trimmed.slice(0, slash) : undefined;
    const bare = slash > 0 ? trimmed.slice(slash + 1) : trimmed;
    return {
      id: trimmed,
      name: (name || '').trim() || bare,
      shortName: bare,
      provider,
    };
  };

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((m) =>
          typeof m === 'string'
            ? toOption(m)
            : toOption(String(m?.id ?? m?.name ?? ''), m?.name || m?.label),
        )
        .filter((m) => m.id.length > 0);
    }
  } catch {
    if (/^\s*[[{]/.test(raw)) return [];
  }
  return raw
    .split(',')
    .map((s) => toOption(s))
    .filter((m) => m.id.length > 0);
}

export interface AgentModelEntry {
  /** The model id the agent is running, as last reported or last set here. */
  current?: string;
  /** Only what the agent's own adapter reported — never a made-up list. */
  options: AgentModelOption[];
}

export type AgentModelState = Readonly<Record<string, AgentModelEntry>>;

const EMPTY: AgentModelState = Object.freeze({});

let state: AgentModelState = EMPTY;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * MUST return the same reference when nothing changed. Every mutator below
 * builds a new object only when it has something to change, because
 * `useSyncExternalStore` compares by identity and a fresh object every call is
 * an infinite render loop.
 */
function getSnapshot(): AgentModelState {
  return state;
}

/** The prerender has no agents; `output: 'export'` builds this file too. */
function getServerSnapshot(): AgentModelState {
  return EMPTY;
}

export function useAgentModels(): AgentModelState {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Read the model list for one agent out of a snapshot. */
export function modelsFor(snapshot: AgentModelState, agentName: string): AgentModelOption[] {
  return snapshot[agentName]?.options ?? [];
}

/** Read the current model id for one agent out of a snapshot. */
export function currentModelFor(snapshot: AgentModelState, agentName: string): string | undefined {
  return snapshot[agentName]?.current;
}

/**
 * Fold in what a heartbeat just reported.
 *
 * `current` from the adapter does NOT overwrite a value set locally: a switch
 * is optimistic and the next `getAgentUsage` may still be answering with the
 * pre-switch model, which would make the menu flip back for one poll cycle.
 * Only fills a blank.
 */
export function hydrateAgentModels(
  agentName: string,
  reported: { options?: AgentModelOption[]; current?: string | null },
): void {
  const prev = state[agentName];
  const nextOptions =
    reported.options && reported.options.length > 0
      ? reported.options
      : prev?.options ?? [];
  const nextCurrent = prev?.current ?? reported.current ?? undefined;

  const optionsUnchanged =
    prev !== undefined &&
    prev.options.length === nextOptions.length &&
    prev.options.every((o, i) => o.id === nextOptions[i]?.id);
  if (optionsUnchanged && prev.current === nextCurrent) return;

  state = { ...state, [agentName]: { options: nextOptions, current: nextCurrent } };
  emit();
}

/** Record a switch. Pass `undefined` to fall back to the environment default. */
export function setCurrentModel(agentName: string, modelId: string | undefined): void {
  const prev = state[agentName];
  if (prev?.current === modelId) return;
  state = {
    ...state,
    [agentName]: { options: prev?.options ?? [], current: modelId },
  };
  emit();
}

/*
  Per-thread persistence. The key format is the one the composer chip already
  wrote, so a workspace that has been in use keeps its saved choices.
*/
const storageKey = (sessionId: string, agentName: string) =>
  `52hz_model_${sessionId}_${agentName}`;

export function rememberForSession(sessionId: string, agentName: string, modelId: string): void {
  try {
    localStorage.setItem(storageKey(sessionId, agentName), modelId);
  } catch {
    // Private windows and cleared site data both throw here; the switch itself
    // already reached the agent, so this is only the memory of it.
  }
}

export function restoreForSession(sessionId: string, agentNames: string[]): void {
  for (const name of agentNames) {
    try {
      const saved = localStorage.getItem(storageKey(sessionId, name));
      if (saved) setCurrentModel(name, saved);
    } catch {
      return;
    }
  }
}
