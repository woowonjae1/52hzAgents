'use strict';

const { locate, fail } = require('./adapters/common');
const { runCodex, safeFileChanges } = require('./adapters/codex');
const { runNativePi, parseNativeModelSpec, buildAllowedPiTools } = require('./adapters/pi-native');
const { runAntigravity, buildAntigravityArgs } = require('./adapters/antigravity');
const { runOpenclaw } = require('./adapters/openclaw');
const { runHermes } = require('./adapters/hermes');
const { probeClients, readVersion } = require('./capabilities');

function resolveNativeAdapterKind(agent, connection = null) {
  const connKind = connection?.kind || connection?.adapterKind || agent?.execution?.connectionKind || null;
  if (connKind === 'native-pi' || connKind === 'pi-native') return 'native-pi';
  if (connKind === 'native-codex' || agent?.runtimeKind === 'codex') return 'native-codex';
  if (connKind === 'native-antigravity' || agent?.runtimeKind === 'antigravity') return 'native-antigravity';
  if (connKind === 'native-openclaw' || agent?.runtimeKind === 'openclaw') return 'native-openclaw';
  if (connKind === 'native-hermes' || agent?.runtimeKind === 'hermes') return 'native-hermes';
  if (agent?.runtimeKind && agent.runtimeKind !== 'pi') return `native-${agent.runtimeKind}`;
  return null;
}

async function getConnectionCapabilitySnapshot(connection, { env = process.env, spawnImpl } = {}) {
  if (!connection) throw fail('Agent connection is required.', 'CONNECTION_NOT_FOUND', 404);
  const rawKind = connection.kind || connection.adapterKind || '';
  const probeKind = rawKind === 'native-pi'
    ? 'pi-native'
    : rawKind === 'native-codex'
      ? 'codex'
      : rawKind === 'native-antigravity'
        ? 'antigravity'
        : rawKind === 'native-openclaw'
          ? 'openclaw'
          : rawKind === 'native-hermes'
            ? 'hermes'
            : rawKind.replace(/^native-/, '');
  const probe = await probeClients({ env, versions: false });
  const row = probe.clients.find(c => c.kind === probeKind) || null;
  const launch = locate(rawKind, env);
  const versionInfo = launch
    ? await readVersion(launch, { timeoutMs: 5000, ...(spawnImpl ? { spawnImpl } : {}) })
    : { version: null, error: 'not-installed' };

  const capabilities = { ...(row?.capabilities || {}) };
  if (rawKind === 'native-pi') {
    capabilities.structuredStream = { status: 'verified', evidence: 'pi --mode rpc strict LF JSONL adapter' };
    capabilities.completionEvent = { status: 'verified', evidence: 'agent_end terminal event verification' };
    capabilities.sessionResume = { status: 'verified', evidence: 'native_session_bindings + --session isolation' };
    capabilities.configRead = { status: 'verified', evidence: 'NativeConfigService + get_state handshake' };
    capabilities.configWrite = { status: 'verified', evidence: 'lossless JSONC patch + SHA-256 conflict guard' };
    capabilities.modelList = { status: 'verified', evidence: 'built-in catalog + models.json merge' };
    capabilities.toolControl = { status: 'verified', evidence: '--tools allowlist & --no-extensions per mode' };
  } else if (rawKind === 'native-codex') {
    capabilities.structuredStream = { status: 'verified', evidence: 'codex app-server --stdio' };
    capabilities.completionEvent = { status: 'verified', evidence: 'turn/completed status verification' };
    capabilities.preExecutionApproval = { status: 'verified', evidence: 'item/fileChange/requestApproval bounded patch' };
    capabilities.configRead = { status: 'verified', evidence: 'NativeConfigService + config/read' };
    capabilities.configWrite = { status: 'verified', evidence: 'lossless TOML top-level patch' };
  } else if (rawKind === 'native-antigravity') {
    capabilities.structuredStream = { status: 'verified', evidence: 'agy JSON stream events' };
    capabilities.completionEvent = { status: 'verified', evidence: 'result/agent_response terminal state' };
    capabilities.preExecutionApproval = { status: 'verified', evidence: '安全权限策略与审批拦截' };
  } else if (rawKind === 'native-openclaw') {
    capabilities.structuredStream = { status: 'verified', evidence: 'openclaw CLI query stream' };
    capabilities.completionEvent = { status: 'verified', evidence: 'process exit code verification' };
    capabilities.sameConnectionConcurrency = { status: 'verified', evidence: '共享 Profile 互斥排他保护' };
  } else if (rawKind === 'native-hermes') {
    capabilities.structuredStream = { status: 'verified', evidence: 'hermes query file execution' };
    capabilities.completionEvent = { status: 'verified', evidence: 'process exit code verification' };
    capabilities.sameConnectionConcurrency = { status: 'verified', evidence: 'Profile 并发互斥排他保护' };
  }

  return {
    connectionId: connection.id,
    adapterKind: rawKind,
    installed: Boolean(launch),
    executablePath: launch?.command || connection.installationRef || connection.executablePath || null,
    version: versionInfo.version || connection.detectedVersion || null,
    versionError: versionInfo.error || null,
    configRoot: connection.configDir || connection.configRoot || null,
    capabilities,
    probedAt: new Date().toISOString(),
  };
}

async function runNativeAdapter(agent, options, deps = {}) {
  const kind = resolveNativeAdapterKind(agent, options?.connection);
  if (kind === 'native-pi') {
    return runNativePi(options, deps);
  }
  if (kind === 'native-codex') {
    return runCodex(options, deps);
  }
  if (kind === 'native-antigravity') {
    return runAntigravity(options, deps);
  }
  if (kind === 'native-openclaw') {
    return runOpenclaw(options, deps);
  }
  if (kind === 'native-hermes') {
    return runHermes(options, deps);
  }
  throw fail(`Unsupported native adapter kind: ${kind || agent?.runtimeKind || 'unknown'}`);
}

module.exports = {
  resolveNativeAdapterKind,
  getConnectionCapabilitySnapshot,
  runNativeAdapter,
  runCodex,
  runNativePi,
  runAntigravity,
  runOpenclaw,
  runHermes,
  buildAntigravityArgs,
  safeFileChanges,
  parseNativeModelSpec,
  buildAllowedPiTools,
};
