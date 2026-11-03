'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const fail = (message, code = 'RUNTIME_UNAVAILABLE', status = 409) =>
  Object.assign(new Error(message), { status, code });

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function resolveShim(shimPath) {
  try {
    const text = fs.readFileSync(shimPath, 'utf8');
    const match = text.match(/%dp0%\\(node_modules\\[^"\r\n]+?\.(?:c|m)?js)/i);
    if (!match) return null;
    const script = path.join(path.dirname(shimPath), match[1]);
    return isFile(script) ? { command: process.execPath, args: [script] } : null;
  } catch {
    return null;
  }
}

const NPM_SCRIPTS_BY_KIND = Object.freeze({
  codex: [['@openai', 'codex', 'bin', 'codex.js']],
  pi: [['@earendil-works', 'pi-coding-agent', 'dist', 'cli.js']],
});

/**
 * Only fixed, known executables. Never accept a shell command from an Agent definition.
 */
function locate(kind, env = process.env) {
  const normalizedKind = kind === 'pi-native' || kind === 'native-pi'
    ? 'pi'
    : kind === 'native-codex'
      ? 'codex'
      : kind;
  const names = normalizedKind === 'antigravity' ? ['agy'] : [normalizedKind];
  const directories = String(env.PATH || env.Path || '')
    .split(path.delimiter)
    .filter(Boolean);
  if (process.platform === 'win32' && env.LOCALAPPDATA && normalizedKind === 'antigravity') {
    directories.push(path.join(env.LOCALAPPDATA, 'agy', 'bin'));
  }
  const win = process.platform === 'win32';
  for (const directory of directories) {
    for (const name of names) {
      const native = path.join(directory, name + (win ? '.exe' : ''));
      if (isFile(native)) return { command: native, args: [] };
      const scripts = NPM_SCRIPTS_BY_KIND[normalizedKind] || [];
      for (const parts of scripts) {
        const script = path.join(directory, 'node_modules', ...parts);
        if (isFile(script)) return { command: process.execPath, args: [script] };
      }
      if (win) {
        const shim = path.join(directory, `${name}.cmd`);
        if (isFile(shim)) {
          const resolved = resolveShim(shim);
          if (resolved) return resolved;
        }
      }
    }
  }
  return null;
}

const WORKBENCH_SENSITIVE_ENV_PREFIXES = [
  'OPENAGENTS_',
  'WORKBENCH_',
  '52HZ_',
  'VAULT_',
  'ELECTRON_IPC_',
];

const WORKBENCH_SENSITIVE_ENV_KEYS = new Set([
  'API_AUTH_TOKEN',
  'DESKTOP_API_TOKEN',
  'INTERNAL_IPC_SECRET',
]);

/**
 * Build a sanitized environment for native child processes (A28):
 * - Strips workbench high-privilege tokens and vault secrets.
 * - Sets ELECTRON_RUN_AS_NODE=1 only when spawning process.execPath on a JS script;
 *   deletes ELECTRON_RUN_AS_NODE for external binaries (such as agy.exe or standalone binaries).
 */
function buildSanitizedNativeEnv(baseEnv = process.env, launch = null, extraEnv = {}) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (WORKBENCH_SENSITIVE_ENV_KEYS.has(upper)) continue;
    if (WORKBENCH_SENSITIVE_ENV_PREFIXES.some(prefix => upper.startsWith(prefix))) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(extraEnv || {})) {
    if (value === undefined || value === null) {
      delete env[key];
    } else {
      env[key] = String(value);
    }
  }
  if (launch && launch.command === process.execPath) {
    env.ELECTRON_RUN_AS_NODE = '1';
  } else {
    delete env.ELECTRON_RUN_AS_NODE;
  }
  return env;
}

/**
 * Terminate only the owned child process tree (A21).
 * Never terminates by image name or touches other clients/shared services.
 */
async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn(
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'),
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, shell: false, stdio: 'ignore' }
      );
      killer.once('error', resolve);
      killer.once('close', resolve);
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      try { child.kill('SIGKILL'); } catch {}
    }
  }
}

module.exports = {
  fail,
  isFile,
  resolveShim,
  locate,
  buildSanitizedNativeEnv,
  stopChild,
};
