'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Scans system environment variables and local .env files
 * for known AI Agent API keys and credentials.
 */
class AuthDiscovery {
  constructor(configDir) {
    this.configDir = configDir || path.join(os.homedir(), '.wwj');
  }

  /**
   * Scan for all available API keys from system env and files.
   * Returns an object mapping key names to discovered values.
   */
  discover() {
    const discovered = {};

    // 1. Known environment variable keys to check
    const knownKeys = [
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'KIMI_API_KEY',
      'MOONSHOT_API_KEY',
      'DEEPSEEK_API_KEY',
      'OPENROUTER_API_KEY',
      'COPILOT_GITHUB_TOKEN',
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'CURSOR_API_KEY',
      'CLINE_API_KEY',
      'AMP_API_KEY',
      'LLM_API_KEY',
      'LLM_BASE_URL'
    ];

    // Check process.env first
    for (const key of knownKeys) {
      if (process.env[key] && process.env[key].trim()) {
        discovered[key] = process.env[key].trim();
      }
    }

    // 2. Scan home directory .env and current workspace .env files
    const envCandidatePaths = [
      path.join(os.homedir(), '.env'),
      path.join(os.homedir(), '.wwj', '.env'),
      path.join(process.cwd(), '.env'),
      path.join(process.cwd(), '.env.local')
    ];

    for (const envPath of envCandidatePaths) {
      try {
        if (fs.existsSync(envPath)) {
          const content = fs.readFileSync(envPath, 'utf-8');
          const lines = content.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
            const eqIdx = trimmed.indexOf('=');
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
            if (knownKeys.includes(key) && val && !discovered[key]) {
              discovered[key] = val;
            }
          }
        }
      } catch (err) {
        // Ignore unreadable env files
      }
    }

    return discovered;
  }

  /**
   * Automatically import discovered keys into agent-specific env files.
   * @param {EnvManager} envManager 
   */
  importToAgents(envManager) {
    const discovered = this.discover();
    const importedCount = { agentsUpdated: 0, keysFound: Object.keys(discovered).length };

    if (Object.keys(discovered).length === 0) {
      return importedCount;
    }

    // Mapping rules from discovered keys to agent types
    const agentMappings = {
      claude: { ANTHROPIC_API_KEY: discovered.ANTHROPIC_API_KEY || discovered.LLM_API_KEY },
      codex: { OPENAI_API_KEY: discovered.OPENAI_API_KEY || discovered.LLM_API_KEY, OPENAI_BASE_URL: discovered.LLM_BASE_URL },
      gemini: { GEMINI_API_KEY: discovered.GEMINI_API_KEY || discovered.GOOGLE_API_KEY || discovered.LLM_API_KEY },
      kimi: { KIMI_API_KEY: discovered.KIMI_API_KEY || discovered.MOONSHOT_API_KEY || discovered.LLM_API_KEY },
      cursor: { CURSOR_API_KEY: discovered.CURSOR_API_KEY || discovered.LLM_API_KEY },
      cline: { CLINE_API_KEY: discovered.CLINE_API_KEY || discovered.OPENAI_API_KEY || discovered.ANTHROPIC_API_KEY },
      copilot: { COPILOT_GITHUB_TOKEN: discovered.COPILOT_GITHUB_TOKEN || discovered.GH_TOKEN || discovered.GITHUB_TOKEN }
    };

    for (const [agentType, envVars] of Object.entries(agentMappings)) {
      const validVars = {};
      for (const [k, v] of Object.entries(envVars)) {
        if (v) validVars[k] = v;
      }
      if (Object.keys(validVars).length > 0) {
        envManager.save(agentType, validVars);
        importedCount.agentsUpdated++;
      }
    }

    return importedCount;
  }
}

module.exports = { AuthDiscovery };
