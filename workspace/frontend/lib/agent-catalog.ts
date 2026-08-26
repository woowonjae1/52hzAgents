'use client';

import { useEffect, useState } from 'react';
import { workspaceApi } from './api';
import type { AgentCatalogEntry, WorkspaceAgent } from './types';

/**
 * The one-click agent roster.
 *
 * This list must stay identical to the backend's
 * (backend/internal/handlers/agents_catalog.go). It used to be copied by hand
 * into four components; three of them drifted, so users got a different roster
 * and different install commands depending on which screen they were on. Import
 * from here instead of re-declaring.
 *
 * `name` is the runtime type the launcher resolves — `chatgpt` is an alias for
 * the Codex CLI, mapped in packages/wwj/src/agent-types.js.
 */
export const DEFAULT_AGENT_CATALOG: AgentCatalogEntry[] = [
  {
    name: 'claude',
    label: 'Claude Code',
    description: "Anthropic's official terminal agent for code generation and shell execution.",
    install_command: 'wwj install claude',
    homepage: 'https://openagents.org',
    tags: ['coding', 'cli'],
    builtin: true,
  },
  {
    name: 'antigravity',
    label: 'Google Antigravity',
    description: 'Google Antigravity (AGY) agentic coding platform with Gemini 3.5 models.',
    install_command: 'wwj connect antigravity',
    homepage: 'https://antigravity.google',
    tags: ['coding', 'cli', 'gemini'],
    builtin: true,
  },
  {
    name: 'openclaw',
    label: 'OpenClaw',
    description: 'A community-driven coding agent with autonomous task execution capabilities.',
    install_command: 'wwj install openclaw',
    homepage: 'https://openagents.org',
    tags: ['coding', 'cli'],
    builtin: true,
  },
  {
    name: 'hermes',
    label: 'Hermes',
    description: 'A fast and lightweight agent built for rapid software maintenance.',
    install_command: 'wwj install hermes',
    homepage: 'https://openagents.org',
    tags: ['coding', 'cli'],
    builtin: true,
  },
  {
    name: 'pi',
    label: 'Pi Agent',
    description: 'Multi-provider coding agent CLI with read/bash/edit/write tools.',
    install_command: 'wwj install pi',
    homepage: 'https://openagents.org',
    tags: ['coding', 'cli'],
    builtin: true,
  },
  {
    name: 'chatgpt',
    label: 'ChatGPT / Codex',
    description: 'OpenAI GPT-4o & Codex terminal assistant for intelligent software development.',
    install_command: 'wwj install chatgpt',
    homepage: 'https://openagents.org',
    tags: ['coding', 'cli'],
    builtin: true,
  },
  {
    name: 'cursor',
    label: 'Cursor Agent',
    description: 'Cursor AI code editor agent CLI bridge.',
    install_command: 'wwj install cursor',
    homepage: 'https://openagents.org',
    tags: ['coding', 'ide'],
    builtin: true,
  },
];

/**
 * Runtimes wwj has a built-in adapter for but that are not featured on the
 * six-card roster. Mirrors packages/wwj/registry.json — anything listed here
 * can be created and connected with no command of its own.
 */
export const EXTRA_AGENT_RUNTIMES: { name: string; label: string }[] = [
  { name: 'goose', label: 'Goose' },
  { name: 'cline', label: 'Cline' },
  { name: 'cursor', label: 'Cursor' },
  { name: 'opencode', label: 'OpenCode' },
  { name: 'copilot', label: 'GitHub Copilot' },
  { name: 'gemini', label: 'Gemini CLI' },
  { name: 'kimi', label: 'Kimi' },
  { name: 'amp', label: 'Amp' },
  { name: 'nanoclaw', label: 'NanoClaw' },
];

/**
 * Roster names that ship no brand icon of their own. `chatgpt` is the Codex
 * CLI wearing an OpenAI face; without this it falls through to default.svg.
 */
export const AGENT_ICON_ALIASES: Record<string, string> = {
  chatgpt: 'openai',
  antigravity: 'antigravity',
  agy: 'antigravity',
};

/** Icon file base name for an agent/provider name. */
export function resolveAgentIconName(name: string): string {
  const key = (name || '').toLowerCase();
  return AGENT_ICON_ALIASES[key] || key;
}

/**
 * Catalog entries rendered as offline agent rows, for surfaces that show the
 * full roster (overview matrix, connect modal) rather than only what is
 * connected. Every one starts Offline — nothing is launched until the user
 * clicks Connect.
 */
export function catalogAsOfflineAgents(catalog: AgentCatalogEntry[]): WorkspaceAgent[] {
  return catalog.map((entry) => ({
    agentName: entry.name,
    role: 'worker',
    agentType: entry.name,
    serverHost: null,
    workingDir: null,
    description: entry.description,
    enabledSkills: null,
    status: 'offline',
    lastHeartbeatAt: null,
    joinedAt: null,
  }));
}

/**
 * Fetch the roster from `/v1/agent-catalog`, falling back to the bundled copy.
 * The fallback is never a loading state — callers always have a usable roster.
 */
export function useAgentCatalog(enabled = true): { catalog: AgentCatalogEntry[]; loading: boolean } {
  const [catalog, setCatalog] = useState<AgentCatalogEntry[]>(DEFAULT_AGENT_CATALOG);
  const [loading, setLoading] = useState(enabled);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    workspaceApi
      .getAgentCatalog()
      .then((entries) => {
        if (!cancelled && entries && entries.length > 0) setCatalog(entries);
      })
      .catch(() => {
        /* keep the bundled roster */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return { catalog, loading };
}
