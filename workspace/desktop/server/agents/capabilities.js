'use strict';

/**
 * R0 client capability probe table.
 *
 * Read-only by design:
 * - locates known executables on PATH (fixed names, never a user-supplied command);
 * - optionally runs `<client> --version` with shell disabled and a short timeout;
 * - stats native configuration files; it never reads, parses or writes them.
 * It never starts a model turn, logs in, installs anything or edits native config.
 *
 * Capability entries record what is known *and on what evidence*. Status values:
 *   verified     exercised by this repository's adapter or live acceptance record
 *   declared     documented by the client source/docs, not yet verified against an installed version
 *   unsupported  known not to work, or deliberately not handled by the current adapter
 *   unknown      not investigated; must not satisfy strict task requirements
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const cap = (status, evidence = '') => Object.freeze({ status, evidence });
const U = cap('unknown');

const CAPABILITY_KEYS = Object.freeze([
  'structuredStream', 'completionEvent', 'sessionResume', 'sameConnectionConcurrency',
  'structuredQuestions', 'preExecutionApproval', 'writeScope', 'readScope',
  'configRead', 'configWrite', 'hotReload', 'modelList', 'sessionModelSwitch', 'defaultModelWrite',
  'usageGranularity', 'preRequestHardBudget', 'toolControl',
]);

const home = env => env.USERPROFILE || env.HOME || os.homedir();

const ADAPTERS = Object.freeze([
  {
    kind: 'pi-native',
    name: 'Pi（本机客户端）',
    binaries: ['pi'],
    npmScripts: [['@earendil-works', 'pi-coding-agent', 'dist', 'cli.js']],
    stage: 'planned-r1',
    stageNote: '尚未接入。检测到 pi 不会自动生成成员，也不会映射旧的内置 Pi SDK 成员。',
    configSources: env => {
      const dir = env.PI_CODING_AGENT_DIR || path.join(home(env), '.pi', 'agent');
      return [
        { id: 'pi.settings', scope: 'global', format: 'json', path: path.join(dir, 'settings.json'), holds: '默认模型与全局设置' },
        { id: 'pi.models', scope: 'global', format: 'json', path: path.join(dir, 'models.json'), holds: '自定义模型定义（不是完整可用列表）' },
        { id: 'pi.auth', scope: 'global', format: 'json', path: path.join(dir, 'auth.json'), holds: '凭据（仅检查是否存在）', secret: true },
      ];
    },
    configNote: 'Agent 目录受 PI_CODING_AGENT_DIR 影响；项目级设置位于项目内 Pi 配置目录，需按项目解析。',
    capabilities: {
      structuredStream: cap('declared', 'pi --mode rpc JSONL 事件流（本地源码 docs/rpc.md）'),
      completionEvent: cap('declared', 'prompt 响应只代表已接受；需以终态事件判断完成'),
      sessionResume: cap('declared', 'new_session / 会话 JSONL'),
      structuredQuestions: cap('verified', '工作台受控提问扩展 + extension_ui_request / extension_ui_response；进程退出后不重投'),
      preExecutionApproval: cap('unsupported', '当前 RPC 模式普通工具通知不等于执行前拦截；命令执行能力默认禁用以保护宿主安全'),
      configRead: cap('declared', 'SettingsManager / ModelRegistry / AuthStorage'),
      modelList: cap('declared', 'get_available_models'),
      sessionModelSwitch: cap('unsupported', 'set_model 会同时写入原生默认选择，不能当作仅本次会话'),
      defaultModelWrite: cap('declared', 'set_model → settingsManager.setDefaultModelAndProvider()'),
    },
  },
  {
    kind: 'builtin-pi-sdk',
    name: '内置 Pi SDK 助手（兼容）',
    binaries: [],
    stage: 'compat',
    stageNote: '随工作台打包的 Pi SDK 循环，使用工作台模型连接。所有 runtimeKind=pi 的旧成员都属于这里。',
    configSources: () => [],
    configNote: '配置保存在工作台自己的连接与 Agent 策略中，不读写 ~/.pi。',
    capabilities: {
      structuredStream: cap('verified', 'pi-engine.mjs'),
      completionEvent: cap('verified', 'pi-engine.mjs'),
      preExecutionApproval: cap('verified', 'runtime-tools.js 审批'),
      writeScope: cap('verified', '项目路径校验 + 检查点'),
      readScope: cap('verified', '项目内读取工具'),
      sameConnectionConcurrency: cap('verified', '并行 Worktree 泳道'),
      usageGranularity: cap('verified', '逐请求'),
      preRequestHardBudget: cap('verified', '请求前预留'),
      toolControl: cap('verified', 'Agent 权限与工具白名单'),
      structuredQuestions: cap('unsupported', '尚无跨客户端提问闭环'),
    },
  },
  {
    kind: 'codex',
    name: 'Codex',
    binaries: ['codex'],
    npmScripts: [['@openai', 'codex', 'bin', 'codex.js']],
    stage: 'preview',
    stageNote: 'App Server 预览接入；Pi → Codex 顺序流水线、文件审批与撤销已真实验证。',
    configSources: env => {
      const dir = env.CODEX_HOME || path.join(home(env), '.codex');
      return [
        { id: 'codex.config', scope: 'global', format: 'toml', path: path.join(dir, 'config.toml'), holds: '默认模型与客户端设置' },
        { id: 'codex.auth', scope: 'global', format: 'json', path: path.join(dir, 'auth.json'), holds: '登录凭据（仅检查是否存在）', secret: true },
      ];
    },
    configNote: '当前适配器通过 config/read 读取，并只在任务线程内覆盖；未修改全局默认。',
    capabilities: {
      structuredStream: cap('verified', 'app-server --stdio JSON-RPC'),
      completionEvent: cap('verified', 'turn/completed'),
      sessionResume: cap('unsupported', '当前线程为 ephemeral'),
      sameConnectionConcurrency: cap('unknown', '每任务独立进程；账号配额共享未验证'),
      structuredQuestions: cap('verified', 'item/tool/requestUserInput；按任务与执行尝试关联的持久化问答'),
      preExecutionApproval: cap('verified', 'requestApproval → 工作台审批'),
      writeScope: cap('verified', 'workspaceWrite + safeFileChanges'),
      readScope: cap('unsupported', '稳定版协议无受限 readableRoots，读取范围由客户端决定'),
      configRead: cap('verified', 'config/read'),
      configWrite: cap('unsupported', '尚未开放默认配置修改'),
      modelList: cap('unknown'),
      sessionModelSwitch: cap('verified', 'thread/start model 覆盖'),
      usageGranularity: cap('verified', '逐轮汇总 thread/tokenUsage/updated'),
      preRequestHardBudget: cap('unsupported', '无法在每次模型请求前预留'),
      toolControl: cap('verified', '任务内禁用插件、MCP、网络搜索'),
    },
  },
  {
    kind: 'antigravity',
    name: 'Antigravity',
    binaries: ['agy'],
    extraDirs: env => (process.platform === 'win32' && env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'agy', 'bin')] : []),
    stage: 'pending',
    stageNote: '可检测，文本回复已验证；审批、权限与会话协议未接入，暂不派发任务。',
    configSources: env => [
      { id: 'antigravity.settings', scope: 'global', format: 'json', path: path.join(home(env), '.gemini', 'antigravity-cli', 'settings.json'), holds: '当前选择的模型' },
    ],
    configNote: '路径来自旧适配器参考，需按实际版本确认。',
    capabilities: {
      structuredStream: cap('unknown'),
      preExecutionApproval: cap('unknown', '不得沿用跳过权限参数'),
    },
  },
  {
    kind: 'gemini',
    name: 'Gemini CLI',
    binaries: ['gemini'],
    stage: 'deferred',
    stageNote: '已降级为暂缓项：同源模型能力可通过其他成员获得，近期不接入。',
    configSources: env => [
      { id: 'gemini.settings', scope: 'global', format: 'json', path: path.join(home(env), '.gemini', 'settings.json'), holds: '客户端设置' },
    ],
    configNote: '仅登记来源，不规划近期读写。',
    capabilities: {},
  },
  {
    kind: 'openclaw',
    name: 'OpenClaw',
    binaries: ['openclaw'],
    stage: 'candidate',
    stageNote: 'packages/wwj 有旧适配器参考；只复用协议解析，不启用旧调度循环。',
    configSources: () => [],
    configNote: '配置文件、Profile 与重载方式待按实际版本确认，不写死路径。',
    capabilities: {},
  },
  {
    kind: 'hermes',
    name: 'Hermes',
    binaries: ['hermes'],
    stage: 'candidate',
    stageNote: 'packages/wwj 有旧适配器参考；ACP 能力待按版本确认。',
    configSources: () => [],
    configNote: '配置按原生 Profile 处理，待按实际版本确认，不写死路径。',
    capabilities: {},
  },
]);

function locateBinary(adapter, env) {
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  if (adapter.extraDirs) dirs.push(...adapter.extraDirs(env));
  const win = process.platform === 'win32';
  for (const dir of dirs) for (const name of adapter.binaries) {
    const exe = path.join(dir, name + (win ? '.exe' : ''));
    if (isFile(exe)) return { path: exe, launch: { command: exe, args: [] } };
    for (const parts of adapter.npmScripts || []) {
      const script = path.join(dir, 'node_modules', ...parts);
      if (isFile(script)) return { path: script, launch: { command: process.execPath, args: [script] } };
    }
    if (win) {
      const shim = path.join(dir, name + '.cmd');
      // Node refuses to spawn .cmd without a shell; resolve npm shims to their script instead.
      if (isFile(shim)) return { path: shim, launch: resolveShim(shim) };
    }
  }
  return null;
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function resolveShim(shim) {
  try {
    const text = fs.readFileSync(shim, 'utf8');
    const match = text.match(/%dp0%\\(node_modules\\[^"\r\n]+?\.(?:c|m)?js)/i);
    if (!match) return null;
    const script = path.join(path.dirname(shim), match[1]);
    return isFile(script) ? { command: process.execPath, args: [script] } : null;
  } catch { return null; }
}

function readVersion(launch, { timeoutMs = 10000, spawnImpl = spawn } = {}) {
  if (!launch) return Promise.resolve({ version: null, error: 'launcher-unresolved' });
  return new Promise(resolve => {
    let out = '', settled = false;
    const done = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const childEnv = { ...process.env, NO_COLOR: '1' };
    if (launch.command === process.execPath) childEnv.ELECTRON_RUN_AS_NODE = '1';
    else delete childEnv.ELECTRON_RUN_AS_NODE;
    let child;
    try {
      child = spawnImpl(launch.command, [...launch.args, '--version'], {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
        env: childEnv,
      });
    } catch { return done({ version: null, error: 'spawn-failed' }); }
    const timer = setTimeout(() => { try { child.kill(); } catch {} done({ version: null, error: 'timeout' }); }, timeoutMs);
    child.stdout.on('data', chunk => { if (out.length < 4096) out += chunk; });
    child.once('error', () => done({ version: null, error: 'spawn-failed' }));
    child.once('close', code => {
      const version = out.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/)?.[0] || null;
      done(code === 0 && version ? { version } : { version: null, error: code === 0 ? 'unparsed' : `exit-${code}` });
    });
  });
}

function statSource(source) {
  let exists = false;
  try { exists = fs.statSync(source.path).isFile(); } catch {}
  return { id: source.id, scope: source.scope, format: source.format, path: source.path, holds: source.holds, secret: Boolean(source.secret), exists };
}

function capabilityRow(adapter) {
  return Object.fromEntries(CAPABILITY_KEYS.map(key => [key, adapter.capabilities[key] || U]));
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, versions?: boolean, spawnImpl?: Function }} options
 */
async function probeClients({ env = process.env, versions = false, spawnImpl } = {}) {
  const rows = [];
  for (const adapter of ADAPTERS) {
    const located = adapter.binaries.length ? locateBinary(adapter, env) : null;
    const version = located && versions ? await readVersion(located.launch, { spawnImpl }) : null;
    rows.push({
      kind: adapter.kind,
      name: adapter.name,
      stage: adapter.stage,
      stageNote: adapter.stageNote,
      installation: adapter.binaries.length
        ? { detected: Boolean(located), path: located?.path || null, version: version?.version || null, versionError: version?.error || null }
        : { detected: true, path: null, version: null, versionError: null, bundled: true },
      configSources: adapter.configSources(env).map(statSource),
      configNote: adapter.configNote,
      capabilities: capabilityRow(adapter),
    });
  }
  return { probedAt: new Date().toISOString(), platform: `${process.platform}-${process.arch}`, clients: rows };
}

module.exports = { ADAPTERS, CAPABILITY_KEYS, probeClients, locateBinary, readVersion };
