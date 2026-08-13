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
