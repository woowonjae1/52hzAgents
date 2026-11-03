'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  MASK_PLACEHOLDER,
  parseJsonc,
  parseTomlDocument,
  applyTomlTopLevelPatch,
} = require('./formats');

const fail = (message, code = 'CONFIG_INVALID', status = 400) =>
  Object.assign(new Error(message), { code, status });

const REASONING_EFFORTS = new Set(['minimal', 'low', 'medium', 'high']);

const CODEX_EDITABLE_KEYS = new Set([
  'model',
  'model_reasoning_effort',
  'model_provider',
]);

const CODEX_KNOWN_MODELS = Object.freeze([
  { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', reasoning: true },
  { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', reasoning: true },
  { id: 'gpt-5-codex', name: 'GPT-5 Codex', reasoning: true },
  { id: 'gpt-5', name: 'GPT-5', reasoning: true },
  { id: 'o4-mini', name: 'o4-mini', reasoning: true },
  { id: 'codex-mini-latest', name: 'Codex Mini Latest', reasoning: true },
]);

function buildCodexSources(configDir) {
  return [
    {
      sourceKey: 'codex.config',
      scope: 'global',
      format: 'toml',
      canonicalPath: path.join(configDir, 'config.toml'),
      holdsSecret: false,
      description: 'Codex 全局默认配置文件 (config.toml)',
    },
    {
      sourceKey: 'codex.auth',
      scope: 'global',
      format: 'json',
      canonicalPath: path.join(configDir, 'auth.json'),
      holdsSecret: true,
      description: 'Codex 本机登录凭据 (auth.json，仅检查存在状态)',
    },
  ];
}

function inspectCodexConfig(fileSnapshots, { env = process.env } = {}) {
  const configSnap = fileSnapshots.get('codex.config');
  const authSnap = fileSnapshots.get('codex.auth');

  const parsedToml = configSnap?.exists
    ? parseTomlDocument(configSnap.rawText)
    : { topLevel: {}, tables: [] };

  const top = parsedToml.topLevel;
  const preservedKeys = Object.keys(top).filter(k => !CODEX_EDITABLE_KEYS.has(k));

  let authInfo = { configured: false, mode: 'none', masked: null };
  if (authSnap?.exists && authSnap.rawText.trim()) {
    try {
      const authDoc = parseJsonc(authSnap.rawText, 'auth.json');
      const hasTokens = Boolean(authDoc && (authDoc.tokens || authDoc.access_token || authDoc.refresh_token));
      const hasApiKey = Boolean(authDoc && authDoc.OPENAI_API_KEY);
      if (hasTokens || hasApiKey) {
        authInfo = {
          configured: true,
          mode: hasTokens ? 'chatgpt-oauth' : 'api-key',
          masked: MASK_PLACEHOLDER,
        };
      }
    } catch {
      authInfo = { configured: false, mode: 'unreadable', masked: null };
    }
  } else if (env.OPENAI_API_KEY) {
    authInfo = { configured: true, mode: 'env:OPENAI_API_KEY', masked: 'OPENAI_API_KEY' };
  }

  return {
    view: {
      config: {
        model: typeof top.model === 'string' ? top.model : null,
        model_reasoning_effort: typeof top.model_reasoning_effort === 'string' ? top.model_reasoning_effort : null,
        model_provider: typeof top.model_provider === 'string' ? top.model_provider : null,
        preservedKeys,
        preservedTables: parsedToml.tables,
      },
      auth: authInfo,
    },
    effective: {
      defaultModel: typeof top.model === 'string' ? top.model : null,
      defaultReasoningEffort: typeof top.model_reasoning_effort === 'string' ? top.model_reasoning_effort : null,
      defaultProvider: typeof top.model_provider === 'string' ? top.model_provider : 'openai',
      sourceScope: 'global',
    },
    readiness: {
      configReadable: true,
      configPresent: Boolean(configSnap?.exists),
      authPresent: Boolean(authSnap?.exists),
      authConfigured: authInfo.configured,
      authMode: authInfo.mode,
    },
    editableFields: [
      {
        path: 'config.model',
        sourceKey: 'codex.config',
        scope: 'global',
        type: 'string',
        label: '全局默认模型 (config.toml: model)',
      },
      {
        path: 'config.model_reasoning_effort',
        sourceKey: 'codex.config',
        scope: 'global',
        type: 'enum',
        options: [...REASONING_EFFORTS],
        label: '全局默认推理深度 (config.toml: model_reasoning_effort)',
      },
      {
        path: 'config.model_provider',
        sourceKey: 'codex.config',
        scope: 'global',
        type: 'string',
        label: '全局默认供应商标识 (config.toml: model_provider)',
      },
    ],
    scopeOptions: [
      {
        scope: 'session',
        label: '仅当前成员 / 任务会话覆盖',
        description: '通过 Codex App Server thread/start 参数传入模型，不修改本机 ~/.codex/config.toml 全局默认。',
      },
      {
        scope: 'global',
        label: '修改本机全局默认 (config.toml)',
        description: '写入 ~/.codex/config.toml 顶层配置，影响共享该连接的成员及之后启动的其他本机 Codex 会话；运行中的会话不会中断或静默切换。',
      },
    ],
    scopeWarning:
      '请注意区分“任务/成员级模型覆盖”与“修改全局默认 config.toml”：修改全局默认会影响本机其他未指定模型的 Codex 会话。',
  };
}

function readCodexModelsCache(configDir) {
  if (!configDir) return [];
  const cachePath = path.join(configDir, 'models_cache.json');
  try {
    const st = fs.lstatSync(cachePath);
    if (!st.isFile() || st.isSymbolicLink()) return [];
    const doc = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    const list = Array.isArray(doc?.models) ? doc.models : Array.isArray(doc) ? doc : [];
    return list
      .filter(m => m && typeof (m.slug || m.id) === 'string')
      .map(m => ({
        id: m.slug || m.id,
        name: m.display_name || m.name || m.slug || m.id,
        reasoning: true,
        defaultReasoningEffort: m.default_reasoning_level || null,
        source: 'models_cache.json',
        verificationStatus: 'cached',
      }));
  } catch {
    return [];
  }
}

function listCodexResources(fileSnapshots, { configDir = null, env = process.env } = {}) {
  const inspected = inspectCodexConfig(fileSnapshots, { env });
  const seen = new Map();

  for (const cached of readCodexModelsCache(configDir)) {
    seen.set(cached.id, cached);
  }
  for (const known of CODEX_KNOWN_MODELS) {
    if (!seen.has(known.id)) {
      seen.set(known.id, { ...known, source: 'codex-catalog', verificationStatus: 'declared' });
    }
  }
  const currentDefault = inspected.effective.defaultModel;
  if (currentDefault && !seen.has(currentDefault)) {
    seen.set(currentDefault, {
      id: currentDefault,
      name: currentDefault,
      reasoning: true,
      source: 'config.toml',
      verificationStatus: 'configured',
    });
  }

  const models = [...seen.values()].map(m => ({
    ...m,
    providerId: inspected.effective.defaultProvider || 'openai',
    providerName: 'Codex (Local Client)',
    authenticated: inspected.readiness.authConfigured,
    isDefault: m.id === currentDefault,
    verificationStatus: m.verificationStatus || 'declared',
  }));

  return {
    effective: inspected.effective,
    readiness: inspected.readiness,
    models,
    cachedModels: models.filter(m => m.verificationStatus === 'cached'),
    declaredModels: models.filter(m => m.verificationStatus === 'declared'),
    verifiedModels: models.filter(m => m.verificationStatus === 'verified'),
    reasoningEfforts: [...REASONING_EFFORTS],
    supportsSessionOverride: true,
    supportsGlobalDefaultWrite: true,
    note: 'Codex 支持按任务会话临时覆盖模型（thread/start model 参数，不改全局文件），也支持修改 config.toml 全局默认。凭据存在状态不代表在线配额已验证。',
  };
}

function validateAndBuildCodexPatch(fileSnapshots, patchInput) {
  if (!patchInput || typeof patchInput !== 'object' || Array.isArray(patchInput)) {
    throw fail('Codex 配置修改请求必须是对象。');
  }
  const configPatch = patchInput.config || patchInput;
  if (!configPatch || typeof configPatch !== 'object' || Array.isArray(configPatch)) {
    throw fail('Codex config 修改必须是对象。');
  }

  const configSnap = fileSnapshots.get('codex.config');
  const currentParsed = configSnap?.exists ? parseTomlDocument(configSnap.rawText) : { topLevel: {}, tables: [] };
  const currentTop = currentParsed.topLevel;

  const tomlPatch = {};
  const redactedChanges = [];

  for (const [key, val] of Object.entries(configPatch)) {
    if (!CODEX_EDITABLE_KEYS.has(key)) {
      throw fail(`字段 config.${key} 不在 Codex 受控编辑白名单中。`, 'CONFIG_FIELD_FORBIDDEN', 400);
    }
    if (key === 'model' || key === 'model_provider') {
      if (val !== null && val !== undefined && (typeof val !== 'string' || !val.trim() || val.length > 200 || /[\r\n\0]/.test(val))) {
        throw fail(`字段 config.${key} 必须是非空单行字符串或 null。`);
      }
      const normalized = val === null || val === undefined ? null : val.trim();
      tomlPatch[key] = normalized;
      redactedChanges.push({
        sourceKey: 'codex.config',
        fieldPath: `config.${key}`,
        before: currentTop[key] ?? null,
        after: normalized,
      });
    } else if (key === 'model_reasoning_effort') {
      if (val !== null && val !== undefined && !REASONING_EFFORTS.has(val)) {
        throw fail(`config.model_reasoning_effort 必须是 ${[...REASONING_EFFORTS].join('/')} 之一或 null。`);
      }
      const normalized = val === null || val === undefined ? null : val;
      tomlPatch[key] = normalized;
      redactedChanges.push({
        sourceKey: 'codex.config',
        fieldPath: 'config.model_reasoning_effort',
        before: currentTop.model_reasoning_effort ?? null,
        after: normalized,
      });
    }
  }

  if (Object.keys(tomlPatch).length === 0) {
    throw fail('没有检测到需要保存的有效 Codex 配置变更。', 'CONFIG_NO_CHANGES', 400);
  }

  const nextText = applyTomlTopLevelPatch(configSnap?.rawText || '', tomlPatch);

  return {
    scope: 'global',
    requiresRestart: false,
    applicationMode: 'next_run',
    applicationNote: '已写入 ~/.codex/config.toml 全局默认配置；下次启动且未设置成员级模型覆盖的会话将读取新默认值，运行中的会话不受影响。',
    redactedChanges,
    fileChanges: [
      {
        sourceKey: 'codex.config',
        nextText,
        expectedFinalCheck: parsed => {
          for (const [k, v] of Object.entries(tomlPatch)) {
            const actual = parsed.topLevel[k] ?? null;
            if (actual !== v) return false;
          }
          return true;
        },
      },
    ],
  };
}

module.exports = {
  REASONING_EFFORTS,
  CODEX_KNOWN_MODELS,
  buildCodexSources,
  inspectCodexConfig,
  listCodexResources,
  validateAndBuildCodexPatch,
};
