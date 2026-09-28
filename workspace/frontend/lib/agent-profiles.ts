/**
 * AGENT PROFILES — one-click presets for the kind of work a thread is for.
 *
 * A profile bundles the settings that belong together so switching from
 * "look at this" to "change this" is one click. Every setting here is applied
 * through a mechanism that already exists; nothing new is invented:
 *
 *   agentMode → `metadata.agent_mode` on every message this thread sends
 *               (chat-view handleSend). The adapter runs THAT turn in that
 *               mode (wwj base.js `_enterTurnMode`), so the choice is per
 *               thread, not per agent, and survives an adapter restart. The
 *               `set_mode` control is only the fallback for messages that
 *               carry no mode (other clients). Accepts 'execute' | 'plan'.
 *
 * WHAT 'plan' ACTUALLY ENFORCES, per CLI (checked in the adapters, 2026-09):
 *   - claude  : `--permission-mode plan`, and Write/Edit/Bash plus the
 *               workspace write tools dropped from `--allowedTools`. The live
 *               per-thread process is restarted when a turn's mode differs.
 *   - copilot : `--plan` instead of the write/shell allow-list.
 *   - cline   : `-p` (plan mode) instead of `--auto-approve true`.
 *   - codex   : `--sandbox read-only` instead of
 *               `--dangerously-bypass-approvals-and-sandbox` (codex exec --help).
 *   - pi      : `--tools read,grep,find,ls`, pi's documented read-only set.
 *   - gemini  : `--approval-mode default` instead of `-y`; headless, a tool
 *               that needs approval is denied (gemini-cli policy-engine docs).
 *   - acp     : edit/delete/move/execute permission requests and fs writes
 *               are refused -- but only what the agent routes through the
 *               client; one that runs tools without asking is not stopped,
 *               so ACP is not counted as enforced below.
 *   - everything else (opencode, goose, cursor, …): the mode only changes the
 *     system prompt ("do not modify files"). That is a request, not a guard,
 *     and the UI says so.
 *
 * A model is deliberately NOT part of any profile: there is no cross-agent
 * notion of "the cheaper model" to pick without guessing per provider.
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
      'Read and propose only. Edits are blocked for Claude, Codex, Gemini, Pi, Copilot and Cline; other agents are only asked not to edit.',
    settings: { agentMode: 'plan' },
  },
];

export const DEFAULT_PROFILE_ID: AgentProfileId = 'fix';

export function getProfile(id: AgentProfileId | null | undefined): AgentProfile {
  return AGENT_PROFILES.find((p) => p.id === id) ?? AGENT_PROFILES[0];
}

/** Agent types whose CLI flags make 'plan' a real read-only guard. */
const READONLY_ENFORCED_TYPES = new Set(['claude', 'codex', 'gemini', 'pi', 'copilot', 'cline']);

export function isReadOnlyEnforced(agentType: string | null | undefined, agentName?: string): boolean {
  const kind = (agentType || agentName || '').toLowerCase();
  return READONLY_ENFORCED_TYPES.has(kind);
}

// ── Per-thread persistence (same shape as the per-session model choice) ──

const storageKey = (sessionId: string) => `52hz_profile_${sessionId}`;

// Where localStorage throws (private windows), picks still hold for this tab,
// so the next message carries the mode the switch shows rather than Fix.
const memoryProfiles = new Map<string, AgentProfileId>();

export function loadThreadProfile(sessionId: string | null | undefined): AgentProfileId | null {
  if (!sessionId) return null;
  try {
    const v = localStorage.getItem(storageKey(sessionId));
    if (v === 'fix' || v === 'review') return v;
  } catch {
    // Fall through to this tab's memory.
  }
  return memoryProfiles.get(sessionId) ?? null;
}

/** The mode a message sent in this thread carries (`metadata.agent_mode`). */
export function threadAgentMode(sessionId: string | null | undefined): AgentMode {
  return getProfile(loadThreadProfile(sessionId) ?? DEFAULT_PROFILE_ID).settings.agentMode;
}

/**
 * Fired after a thread's profile is written, so a switch that is already on
 * screen for that thread (the composer's) follows a write made elsewhere --
 * Home's setup saves the profile a tick after the draft opens.
 */
export const THREAD_PROFILE_EVENT = 'wwj:thread-profile-changed';

export function saveThreadProfile(sessionId: string, id: AgentProfileId): void {
  memoryProfiles.set(sessionId, id);
  try {
    localStorage.setItem(storageKey(sessionId), id);
  } catch {
    // Private windows throw; memoryProfiles keeps the pick for this tab.
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(THREAD_PROFILE_EVENT, { detail: { sessionId, id } }));
  }
}

/** A new chat's profile is picked under its draft id; carry it to the real one. */
export function moveThreadProfile(fromSessionId: string, toSessionId: string): void {
  const mem = memoryProfiles.get(fromSessionId);
  if (mem) {
    memoryProfiles.set(toSessionId, mem);
    memoryProfiles.delete(fromSessionId);
  }
  try {
    const v = localStorage.getItem(storageKey(fromSessionId));
    if (v !== null) localStorage.setItem(storageKey(toSessionId), v);
    localStorage.removeItem(storageKey(fromSessionId));
  } catch {
    // See saveThreadProfile.
  }
}
