'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const {
  fail,
  locate,
  buildSanitizedNativeEnv,
  stopChild,
  acquireSharedResourceLock,
} = require('./common');

/**
 * Runs a task through OpenClaw native adapter.
 *
 * Implements:
 * - Profile and Gateway concurrency lock protection (A18 / R5):
 *   Prevents parallel tasks on the same OpenClaw profile from corrupting session state.
 * - Detached child execution with sanitized environment (A28).
 * - Graceful process cancellation via taskkill/SIGKILL (A21).
 */
async function runOpenclaw(
  options = {},
  { launch = locate('openclaw', options?.env || process.env), spawnImpl = spawn } = {}
) {
  if (!launch) {
    throw fail('OpenClaw client not found on PATH or node_modules.', 'CLIENT_NOT_FOUND', 404);
  }
  if (options.signal?.aborted) {
    throw fail('Task cancelled.', 'ABORT_ERR');
  }
  if (!options.projectDir || !fs.statSync(options.projectDir).isDirectory()) {
    throw fail('Choose an existing project directory for OpenClaw execution.', 'INVALID_PROJECT_DIR', 400);
  }

  // 1. Concurrency Mutex for shared OpenClaw Profile / Gateway (R5)
  const profile = options.connection?.profile || options.agent?.profile || 'default';
  const sharedLockKey = `openclaw:profile:${profile}`;
  const sharedLock = await acquireSharedResourceLock(sharedLockKey, {
    timeoutMs: options.lockTimeoutMs || 15000,
    holder: options.runId,
  });

  let binding = null;
  const sessionBindings = options.sessionBindings || null;
  const runId = options.runId || null;

  try {
    if (sessionBindings && options.channel && options.agentId && runId) {
      binding = sessionBindings.resolveOrCreate({
        channel: options.channel,
        contextKey: options.contextKey || null,
        agentId: options.agentId,
        connectionId: options.connection?.id || null,
        adapterKind: 'native-openclaw',
        sessionDir: options.projectDir,
      });
      binding = sessionBindings.acquireWriteLock(binding.id, { runId });
    }

    const sanitizedEnv = buildSanitizedNativeEnv(options.env || process.env, launch);
    const args = [...(launch.args || []), '--query', String(options.prompt || ''), '--dir', path.resolve(options.projectDir)];
    if (profile && profile !== 'default') {
      args.push('--profile', profile);
    }

    let child;
    try {
      child = spawnImpl(launch.command, args, {
        cwd: options.projectDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: sanitizedEnv,
      });
    } catch (err) {
      throw fail(`Failed to spawn OpenClaw: ${err.message}`, 'SPAWN_ERROR', 500);
    }

    let text = '';
    let stderrText = '';
    const events = [];
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
        if (data.type === 'delta' || data.text) {
          const delta = data.delta || data.text || '';
          text += delta;
          if (options.onEvent) options.onEvent({ type: 'delta', text: delta });
        }
      } catch (_) {
        text += (text ? '\n' : '') + trimmed;
        if (options.onEvent) options.onEvent({ type: 'delta', text: trimmed });
      }
    });

    const exitPromise = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });

    const { code } = await exitPromise;
    if (aborted || options.signal?.aborted) {
      throw fail('Task cancelled.', 'ABORT_ERR');
    }
    if (code !== 0 && code !== null) {
      const detail = (stderrText || text).slice(0, 800).trim();
      throw fail(`OpenClaw exited with code ${code}: ${detail || 'Unknown error'}`, 'RUNTIME_FAILED', 500);
    }

    return {
      status: 'completed',
      text: text.trim(),
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: null },
      events,
    };
  } finally {
    // Release both session binding lock and shared profile mutex
    if (binding && sessionBindings) {
      try { sessionBindings.releaseWriteLock(binding.id, { runId }); } catch (_) {}
    }
    sharedLock.release();
  }
}

module.exports = {
  runOpenclaw,
};
