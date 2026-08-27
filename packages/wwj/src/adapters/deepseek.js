/**
 * DeepSeek adapter — DeepSeek OpenAI-compatible chat completions.
 *
 * Reuses LlmDirectAdapter's streaming chat-completions client:
 *  - reads DEEPSEEK_API_KEY (also accepts LLM_API_KEY / OPENAI_API_KEY)
 *  - reads DEEPSEEK_BASE_URL, defaulting to https://api.deepseek.com
 *  - reads DEEPSEEK_MODEL, defaulting to deepseek-chat
 *
 * Priority: UI-saved env > process env > default.
 */

'use strict';

const LlmDirectAdapter = require('./llm-direct');

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';

class DeepSeekAdapter extends LlmDirectAdapter {
  constructor(opts) {
    super({
      ...opts,
      adapterLabel: 'DeepSeek',
      modelEnvVar: 'DEEPSEEK_MODEL',
      suppressConfigLog: true,
    });

    const env = this.agentEnv || process.env;

    const apiKey =
      env.DEEPSEEK_API_KEY ||
      env.LLM_API_KEY ||
      env.OPENAI_API_KEY ||
      '';

    const baseUrl = (
      env.DEEPSEEK_BASE_URL ||
      env.LLM_BASE_URL ||
      DEFAULT_BASE_URL
    ).replace(/\/$/, '');

    // DEFAULT_MODEL is this vendor's documented default, used so a run can still
    // go out - but it is NOT the user's configuration, and the flag below keeps
    // the workspace from reporting it as though it were.
    const configuredModel =
      env.DEEPSEEK_MODEL ||
      env.LLM_MODEL ||
      '';
    const model = configuredModel || DEFAULT_MODEL;

    this._apiKey = apiKey;
    this._baseUrl = baseUrl;
    this._model = model;
    this._modelIsVendorDefault = !configuredModel;
    this.model = model;
    this._directMode = !!(this._apiKey && this._baseUrl);

    if (this._directMode) {
      this._log(`DeepSeek mode: ${this._baseUrl} model=${this._model}`);
    } else {
      this._log(
        'DeepSeek adapter started without API key. ' +
        'Set DEEPSEEK_API_KEY via the Launcher Configure screen.'
      );
    }
  }
}

module.exports = DeepSeekAdapter;
