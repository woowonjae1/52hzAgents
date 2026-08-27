/**
 * Direct LLM API adapter — shared base for NanoClaw and Cursor.
 *
 * Calls OpenAI-compatible chat completions API directly with SSE streaming.
 * No CLI binary needed — just OPENAI_API_KEY + OPENAI_BASE_URL.
 *
 * Port of Python: sdk/src/openagents/adapters/nanoclaw.py & cursor.py
 */

'use strict';

const https = require('https');
const http = require('http');

const BaseAdapter = require('./base');
const { formatAttachmentsForPrompt } = require('./utils');
const { buildOpenclawSystemPrompt } = require('./workspace-prompt');

const MAX_HISTORY = 50;

// `GET /models` runs off the 30s heartbeat, so it is cached: long enough that a
// tick costs nothing, short enough that a newly granted model shows up quickly.
const MODELS_CACHE_TTL_MS = 5 * 60 * 1000;

class LlmDirectAdapter extends BaseAdapter {
  /**
   * @param {object} opts - BaseAdapter opts plus:
   * @param {Set} [opts.disabledModules]
   * @param {string} opts.adapterLabel - e.g. "NanoClaw" or "Cursor"
   * @param {string} opts.modelEnvVar - e.g. "NANOCLAW_MODEL" or "CURSOR_MODEL"
   */
  constructor(opts) {
    super(opts);
    this.disabledModules = opts.disabledModules || new Set();
    this._adapterLabel = opts.adapterLabel || 'LLM';
    this._modelEnvVar = opts.modelEnvVar || '';

    const env = this.agentEnv || process.env;
    this._apiKey = env.OPENAI_API_KEY || '';
    this._baseUrl = (env.OPENAI_BASE_URL || '').replace(/\/$/, '');
    this._model = env[this._modelEnvVar] || env.OPENCLAW_MODEL || '';
    this.model = this._model || opts.model || '';
    this._directMode = !!(this._apiKey && this._baseUrl);

    if (!opts.suppressConfigLog) {
      if (this._directMode) {
        this._log(`Direct LLM mode: ${this._baseUrl} model=${this._model || 'gpt-4o'}`);
      } else {
        this._log(
          `${this._adapterLabel} adapter started without direct API config. ` +
          'Set OPENAI_API_KEY + OPENAI_BASE_URL for direct mode.'
        );
      }
    }

    this._conversationHistory = [];
    this._activeRequests = new Set();
    this._modelsCache = null;
    this._modelsInFlight = null;
    // Set by subclasses when `_model` fell through to their vendor default
    // constant rather than anything the user configured, so the workspace can
    // say so instead of presenting a constant as the user's choice.
    this._modelIsVendorDefault = false;
  }

  stop() {
    super.stop();
    for (const req of this._activeRequests) {
      try { req.destroy(new Error('LLM API request stopped')); } catch {}
    }
    this._activeRequests.clear();
  }

  /**
   * Every model this endpoint actually serves, from its own OpenAI-compatible
   * `GET /models`. This is the only authoritative source for a direct-API agent
   * - there is no local config file to read - so a failed probe reports
   * "unknown" and is retried, never hardened into a guessed list.
   *
   * Cached behind a TTL because this runs off the heartbeat, and de-duplicated
   * so concurrent ticks share one request.
   */
  async _listModels() {
    if (!this._directMode) return [];
    const now = Date.now();
    if (this._modelsCache && now - this._modelsCache.at < MODELS_CACHE_TTL_MS) {
      return this._modelsCache.models;
    }
    if (this._modelsInFlight) return this._modelsInFlight;

    this._modelsInFlight = this._probeModels()
      .then((models) => {
        // Only cache a non-empty answer: an empty result means the probe failed
        // or the endpoint does not implement /models, both of which must stay
        // retryable rather than freeze into "this account has no models".
        if (models.length) this._modelsCache = { at: Date.now(), models };
        return models;
      })
      .catch(() => [])
      .finally(() => { this._modelsInFlight = null; });
    return this._modelsInFlight;
  }

  /** One `GET {baseUrl}/models` request, parsed into {id, provider, label}. */
  _probeModels() {
    return new Promise((resolve) => {
      let url;
      try {
        url = new URL(`${this._baseUrl}/models`);
      } catch {
        resolve([]);
        return;
      }
      const lib = url.protocol === 'http:' ? http : https;
      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'http:' ? 80 : 443),
          path: url.pathname + url.search,
          method: 'GET',
          headers: { 'Authorization': `Bearer ${this._apiKey}` },
          timeout: 10000,
        },
        (res) => {
          let body = '';
          res.on('data', (d) => { body += d.toString('utf-8'); });
          res.on('end', () => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
              this._log(`${this._adapterLabel} /models probe: HTTP ${res.statusCode}`);
              resolve([]);
              return;
            }
            try {
              const parsed = JSON.parse(body);
              const list = Array.isArray(parsed && parsed.data) ? parsed.data
                : Array.isArray(parsed) ? parsed
                : [];
              const seen = new Set();
              const models = [];
              for (const m of list) {
                const id = typeof m === 'string' ? m : (m && m.id);
                if (!id || seen.has(id)) continue;
                seen.add(id);
                models.push({ id, provider: this._adapterLabel, label: id });
              }
              resolve(models);
            } catch {
              resolve([]);
            }
          });
        }
      );
      req.on('error', (e) => { this._log(`${this._adapterLabel} /models probe failed: ${e.message}`); resolve([]); });
      req.on('timeout', () => { req.destroy(); resolve([]); });
      req.end();
    });
  }

  async fetchAndReportUsage() {
    try {
      // `this.model` is also seeded from the vendor default by some subclasses,
      // so "resolved" alone cannot mean "the user overrode this" - only a value
      // that differs from the configured/default model is a real override.
      const resolved = this._resolveModel();
      const override = (resolved && resolved !== this._model) ? resolved : '';
      const current = resolved || this._model || null;
      const models = await this._listModels();
      const source = !this._directMode ? 'unconfigured'
        : override ? 'workspace-override'
        : this._modelIsVendorDefault ? 'vendor-default'
        : this._model ? 'agent-env'
        : 'unconfigured';
      await this.client.reportAgentUsage(
        this.workspaceId,
        this.agentName,
        {
          session_used_percent: 0,
          week_used_percent: 0,
          current_model: current,
          // Omitted rather than padded with the current model: an endpoint that
          // does not answer /models is "unknown", not "one model".
          available_models: models.length ? JSON.stringify(models) : null,
          raw_text: `${this._adapterLabel} direct mode model_source=${source} endpoint=${this._baseUrl || 'unset'}`,
        },
        this.token
      );
    } catch (e) {
      this._log(`fetchAndReportUsage error: ${e.message}`);
    }
  }

  async _onControlAction(action, payload) {
    if (action === 'set_model') {
      const requested = payload && payload.model;
      const channel = (payload && typeof payload === 'object') ? payload.channel : null;
      if (!requested) return;
      if (channel) {
        this._channelModels[channel] = requested;
      } else {
        for (const c of Object.keys(this._channelModels)) this._channelModels[c] = requested;
        this._channelModels['*'] = requested;
        this.model = requested;
        this._model = requested;
      }
      this._log(`Model override for channel=${channel || 'all'} set to '${requested}'`);
      this.fetchAndReportUsage().catch(() => {});
      return;
    }
    if (action === 'stop') {
      for (const req of this._activeRequests) {
        try { req.destroy(new Error('LLM API request stopped')); } catch {}
      }
      this._activeRequests.clear();
      return;
    }
    await super._onControlAction(action, payload);
  }

  _buildSystemPrompt(channelName) {
    return buildOpenclawSystemPrompt({
      agentName: this.agentName,
      workspaceId: this.workspaceId,
      channelName,
      endpoint: this.endpoint,
      token: this.token,
      mode: this._mode,
      disabledModules: this.disabledModules,
    });
  }

  async _handleMessage(msg) {
    let content = (msg.content || '').trim();
    const attachments = msg.attachments || [];

    const attText = formatAttachmentsForPrompt(attachments);
    if (attText) content = content ? content + attText : attText.trim();
    if (!content) return;

    const msgChannel = msg.sessionId || this.channelName;
    const sender = msg.senderName || msg.senderType || 'user';
    this._log(`Processing message from ${sender} in ${msgChannel}: ${content.slice(0, 80)}...`);

    await this._autoTitleChannel(msgChannel, content);
    await this.sendStatus(msgChannel, 'thinking...');

    try {
      if (!this._directMode) {
        await this.sendError(
          msgChannel,
          `${this._adapterLabel} direct API mode not configured. Set OPENAI_API_KEY + OPENAI_BASE_URL.`
        );
        return;
      }

      const responseText = await this._callCompletionApi(content, msgChannel);

      if (responseText) {
        this._conversationHistory.push({ role: 'user', content });
        this._conversationHistory.push({ role: 'assistant', content: responseText });
        if (this._conversationHistory.length > MAX_HISTORY * 2) {
          this._conversationHistory = this._conversationHistory.slice(-MAX_HISTORY * 2);
        }
        await this.sendResponse(msgChannel, responseText);
      } else {
        await this.sendResponse(msgChannel, 'No response generated. Please try again.');
      }
    } catch (e) {
      this._log(`Error handling message: ${e.message}`);
      await this.sendError(msgChannel, `Error processing message: ${e.message}`);
    }
  }

  /**
   * Call OpenAI-compatible chat completions API with SSE streaming.
   */
  _callCompletionApi(userMessage, channel) {
    const systemPrompt = this._buildSystemPrompt(channel);

    const messages = [{ role: 'system', content: systemPrompt }];
    messages.push(...this._conversationHistory);
    messages.push({ role: 'user', content: userMessage });

    const url = `${this._baseUrl}/chat/completions`;
    const headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this._apiKey}`,
    };
    const payload = JSON.stringify({
      model: this._resolveModel(channel) || this._model || 'gpt-4o',
      messages,
      stream: true,
    });

    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const transport = parsedUrl.protocol === 'https:' ? https : http;

      const req = transport.request(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) },
        timeout: 300000,
      }, (res) => {
        const cleanup = () => this._activeRequests.delete(req);
        if (res.statusCode !== 200) {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => {
            cleanup();
            reject(new Error(`LLM API returned ${res.statusCode}: ${body.slice(0, 300)}`));
          });
          return;
        }

        let fullText = '';
        let lineBuf = '';

        res.on('data', (chunk) => {
          lineBuf += chunk.toString('utf-8');
          const lines = lineBuf.split('\n');
          lineBuf = lines.pop(); // keep incomplete line

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data: ')) continue;

            const data = trimmed.slice(6);
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              const choices = parsed.choices || [];
              if (choices.length > 0) {
                const delta = choices[0].delta || {};
                if (delta.content) fullText += delta.content;
              }
            } catch {}
          }
        });

        res.on('end', () => {
          cleanup();
          resolve(fullText.trim());
        });
      });

      this._activeRequests.add(req);
      req.on('error', (err) => {
        this._activeRequests.delete(req);
        reject(err);
      });
      req.on('timeout', () => {
        req.destroy(new Error('LLM API request timed out'));
      });
      req.write(payload);
      req.end();
    });
  }
}

module.exports = LlmDirectAdapter;
