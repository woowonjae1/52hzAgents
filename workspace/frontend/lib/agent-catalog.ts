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
    name: 'chatgpt',
    label: 'ChatGPT / Codex',
    description: 'OpenAI o-series & GPT flagship models terminal assistant for intelligent software development.',
    install_command: 'wwj install chatgpt',
    homepage: 'https://chatgpt.com',
    tags: ['coding', 'cli'],
    builtin: true,
  },
  {
    name: 'claude',
    label: 'Claude Code',
    description: "Anthropic's official terminal agent for code generation and shell execution.",
    install_command: 'wwj install claude',
    homepage: 'https://claude.ai',
    tags: ['coding', 'cli'],
    builtin: true,
  },
  {
    name: 'antigravity',
    label: 'Google Antigravity',
    description: 'Google Antigravity (AGY) agentic coding platform with Gemini models.',
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
    homepage: 'https://openclaw.ai',
    tags: ['coding', 'cli'],
    builtin: true,
  },
  {
    name: 'kilo',
    label: 'Kilo Code',
    description: 'Agentic engineering CLI platform with multi-model support and specialized modes.',
    install_command: 'wwj install kilo',
    homepage: 'https://kilo.ai',
    tags: ['coding', 'cli', 'architect'],
    builtin: true,
  },
  {
    name: 'cline',
    label: 'Cline',
    description: 'Autonomous coding agent extension and CLI with file edit and terminal tools.',
    install_command: 'wwj install cline',
    homepage: 'https://github.com/cline/cline',
    tags: ['coding', 'cli'],
    builtin: true,
  },
  {
    name: 'opencode',
    label: 'OpenCode',
    description: 'Open-source terminal coding assistant for agile software development.',
    install_command: 'wwj install opencode',
    homepage: 'https://opencode.ai',
    tags: ['coding', 'cli'],
    builtin: true,
  },
  {
    name: 'amp',
    label: 'Amp Agent',
    description: 'High-velocity AI software engineering agent with deep contextual tools.',
    install_command: 'wwj install amp',
    homepage: 'https://ampcode.com',
    tags: ['coding', 'cli'],
    builtin: true,
  },
  {
    name: 'cursor',
    label: 'Cursor Agent',
    description: 'Cursor AI code editor agent CLI bridge.',
    install_command: 'wwj install cursor',
    homepage: 'https://cursor.com',
    tags: ['coding', 'ide'],
    builtin: true,
  },
  {
    name: 'deepseek',
    label: 'DeepSeek',
    description: 'Deep reasoning and code architecture intelligence agent.',
    install_command: 'wwj install deepseek',
    homepage: 'https://deepseek.com',
    tags: ['coding', 'reasoning'],
    builtin: true,
  },
  {
    name: 'openhands',
    label: 'OpenHands',
    description: 'Autonomous AI software developer powered by OpenHands runtime.',
    install_command: 'wwj install openhands',
    homepage: 'https://openhands.ai',
    tags: ['coding', 'autonomous'],
    builtin: true,
  },
  {
    name: 'hermes',
    label: 'Hermes',
    description: 'A fast and lightweight agent built for rapid software maintenance.',
    install_command: 'wwj install hermes',
    homepage: 'https://github.com/hermes-agent',
    tags: ['coding', 'cli'],
    builtin: true,
  },
  {
    name: 'pi',
    label: 'Pi Agent',
    description: 'Multi-provider coding agent CLI with read/bash/edit/write tools.',
    install_command: 'wwj install pi',
    homepage: 'https://pi.ai',
    tags: ['coding', 'cli'],
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
  { name: 'acp', label: 'ACP Agent' },
];

// ---------------------------------------------------------------------------
// ACP: one runtime type, many CLIs. The user supplies the command.
// ---------------------------------------------------------------------------

/**
 * The generic Agent Client Protocol runtime (packages/wwj/src/adapters/acp.js,
 * registry entry "acp"). Not a one-click card like the roster above: it runs
 * nothing until the user says which command speaks ACP. The backend catalog
 * does not list it, so connect surfaces append it with `withAcpRuntime`.
 */
export const ACP_AGENT_ENTRY: AgentCatalogEntry = {
  name: 'acp',
  label: 'ACP Agent',
  description: 'Any CLI that speaks the Agent Client Protocol — Gemini CLI, OpenCode, Claude Code or Codex via an ACP bridge. You choose the command.',
  install_command: '',
  homepage: 'https://agentclientprotocol.com',
  tags: ['acp', 'custom'],
  builtin: true,
};

/** Append the ACP entry to a roster that does not already have it. */
export function withAcpRuntime(catalog: AgentCatalogEntry[]): AgentCatalogEntry[] {
  return catalog.some((e) => e.name === ACP_AGENT_ENTRY.name) ? catalog : [...catalog, ACP_AGENT_ENTRY];
}

/** One-click commands for CLIs known to speak ACP. */
export const ACP_COMMAND_PRESETS: { label: string; command: string }[] = [
  { label: 'Gemini CLI', command: 'gemini --experimental-acp' },
  { label: 'OpenCode', command: 'opencode acp' },
  { label: 'Claude Code', command: 'claude-code-acp' },
  { label: 'Codex', command: 'codex-acp' },
];

export type AcpPermissionMode = 'ask' | 'auto' | 'deny';

/** ACP_PERMISSION_MODE values, in the adapter's own terms (see acp.js). */
export const ACP_PERMISSION_MODES: { value: AcpPermissionMode; label: string; hint: string }[] = [
  { value: 'ask', label: 'Ask each time', hint: 'Each permission request posts an approval card in the channel; no answer means no.' },
  { value: 'auto', label: 'Auto-allow', hint: 'Every request is approved without asking, as the other local agents run.' },
  { value: 'deny', label: 'Deny all', hint: 'Every request is refused; the agent only does what needs no approval.' },
];

/** The agent env an ACP agent is connected with. */
export function acpAgentEnv(command: string, permissionMode: AcpPermissionMode): Record<string, string> {
  return { ACP_COMMAND: command.trim(), ACP_PERMISSION_MODE: permissionMode };
}

/**
 * Quote one argument for pasting into a terminal. Plain values stay bare;
 * values with spaces and otherwise ordinary characters get double quotes,
 * which bash, zsh, PowerShell and cmd.exe all read the same way. Anything
 * with characters those shells treat differently falls back to POSIX single
 * quotes.
 */
export function shellQuoteArg(value: string): string {
  if (value === '') return "''";
  if (/^[A-Za-z0-9_\-./:=@+,]+$/.test(value)) return value;
  if (/^[A-Za-z0-9_\-./:=@+, ]+$/.test(value)) return `"${value}"`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const COMMAND_RUNNERS = new Set(['npx', 'bunx', 'pnpm', 'pnpx', 'yarn', 'dlx', 'node', 'bun', 'deno', 'uvx', 'exec']);

/**
 * Agent name for an ACP command: `acp-gemini`, `acp-opencode`,
 * `acp-claude-code`. Keyed by the tool so connecting Gemini and then OpenCode
 * creates two agents instead of re-pointing one. Always within the backend's
 * agent-name charset.
 */
export function acpAgentName(command: string): string {
  const tokens = command.trim().split(/\s+/).filter((t) => t && !t.startsWith('-'));
  const tool = tokens.find((t) => !COMMAND_RUNNERS.has(t.toLowerCase())) || '';
  const base = (tool.split(/[\\/]/).pop() || '')
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|js|mjs)$/, '')
    .replace(/[-_]?acp$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base ? `acp-${base}` : 'acp-agent';
}

/** `wwj connect` for a new ACP agent, with its settings as `--env` flags. */
export function acpConnectCommand(
  agentName: string,
  token: string,
  command: string,
  permissionMode: AcpPermissionMode,
): string {
  const env = acpAgentEnv(command, permissionMode);
  const envFlags = Object.entries(env).map(([k, v]) => `--env ${shellQuoteArg(`${k}=${v}`)}`);
  return ['wwj connect', agentName, token, '--type acp', ...envFlags].join(' ');
}

/**
 * Roster names that ship no brand icon of their own. `chatgpt` is the Codex
 * CLI wearing an OpenAI face; without this it falls through to default.svg.
 */
export const AGENT_ICON_ALIASES: Record<string, string> = {
  chatgpt: 'openai',
  antigravity: 'antigravity',
  agy: 'antigravity',
  claude: 'claude',
  anthropic: 'claude',
  'claude-code': 'claude',
  'claude-api': 'claude',
  // Generic runtime — no brand of its own; the neutral "custom" glyph.
  acp: 'custom',
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
