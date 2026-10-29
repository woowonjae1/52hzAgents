const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function normalizeUrl(url, protocol) {
  if (!url || typeof url !== 'string') return '';
  let cleaned = url.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(cleaned)) {
    cleaned = `https://${cleaned}`;
  }
  // Strip trailing chat endpoints that users accidentally copy-paste
  cleaned = cleaned.replace(/\/(chat\/completions|messages|api\/chat)$/i, '');
  let parsedUrl;
  try {parsedUrl = new URL(cleaned);} catch {throw Object.assign(new Error('Invalid base URL.'),{status:400});}
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) throw Object.assign(new Error('Use an HTTP(S) base URL without credentials, query or fragment.'), { status: 400 });

  if (protocol === 'openai') {
    // If domain has no path, default to /v1
    try {
      const parsed = new URL(cleaned);
      if (!parsed.pathname || parsed.pathname === '/') {
        cleaned = `${parsed.origin}/v1`;
      }
    } catch (_) {}
  } else if (protocol === 'anthropic') {
    // Anthropic API uses /v1 directly in requests; base url should strip /v1 if attached
    cleaned = cleaned.replace(/\/v1$/i, '');
  }
  return cleaned;
}

const DEFAULT_PRESETS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    models: [
      { id: 'deepseek-chat', name: 'DeepSeek-V3 (Chat)', contextWindow: 65536, maxTokens: 8192 },
      { id: 'deepseek-reasoner', name: 'DeepSeek-R1 (Reasoner)', contextWindow: 65536, maxTokens: 8192 },
    ],
    envKey: 'DEEPSEEK_API_KEY',
    envBase: 'DEEPSEEK_BASE_URL',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o',
    models: [
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000, maxTokens: 4096 },
      { id: 'gpt-4o-mini', name: 'GPT-4o mini', contextWindow: 128000, maxTokens: 4096 },
      { id: 'o3-mini', name: 'o3-mini', contextWindow: 200000, maxTokens: 8192 },
    ],
    envKey: 'OPENAI_API_KEY',
    envBase: 'OPENAI_BASE_URL',
  },
  {
    id: 'claude',
    name: 'Claude (Anthropic)',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-3-7-sonnet-20250219',
    models: [
      { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet', contextWindow: 200000, maxTokens: 8192 },
      { id: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', contextWindow: 200000, maxTokens: 8192 },
      { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', contextWindow: 200000, maxTokens: 8192 },
    ],
    envKey: 'ANTHROPIC_API_KEY',
    envBase: 'ANTHROPIC_BASE_URL',
  },
  {
    id: 'gemini',
    name: 'Gemini (Google)',
    protocol: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash',
    models: [
      { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextWindow: 1048576, maxTokens: 8192 },
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', contextWindow: 2097152, maxTokens: 8192 },
    ],
    envKey: 'GEMINI_API_KEY',
    envBase: 'GEMINI_BASE_URL',
  },
  {
    id: 'ollama',
    name: 'Ollama (Local)',
    protocol: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    defaultModel: 'llama3:latest',
    models: [
      { id: 'llama3:latest', name: 'Llama 3' },
      { id: 'qwen2.5-coder:latest', name: 'Qwen 2.5 Coder' },
      { id: 'deepseek-r1:latest', name: 'DeepSeek R1' },
    ],
    envKey: null,
    envBase: 'OLLAMA_BASE_URL',
  },
];

class ConfigManager {
  constructor(userDataPath, credentialVault, env = process.env) {
    this.filePath = path.join(userDataPath, 'connections.json');
    this.vault = credentialVault;
    this.env = env;
    this.userConnections = this.loadUserConnections();
  }

  loadUserConnections() {
    try {
      if (fs.existsSync(this.filePath)) {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      }
    } catch (_) {}
    return [];
  }

  saveUserConnections() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath+'.tmp', JSON.stringify(this.userConnections, null, 2), 'utf8');
      fs.renameSync(this.filePath+'.tmp',this.filePath);
    } catch (err) { throw new Error('Could not persist connection settings.'); }
  }

  /** Returns all connections merged: user configured take precedence, presets/env as fallback */
  getConnections() {
    const list = [];
    const userIds = new Set(this.userConnections.map((c) => c.id));

    // 1. User connections
    for (const c of this.userConnections) {
      list.push({
        id: c.id,
        name: c.name || c.id,
        protocol: c.protocol || 'openai',
        baseUrl: c.baseUrl,
        defaultModel: c.defaultModel,
        models: c.models || [],
        hasCredential: c.protocol === 'ollama' || Boolean(this.getConnectionSecret(c.id)),
        source: 'user',
        confirmedContextWindow: c.confirmedContextWindow,
        version: c.version || 1,
        credentialSource: c.protocol === 'ollama' ? 'not_required' : this.vault.has(c.credentialRef || `conn:${c.id}`) ? 'vault' : this.getConnectionSecret(c.id) ? 'env' : 'none',
      });
    }

    // 2. Default Presets / Env connections if not overridden by user
    for (const p of DEFAULT_PRESETS) {
      if (!userIds.has(p.id)) {
        const envVal = p.envKey ? this.env[p.envKey] : null;
        const envBase = p.envBase ? this.env[p.envBase] : null;
        const hasVaultKey = this.vault.has(`conn:${p.id}`);
        const hasKey = p.id === 'ollama' || Boolean(envVal) || hasVaultKey;

        list.push({
          id: p.id,
          name: p.name,
          protocol: p.protocol,
          baseUrl: envBase || p.baseUrl,
          defaultModel: this.env[`${p.id.toUpperCase()}_MODEL`] || (p.envKey && this.env[`${p.envKey.replace('_API_KEY','')}_MODEL`]) || p.defaultModel,
          models: p.models,
          hasCredential: hasKey,
          source: hasVaultKey ? 'user' : (envVal || envBase) ? 'env' : 'preset',
        });
      }
    }

    return list;
  }

  getConnection(id) {
    return this.getConnections().find((c) => c.id === id) || null;
  }

  /** Internal use only: retrieves decrypted API Key for the connection */
  getConnectionSecret(id) {
    const record=this.userConnections.find(c => c.id === id);
    if (record?.credentialDeleted) return '';
    const reference=record?.credentialRef || `conn:${id}`;
    if (this.vault.has(reference)) {
      return this.vault.get(reference);
    }
    const preset = DEFAULT_PRESETS.find((p) => p.id === id);
    if (preset?.envKey && this.env[preset.envKey]) {
      return this.env[preset.envKey];
    }
    return '';
  }

  saveConnection({ id, name, protocol, baseUrl, defaultModel, models, credentialAction = 'keep', credentialValue = '', confirmedContextWindow }) {
    if (!id || typeof id !== 'string') {
      const err = new Error('Connection ID is required.');
      err.status = 400;
      throw err;
    }
    const cleanId = id.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    if (!cleanId || cleanId.length > 100 || !['keep', 'replace', 'delete'].includes(credentialAction)) throw Object.assign(new Error('Invalid connection ID or credential action.'), { status: 400 });
    const old = this.userConnections.find(c => c.id === cleanId) || this.getConnection(cleanId) || {};
    if (protocol !== undefined && !['openai', 'anthropic', 'ollama'].includes(protocol)) throw Object.assign(new Error('Invalid protocol.'), { status: 400 });
    const cleanProtocol = protocol || old.protocol || 'openai';
    const cleanBaseUrl = normalizeUrl(baseUrl ?? old.baseUrl, cleanProtocol);
    if(confirmedContextWindow!==undefined && Number(confirmedContextWindow)!==0 && (!Number.isSafeInteger(Number(confirmedContextWindow)) || Number(confirmedContextWindow)<2048 || Number(confirmedContextWindow)>10000000)) throw Object.assign(new Error('Context capacity must be 2048–10000000 tokens, or left unknown.'),{status:400});
    if (!cleanBaseUrl) throw Object.assign(new Error('A base URL is required.'), { status: 400 });
    if (credentialAction === 'replace' && (!credentialValue || !credentialValue.trim())) throw Object.assign(new Error('Enter a non-empty credential.'), { status: 400 });

    // Versioned secret references make the configuration rename the commit point.
    // A failed URL/config write must never send a new key to the old endpoint.
    const previous=this.userConnections;
    const priorReference=old.credentialRef || `conn:${cleanId}`;
    const reference=credentialAction==='replace'?`conn:${cleanId}:${crypto.randomUUID()}`:priorReference;
    const existingIdx = this.userConnections.findIndex((c) => c.id === cleanId);
    const newRecord = {
      id: cleanId,
      name: name?.trim() || cleanId,
      protocol: cleanProtocol,
      baseUrl: cleanBaseUrl,
      defaultModel: defaultModel === undefined ? old.defaultModel || '' : defaultModel.trim(),
      models: Array.isArray(models) ? models : old.models || [],
      confirmedContextWindow: confirmedContextWindow === undefined ? old.confirmedContextWindow : Number(confirmedContextWindow) || undefined,
      version: (old.version || 0) + 1,
      credentialDeleted: credentialAction === 'delete' ? true : credentialAction === 'replace' ? false : Boolean(old.credentialDeleted),
      credentialRef: reference,
    };
    if(credentialAction==='replace')this.vault.set(reference,credentialValue.trim());
    this.userConnections=existingIdx>=0?previous.map((record,index)=>index===existingIdx?{...record,...newRecord}:record):[...previous,newRecord];
    try{this.saveUserConnections();}catch(error){
      this.userConnections=previous;
      if(credentialAction==='replace')try{this.vault.delete(reference);}catch{}
      throw error;
    }
    if(credentialAction!=='keep')try{this.vault.delete(priorReference);}catch{console.warn('[ConfigManager] Deferred cleanup of an unused encrypted credential.');}
    return this.getConnection(cleanId);
  }

  deleteConnection(id) {
    const idx = this.userConnections.findIndex((c) => c.id === id);
    const previous=this.userConnections,reference=previous[idx]?.credentialRef || `conn:${id}`;
    if (idx >= 0) {
      this.userConnections=this.userConnections.filter(c=>c.id!==id);
      try{this.saveUserConnections();}catch(error){this.userConnections=previous;throw error;}
    }
    this.vault.delete(reference);
    return { ok: true };
  }
}

module.exports = { ConfigManager, normalizeUrl };
