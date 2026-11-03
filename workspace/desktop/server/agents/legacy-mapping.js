'use strict';

/**
 * R0/R1 mapping rules between stored Agent definitions and execution connections.
 *
 * The stored `runtimeKind` column predates native connections. Its value `pi`
 * (when `connection_id` is NULL) always means the workbench-driven Pi SDK loop
 * (pi-engine.mjs) using workbench model connections. It must never be silently
 * reinterpreted as the user's local Pi CLI (`pi --mode rpc` with ~/.pi config).
 *
 * A native Pi member can only come from an explicit `agent_connections` record
 * (`kind: 'native-pi'`) linked via `agent_definitions.connection_id`.
 */

const EXECUTION_KINDS = Object.freeze({
  pi: Object.freeze({
    connectionKind: 'builtin-pi-sdk',
    label: '内置 Pi SDK 助手',
    compatibility: 'legacy-builtin',
    nativeConnection: null,
    usesWorkbenchModelConnection: true,
    note: '由工作台 Pi SDK 循环驱动，使用工作台模型连接；不是本机 Pi 客户端。',
  }),
  codex: Object.freeze({
    connectionKind: 'native-codex',
    label: 'Codex',
    compatibility: 'native-preview',
    nativeConnection: 'codex',
    usesWorkbenchModelConnection: false,
    note: '通过本机 Codex App Server 执行，复用本机登录与配置。',
  }),
  antigravity: Object.freeze({
    connectionKind: 'native-antigravity',
    label: 'Antigravity',
    compatibility: 'native-pending',
    nativeConnection: 'antigravity',
    usesWorkbenchModelConnection: false,
    note: '可检测；审批、权限与会话协议尚未接入，暂不派发任务。',
  }),
  gemini: Object.freeze({
    connectionKind: 'native-gemini',
    label: 'Gemini CLI',
    compatibility: 'deferred',
    nativeConnection: 'gemini',
    usesWorkbenchModelConnection: false,
    note: '已降级为暂缓项：近期不接入，保留旧数据可读。',
  }),
});

const EXPLICIT_CONNECTION_DESCRIPTORS = Object.freeze({
  'native-pi': Object.freeze({
    connectionKind: 'native-pi',
    label: 'Pi（本机客户端）',
    compatibility: 'native-preview',
    nativeConnection: 'pi-native',
    usesWorkbenchModelConnection: false,
    note: '关联本机安装的 Pi 客户端及其原生配置（~/.pi/agent），不要求配置工作台模型供应商。',
  }),
  'native-codex': EXECUTION_KINDS.codex,
  'native-antigravity': EXECUTION_KINDS.antigravity,
  'native-openclaw': Object.freeze({
    connectionKind: 'native-openclaw',
    label: 'OpenClaw',
    compatibility: 'native-pending',
    nativeConnection: 'openclaw',
    usesWorkbenchModelConnection: false,
    note: '关联本机 OpenClaw 连接；执行协议与配置适配待按版本开启。',
  }),
  'native-hermes': Object.freeze({
    connectionKind: 'native-hermes',
    label: 'Hermes',
    compatibility: 'native-pending',
    nativeConnection: 'hermes',
    usesWorkbenchModelConnection: false,
    note: '关联本机 Hermes 连接；执行协议与配置适配待按版本开启。',
  }),
});

/** Connection kinds that exist only as explicit `agent_connections` records. */
const RESERVED_CONNECTION_KINDS = Object.freeze(['native-pi', 'native-openclaw', 'native-hermes']);

function describeExecution(runtimeKind, connection = null) {
  if (connection && typeof connection === 'object' && connection.kind) {
    const explicit = EXPLICIT_CONNECTION_DESCRIPTORS[connection.kind];
    if (!explicit) {
      throw Object.assign(new Error(`Unknown connection kind: ${connection.kind}`), { status: 500, code: 'UNKNOWN_CONNECTION_KIND' });
    }
    return { ...explicit, connectionId: connection.id || null };
  }
  const entry = EXECUTION_KINDS[runtimeKind];
  if (!entry) throw Object.assign(new Error(`Unknown stored runtime kind: ${runtimeKind}`), { status: 500, code: 'UNKNOWN_RUNTIME_KIND' });
  return { ...entry };
}

module.exports = { EXECUTION_KINDS, EXPLICIT_CONNECTION_DESCRIPTORS, RESERVED_CONNECTION_KINDS, describeExecution };
