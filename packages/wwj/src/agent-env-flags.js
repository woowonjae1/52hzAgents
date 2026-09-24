'use strict';

/**
 * `--env KEY=VALUE` on `wwj connect` / `wwj create`: per-agent settings stored
 * in that agent's `env` block in config.yaml, which the daemon merges into the
 * adapter's environment (`_buildAgentEnv`).
 *
 * Only keys the agent type declares in registry.json `env_config` are accepted.
 * The flag is reachable from the workspace UI (LaunchAgent passes it through),
 * so an open key space would let a caller plant NODE_OPTIONS, PATH, etc. into
 * the agent process. Declared keys are the whole contract.
 */

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Normalise the parsed flag (absent, `true`, a string, or repeated → array). */
function envFlagValues(flag) {
  if (flag === undefined || flag === null || flag === false) return [];
  const list = Array.isArray(flag) ? flag : [flag];
  return list.map((v) => (v === true ? '' : String(v)));
}

/**
 * @param {string[]} assignments  raw "KEY=VALUE" strings
 * @param {{name: string}[]} envFields  the type's registry env_config
 * @param {string} type  agent type, for messages
 * @returns {{ env: Record<string,string>, errors: string[] }}
 */
function parseEnvAssignments(assignments, envFields, type) {
  const env = {};
  const errors = [];
  const allowed = new Set((envFields || []).map((f) => f && f.name).filter(Boolean));

  for (const raw of assignments) {
    const eq = raw.indexOf('=');
    if (eq < 1) {
      errors.push(`--env expects KEY=VALUE, got '${raw}'`);
      continue;
    }
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1);
    if (!KEY_RE.test(key)) {
      errors.push(`--env: '${key}' is not a valid variable name`);
      continue;
    }
    if (!allowed.has(key)) {
      const known = [...allowed];
      errors.push(
        known.length
          ? `--env: '${key}' is not a setting of agent type '${type}' (known: ${known.join(', ')})`
          : `--env: agent type '${type}' has no configurable settings`
      );
      continue;
    }
    if (/[\0\r\n]/.test(value)) {
      errors.push(`--env: value for '${key}' must be a single line`);
      continue;
    }
    env[key] = value.trim();
  }

  return { env, errors };
}

/** Required env_config fields with no value in `env`. */
function missingRequired(envFields, env) {
  return (envFields || [])
    .filter((f) => f && f.required && !String((env && env[f.name]) || '').trim())
    .map((f) => f.name);
}

module.exports = { envFlagValues, parseEnvAssignments, missingRequired };
