/**
 * Adapter registry — maps agent type names to adapter classes.
 */

'use strict';

const BaseAdapter = require('./base');
const OpenClawAdapter = require('./openclaw');
const ClaudeAdapter = require('./claude');
const CodexAdapter = require('./codex');
const OpenCodeAdapter = require('./opencode');
const NanoClawAdapter = require('./nanoclaw');
const CursorAdapter = require('./cursor');
const HermesAdapter = require('./hermes');
const GeminiAdapter = require('./gemini');
const KimiAdapter = require('./kimi');
const GooseAdapter = require('./goose');
const CopilotAdapter = require('./copilot');
const ClineAdapter = require('./cline');
const AmpAdapter = require('./amp');
const PiAdapter = require('./pi');
const AntigravityAdapter = require('./antigravity');
const DeepSeekAdapter = require('./deepseek');
const CustomAdapter = require('./custom');
const { AGENT_TYPE_ALIASES, resolveAgentType } = require('../agent-types');

const ADAPTER_MAP = {
  openclaw: OpenClawAdapter,
  claude: ClaudeAdapter,
  codex: CodexAdapter,
  opencode: OpenCodeAdapter,
  kilocode: OpenCodeAdapter,
  kilo: OpenCodeAdapter,
  nanoclaw: NanoClawAdapter,
  cursor: CursorAdapter,
  hermes: HermesAdapter,
  gemini: GeminiAdapter,
  antigravity: AntigravityAdapter,
  agy: AntigravityAdapter,
  deepseek: DeepSeekAdapter,
  kimi: KimiAdapter,
  goose: GooseAdapter,
  copilot: CopilotAdapter,
  cline: ClineAdapter,
  amp: AmpAdapter,
  pi: PiAdapter,
  // A user-supplied command, NOT OpenClaw. Pointing `custom` at OpenClawAdapter
  // meant "connect a custom agent" quietly launched OpenClaw instead.
  custom: CustomAdapter,
};

/**
 * Create an adapter instance for the given agent type.
 * @param {string} type - Agent type (openclaw, claude, codex, opencode, nanoclaw, cursor, hermes, gemini, kimi, aider, goose, copilot, cline, amp, pi)
 * @param {object} opts - Adapter constructor options
 * @returns {BaseAdapter}
 */
function createAdapter(type, opts) {
  const AdapterClass = ADAPTER_MAP[resolveAgentType(type)];
  if (!AdapterClass) {
    const supported = [...Object.keys(ADAPTER_MAP), ...Object.keys(AGENT_TYPE_ALIASES)].sort();
    throw new Error(`Unknown agent type: ${type}. Supported: ${supported.join(', ')}`);
  }
  return new AdapterClass(opts);
}

/** Every type name `createAdapter` accepts, runtime types and aliases alike. */
function knownAgentTypes() {
  return [...Object.keys(ADAPTER_MAP), ...Object.keys(AGENT_TYPE_ALIASES)];
}

module.exports = {
  BaseAdapter,
  OpenClawAdapter,
  ClaudeAdapter,
  CodexAdapter,
  OpenCodeAdapter,
  NanoClawAdapter,
  CursorAdapter,
  HermesAdapter,
  GeminiAdapter,
  AntigravityAdapter,
  DeepSeekAdapter,
  KimiAdapter,
  GooseAdapter,
  CopilotAdapter,
  ClineAdapter,
  AmpAdapter,
  PiAdapter,
  CustomAdapter,
  createAdapter,
  knownAgentTypes,
  ADAPTER_MAP,
};
