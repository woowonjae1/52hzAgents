'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { fail, locate, buildSanitizedNativeEnv, stopChild } = require('./common');

/**
 * Builds safe execution arguments for the Antigravity CLI (A28 / Section 8.1).
 * Never enables bypass flags like --yolo, --skip-approval, or --dangerously-skip-permissions.
 */
function buildAntigravityArgs(options = {}) {
  const args = [];
  if (options.prompt) {
    args.push('--prompt', String(options.prompt));
  }
  if (options.outputFormat !== 'text') {
    args.push('--output', 'json');
  }
  if (options.projectDir) {
    args.push('--add-dir', path.resolve(options.projectDir));
  }
  // Enforce read-only tool restrictions if writeFiles or executeCommands permissions are denied
  if (options.permissions?.writeFiles === false) {
    args.push('--read-only');
  }
  return args;
}

/**
 * Executes a task using the native Google Antigravity CLI (agy / antigravity).
 *
 * @param {object} options
 * @param {string} options.prompt - Prompt or instruction to execute
 * @param {string} options.projectDir - Working project directory
 * @param {string} [options.channel] - Session / channel identifier
 * @param {string} [options.contextKey] - Lane context key
 * @param {string} [options.agentId] - Agent ID
 * @param {object} [options.connection] - Connection model
 * @param {object} [options.permissions] - Tool capabilities
 * @param {AbortSignal} [options.signal] - Cancellation signal
 * @param {object} [options.sessionBindings] - NativeSessionBindingsRepository
 * @param {string} [options.runId] - Unique execution run ID
 * @param {function} [options.onEvent] - Event callback
 * @param {object} [options.env] - Environment overrides
 * @param {object} [deps]
 * @param {object} [deps.launch] - Custom launcher { command, args }
 * @param {function} [deps.spawnImpl] - Process spawn implementation
 */
async function runAntigravity(
  options = {},
  { launch = locate('antigravity', options?.env || process.env), spawnImpl = spawn } = {}
) {
  if (!launch) {
    throw fail('Antigravity client (agy) not found on PATH or app data directory.', 'CLIENT_NOT_FOUND', 404);
  }
  if (options.signal?.aborted) {
    throw fail('Task cancelled.', 'ABORT_ERR');
  }
  if (!options.projectDir || !fs.statSync(options.projectDir).isDirectory()) {
    throw fail('Choose an existing project directory for Antigravity execution.', 'INVALID_PROJECT_DIR', 400);
  }

  let binding = null;
  const sessionBindings = options.sessionBindings || null;
  const runId = options.runId || null;
  if (sessionBindings && options.channel && options.agentId && runId) {
    binding = sessionBindings.resolveOrCreate({
      channel: options.channel,
      contextKey: options.contextKey || null,
      agentId: options.agentId,
      connectionId: options.connection?.id || null,
      adapterKind: 'native-antigravity',
      sessionDir: options.projectDir,
    });
    binding = sessionBindings.acquireWriteLock(binding.id, { runId });
  }

  const sanitizedEnv = buildSanitizedNativeEnv(options.env || process.env, launch);
  const args = [...(launch.args || []), ...buildAntigravityArgs(options)];

  let child;
  try {
    child = spawnImpl(launch.command, args, {
      cwd: options.projectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: sanitizedEnv,
    });
  } catch (err) {
    if (binding) sessionBindings.releaseWriteLock(binding.id, { runId });
    throw fail(`Failed to spawn Antigravity client: ${err.message}`, 'SPAWN_ERROR', 500);
  }

  let text = '';
  let conversationId = null;
  let tokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: null };
  const events = [];
  let stderrText = '';

  let aborted = false;
  const abortHandler = () => {
    aborted = true;
    void stopChild(child);
  };
  if (options.signal) {
    options.signal.addEventListener('abort', abortHandler, { once: true });
  }

  child.stderr.on('data', chunk => {
    stderrText += chunk.toString('utf8');
  });

  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const data = JSON.parse(trimmed);
      events.push(data);

      if (data.event === 'init' || data.type === 'init') {
        conversationId = data.conversation_id || data.init?.conversation_id || null;
        if (conversationId && binding && sessionBindings) {
          sessionBindings.recordAttempt(binding.id, {
            nativeSessionId: conversationId,
            attemptId: options.attemptId || runId,
          });
        }
      } else if (data.event === 'thought' || data.type === 'thought') {
        const thought = data.thought || data.content || '';
        if (thought && options.onEvent) {
          options.onEvent({ type: 'thought', text: thought });
        }
      } else if (data.event === 'agent_response' || data.type === 'text_delta') {
        const delta = data.text || data.delta || data.content || '';
        text += delta;
        if (delta && options.onEvent) {
          options.onEvent({ type: 'delta', text: delta });
        }
      } else if (data.event === 'result' || data.type === 'turn_completed') {
        if (data.response && !text) {
          text = data.response;
        }
        if (data.usage) {
          tokenUsage = {
            inputTokens: data.usage.input_tokens || data.usage.prompt_tokens || 0,
            outputTokens: data.usage.output_tokens || data.usage.completion_tokens || 0,
            totalTokens: data.usage.total_tokens || 0,
            costUsd: data.usage.cost_usd || null,
          };
        }
      }
    } catch (_) {
      // Non-JSON plaintext output
      text += (text ? '\n' : '') + trimmed;
      if (options.onEvent) {
        options.onEvent({ type: 'delta', text: trimmed });
      }
    }
  });

  const exitPromise = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  try {
    const { code, signal } = await exitPromise;
    if (aborted || options.signal?.aborted) {
      throw fail('Task cancelled.', 'ABORT_ERR');
    }
    if (code !== 0 && code !== null) {
      const detail = (stderrText || text).slice(0, 800).trim();
      throw fail(`Antigravity exited with code ${code}: ${detail || 'Unknown error'}`, 'RUNTIME_FAILED', 500);
    }
    return {
      status: 'completed',
      text: text.trim(),
      tokenUsage,
      conversationId,
      events,
    };
  } finally {
    if (options.signal) {
      options.signal.removeEventListener('abort', abortHandler);
    }
    if (binding && sessionBindings) {
      try {
        sessionBindings.releaseWriteLock(binding.id, { runId });
      } catch (_) {}
    }
  }
}

module.exports = {
  buildAntigravityArgs,
  runAntigravity,
};
