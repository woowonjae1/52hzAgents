'use strict';

const { fail, locate, stopChild, buildSanitizedNativeEnv } = require('./agents/adapters/common');
const { safeFileChanges, runCodex } = require('./agents/adapters/codex');
const { runNativePi } = require('./agents/adapters/pi-native');
const { runAntigravity } = require('./agents/adapters/antigravity');
const { runOpenclaw } = require('./agents/adapters/openclaw');
const { runHermes } = require('./agents/adapters/hermes');
const { resolveNativeAdapterKind, runNativeAdapter } = require('./agents/registry');

function listRuntimes(env = process.env) {
  return [
    // `pi` is the bundled Pi SDK loop driven by workbench model connections, not a local Pi client.
    {
      kind: 'pi',
      name: '内置 Pi SDK 助手（兼容）',
      installed: true,
      supported: true,
      modes: ['chat', 'plan', 'agent'],
      reason: '随工作台打包的 Pi SDK 循环；执行资源在高级设置中配置。不读取本机 Pi 配置。',
    },
    ...['codex', 'antigravity', 'openclaw', 'hermes', 'gemini'].map(kind => {
      const installed = Boolean(locate(kind, env));
      const supported = kind === 'codex';
      const names = {
        codex: 'Codex',
        antigravity: 'Antigravity',
        openclaw: 'OpenClaw',
        hermes: 'Hermes',
        gemini: 'Gemini CLI',
      };
      return {
        kind,
        name: names[kind] || kind,
        installed,
        supported,
        modes: supported ? ['plan', 'agent'] : [],
        budgetBlocked: kind === 'codex',
        authentication: 'local-client',
        usage: 'turn-total',
        hardRequestBudgets: false,
        readScope: 'client',
        reason:
          kind === 'gemini'
            ? '已降级为暂缓项，近期不接入，暂不派发任务。'
            : !installed
              ? '未检测到本地客户端。'
              : !supported
                ? '已检测到客户端；审批与权限隔离适配尚未通过，暂不派发任务。'
                : '复用本机登录；支持安全权限与工作区沙箱执行。安装状态不代表登录或服务已验证。',
      };
    }),
  ];
}

function resolveDefaultRuntimeStatus(agent, env = process.env) {
  const adapterKind = resolveNativeAdapterKind(agent);
  if (adapterKind === 'native-pi') {
    const installed = Boolean(locate('pi', env));
    return {
      kind: 'pi-native',
      name: 'Pi（本机客户端）',
      installed,
      supported: true,
      modes: ['plan', 'agent'],
      reason: installed ? '复用本机 Pi 配置与登录。' : '未检测到本地 Pi 客户端。',
    };
  }
  if (adapterKind === 'native-antigravity' || adapterKind === 'native-openclaw' || adapterKind === 'native-hermes') {
    const rawKind = adapterKind.replace(/^native-/, '');
    const installed = Boolean(locate(rawKind, env));
    return {
      kind: agent.runtimeKind,
      name: rawKind,
      installed,
      supported: true,
      modes: ['plan', 'agent'],
      reason: installed ? '复用本机登录；支持安全权限与工作区沙箱执行。' : '未检测到本地客户端。',
    };
  }
  return listRuntimes(env).find(item => item.kind === agent.runtimeKind);
}

function assertNativePolicy(
  agent,
  config,
  { budgets, execution, compactOnly = false, nativeBudgetAuthorized = false, env = process.env, runtime = resolveDefaultRuntimeStatus(agent, env) } = {}
) {
  if (!runtime?.installed || !runtime.supported) throw fail(runtime?.reason || 'Unsupported runtime.');
  if (compactOnly) throw fail('此客户端自行管理上下文，工作台压缩暂不适用。', 'RUNTIME_CAPABILITY');
  if (!runtime.modes.includes(config.mode)) {
    throw fail('原生客户端暂不支持无工具对话模式，请选择只读分析或实施。', 'RUNTIME_CAPABILITY');
  }

  const adapterKind = resolveNativeAdapterKind(agent);
  const p = agent.permissions || {};

  if (adapterKind === 'native-pi') {
    if (
      !p.readFiles ||
      (config.mode === 'agent' && !p.writeFiles) ||
      p.executeCommands ||
      p.mcp ||
      p.delegate ||
      p.knowledge ||
      agent.profileTools?.length
    ) {
      throw fail(
        '本机 Pi 原生执行要求开启文件读取权限；实施模式需开启文件修改权限。原生 Pi 命令执行尚未建立执行前受控审批桥接，已默认禁用；暂不支持工作台 MCP、知识工具、委派或自定义工具白名单。',
        'RUNTIME_CAPABILITY'
      );
    }
  } else if (adapterKind === 'native-codex') {
    if (
      !p.readFiles ||
      !p.executeCommands ||
      (config.mode === 'agent' && !p.writeFiles && !(execution?.kind === 'review' && execution.verification)) ||
      p.mcp ||
      p.delegate ||
      p.knowledge ||
      agent.profileTools?.length
    ) {
      throw fail(
        'Codex 原生工具要求文件读取和命令权限；实施还需写入权限。暂不支持工作台 MCP、知识工具、委派或自定义工具白名单。',
        'RUNTIME_CAPABILITY'
      );
    }
  } else if (adapterKind === 'native-antigravity') {
    if (
      !p.readFiles ||
      (config.mode === 'agent' && !p.writeFiles) ||
      p.mcp ||
      p.delegate ||
      p.knowledge ||
      agent.profileTools?.length
    ) {
      throw fail(
        'Antigravity 原生执行要求开启文件读取权限；实施模式需开启文件修改权限。暂不支持工作台 MCP、知识工具或委派。',
        'RUNTIME_CAPABILITY'
      );
    }
  } else if (adapterKind === 'native-openclaw' || adapterKind === 'native-hermes') {
    if (
      !p.readFiles ||
      (config.mode === 'agent' && !p.writeFiles) ||
      p.mcp ||
      p.delegate ||
      p.knowledge ||
      agent.profileTools?.length
    ) {
      const clientName = adapterKind === 'native-openclaw' ? 'OpenClaw' : 'Hermes';
      throw fail(
        `${clientName} 原生执行要求开启文件读取权限；实施模式需开启文件修改权限。暂不支持工作台 MCP、知识工具或委派。`,
        'RUNTIME_CAPABILITY'
      );
    }
  }

  const limits = agent.limits || {};
  const budget = budgets;
  if (!nativeBudgetAuthorized && (
    limits.maxTokensPerRun ||
    limits.maxStepsPerRun ||
    limits.maxCostPerRun ||
    (budget && (budget.maxTokensPerRun || budget.maxStepsPerRun || budget.maxCostPerSession || budget.maxCostPerDay)) ||
    (execution && execution.kind !== 'pipeline')
  )) {
    throw fail(
      '原生客户端不能保证逐请求 Token/费用硬预算。请使用内置 SDK 助手，或由用户明确确认仅本批次采用原生配额；工作台全局预算不会被自动关闭。',
      'RUNTIME_BUDGET_UNSUPPORTED'
    );
  }
}

module.exports = {
  locate,
  listRuntimes,
  assertNativePolicy,
  safeFileChanges,
  runCodex,
  runNativePi,
  runAntigravity,
  runOpenclaw,
  runHermes,
  runNativeAdapter,
  stopChild,
  buildSanitizedNativeEnv,
};
