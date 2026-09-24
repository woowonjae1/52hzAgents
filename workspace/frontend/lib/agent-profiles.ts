/**
 * AGENT PROFILES — one-click presets for the kind of work a thread is for.
 *
 * A profile bundles the settings that belong together so switching from
 * "look at this" to "change this" is one click. Every setting here is applied
 * through a mechanism that already exists; nothing new is invented:
 *
 *   agentMode → the adapter's `set_mode` control action (wwj base.js
 *               `_pollControl`), which accepts exactly 'execute' | 'plan'.
 *
 * WHAT 'plan' ACTUALLY ENFORCES, per CLI (checked in the adapters, 2026-09):
 *   - claude  : `--permission-mode plan`, and Write/Edit/Bash plus the
 *               workspace write tools dropped from `--allowedTools`. A live
 *               per-thread process is restarted on a mode change (claude.js).
 *   - copilot : `--plan` instead of the write/shell allow-list.
 *   - cline   : `-p` (plan mode) instead of `--auto-approve true`.
 *   - everything else (codex, opencode, gemini, pi, goose, …): the mode only
 *     changes the system prompt ("do not modify files"). codex in particular
 *     still runs with `--dangerously-bypass-approvals-and-sandbox`. That is a
 *     request, not a guard, and the UI says so.
 *
 * A model is deliberately NOT part of any profile: there is no cross-agent
 * notion of "the cheaper model" to pick without guessing per provider.
 *
 * SCOPE LIMITATION: the adapter holds ONE mode per agent, not per channel. So
 * a thread's profile is re-applied to its agents when the thread is opened —
 * but an agent working in two threads at once runs in whichever mode was set
 * last. The picker's hint states this rather than pretending otherwise.
 */

import { Eye, Wrench, type LucideIcon } from 'lucide-react';

export type AgentMode = 'execute' | 'plan';
export type AgentProfileId = 'fix' | 'review';

export interface AgentProfile {
  id: AgentProfileId;
  label: string;
  icon: LucideIcon;
  /** One line: when to pick this. Honest about what is enforced. */
  whenToUse: string;
  settings: {
    agentMode: AgentMode;
  };
}

export const AGENT_PROFILES: readonly AgentProfile[] = [
  {
    id: 'fix',
    label: 'Fix',
    icon: Wrench,
    whenToUse: 'Agents can edit files and run commands. For making the change.',
    settings: { agentMode: 'execute' },
  },
  {
    id: 'review',
    label: 'Review',
    icon: Eye,
    whenToUse:
      'Read and propose only. Edits are blocked for Claude, Copilot and Cline; other agents are only asked not to edit.',
    settings: { agentMode: 'plan' },
  },
];

export const DEFAULT_PROFILE_ID: AgentProfileId = 'fix';

export function getProfile(id: AgentProfileId | null | undefined): AgentProfile {
  return AGENT_PROFILES.find((p) => p.id === id) ?? AGENT_PROFILES[0];
}

/** Agent types whose CLI flags make 'plan' a real read-only guard. */
const READONLY_ENFORCED_TYPES = new Set(['claude', 'copilot', 'cline']);

export function isReadOnlyEnforced(agentType: string | null | undefined, agentName?: string): boolean {
  const kind = (agentType || agentName || '').toLowerCase();
  return READONLY_ENFORCED_TYPES.has(kind);
}

// ── Per-thread persistence (same shape as the per-session model choice) ──

const storageKey = (sessionId: string) => `52hz_profile_${sessionId}`;

export function loadThreadProfile(sessionId: string | null | undefined): AgentProfileId | null {
  if (!sessionId) return null;
  try {
    const v = localStorage.getItem(storageKey(sessionId));
    return v === 'fix' || v === 'review' ? v : null;
  } catch {
    return null;
  }
}

export function saveThreadProfile(sessionId: string, id: AgentProfileId): void {
  try {
    localStorage.setItem(storageKey(sessionId), id);
  } catch {
    // Private windows throw; the mode already reached the agents.
  }
}

/** A new chat's profile is picked under its draft id; carry it to the real one. */
export function moveThreadProfile(fromSessionId: string, toSessionId: string): void {
  try {
    const v = localStorage.getItem(storageKey(fromSessionId));
    if (v !== null) localStorage.setItem(storageKey(toSessionId), v);
    localStorage.removeItem(storageKey(fromSessionId));
  } catch {
    // See saveThreadProfile.
  }
}

// ── What this browser last told each agent ──
//
// The adapter never reports its mode except as `agent_mode` on the messages
// it posts, which may be old. This records what was actually sent from here,
// so opening a Fix thread only sends 'execute' to an agent that may still be
// in plan. (Opening a Review thread always re-asserts 'plan' — an adapter
// restart silently resets to execute, and that is the direction that matters.)

const modeKey = (agentName: string) => `52hz_agent_mode_${agentName.toLowerCase()}`;

export function lastSentMode(agentName: string): AgentMode | undefined {
  try {
    const v = localStorage.getItem(modeKey(agentName));
    return v === 'execute' || v === 'plan' ? v : undefined;
  } catch {
    return undefined;
  }
}

export function noteModeSent(agentName: string, mode: AgentMode): void {
  try {
    localStorage.setItem(modeKey(agentName), mode);
  } catch {
    // See saveThreadProfile.
  }
}
