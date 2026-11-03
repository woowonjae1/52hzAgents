'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  MASK_PLACEHOLDER,
  isMaskedSecret,
  redactSecretString,
  parseJsonc,
  applyJsoncPatch,
} = require('./formats');

const fail = (message, code = 'CONFIG_INVALID', status = 400) =>
  Object.assign(new Error(message), { code, status });

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

const SETTINGS_EDITABLE_KEYS = new Set([
  'defaultProvider',
  'defaultModel',
  'defaultThinkingLevel',
  'theme',
  'quietStartup',
  'hideThinkingBlock',
  'compaction',
  'enabledModels',
]);

/**
 * Built-in provider catalog recognized by Pi's ModelRegistry (merged with custom models.json).
 */
const PI_BUILTIN_PROVIDERS = Object.freeze([
  {
    id: 'anthropic',
    name: 'Anthropic',
    envVars: ['ANTHROPIC_API_KEY', 'ANTHROPIC_OAUTH_TOKEN'],
    models: [
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', reasoning: true, contextWindow: 200000 },
      { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', reasoning: true, contextWindow: 200000 },
      { id: 'claude-3-7-sonnet-latest', name: 'Claude 3.7 Sonnet', reasoning: true, contextWindow: 200000 },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    envVars: ['OPENAI_API_KEY'],
    models: [
      { id: 'gpt-5', name: 'GPT-5', reasoning: true, contextWindow: 400000 },
      { id: 'gpt-4.1', name: 'GPT-4.1', reasoning: false, contextWindow: 1000000 },
      { id: 'o4-mini', name: 'o4-mini', reasoning: true, contextWindow: 200000 },
    ],
  },
  {
    id: 'google',
    name: 'Google Gemini',
    envVars: ['GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    models: [
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', reasoning: true, contextWindow: 1000000 },
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', reasoning: true, contextWindow: 1000000 },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    envVars: ['DEEPSEEK_API_KEY'],
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek Chat (V3)', reasoning: false, contextWindow: 128000 },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner (R1)', reasoning: true, contextWindow: 128000 },
    ],
  },
  {
    id: 'xai',
    name: 'xAI (Grok)',
    envVars: ['XAI_API_KEY'],
    models: [
      { id: 'grok-3', name: 'Grok 3', reasoning: true, contextWindow: 131072 },
      { id: 'grok-2', name: 'Grok 2', reasoning: false, contextWindow: 131072 },
    ],
  },
]);

function buildPiSources(configDir) {
  return [
    {
      sourceKey: 'pi.settings',
      scope: 'global',
      format: 'jsonc',
      canonicalPath: path.join(configDir, 'settings.json'),
      holdsSecret: false,
      description: 'Pi 全局设置与默认模型选择',
    },
    {
      sourceKey: 'pi.models',
      scope: 'global',
      format: 'jsonc',
      canonicalPath: path.join(configDir, 'models.json'),
      holdsSecret: true,
      description: 'Pi 自定义模型与供应商定义（含脱敏凭据引用）',
    },
    {
      sourceKey: 'pi.auth',
      scope: 'global',
      format: 'json',
      canonicalPath: path.join(configDir, 'auth.json'),
      holdsSecret: true,
      description: 'Pi 登录与 API 密钥存储（仅展示存在状态）',
    },
  ];
}

function inspectProjectPiSettings(projectDir) {
  if (!projectDir || typeof projectDir !== 'string') return null;
  const candidate = path.join(projectDir, '.pi', 'settings.json');
  try {
    const st = fs.lstatSync(candidate);
    if (!st.isFile() || st.isSymbolicLink()) return null;
    const raw = fs.readFileSync(candidate, 'utf8');
    const parsed = parseJsonc(raw, '项目 .pi/settings.json');
    return {
      path: candidate,
      defaultProvider: parsed.defaultProvider || null,
      defaultModel: parsed.defaultModel || null,
      defaultThinkingLevel: parsed.defaultThinkingLevel || null,
      keys: Object.keys(parsed),
    };
  } catch {
    return null;
  }
}

function inspectPiConfig(fileSnapshots, { projectDir = null, env = process.env } = {}) {
  const settingsSnap = fileSnapshots.get('pi.settings');
  const modelsSnap = fileSnapshots.get('pi.models');
  const authSnap = fileSnapshots.get('pi.auth');

  const settings = settingsSnap?.exists ? parseJsonc(settingsSnap.rawText, 'settings.json') : {};
  const modelsDoc = modelsSnap?.exists ? parseJsonc(modelsSnap.rawText, 'models.json') : {};
  const authDoc = authSnap?.exists ? parseJsonc(authSnap.rawText, 'auth.json') : {};

  const preservedSettingsKeys = Object.keys(settings).filter(k => !SETTINGS_EDITABLE_KEYS.has(k));

  const authProviders = {};
  if (authDoc && typeof authDoc === 'object') {
    for (const [provId, cred] of Object.entries(authDoc)) {
      if (!cred || typeof cred !== 'object') continue;
      const type = cred.type === 'oauth' ? 'oauth' : cred.type === 'api_key' ? 'api_key' : 'stored';
      const configured = Boolean(cred.key || cred.access || cred.refresh || cred.token);
      authProviders[provId] = { providerId: provId, type, configured, masked: configured ? MASK_PLACEHOLDER : null };
    }
  }

  const customProviders = {};
  const rawProviders = modelsDoc && typeof modelsDoc.providers === 'object' && modelsDoc.providers ? modelsDoc.providers : {};
  for (const [provId, prov] of Object.entries(rawProviders)) {
    if (!prov || typeof prov !== 'object') continue;
    const credInfo = redactSecretString(prov.apiKey);
    const headerNames = prov.headers && typeof prov.headers === 'object' ? Object.keys(prov.headers) : [];
    const models = Array.isArray(prov.models)
      ? prov.models
          .filter(m => m && typeof m === 'object' && typeof m.id === 'string')
          .map(m => ({
            id: m.id,
            name: m.name || m.id,
            reasoning: Boolean(m.reasoning),
            contextWindow: typeof m.contextWindow === 'number' ? m.contextWindow : null,
            maxTokens: typeof m.maxTokens === 'number' ? m.maxTokens : null,
          }))
      : [];
    const overrideIds = prov.modelOverrides && typeof prov.modelOverrides === 'object'
      ? Object.keys(prov.modelOverrides)
      : [];
    customProviders[provId] = {
      id: provId,
      name: prov.name || provId,
      baseUrl: prov.baseUrl || null,
      api: prov.api || null,
      authHeader: typeof prov.authHeader === 'boolean' ? prov.authHeader : undefined,
      credential: credInfo,
      headerKeys: headerNames,
      models,
      modelOverrideIds: overrideIds,
    };
  }

  const projectOverride = inspectProjectPiSettings(projectDir);
  const effectiveProvider = projectOverride?.defaultProvider || settings.defaultProvider || null;
  const effectiveModel = projectOverride?.defaultModel || settings.defaultModel || null;
  const effectiveThinkingLevel = projectOverride?.defaultThinkingLevel || settings.defaultThinkingLevel || 'medium';

  const hasCredentialForProvider = provId => {
    if (!provId) return false;
    if (authProviders[provId]?.configured) return true;
    if (customProviders[provId]?.credential?.configured) return true;
    const builtin = PI_BUILTIN_PROVIDERS.find(p => p.id === provId);
    if (builtin && builtin.envVars.some(k => Boolean(env[k]))) return true;
    return false;
  };

  const anyAuthConfigured =
    Object.values(authProviders).some(a => a.configured) ||
    Object.values(customProviders).some(p => p.credential.configured) ||
    PI_BUILTIN_PROVIDERS.some(p => p.envVars.some(k => Boolean(env[k])));

  return {
    view: {
      settings: {
        defaultProvider: settings.defaultProvider ?? null,
        defaultModel: settings.defaultModel ?? null,
        defaultThinkingLevel: settings.defaultThinkingLevel ?? null,
        theme: settings.theme ?? null,
        quietStartup: typeof settings.quietStartup === 'boolean' ? settings.quietStartup : null,
        hideThinkingBlock: typeof settings.hideThinkingBlock === 'boolean' ? settings.hideThinkingBlock : null,
        compaction: settings.compaction && typeof settings.compaction === 'object'
          ? {
              enabled: settings.compaction.enabled,
              reserveTokens: settings.compaction.reserveTokens,
              keepRecentTokens: settings.compaction.keepRecentTokens,
            }
          : null,
        enabledModels: Array.isArray(settings.enabledModels) ? settings.enabledModels : null,
        preservedKeys: preservedSettingsKeys,
      },
      customProviders,
      authProviders,
      projectOverride,
    },
    effective: {
      defaultProvider: effectiveProvider,
      defaultModel: effectiveModel,
      defaultThinkingLevel: effectiveThinkingLevel,
      sourceScope: projectOverride?.defaultModel || projectOverride?.defaultProvider ? 'project' : 'global',
      shadowedByProject: Boolean(
        projectOverride &&
          ((projectOverride.defaultProvider && projectOverride.defaultProvider !== settings.defaultProvider) ||
            (projectOverride.defaultModel && projectOverride.defaultModel !== settings.defaultModel))
      ),
    },
    readiness: {
      configReadable: true,
      settingsPresent: Boolean(settingsSnap?.exists),
      modelsPresent: Boolean(modelsSnap?.exists),
      authPresent: Boolean(authSnap?.exists),
      authConfigured: effectiveProvider ? hasCredentialForProvider(effectiveProvider) : anyAuthConfigured,
      anyAuthConfigured,
    },
    editableFields: [
      { path: 'settings.defaultProvider', sourceKey: 'pi.settings', scope: 'global', type: 'string', label: '默认供应商 (defaultProvider)' },
      { path: 'settings.defaultModel', sourceKey: 'pi.settings', scope: 'global', type: 'string', label: '默认模型 (defaultModel)' },
      {
        path: 'settings.defaultThinkingLevel',
        sourceKey: 'pi.settings',
        scope: 'global',
        type: 'enum',
        options: [...THINKING_LEVELS],
        label: '默认思考深度 (defaultThinkingLevel)',
      },
      { path: 'settings.theme', sourceKey: 'pi.settings', scope: 'global', type: 'string', label: '终端主题 (theme)' },
      { path: 'settings.quietStartup', sourceKey: 'pi.settings', scope: 'global', type: 'boolean', label: '静默启动 (quietStartup)' },
      { path: 'settings.hideThinkingBlock', sourceKey: 'pi.settings', scope: 'global', type: 'boolean', label: '隐藏思考过程 (hideThinkingBlock)' },
      { path: 'settings.compaction', sourceKey: 'pi.settings', scope: 'global', type: 'object', label: '自动压缩设置 (compaction)' },
      { path: 'models.providers', sourceKey: 'pi.models', scope: 'global', type: 'providers', label: '自定义模型供应商 (models.json)' },
    ],
    scopeWarning:
      '修改 settings.json 或 models.json 会更新本机 Pi 的全局默认配置，影响共享该连接的工作台成员及之后启动的本机 Pi 会话。Pi 当前版本的 RPC set_model 也会写入全局默认，不能标为“仅本次会话”。',
  };
}

function listPiResources(fileSnapshots, { env = process.env } = {}) {
  const inspected = inspectPiConfig(fileSnapshots, { env });
  const { customProviders, authProviders } = inspected.view;
  const providerMap = new Map();

  // 1. Built-in providers from Pi registry.
  for (const builtin of PI_BUILTIN_PROVIDERS) {
    const envAuth = builtin.envVars.find(k => Boolean(env[k]));
    const storedAuth = authProviders[builtin.id]?.configured;
    providerMap.set(builtin.id, {
      id: builtin.id,
      name: builtin.name,
      source: 'pi-builtin',
      baseUrl: null,
      authenticated: Boolean(storedAuth || envAuth),
      authSource: storedAuth ? `auth.json (${authProviders[builtin.id].type})` : envAuth ? `env:${envAuth}` : 'none',
      models: builtin.models.map(m => ({ ...m, providerId: builtin.id, source: 'pi-builtin', verificationStatus: 'declared' })),
    });
  }

  // 2. Merge custom providers & models from models.json (custom definitions override or extend built-in).
  for (const [provId, custom] of Object.entries(customProviders)) {
    const existing = providerMap.get(provId);
    const storedAuth = authProviders[provId]?.configured;
    const customAuth = custom.credential?.configured;
    const authenticated = Boolean(storedAuth || customAuth || existing?.authenticated);
    const authSource = customAuth
      ? `models.json (${custom.credential.kind})`
      : storedAuth
      ? `auth.json (${authProviders[provId].type})`
      : existing?.authSource || 'none';

    const mergedModels = new Map();
    if (existing) {
      for (const m of existing.models) mergedModels.set(m.id, m);
    }
    for (const m of custom.models) {
      mergedModels.set(m.id, { ...m, providerId: provId, source: 'models.json', verificationStatus: 'configured' });
    }
    providerMap.set(provId, {
      id: provId,
      name: custom.name || existing?.name || provId,
      source: existing ? 'merged' : 'models.json',
      baseUrl: custom.baseUrl || existing?.baseUrl || null,
      authenticated,
      authSource,
      models: [...mergedModels.values()],
    });
  }

  const providers = [...providerMap.values()];
  const models = providers.flatMap(p =>
    p.models.map(m => ({
      ...m,
      providerName: p.name,
      authenticated: p.authenticated,
      isDefault:
        inspected.effective.defaultProvider === p.id && inspected.effective.defaultModel === m.id,
      verificationStatus: m.verificationStatus || 'declared',
    }))
  );

  return {
    effective: inspected.effective,
    readiness: inspected.readiness,
    providers,
    models,
    declaredModels: models.filter(m => m.verificationStatus === 'declared'),
    configuredModels: models.filter(m => m.verificationStatus === 'configured'),
    verifiedModels: models.filter(m => m.verificationStatus === 'verified'),
    note: '可用列表合并了 Pi 内置模型注册表与本机 models.json 自定义模型；认证状态仅代表检测到凭据配置，不代表已完成在线请求验证。',
  };
}

function validateAndBuildPiPatch(fileSnapshots, patchInput) {
  if (!patchInput || typeof patchInput !== 'object' || Array.isArray(patchInput)) {
    throw fail('配置修改请求必须是对象。');
  }
  const allowedTop = new Set(['settings', 'models']);
  for (const key of Object.keys(patchInput)) {
    if (!allowedTop.has(key)) throw fail(`不支持的 Pi 配置修改分组: ${key}`);
  }

  const fileChanges = [];
  const redactedChanges = [];

  if (patchInput.settings !== undefined) {
    if (!patchInput.settings || typeof patchInput.settings !== 'object' || Array.isArray(patchInput.settings)) {
      throw fail('settings 修改必须是对象。');
    }
    const settingsSnap = fileSnapshots.get('pi.settings');
    const currentSettings = settingsSnap?.exists ? parseJsonc(settingsSnap.rawText, 'settings.json') : {};
    const patchObj = {};

    for (const [key, val] of Object.entries(patchInput.settings)) {
      if (!SETTINGS_EDITABLE_KEYS.has(key)) {
        throw fail(`字段 settings.${key} 不在受控编辑白名单中。`, 'CONFIG_FIELD_FORBIDDEN', 400);
      }
      if (key === 'defaultProvider' || key === 'defaultModel' || key === 'theme') {
        if (val !== null && val !== undefined && (typeof val !== 'string' || !val.trim() || val.length > 200)) {
          throw fail(`字段 settings.${key} 必须是非空字符串或 null。`);
        }
        const normalized = val === null || val === undefined ? undefined : val.trim();
        patchObj[key] = normalized;
        redactedChanges.push({
          sourceKey: 'pi.settings',
          fieldPath: `settings.${key}`,
          before: currentSettings[key] ?? null,
          after: normalized ?? null,
        });
      } else if (key === 'defaultThinkingLevel') {
        if (val !== null && val !== undefined && !THINKING_LEVELS.has(val)) {
          throw fail(`settings.defaultThinkingLevel 必须是 ${[...THINKING_LEVELS].join('/')} 之一或 null。`);
        }
        const normalized = val === null || val === undefined ? undefined : val;
        patchObj[key] = normalized;
        redactedChanges.push({
          sourceKey: 'pi.settings',
          fieldPath: 'settings.defaultThinkingLevel',
          before: currentSettings.defaultThinkingLevel ?? null,
          after: normalized ?? null,
        });
      } else if (key === 'quietStartup' || key === 'hideThinkingBlock') {
        if (val !== null && val !== undefined && typeof val !== 'boolean') {
          throw fail(`字段 settings.${key} 必须是布尔值或 null。`);
        }
        const normalized = val === null || val === undefined ? undefined : val;
        patchObj[key] = normalized;
        redactedChanges.push({
          sourceKey: 'pi.settings',
          fieldPath: `settings.${key}`,
          before: currentSettings[key] ?? null,
          after: normalized ?? null,
        });
      } else if (key === 'compaction') {
        if (val !== null && val !== undefined && (typeof val !== 'object' || Array.isArray(val))) {
          throw fail('settings.compaction 必须是对象或 null。');
        }
        if (val === null) {
          patchObj.compaction = undefined;
        } else if (val) {
          const compPatch = {};
          for (const ck of Object.keys(val)) {
            if (!['enabled', 'reserveTokens', 'keepRecentTokens'].includes(ck)) {
              throw fail(`不支持的 compaction 字段: ${ck}`);
            }
          }
          if (val.enabled !== undefined) {
            if (typeof val.enabled !== 'boolean') throw fail('compaction.enabled 必须是布尔值。');
            compPatch.enabled = val.enabled;
          }
          if (val.reserveTokens !== undefined) {
            if (!Number.isInteger(val.reserveTokens) || val.reserveTokens < 1024) {
              throw fail('compaction.reserveTokens 必须是 >= 1024 的整数。');
            }
            compPatch.reserveTokens = val.reserveTokens;
          }
          if (val.keepRecentTokens !== undefined) {
            if (!Number.isInteger(val.keepRecentTokens) || val.keepRecentTokens < 1024) {
              throw fail('compaction.keepRecentTokens 必须是 >= 1024 的整数。');
            }
            compPatch.keepRecentTokens = val.keepRecentTokens;
          }
          patchObj.compaction = compPatch;
        }
        redactedChanges.push({
          sourceKey: 'pi.settings',
          fieldPath: 'settings.compaction',
          before: currentSettings.compaction ?? null,
          after: val,
        });
      } else if (key === 'enabledModels') {
        if (val !== null && val !== undefined && (!Array.isArray(val) || val.some(item => typeof item !== 'string' || !item.trim()))) {
          throw fail('settings.enabledModels 必须是字符串数组或 null。');
        }
        patchObj.enabledModels = val === null || val === undefined ? undefined : val.map(s => s.trim());
        redactedChanges.push({
          sourceKey: 'pi.settings',
          fieldPath: 'settings.enabledModels',
          before: currentSettings.enabledModels ?? null,
          after: patchObj.enabledModels ?? null,
        });
      }
    }

    if (Object.keys(patchObj).length > 0) {
      const nextText = applyJsoncPatch(settingsSnap?.rawText || '', patchObj, 'settings.json');
      fileChanges.push({
        sourceKey: 'pi.settings',
        nextText,
        expectedFinalCheck: parsed => {
          for (const [k, v] of Object.entries(patchObj)) {
            if (k === 'compaction' && v && typeof v === 'object') {
              for (const [ck, cv] of Object.entries(v)) {
                if (parsed.compaction?.[ck] !== cv) return false;
              }
            } else if (JSON.stringify(parsed[k]) !== JSON.stringify(v)) {
              return false;
            }
          }
          return true;
        },
      });
    }
  }

  if (patchInput.models !== undefined) {
    if (!patchInput.models || typeof patchInput.models !== 'object' || Array.isArray(patchInput.models)) {
      throw fail('models 修改必须是对象。');
    }
    const providersPatch = patchInput.models.providers;
    if (!providersPatch || typeof providersPatch !== 'object' || Array.isArray(providersPatch)) {
      throw fail('models.providers 必须是对象。');
    }
    const modelsSnap = fileSnapshots.get('pi.models');
    const currentModelsDoc = modelsSnap?.exists ? parseJsonc(modelsSnap.rawText, 'models.json') : {};
    const currentProviders = currentModelsDoc.providers || {};
    const jsoncProvidersPatch = {};

    for (const [provId, provPatch] of Object.entries(providersPatch)) {
      if (!/^[A-Za-z0-9._-]+$/.test(provId)) throw fail(`无效的供应商 ID: ${provId}`);
      if (provPatch === null) {
        jsoncProvidersPatch[provId] = undefined;
        redactedChanges.push({
          sourceKey: 'pi.models',
          fieldPath: `models.providers.${provId}`,
          before: currentProviders[provId] ? { id: provId } : null,
          after: null,
        });
        continue;
      }
      if (typeof provPatch !== 'object' || Array.isArray(provPatch)) {
        throw fail(`供应商 ${provId} 修改项必须是对象或 null。`);
      }

      const existingProv = currentProviders[provId] || {};
      const singleProvPatch = {};

      if (provPatch.name !== undefined) {
        if (provPatch.name !== null && (typeof provPatch.name !== 'string' || !provPatch.name.trim())) {
          throw fail(`供应商 ${provId}.name 必须是非空字符串或 null。`);
        }
        singleProvPatch.name = provPatch.name === null ? undefined : provPatch.name.trim();
        redactedChanges.push({
          sourceKey: 'pi.models',
          fieldPath: `models.providers.${provId}.name`,
          before: existingProv.name ?? null,
          after: singleProvPatch.name ?? null,
        });
      }

      if (provPatch.baseUrl !== undefined) {
        if (provPatch.baseUrl !== null && (typeof provPatch.baseUrl !== 'string' || !provPatch.baseUrl.trim())) {
          throw fail(`供应商 ${provId}.baseUrl 必须是非空字符串或 null。`);
        }
        singleProvPatch.baseUrl = provPatch.baseUrl === null ? undefined : provPatch.baseUrl.trim();
        redactedChanges.push({
          sourceKey: 'pi.models',
          fieldPath: `models.providers.${provId}.baseUrl`,
          before: existingProv.baseUrl ?? null,
          after: singleProvPatch.baseUrl ?? null,
        });
      }

      if (provPatch.api !== undefined) {
        if (provPatch.api !== null && (typeof provPatch.api !== 'string' || !provPatch.api.trim())) {
          throw fail(`供应商 ${provId}.api 必须是非空字符串或 null。`);
        }
        singleProvPatch.api = provPatch.api === null ? undefined : provPatch.api.trim();
        redactedChanges.push({
          sourceKey: 'pi.models',
          fieldPath: `models.providers.${provId}.api`,
          before: existingProv.api ?? null,
          after: singleProvPatch.api ?? null,
        });
      }

      // Credential handling: explicit keep / replace / delete. Never write mask placeholders!
      const credAction = provPatch.credentialAction || (provPatch.apiKey === undefined ? 'keep' : 'replace');
      if (!['keep', 'replace', 'delete'].includes(credAction)) {
        throw fail(`不支持的凭据操作 credentialAction: ${credAction}`);
      }
      if (credAction === 'replace') {
        if (typeof provPatch.apiKey !== 'string' || !provPatch.apiKey.trim()) {
          throw fail(`替换供应商 ${provId} 凭据时必须提供有效 apiKey。`, 'INVALID_CREDENTIAL', 400);
        }
        if (isMaskedSecret(provPatch.apiKey)) {
          throw fail('禁止将掩码占位符当作真实密钥写回配置文件。', 'INVALID_CREDENTIAL_MASK', 400);
        }
        if (provPatch.apiKey.trim().startsWith('!')) {
          throw fail('出于安全限制，工作台不允许向 models.json 写入 !command 命令执行凭据。', 'CONFIG_COMMAND_FORBIDDEN', 400);
        }
        singleProvPatch.apiKey = provPatch.apiKey.trim();
        redactedChanges.push({
          sourceKey: 'pi.models',
          fieldPath: `models.providers.${provId}.apiKey`,
          before: existingProv.apiKey ? MASK_PLACEHOLDER : null,
          after: MASK_PLACEHOLDER,
          credentialAction: 'replace',
        });
      } else if (credAction === 'delete') {
        singleProvPatch.apiKey = undefined;
        redactedChanges.push({
          sourceKey: 'pi.models',
          fieldPath: `models.providers.${provId}.apiKey`,
          before: existingProv.apiKey ? MASK_PLACEHOLDER : null,
          after: null,
          credentialAction: 'delete',
        });
      } else if (provPatch.apiKey !== undefined && isMaskedSecret(provPatch.apiKey)) {
        // Explicit `keep` with masked placeholder in form: do not touch apiKey in JSONC.
      }

      if (provPatch.models !== undefined) {
        if (!Array.isArray(provPatch.models)) throw fail(`供应商 ${provId}.models 必须是数组。`);
        const validatedModels = provPatch.models.map(m => {
          if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id.trim()) {
            throw fail(`供应商 ${provId}.models 中的每项必须包含有效的 id 字符串。`);
          }
          const item = { id: m.id.trim(), name: (typeof m.name === 'string' && m.name.trim()) ? m.name.trim() : m.id.trim() };
          if (typeof m.reasoning === 'boolean') item.reasoning = m.reasoning;
          if (typeof m.contextWindow === 'number' && m.contextWindow > 0) item.contextWindow = m.contextWindow;
          if (typeof m.maxTokens === 'number' && m.maxTokens > 0) item.maxTokens = m.maxTokens;
          return item;
        });
        singleProvPatch.models = validatedModels;
        redactedChanges.push({
          sourceKey: 'pi.models',
          fieldPath: `models.providers.${provId}.models`,
          before: existingProv.models || [],
          after: validatedModels,
        });
      }

      if (Object.keys(singleProvPatch).length > 0) {
        jsoncProvidersPatch[provId] = singleProvPatch;
      }
    }

    if (Object.keys(jsoncProvidersPatch).length > 0) {
      const baseText = modelsSnap?.exists && modelsSnap.rawText.trim()
        ? modelsSnap.rawText
        : '{\n  "providers": {}\n}\n';
      const nextText = applyJsoncPatch(baseText, { providers: jsoncProvidersPatch }, 'models.json');
      fileChanges.push({
        sourceKey: 'pi.models',
        nextText,
        expectedFinalCheck: parsed => Boolean(parsed && typeof parsed.providers === 'object'),
      });
    }
  }

  if (fileChanges.length === 0) {
    throw fail('没有检测到需要保存的有效配置变更。', 'CONFIG_NO_CHANGES', 400);
  }

  return {
    scope: 'global',
    requiresRestart: false,
    applicationMode: 'next_run',
    applicationNote: '已写入本机 Pi 原生配置文件；新配置将在下一次启动本机 Pi 会话或任务时生效。',
    redactedChanges,
    fileChanges,
  };
}

module.exports = {
  PI_BUILTIN_PROVIDERS,
  THINKING_LEVELS,
  buildPiSources,
  inspectPiConfig,
  listPiResources,
  validateAndBuildPiPatch,
};
