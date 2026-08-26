'use strict';

/**
 * Product-facing agent names that are NOT runtime types of their own.
 *
 * The workspace catalog (`/v1/agent-catalog`) offers "chatgpt" as a one-click
 * agent, but the runtime behind it is the Codex CLI. Without this mapping
 * `wwj install chatgpt` dies with "Unknown agent type", and `wwj connect
 * chatgpt` silently falls back to the generic custom adapter — the user clicks
 * ChatGPT and OpenClaw comes up instead.
 */
const AGENT_TYPE_ALIASES = {
  chatgpt: 'codex',
  openai: 'codex',
  agy: 'antigravity',
  // `kilo` is shorthand for the kilocode type, NOT for opencode. Kilo Code's
  // CLI is served by the same adapter as OpenCode but is its own agent type:
  // separate binary, install command, config directory, credentials and version
  // line. Folding it into `opencode` at creation time erased the distinction
  // before the adapter could see it, leaving `agentName.includes('kilo')` as the
  // only surviving signal.
  kilo: 'kilocode',
};

/**
 * Normalize a user- or catalog-supplied agent type to its runtime type.
 * @param {string} type
 * @returns {string} lower-cased runtime type, aliases resolved
 */
function resolveAgentType(type) {
  if (!type) return type;
  const key = String(type).toLowerCase();
  return AGENT_TYPE_ALIASES[key] || key;
}

module.exports = { AGENT_TYPE_ALIASES, resolveAgentType };
