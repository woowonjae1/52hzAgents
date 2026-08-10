"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
const electron = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const promises = require("stream/promises");
const child_process = require("child_process");
const https = require("https");
const events = require("events");
const http = require("http");
const electronUpdater = require("electron-updater");
class Store {
  constructor(defaults = {}) {
    this._data = {};
    this._pathResolved = false;
    this._path = null;
    this._data = { ...defaults };
  }
  _ensurePath() {
    if (!this._pathResolved) {
      this._path = path.join(electron.app.getPath("userData"), "settings.json");
      this._pathResolved = true;
      this._load();
    }
  }
  _load() {
    try {
      if (this._path && fs.existsSync(this._path)) {
        const raw = fs.readFileSync(this._path, "utf-8");
        this._data = { ...this._data, ...JSON.parse(raw) };
      }
    } catch {
    }
  }
  _save() {
    this._ensurePath();
    try {
      const dir = path.dirname(this._path);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._path, JSON.stringify(this._data, null, 2), "utf-8");
    } catch (err) {
      console.error("Failed to save settings:", err);
    }
  }
  get(key) {
    this._ensurePath();
    if (key === void 0) return { ...this._data };
    return this._data[key];
  }
  set(key, value) {
    if (typeof key === "object") {
      Object.assign(this._data, key);
    } else {
      this._data[key] = value;
    }
    this._save();
  }
  delete(key) {
    delete this._data[key];
    this._save();
  }
  has(key) {
    return key in this._data;
  }
}
function readPathEnv() {
  for (const k of Object.keys(process.env)) {
    if (k.toLowerCase() === "path") return process.env[k] || "";
  }
  return "";
}
function writePathEnv(value) {
  let touched = false;
  for (const k of Object.keys(process.env)) {
    if (k.toLowerCase() === "path") {
      process.env[k] = value;
      touched = true;
    }
  }
  if (!touched) {
    process.env[process.platform === "win32" ? "Path" : "PATH"] = value;
  }
}
function withPathEnv(value, base) {
  const src = base ?? process.env;
  const out = {};
  for (const k of Object.keys(src)) {
    if (k.toLowerCase() === "path") continue;
    out[k] = src[k];
  }
  out[process.platform === "win32" ? "Path" : "PATH"] = value;
  return out;
}
const OFFICIAL_NODE = "https://nodejs.org/dist";
const MIRROR_NODE = "https://cdn.npmmirror.com/binaries/node";
const OFFICIAL_NPM = "https://registry.npmjs.org";
const MIRROR_NPM = "https://registry.npmmirror.com";
let _override = "auto";
function setRegionPreference(pref) {
  if (pref === "global" || pref === "cn" || pref === "auto") _override = pref;
}
let _cachedCN = null;
function detectChina() {
  if (_cachedCN !== null) return _cachedCN;
  let cn = false;
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    if (/Shanghai|Chongqing|Chungking|Urumqi|Harbin|Kashgar|PRC/i.test(tz))
      cn = true;
  } catch {
  }
  try {
    const loc = (electron.app?.getLocale?.() || "").toLowerCase();
    if (loc === "zh" || loc.startsWith("zh-cn") || loc.startsWith("zh-hans"))
      cn = true;
  } catch {
  }
  _cachedCN = cn;
  return cn;
}
function useChinaMirror() {
  if (_override === "cn") return true;
  if (_override === "global") return false;
  return detectChina();
}
function nodeDistUrls(relPath) {
  const official = `${OFFICIAL_NODE}/${relPath}`;
  if (useChinaMirror()) return [`${MIRROR_NODE}/${relPath}`, official];
  return [official];
}
function npmUrls(relPath) {
  const official = `${OFFICIAL_NPM}/${relPath}`;
  if (useChinaMirror()) return [`${MIRROR_NPM}/${relPath}`, official];
  return [official];
}
function npmRegistryBase() {
  return useChinaMirror() ? MIRROR_NPM : OFFICIAL_NPM;
}
const BUNDLED_REGISTRY = [
  {
    name: "aider",
    label: "Aider",
    description: "AI pair programming in your terminal",
    homepage: "https://aider.chat",
    tags: [
      "coding",
      "pair-programming",
      "open-source"
    ],
    builtin: true,
    support: {
      install: true,
      workspace: true,
      collaboration: true
    },
    install: {
      binary: "aider",
      macos: "curl -LsSf https://aider.chat/install.sh | sh",
      linux: "curl -LsSf https://aider.chat/install.sh | sh",
      windows: "irm https://aider.chat/install.ps1 | iex"
    },
    adapter: {
      module: "openagents.adapters.aider",
      "class": "AiderAdapter"
    },
    launch: {
      args: []
    },
    env_config: [
      {
        name: "AIDER_PROVIDER",
        description: "Which provider the API key belongs to. One of: auto, openai, anthropic, openrouter, gemini, deepseek, openai-compatible. `auto` infers from the model name; set it explicitly when the model name doesn't identify the provider.",
        required: false,
        "default": "auto",
        placeholder: "auto"
      },
      {
        name: "AIDER_MODEL",
        description: "Model to use, e.g. sonnet, gpt-4o, claude-3-5-sonnet-20241022, openrouter/anthropic/claude-3.5-sonnet, gemini/gemini-1.5-pro, deepseek/deepseek-chat. May be left blank to let Aider auto-select — but if you set LLM_API_KEY, the provider must be determinable (via AIDER_PROVIDER or the model name).",
        required: false,
        placeholder: "gpt-4o"
      },
      {
        name: "LLM_API_KEY",
        description: "API key for the selected provider. Injected into the provider env var chosen by AIDER_PROVIDER/model. Leave blank to reuse a provider key already in your shell or the project's .env / .aider.conf.yml.",
        required: false,
        password: true
      },
      {
        name: "LLM_BASE_URL",
        description: "Endpoint URL — ONLY for AIDER_PROVIDER=openai-compatible (self-hosted / relay / local). Becomes OPENAI_API_BASE; leave blank for hosted providers.",
        required: false,
        placeholder: "https://my-endpoint.example/v1"
      }
    ],
    check_ready: {
      env_vars: [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENROUTER_API_KEY",
        "GEMINI_API_KEY",
        "DEEPSEEK_API_KEY"
      ],
      saved_env_key: "LLM_API_KEY",
      not_ready_message: "No model API key — set a model + LLM_API_KEY (or a provider key such as OPENAI_API_KEY) — press e to configure"
    }
  },
  {
    name: "amp",
    label: "Amp (Sourcegraph)",
    description: "Sourcegraph's AI coding agent for CLI and VS Code",
    homepage: "https://ampcode.com",
    tags: [
      "coding",
      "sourcegraph",
      "cli",
      "vscode"
    ],
    builtin: true,
    support: {
      install: true,
      workspace: true,
      collaboration: true
    },
    install: {
      binary: "amp",
      macos: "curl -fsSL https://ampcode.com/install.sh | bash",
      linux: "curl -fsSL https://ampcode.com/install.sh | bash",
      windows: "irm https://ampcode.com/install.ps1 | iex"
    },
    adapter: {
      module: "openagents.adapters.amp",
      "class": "AmpAdapter"
    },
    launch: {
      args: []
    },
    env_config: [
      {
        name: "AMP_API_KEY",
        description: "Amp API key (create one at https://ampcode.com/settings) — leave blank if you have run `amp login`",
        required: false,
        password: true
      },
      {
        name: "AMP_URL",
        description: "Amp server URL for enterprise/self-hosted deployments (leave blank for the default)",
        required: false
      }
    ],
    check_ready: {
      login_command: "amp login",
      not_ready_message: "Amp is installed but not signed in — run: amp login or set AMP_API_KEY"
    }
  },
  {
    name: "claude",
    label: "Claude Code CLI",
    description: "Anthropic's official CLI agent for Claude",
    homepage: "https://claude.ai/claude-code",
    tags: [
      "coding",
      "cli",
      "anthropic"
    ],
    featured: true,
    order: 1,
    support: {
      install: true,
      workspace: true,
      collaboration: true
    },
    builtin: true,
    install: {
      binary: "claude",
      requires: [
        "nodejs",
        "git"
      ],
      macos: "npm install -g @anthropic-ai/claude-code",
      linux: "npm install -g @anthropic-ai/claude-code",
      windows: "npm install -g @anthropic-ai/claude-code"
    },
    adapter: {
      module: "openagents.adapters.claude",
      "class": "ClaudeAdapter"
    },
    launch: {
      args: [
        "--append-system-prompt",
        "Your agent name is '{agent_name}'."
      ]
    },
    check_ready: {
      env_vars: [
        "ANTHROPIC_API_KEY"
      ],
      creds_file: "~/.claude/sessions",
      creds_key: null,
      keychain_service: "Claude Code-credentials",
      not_ready_message: "Not logged in. Run: claude login",
      login_command: "claude login",
      alt_check: "claude --print hi"
    },
    env_config: []
  },
  {
    name: "cline",
    label: "Cline",
    description: "Autonomous coding agent CLI by Cline Bot",
    homepage: "https://github.com/cline/cline",
    tags: [
      "coding",
      "cli",
      "autonomous"
    ],
    builtin: true,
    support: {
      install: true,
      workspace: true,
      collaboration: false
    },
    install: {
      binary: "cline",
      requires: [
        "nodejs"
      ],
      verify: "cline --version",
      verify_win: "cline --version",
      macos: "npm install -g cline",
      linux: "npm install -g cline",
      windows: "npm install -g cline"
    },
    adapter: {
      module: "openagents.adapters.cline",
      "class": "ClineAdapter"
    },
    launch: {
      args: []
    },
    env_config: [
      {
        name: "CLINE_API_KEY",
        description: "API key for the selected provider (passed to Cline with -k). Leave blank to use `cline auth` (account or provider sign-in).",
        required: false,
        password: true
      },
      {
        name: "CLINE_PROVIDER",
        description: "Cline provider id (e.g. cline, anthropic, openai, openrouter). Leave blank to use Cline's configured default.",
        required: false,
        placeholder: "openrouter"
      },
      {
        name: "CLINE_MODEL",
        description: "Model id for the selected provider.",
        required: false,
        placeholder: "anthropic/claude-sonnet-4.6"
      }
    ],
    check_ready: {
      min_version: "3.0.0",
      env_vars: [
        "CLINE_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "OPENROUTER_API_KEY"
      ],
      saved_env_key: "CLINE_API_KEY",
      login_command: "cline auth",
      not_ready_message: "Not configured — set an API key (press e) or run: cline auth"
    }
  },
  {
    name: "codex",
    label: "OpenAI Codex CLI",
    description: "OpenAI's coding agent for the terminal",
    homepage: "https://github.com/openai/codex",
    tags: [
      "coding",
      "openai",
      "cli"
    ],
    featured: true,
    order: 3,
    support: {
      install: true,
      workspace: true,
      collaboration: true
    },
    builtin: true,
    install: {
      binary: "codex",
      requires: [
        "nodejs"
      ],
      macos: "npm install -g @openai/codex",
      linux: "npm install -g @openai/codex",
      windows: "npm install -g @openai/codex"
    },
    adapter: {
      module: "openagents.adapters.codex",
      "class": "CodexAdapter"
    },
    launch: {
      args: [
        null
      ]
    },
    env_config: [
      {
        name: "OPENAI_API_KEY",
        description: "OpenAI API key (optional if using Codex subscription via 'codex login')",
        required: false,
        password: true
      },
      {
        name: "OPENAI_BASE_URL",
        description: "OpenAI-compatible base URL (optional if using Codex subscription)",
        required: false
      }
    ],
    check_ready: {
      env_all: [
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL"
      ],
      saved_env_all: [
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL"
      ],
      status_command: "codex login status",
      login_command: "codex login",
      unverifiable: true,
      not_ready_message: "Not configured. Set OPENAI_API_KEY + OPENAI_BASE_URL, or run: codex login"
    },
    resolve_env: {
      rules: [
        {
          from: "LLM_API_KEY",
          to: "OPENAI_API_KEY"
        },
        {
          from: "LLM_BASE_URL",
          to: "OPENAI_BASE_URL"
        },
        {
          from: "LLM_MODEL",
          to: "CODEX_MODEL"
        }
      ]
    }
  },
  {
    name: "copilot",
    label: "GitHub Copilot CLI",
    description: "GitHub's official Copilot coding agent for the terminal (the `copilot` CLI, not the retired `gh copilot` extension)",
    homepage: "https://github.com/github/copilot-cli",
    tags: [
      "coding",
      "github",
      "cli"
    ],
    order: 9,
    support: {
      install: true,
      workspace: true,
      collaboration: false
    },
    builtin: true,
    install: {
      binary: "copilot",
      npm_package: "@github/copilot",
      requires: [
        "nodejs"
      ],
      min_version: "1.0.0",
      verify: "copilot --version >/dev/null 2>&1",
      verify_win: "copilot --version >nul 2>nul",
      macos: "npm install -g @github/copilot",
      linux: "npm install -g @github/copilot",
      windows: "npm install -g @github/copilot"
    },
    adapter: {
      module: "openagents.adapters.copilot",
      "class": "CopilotAdapter"
    },
    launch: {
      args: []
    },
    env_config: [
      {
        name: "COPILOT_GITHUB_TOKEN",
        description: "GitHub token with Copilot access (optional — you can also sign in by running `copilot`, or rely on GH_TOKEN / GITHUB_TOKEN / gh auth)",
        required: false,
        password: true
      },
      {
        name: "COPILOT_MODEL",
        description: "Model to use (optional; leave blank for the account default)",
        required: false
      }
    ],
    check_ready: {
      env_vars: [
        "COPILOT_GITHUB_TOKEN",
        "GH_TOKEN",
        "GITHUB_TOKEN"
      ],
      saved_env_key: "COPILOT_GITHUB_TOKEN",
      login_command: "copilot",
      unverifiable: true,
      not_ready_message: "Sign-in not confirmed. A token env var (COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN) is one option; you may already be signed in via `copilot` /login or `gh auth`. Auth is confirmed when you run a task."
    }
  },
  {
    name: "cursor",
    label: "Cursor",
    description: "AI-powered code editor with agent mode CLI",
    homepage: "https://cursor.com",
    tags: [
      "coding",
      "editor",
      "cli",
      "ai"
    ],
    featured: true,
    order: 4,
    builtin: true,
    install: {
      binary: "cursor-agent",
      binary_aliases: [
        "agent"
      ],
      verify: "cursor-agent --version 2>/dev/null | head -1",
      verify_win: "cursor-agent --version 2>nul",
      requires: [],
      macos: "curl https://cursor.com/install -fsSL | bash",
      linux: "curl https://cursor.com/install -fsSL | bash",
      windows: `"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "Invoke-RestMethod -UseBasicParsing 'https://cursor.com/install?win32=true' | Invoke-Expression"`
    },
    adapter: {
      module: "openagents.adapters.cursor",
      "class": "CursorAdapter"
    },
    launch: {
      args: []
    },
    env_config: [
      {
        name: "CURSOR_API_KEY",
        description: "Cursor API key for CLI authentication",
        required: false,
        password: true
      },
      {
        name: "CURSOR_MODEL",
        description: "Model to use (e.g. claude-sonnet-4-6, gpt-4o)",
        required: false
      }
    ],
    check_ready: {
      binary: "agent",
      not_ready_message: "Cursor CLI not found — install with: curl https://cursor.com/install -fsSL | bash"
    },
    resolve_env: {
      rules: [
        {
          from: "LLM_API_KEY",
          to: "CURSOR_API_KEY"
        },
        {
          from: "LLM_MODEL",
          to: "CURSOR_MODEL"
        }
      ]
    }
  },
  {
    name: "gemini",
    label: "Gemini CLI",
    description: "Google's open-source AI agent for the command line",
    homepage: "https://github.com/google-gemini/gemini-cli",
    tags: [
      "coding",
      "google",
      "open-source",
      "cli"
    ],
    builtin: true,
    support: {
      install: true,
      workspace: true,
      collaboration: true
    },
    install: {
      binary: "gemini",
      requires: [
        "nodejs"
      ],
      macos: "npm install -g @google/gemini-cli",
      linux: "npm install -g @google/gemini-cli",
      windows: "npm install -g @google/gemini-cli"
    },
    adapter: {
      module: "openagents.adapters.gemini",
      "class": "GeminiAdapter"
    },
    launch: {
      args: [
        "-p",
        "Your agent name is '{agent_name}'.",
        "-y",
        "-o",
        "stream-json"
      ]
    },
    check_ready: {
      creds_file: "~/.gemini/oauth_creds.json",
      creds_no_parse: true,
      creds_path_env: [
        "GOOGLE_APPLICATION_CREDENTIALS"
      ],
      env_vars: [
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY"
      ],
      saved_env_key: "GEMINI_API_KEY",
      login_command: "gemini",
      not_ready_message: "Needs sign-in — run `gemini` to sign in, or set GEMINI_API_KEY.",
      unreadable_message: "Gemini credentials were found but could not be read. Check permissions on ~/.gemini, or run `gemini` to sign in again.",
      auth_detected_labels: {
        cli_login: "Google account sign-in detected",
        api_key: "API key detected"
      }
    },
    env_config: []
  },
  {
    name: "goose",
    label: "Goose",
    description: "An open-source AI developer agent by Block (CLI — Beta)",
    homepage: "https://github.com/block/goose",
    tags: [
      "coding",
      "developer",
      "open-source",
      "cli"
    ],
    order: 9,
    support: {
      install: true,
      workspace: true,
      collaboration: true
    },
    builtin: true,
    install: {
      binary: "goose",
      macos: "curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash",
      linux: "curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash",
      windows: `powershell -c "$env:CONFIGURE='false'; irm https://raw.githubusercontent.com/block/goose/main/download_cli.ps1 | iex"`
    },
    adapter: {
      module: "openagents.adapters.goose",
      "class": "GooseAdapter"
    },
    launch: {
      args: []
    },
    env_config: [
      {
        name: "GOOSE_PROVIDER",
        description: "Goose provider id (e.g. openai, anthropic, google, openrouter, ollama). Leave blank to reuse your existing Goose config.",
        required: false
      },
      {
        name: "GOOSE_MODEL",
        description: "Model name for the selected provider (e.g. gpt-4o, claude-sonnet-4-6). Leave blank to reuse your existing Goose config.",
        required: false
      },
      {
        name: "GOOSE_PROVIDER__API_KEY",
        description: "Provider API key (generic Goose provider key). Leave blank to reuse the Goose keyring/config, an OAuth provider, or a local provider.",
        required: false,
        password: true
      },
      {
        name: "GOOSE_PROVIDER__HOST",
        description: "Custom provider endpoint/host URL (optional — for proxies or self-hosted/OpenAI-compatible endpoints).",
        required: false
      },
      {
        name: "GOOSE_MODE",
        description: "Headless tool-permission mode. 'auto' runs tools without approval (required for the workspace); 'chat' disables tools. Approval modes are coerced to 'auto'.",
        required: false,
        "default": "auto"
      }
    ],
    check_ready: {
      require_binary: true,
      not_ready_message: "Goose CLI not found. Install it: openagents install goose — then set a provider/model (or run `goose configure` once)."
    }
  },
  {
    name: "nanoclaw",
    label: "NanoClaw",
    description: "Containerized agent runtime — each Agent Group runs in its own Docker container (Claude Agent SDK). Bridged to the Workspace via a native OpenAgents channel.",
    homepage: "https://github.com/nanocoai/nanoclaw",
    tags: [
      "coding",
      "container",
      "docker",
      "runtime",
      "open-source"
    ],
    builtin: true,
    support: {
      install: true,
      workspace: true,
      collaboration: false
    },
    install: {
      binary: "ncl",
      requires: [
        "nodejs",
        "docker",
        "git"
      ],
      macos: "echo 'NanoClaw is an external containerized runtime. Set it up from https://github.com/nanocoai/nanoclaw (clone, pnpm install, ./nanoclaw.sh setup), symlink bin/ncl onto your PATH, then install the OpenAgents channel: see docs/nanoclaw.md (/add-openagents).'",
      linux: "echo 'NanoClaw is an external containerized runtime. Set it up from https://github.com/nanocoai/nanoclaw (clone, pnpm install, ./nanoclaw.sh setup), symlink bin/ncl onto your PATH, then install the OpenAgents channel: see docs/nanoclaw.md (/add-openagents).'",
      windows: "echo 'NanoClaw requires Docker Desktop + WSL2 on Windows. Set it up inside WSL2 from https://github.com/nanocoai/nanoclaw, symlink bin/ncl onto your PATH, then install the OpenAgents channel: see docs/nanoclaw.md (/add-openagents).'"
    },
    launch: {
      args: [
        null
      ]
    },
    env_config: [
      {
        name: "NANOCLAW_HOME",
        description: "Path to your NanoClaw checkout (optional if `ncl` is on PATH)",
        required: false,
        password: false
      },
      {
        name: "NANOCLAW_AGENT_GROUP",
        description: "NanoClaw Agent Group id or name to bridge to this agent",
        required: true,
        password: false
      }
    ],
    check_ready: {
      env_vars: [
        "NANOCLAW_AGENT_GROUP"
      ],
      saved_env_key: "NANOCLAW_AGENT_GROUP",
      not_ready_message: "Set NANOCLAW_AGENT_GROUP (and NANOCLAW_HOME) — press e to configure"
    }
  },
  {
    name: "openclaw",
    label: "OpenClaw",
    description: "Open-source coding agent with multi-model support",
    homepage: "https://github.com/openagents/openclaw",
    tags: [
      "coding",
      "open-source"
    ],
    featured: true,
    order: 2,
    support: {
      install: true,
      workspace: true,
      collaboration: true
    },
    builtin: true,
    install: {
      binary: "openclaw",
      requires: [
        "nodejs>=22",
        "git"
      ],
      macos: "npm install -g openclaw@latest",
      linux: "npm install -g openclaw@latest",
      windows: "npm install -g openclaw@latest"
    },
    adapter: {
      module: "openagents.adapters.openclaw",
      "class": "OpenClawAdapter",
      options: {
        openclaw_host: "127.0.0.1",
        openclaw_port: 18789,
        openclaw_agent_id: "main"
      }
    },
    env_config: [
      {
        name: "LLM_API_KEY",
        description: "API key",
        required: true,
        password: true
      },
      {
        name: "LLM_BASE_URL",
        description: "API base URL (OpenAI-compatible endpoint)",
        required: false,
        "default": "https://api.openai.com/v1",
        placeholder: "https://api.openai.com/v1"
      },
      {
        name: "LLM_MODEL",
        description: "Model name",
        required: false,
        placeholder: "gpt-4o, claude-sonnet-4-20250514, deepseek-chat, etc."
      }
    ],
    resolve_env: {
      rules: [
        {
          from: "LLM_API_KEY",
          to: "OPENAI_API_KEY",
          unless_base_url_contains: "anthropic"
        },
        {
          from: "LLM_API_KEY",
          to: "ANTHROPIC_API_KEY",
          if_base_url_contains: "anthropic"
        },
        {
          from: "LLM_BASE_URL",
          to: "OPENAI_BASE_URL"
        },
        {
          from: "LLM_MODEL",
          to: "OPENCLAW_MODEL"
        }
      ]
    },
    check_ready: {
      env_vars: [
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY"
      ],
      saved_env_key: "LLM_API_KEY",
      not_ready_message: "Not configured — press e to configure"
    }
  },
  {
    name: "opencode",
    label: "OpenCode",
    description: "Open-source terminal-native AI coding agent",
    homepage: "https://opencode.ai",
    tags: [
      "coding",
      "open-source",
      "cli",
      "terminal"
    ],
    featured: true,
    order: 5,
    builtin: true,
    install: {
      binary: "opencode",
      requires: [
        "nodejs"
      ],
      macos: "npm install -g opencode-ai@1.17.11",
      linux: "npm install -g opencode-ai@1.17.11",
      windows: "npm install -g opencode-ai@1.17.11"
    },
    adapter: {
      module: "openagents.adapters.opencode",
      "class": "OpenCodeAdapter"
    },
    env_config: [
      {
        name: "LLM_API_KEY",
        description: "API key",
        required: true,
        password: true
      },
      {
        name: "LLM_BASE_URL",
        description: "API base URL (OpenAI-compatible endpoint)",
        required: false,
        "default": "https://api.openai.com/v1",
        placeholder: "https://api.openai.com/v1"
      },
      {
        name: "LLM_MODEL",
        description: "Model name (required — OpenCode hangs without one)",
        required: true,
        placeholder: "gpt-4o, claude-sonnet-4-20250514, etc."
      }
    ],
    resolve_env: {
      rules: [
        {
          from: "LLM_API_KEY",
          to: "OPENAI_API_KEY"
        },
        {
          from: "LLM_BASE_URL",
          to: "OPENAI_BASE_URL"
        },
        {
          from: "LLM_MODEL",
          to: "OPENCODE_MODEL"
        }
      ]
    },
    check_ready: {
      env_vars: [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY"
      ],
      saved_env_key: "LLM_API_KEY",
      min_version: "1.17.0",
      not_ready_message: "Not configured — press e to configure"
    }
  },
  {
    name: "kimi",
    label: "Kimi",
    description: "Kimi agent powered by Moonshot AI, OpenAI-compatible API.",
    homepage: "https://platform.moonshot.ai",
    tags: [
      "coding",
      "moonshot",
      "open-source"
    ],
    featured: true,
    order: 7,
    support: {
      install: true,
      workspace: true,
      collaboration: true
    },
    builtin: true,
    install: {
      binary: "kimi",
      api_only: true,
      macos: "echo 'Kimi uses direct API mode — no binary install needed'",
      linux: "echo 'Kimi uses direct API mode — no binary install needed'",
      windows: "echo 'Kimi uses direct API mode — no binary install needed'"
    },
    adapter: {
      module: "openagents.adapters.kimi",
      "class": "KimiAdapter"
    },
    launch: {
      args: []
    },
    env_config: [
      {
        name: "KIMI_API_KEY",
        description: "Moonshot/Kimi API key (also accepts MOONSHOT_API_KEY env var)",
        required: true,
        password: true
      },
      {
        name: "KIMI_BASE_URL",
        description: "Kimi API base URL (OpenAI-compatible endpoint)",
        required: false,
        "default": "https://api.moonshot.ai/v1",
        placeholder: "https://api.moonshot.ai/v1"
      },
      {
        name: "KIMI_MODEL",
        description: "Kimi model name",
        required: false,
        "default": "kimi-k2.6",
        placeholder: "kimi-k2.6"
      }
    ],
    check_ready: {
      env_vars: [
        "KIMI_API_KEY",
        "MOONSHOT_API_KEY"
      ],
      saved_env_key: "KIMI_API_KEY",
      not_ready_message: "No API key — press e to configure"
    }
  },
  {
    name: "hermes",
    label: "Hermes Agent",
    description: "Nous Hermes Agent — self-improving AI with tools, profiles, memory, and messaging",
    homepage: "https://github.com/NousResearch/hermes-agent",
    tags: [
      "coding",
      "tools",
      "orchestration",
      "profiles"
    ],
    featured: true,
    order: 6,
    support: {
      install: true,
      workspace: true,
      collaboration: true
    },
    builtin: true,
    install: {
      binary: "hermes",
      requires: [
        "python3"
      ],
      macos: "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup",
      linux: "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash -s -- --skip-setup",
      windows: `"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "Invoke-RestMethod -UseBasicParsing 'https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.ps1' | Invoke-Expression"`
    },
    launch: {
      args: []
    },
    check_ready: {
      creds_file: "~/.hermes/config.yaml",
      status_command: "hermes status",
      login_command: "hermes setup",
      not_ready_message: "Hermes not configured — run: hermes setup"
    }
  },
  {
    name: "pi",
    label: "Pi Agent",
    description: "Mathematical and reasoning agent tailored for algorithmic tasks.",
    homepage: "https://openagents.org",
    tags: [
      "coding",
      "reasoning",
      "cli"
    ],
    builtin: true,
    support: {
      install: true,
      workspace: true,
      collaboration: true
    },
    install: {
      binary: "pi",
      api_only: true
    },
    adapter: {
      module: "openagents.adapters.openclaw",
      "class": "OpenClawAdapter"
    },
    launch: {
      args: []
    }
  },
  {
    name: "custom",
    label: "Custom Agent",
    description: "Custom agent process connected via stdin/stdout or WebSocket framing.",
    homepage: "https://openagents.org",
    tags: [
      "custom"
    ],
    builtin: true,
    support: {
      install: true,
      workspace: true,
      collaboration: true
    },
    install: {
      binary: "custom",
      api_only: true
    },
    adapter: {
      module: "openagents.adapters.openclaw",
      "class": "OpenClawAdapter"
    },
    launch: {
      args: []
    }
  }
];
const CONFIG_DIR = path.join(os.homedir(), ".openagents");
const GLOBAL_CORE = path.join(
  CONFIG_DIR,
  "nodejs",
  "node_modules",
  "@openagents-org",
  "agent-launcher"
);
const LOCAL_CORE$1 = path.resolve(__dirname, "../../../wwj");
const INSTALLED_HISTORY_FILE = path.join(
  CONFIG_DIR,
  "installed_agents_history.json"
);
const DAEMON_PID_FILE = path.join(CONFIG_DIR, "daemon.pid");
const DAEMON_STATUS_FILE = path.join(CONFIG_DIR, "daemon.status.json");
const DAEMON_CMD_FILE = path.join(CONFIG_DIR, "daemon.cmd");
const DAEMON_LOG_FILE = path.join(CONFIG_DIR, "daemon.log");
const LAUNCHER_SESSIONS_DIR = path.join(CONFIG_DIR, "launcher-sessions");
const DEFAULT_CHAT_CHANNEL = "main";
const CHAT_POLL_INTERVAL_MS = 2500;
const LAUNCHER_AUTH_OVERRIDES = {
  claude: [
    {
      name: "ANTHROPIC_API_KEY",
      description: "Anthropic API key",
      required: true,
      password: true
    },
    {
      name: "ANTHROPIC_BASE_URL",
      description: "Anthropic-compatible base URL (the default works for direct Anthropic API; change it for a proxy or relay)",
      required: true,
      default: "https://api.anthropic.com",
      placeholder: "https://api.anthropic.com"
    },
    {
      name: "ANTHROPIC_MODEL",
      description: "Model name (change it when using a relay/proxy — its channels rarely match the default)",
      required: true,
      default: "claude-sonnet-4-6",
      placeholder: "claude-sonnet-4-6"
    }
  ],
  // Gemini authenticates EITHER via its CLI's Google sign-in (the default
  // `gemini` OAuth login, detected by the core's check_ready) OR via an API key.
  // The key is therefore an OPTIONAL alternative — none of these fields are
  // `required`, so a user who signs in with Google is never forced to enter a
  // key. See KEY_OPTIONAL_LOGIN_AGENTS, which keeps the registry login_command
  // flowing into onboarding/Configure so both paths are offered.
  gemini: [
    {
      name: "GEMINI_API_KEY",
      description: "Google AI Studio API key — get one at https://aistudio.google.com/apikey (optional if you sign in with Google)",
      required: false,
      password: true
    },
    {
      name: "GOOGLE_GEMINI_BASE_URL",
      description: "Gemini-compatible base URL (the default works for Google AI Studio; change it for a proxy or custom gateway)",
      required: false,
      default: "https://generativelanguage.googleapis.com",
      placeholder: "https://generativelanguage.googleapis.com"
    },
    {
      name: "GEMINI_MODEL",
      description: "Model name (change it when using a relay/proxy — its channels rarely match the default)",
      required: false,
      default: "gemini-2.5-pro",
      placeholder: "gemini-2.5-pro"
    }
  ],
  codex: [
    {
      name: "OPENAI_API_KEY",
      description: "OpenAI API key",
      required: true,
      password: true
    },
    {
      name: "OPENAI_BASE_URL",
      description: "OpenAI-compatible base URL (the default works for the OpenAI API; change it for a proxy or relay)",
      required: true,
      default: "https://api.openai.com/v1",
      placeholder: "https://api.openai.com/v1"
    },
    {
      name: "CODEX_MODEL",
      description: "Model name (change it when using a relay/proxy — its channels rarely match the default)",
      required: true,
      default: "gpt-5-codex",
      placeholder: "gpt-5-codex"
    }
  ],
  kimi: [
    {
      name: "KIMI_API_KEY",
      description: "Moonshot / Kimi API key (also accepts MOONSHOT_API_KEY)",
      required: true,
      password: true
    },
    {
      name: "KIMI_BASE_URL",
      description: "Kimi API base URL (OpenAI-compatible endpoint)",
      required: true,
      default: "https://api.moonshot.ai/v1",
      placeholder: "https://api.moonshot.ai/v1"
    },
    {
      name: "KIMI_MODEL",
      description: "Kimi model name",
      required: true,
      default: "kimi-k2.6",
      placeholder: "kimi-k2.6"
    }
  ],
  openclaw: [
    {
      name: "LLM_API_KEY",
      description: "API key",
      required: true,
      password: true
    },
    {
      name: "LLM_BASE_URL",
      description: "API base URL (OpenAI-compatible endpoint)",
      required: true,
      default: "https://api.openai.com/v1",
      placeholder: "https://api.openai.com/v1"
    },
    {
      name: "LLM_MODEL",
      description: "Model name",
      required: true,
      default: "gpt-4o",
      placeholder: "gpt-4o, claude-sonnet-4-6, deepseek-chat, etc."
    }
  ],
  opencode: [
    {
      name: "LLM_API_KEY",
      description: "API key",
      required: true,
      password: true
    },
    {
      name: "LLM_BASE_URL",
      description: "API base URL (OpenAI-compatible endpoint)",
      required: true,
      default: "https://api.openai.com/v1",
      placeholder: "https://api.openai.com/v1"
    },
    {
      name: "LLM_MODEL",
      description: "Model name",
      required: true,
      default: "gpt-4o",
      placeholder: "gpt-4o, claude-sonnet-4-6, etc."
    }
  ],
  // Cline supports many providers (its own account, Anthropic, OpenAI,
  // OpenRouter, …). The launcher collects an optional per-run API key plus the
  // provider/model selection (mapped by the adapter to Cline's -k/-P/-m). All
  // fields are optional: a user can instead run `cline auth` to sign in and the
  // agent will use Cline's stored credentials.
  cline: [
    {
      name: "CLINE_API_KEY",
      description: "API key for the selected provider — or leave blank and run `cline auth` to sign in.",
      required: false,
      password: true
    },
    {
      name: "CLINE_PROVIDER",
      description: "Provider id (cline, anthropic, openai, openrouter, …). Leave blank for Cline's configured default.",
      required: false,
      placeholder: "openrouter"
    },
    {
      name: "CLINE_MODEL",
      description: "Model id for the selected provider.",
      required: false,
      placeholder: "anthropic/claude-sonnet-4.6"
    }
  ]
};
const READY_REASON = {
  READY: "ready",
  NOT_INSTALLED: "not_installed",
  LOGIN_REQUIRED: "login_required"
};
const HOSTED_LOGIN_AGENTS = {
  cursor: {
    loginCommand: "cursor-agent login",
    statusArgs: ["status"],
    loggedOutPattern: /not logged in|logged out|signed out/i,
    apiKeyEnv: "CURSOR_API_KEY",
    loginClearsEnv: ["CURSOR_API_KEY", "CURSOR_MODEL"]
  },
  hermes: {
    // `hermes setup` is the interactive wizard; `hermes status` prints a rich
    // report where a configured auth provider reads "✓ logged in" (everything
    // unconfigured reads "✗ not logged in"), so match the positive marker.
    loginCommand: "hermes setup",
    statusArgs: ["status"],
    loggedInPattern: /✓\s*logged in/i
  }
};
const AMP_LOGGED_OUT = /invalid or missing api key|run ['"]?amp login/i;
const DUAL_LOGIN_AGENTS = {
  claude: {
    // `claude auth login` opens the browser sign-in; `claude auth status`
    // prints `{ "loggedIn": true, ... }` (exit 0) when authenticated.
    loginCommand: "claude auth login",
    statusArgs: ["auth", "status"],
    loggedInPattern: /"loggedIn"\s*:\s*true/i
  },
  codex: {
    // Codex authenticates the same way: `codex login` signs in with a ChatGPT
    // account (a Plus/Pro/Team plan works with NO OpenAI API key — the auth is
    // stored in ~/.codex/auth.json), and `codex login status` reports it.
    // Treating codex as key-only forced an OPENAI_API_KEY on users who actually
    // sign in via ChatGPT, and the adapter then injected that key into the CLI
    // env — flipping the CLI out of its working ChatGPT session into API-key
    // mode, which fails for accounts without API/Responses access. Dual-login
    // makes the ChatGPT sign-in the primary path with the key as a fallback.
    //
    // `codex login status` prints "Logged in using ChatGPT" / "Logged in using
    // an API key" (exit 0) when authenticated and "Not logged in" otherwise;
    // the pattern matches the positive form only (avoids "Not logged in").
    loginCommand: "codex login",
    statusArgs: ["login", "status"],
    loggedInPattern: /logged in using/i
  },
  amp: {
    // Amp (Sourcegraph) authenticates against Sourcegraph's own service, two
    // ways: `amp login` opens the browser sign-in (token stored in
    // ~/.config/amp/settings.json), or the user sets AMP_API_KEY directly (an
    // access token from ampcode.com/settings — see the registry env_config).
    // Amp ships no status/whoami command, so the sign-in probe runs `amp usage`
    // (it prints the credit balance when authenticated and AMP_LOGGED_OUT's
    // error otherwise); a negative match on that error means signed in. A saved
    // AMP_API_KEY is honored separately by _reconcileAgentHealth (it counts as
    // configured credentials), so readiness is "installed AND (signed in OR has
    // a key)" just like the other dual-login agents.
    loginCommand: "amp login",
    statusArgs: ["usage"],
    loggedOutPattern: AMP_LOGGED_OUT
  },
  gemini: {
    // Gemini CLI (v0.46) has NO `login`/`auth`/`status` subcommand — auth is the
    // interactive "Login with Google" OAuth flow reached by launching the CLI
    // (its `/auth` picker), or a GEMINI_API_KEY. So the login command is bare
    // `gemini` (on first run it prompts for the auth method and opens the browser
    // sign-in), and sign-in is detected by the OAuth token cache it writes at
    // ~/.gemini/oauth_creds.json — there is no status command to spawn, and
    // spawning bare `gemini` for a probe would launch its TUI and hang. A saved
    // GEMINI_API_KEY counts as configured credentials separately, so readiness is
    // "installed AND (signed in OR has a key)" like the other dual-login agents.
    loginCommand: "gemini",
    statusArgs: [],
    credsFile: ".gemini/oauth_creds.json"
  }
};
function launcherAuthFields(type) {
  const override = LAUNCHER_AUTH_OVERRIDES[type];
  if (!override) return null;
  if (DUAL_LOGIN_AGENTS[type]) {
    return override.map((f) => ({ ...f, required: false }));
  }
  return override;
}
const KEY_OPTIONAL_LOGIN_AGENTS = /* @__PURE__ */ new Set(["gemini"]);
const CORE_AGENTS = [
  "claude",
  "openclaw",
  "codex",
  "cursor",
  "opencode",
  "hermes",
  "kimi",
  "gemini",
  // Amp (Sourcegraph): external curl install + `amp login`/AMP_API_KEY auth.
  // aider/goose/copilot/cline are intentionally NOT in this set — they stay
  // "coming soon" (visible but not installable) so the supported download list
  // is the core agents + amp.
  "amp"
  // NanoClaw is intentionally NOT in this set: it's a BETA external
  // containerized runtime bridged via a native NanoClaw `openagents` channel,
  // so it stays "coming soon" (visible but not installable) and out of
  // onboarding rather than being surfaced as a supported download. It remains
  // in the runnable ADAPTER_MAP for existing workspaces. See docs/agents/nanoclaw.md.
];
const CORE_AGENT_ORDER = new Map(
  CORE_AGENTS.map((name, i) => [name, i])
);
function httpRequestJson(urlStr, method, headers, body, timeoutMs = 15e3) {
  return new Promise((resolve, reject) => {
    try {
      void new URL(urlStr);
    } catch {
      reject(new Error(`Invalid URL: ${urlStr}`));
      return;
    }
    const req = electron.net.request({ method, url: urlStr });
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v);
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => {
        try {
          req.abort();
        } catch {
        }
        reject(new Error("Request timed out"));
      });
    }, timeoutMs);
    req.on("response", (res) => {
      let data = "";
      res.on("data", (c) => {
        data += c.toString("utf8");
      });
      res.on(
        "end",
        () => finish(() => resolve({ status: res.statusCode || 0, text: data }))
      );
      res.on("error", (e) => finish(() => reject(e)));
    });
    req.on("error", (e) => finish(() => reject(e)));
    if (body) req.write(body);
    req.end();
  });
}
async function testLLMConnection(env) {
  const pick = (...names) => {
    for (const n of names) {
      const v = (env[n] || "").trim();
      if (v) return v;
    }
    return "";
  };
  const trimSlash = (u) => u.replace(/\/+$/, "");
  try {
    const aiderProvider = pick("AIDER_PROVIDER").toLowerCase();
    if (aiderProvider || pick("AIDER_MODEL")) {
      const validProviders = [
        "auto",
        "openai",
        "anthropic",
        "openrouter",
        "gemini",
        "deepseek",
        "openai-compatible"
      ];
      if (aiderProvider && !validProviders.includes(aiderProvider)) {
        return {
          success: false,
          error: `Unknown AIDER_PROVIDER '${aiderProvider}'. Valid values: ${validProviders.join(", ")}.`
        };
      }
      if (aiderProvider === "openai-compatible" && !pick("LLM_BASE_URL")) {
        return {
          success: false,
          error: "AIDER_PROVIDER=openai-compatible requires LLM_BASE_URL (the OpenAI-compatible endpoint URL)."
        };
      }
      return {
        success: false,
        error: "Aider injects your key into the provider chosen by AIDER_PROVIDER (or the model name) and verifies it on its first run — there's no single endpoint to test here. Save the config and send a message in the workspace to confirm."
      };
    }
    const geminiKey = pick("GEMINI_API_KEY", "GOOGLE_API_KEY");
    if (geminiKey) {
      const base2 = trimSlash(
        pick("GOOGLE_GEMINI_BASE_URL") || "https://generativelanguage.googleapis.com"
      );
      const model2 = pick("GEMINI_MODEL", "GOOGLE_GEMINI_MODEL") || "gemini-2.0-flash";
      const geminiPath = /\/v\d+(beta)?$/.test(base2) ? `/models/${model2}:generateContent` : `/v1beta/models/${model2}:generateContent`;
      const { status: status2, text: text2 } = await httpRequestJson(
        `${base2}${geminiPath}?key=${encodeURIComponent(geminiKey)}`,
        "POST",
        // Native Google also accepts the key via x-goog-api-key; harmless next
        // to ?key=. Deliberately NOT sending Authorization: Bearer — Google
        // would treat it as an OAuth token and reject a plain API key with 401.
        { "content-type": "application/json", "x-goog-api-key": geminiKey },
        JSON.stringify({
          contents: [{ parts: [{ text: "Say hi in 5 words." }] }]
        })
      );
      if (status2 >= 400)
        return { success: false, error: `HTTP ${status2}: ${text2.slice(0, 200)}` };
      let reply2 = "";
      try {
        reply2 = JSON.parse(text2)?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      } catch {
      }
      return { success: true, model: model2, response: reply2.slice(0, 80) };
    }
    const anthropicKey = pick("ANTHROPIC_API_KEY");
    const openaiKey = pick(
      "OPENAI_API_KEY",
      "LLM_API_KEY",
      "KIMI_API_KEY",
      "MOONSHOT_API_KEY",
      "OPENROUTER_API_KEY"
    );
    if (pick("CURSOR_API_KEY") && !anthropicKey && !openaiKey) {
      return {
        success: false,
        error: "Cursor signs in through its own service — there's no key endpoint to test here. Save the key and launch the agent to verify."
      };
    }
    const clineKey = pick("CLINE_API_KEY");
    if (clineKey && !anthropicKey && !openaiKey && !geminiKey) {
      const provider = pick("CLINE_PROVIDER").toLowerCase();
      const clineModel = pick("CLINE_MODEL");
      if (provider.includes("anthropic")) {
        const base2 = "https://api.anthropic.com";
        const model2 = clineModel || "claude-3-5-haiku-latest";
        const { status: status2, text: text2 } = await httpRequestJson(
          `${base2}/v1/messages`,
          "POST",
          {
            "x-api-key": clineKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json"
          },
          JSON.stringify({
            model: model2,
            max_tokens: 16,
            messages: [{ role: "user", content: "Say hi in 5 words." }]
          })
        );
        if (status2 >= 400)
          return { success: false, error: `HTTP ${status2}: ${text2.slice(0, 200)}` };
        let reply2 = "";
        try {
          reply2 = JSON.parse(text2)?.content?.[0]?.text || "";
        } catch {
        }
        return { success: true, model: model2, response: reply2.slice(0, 80) };
      }
      if (provider.includes("openai") || provider.includes("openrouter")) {
        const base2 = provider.includes("openrouter") ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1";
        const model2 = clineModel || (provider.includes("openrouter") ? "openai/gpt-4o-mini" : "gpt-4o-mini");
        const { status: status2, text: text2 } = await httpRequestJson(
          `${base2}/chat/completions`,
          "POST",
          { Authorization: `Bearer ${clineKey}`, "Content-Type": "application/json" },
          JSON.stringify({
            model: model2,
            max_tokens: 16,
            messages: [{ role: "user", content: "Say hi in 5 words." }]
          })
        );
        if (status2 >= 400)
          return { success: false, error: `HTTP ${status2}: ${text2.slice(0, 200)}` };
        let reply2 = "", used2 = model2;
        try {
          const p = JSON.parse(text2);
          reply2 = p?.choices?.[0]?.message?.content || "";
          used2 = p?.model || model2;
        } catch {
        }
        return { success: true, model: used2, response: reply2.slice(0, 80) };
      }
      return {
        success: false,
        error: "Cline targets your selected provider — this provider can't be tested directly here. Save the settings and launch the agent to verify (or run `cline auth`)."
      };
    }
    if (anthropicKey && !openaiKey) {
      const base2 = trimSlash(
        pick("ANTHROPIC_BASE_URL") || "https://api.anthropic.com"
      ).replace(/\/v1$/, "");
      const model2 = pick("ANTHROPIC_MODEL") || "claude-3-5-haiku-latest";
      const authHeader = isOfficialAnthropicBase(base2) ? { "x-api-key": anthropicKey } : { Authorization: `Bearer ${anthropicKey}` };
      const { status: status2, text: text2 } = await httpRequestJson(
        `${base2}/v1/messages`,
        "POST",
        {
          ...authHeader,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        JSON.stringify({
          model: model2,
          max_tokens: 16,
          messages: [{ role: "user", content: "Say hi in 5 words." }]
        })
      );
      if (status2 >= 400)
        return { success: false, error: `HTTP ${status2}: ${text2.slice(0, 200)}` };
      let reply2 = "", used2 = model2;
      try {
        const p = JSON.parse(text2);
        reply2 = p?.content?.[0]?.text || "";
        used2 = p?.model || model2;
      } catch {
      }
      return { success: true, model: used2, response: reply2.slice(0, 80) };
    }
    const apiKey = openaiKey || anthropicKey;
    if (!apiKey) {
      return {
        success: false,
        error: "No API key to test for this agent. Enter a key above — or this agent may authenticate a different way (e.g. a hosted login)."
      };
    }
    const hasKimi = !!pick(
      "KIMI_API_KEY",
      "MOONSHOT_API_KEY",
      "KIMI_BASE_URL",
      "KIMI_MODEL"
    );
    let base = trimSlash(
      pick("OPENAI_BASE_URL", "LLM_BASE_URL", "KIMI_BASE_URL") || (hasKimi ? "https://api.moonshot.ai/v1" : "https://api.openai.com/v1")
    );
    if (!/\/v\d+$/.test(base)) base += "/v1";
    const model = pick(
      "OPENAI_MODEL",
      "CODEX_MODEL",
      "LLM_MODEL",
      "KIMI_MODEL",
      "OPENCLAW_MODEL"
    ) || (hasKimi ? "kimi-k2.6" : "gpt-4o-mini");
    const { status, text } = await httpRequestJson(
      `${base}/chat/completions`,
      "POST",
      { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "Say hi in 5 words." }]
      })
    );
    if (status >= 400)
      return { success: false, error: `HTTP ${status}: ${text.slice(0, 200)}` };
    let reply = "", used = model;
    try {
      const p = JSON.parse(text);
      reply = p?.choices?.[0]?.message?.content || "";
      used = p?.model || model;
    } catch {
    }
    return { success: true, model: used, response: reply.slice(0, 80) };
  } catch (e) {
    return { success: false, error: e?.message || "Request failed" };
  }
}
function normalizeWorkspaceEndpoint(value) {
  if (typeof value !== "string") return void 0;
  const raw = value.trim();
  if (!raw) return void 0;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return void 0;
    if (url.hostname === "workspace.openagents.org") {
      return url.origin.replace("workspace.openagents.org", "workspace-endpoint.openagents.org");
    }
    return url.origin;
  } catch {
    return void 0;
  }
}
function isOfficialAnthropicBase(base) {
  try {
    const h = new URL(base).hostname.toLowerCase();
    return h === "anthropic.com" || h.endsWith(".anthropic.com");
  } catch {
    return false;
  }
}
function normalizeEnvForSave(env) {
  const out = { ...env };
  const anthropicBase = out.ANTHROPIC_BASE_URL;
  if (typeof anthropicBase === "string" && anthropicBase.trim()) {
    out.ANTHROPIC_BASE_URL = anthropicBase.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  }
  const anthropicKey = (out.ANTHROPIC_API_KEY || "").trim();
  const resolvedBase = (out.ANTHROPIC_BASE_URL || "").trim();
  if (anthropicKey && resolvedBase) {
    if (isOfficialAnthropicBase(resolvedBase)) {
      out.ANTHROPIC_AUTH_TOKEN = "";
    } else if (!(out.ANTHROPIC_AUTH_TOKEN || "").trim()) {
      out.ANTHROPIC_AUTH_TOKEN = anthropicKey;
    }
  }
  return out;
}
function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
  }
}
function sessionFilePath(workspaceId, channelName) {
  return path.join(LAUNCHER_SESSIONS_DIR, workspaceId, `${channelName}.json`);
}
function classifyTool(name) {
  const n = (name || "").toLowerCase();
  if (n.includes("browser")) return "browser";
  if (n.includes("file")) return "files";
  if (n.includes("tunnel")) return "tunnel";
  if (n.includes("todo")) return "todos";
  if (n.includes("timer")) return "timers";
  if (n.includes("shell") || n.includes("exec") || n.includes("terminal") || n.includes("bash"))
    return "terminal";
  if (n.includes("workspace")) return "workspace";
  return "other";
}
function attachmentsToServer(attachments) {
  if (!attachments || attachments.length === 0) return void 0;
  return attachments.map((a) => {
    const out = {};
    if (a.fileId) out.fileId = a.fileId;
    if (a.filename) out.filename = a.filename;
    if (a.contentType) out.contentType = a.contentType;
    if (typeof a.size === "number") out.size = a.size;
    if (a.url) out.url = a.url;
    return out;
  });
}
function attachmentsFromServer(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return void 0;
  return raw.map((entry) => {
    const e = entry || {};
    return {
      fileId: e.fileId || e.file_id || e.id || void 0,
      filename: e.filename || e.name || void 0,
      contentType: e.contentType || e.content_type || void 0,
      size: typeof e.size === "number" ? e.size : void 0,
      url: e.url || void 0
    };
  });
}
function normalizeIncomingMessage(m) {
  return {
    ...m,
    attachments: m.attachments ? attachmentsFromServer(m.attachments) : void 0,
    toolCalls: extractToolCalls(m)
  };
}
function extractToolCalls(msg) {
  const meta = msg.metadata || {};
  const raw = meta.tool_calls || meta.toolCalls || void 0;
  if (!Array.isArray(raw) || raw.length === 0) return void 0;
  return raw.map((entry, i) => {
    const e = entry || {};
    const name = e.name || e.tool || `tool_${i}`;
    const status = e.status || (e.error ? "error" : e.result !== void 0 ? "success" : "pending");
    return {
      id: e.id || `${msg.messageId}:${i}`,
      name,
      category: classifyTool(name),
      status,
      args: e.args ?? e.arguments,
      result: e.result ?? e.error,
      durationMs: typeof e.duration_ms === "number" ? e.duration_ms : typeof e.durationMs === "number" ? e.durationMs : void 0
    };
  });
}
function extractMentions(text) {
  const out = [];
  const re = /(^|\s)@([a-zA-Z0-9_-]+)/g;
  let match = re.exec(text);
  while (match !== null) {
    if (!out.includes(match[2])) out.push(match[2]);
    match = re.exec(text);
  }
  return out;
}
function loadCore() {
  if (fs.existsSync(path.join(LOCAL_CORE$1, "package.json"))) {
    try {
      return require(LOCAL_CORE$1);
    } catch (e) {
      console.error("Failed to load local core:", e);
    }
  }
  if (fs.existsSync(path.join(GLOBAL_CORE, "package.json"))) {
    try {
      return require(GLOBAL_CORE);
    } catch {
    }
  }
  try {
    return require("@openagents-org/agent-launcher");
  } catch {
  }
  return null;
}
function appendDaemonLog(message) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.appendFileSync(
      DAEMON_LOG_FILE,
      `[${(/* @__PURE__ */ new Date()).toISOString()}] launcher: ${message}
`,
      "utf-8"
    );
  } catch {
  }
}
function isPidAlive(pid) {
  if (!pid || !Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function canExecuteNode(binaryPath) {
  try {
    const r = child_process.spawnSync(binaryPath, ["--version"], {
      timeout: 5e3,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return r.status === 0 && !r.error;
  } catch {
    return false;
  }
}
function resolveWorkingNode(portableNodeDir, enhancedPath) {
  const candidates = [
    path.join(
      portableNodeDir,
      "node" + (process.platform === "win32" ? ".exe" : "")
    ),
    path.join(portableNodeDir, "bin", "node")
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && canExecuteNode(c)) return c;
  }
  try {
    const which = process.platform === "win32" ? "where" : "which";
    const out = require("child_process").execFileSync(which, ["node"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5e3,
      windowsHide: true,
      env: withPathEnv(enhancedPath)
    });
    for (const line of out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      if (canExecuteNode(line)) return line;
    }
  } catch {
  }
  return null;
}
function resolveNpmInvocation$1() {
  const portableNodeDir = path.join(CONFIG_DIR, "nodejs");
  const exists = (p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  };
  const nodeBin = [
    path.join(
      portableNodeDir,
      process.platform === "win32" ? "node.exe" : "node"
    ),
    path.join(portableNodeDir, "bin", "node")
  ].find(exists);
  if (nodeBin) {
    const npmCli = [
      path.join(portableNodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
      path.join(
        portableNodeDir,
        "lib",
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js"
      )
    ].find(exists);
    if (npmCli) return { cmd: nodeBin, preArgs: [npmCli], useShell: false };
  }
  return {
    cmd: process.platform === "win32" ? "npm.cmd" : "npm",
    preArgs: [],
    useShell: false
  };
}
let core = loadCore();
class AgentManager extends events.EventEmitter {
  constructor(store2) {
    super();
    this._healthByType = /* @__PURE__ */ new Map();
    this._healthRefreshInFlight = /* @__PURE__ */ new Set();
    this._lastHealthRefreshAt = 0;
    this._healthQueue = [];
    this._healthProcessing = false;
    this._hostedLoginAuth = /* @__PURE__ */ new Map();
    this._hostedLoginProbe = /* @__PURE__ */ new Map();
    this._agentsCache = { value: [], at: 0 };
    this._catalogCache = {
      value: null,
      at: 0,
      inFlight: null
    };
    this._updatesCache = {
      value: [],
      at: 0,
      inFlight: null
    };
    this._statusCache = { value: {}, at: 0 };
    this._chatPolls = /* @__PURE__ */ new Map();
    this._connector = null;
    this._store = store2;
    if (!core) core = loadCore();
    if (core) {
      this._connector = this.createConnector();
    }
    ensureDir(LAUNCHER_SESSIONS_DIR);
  }
  createConnector() {
    const AgentConnector = core.AgentConnector;
    const workspaceEndpoint = normalizeWorkspaceEndpoint(
      this._store.get("workspaceEndpoint")
    );
    return new AgentConnector({
      configDir: CONFIG_DIR,
      ...workspaceEndpoint ? { workspaceEndpoint } : {}
    });
  }
  configuredWorkspaceEndpoint() {
    return normalizeWorkspaceEndpoint(this._store.get("workspaceEndpoint"));
  }
  getSupportedAgentTypes() {
    const supported = core?.adapters ? Object.keys(
      core.adapters.ADAPTER_MAP
    ) : [];
    return supported.sort();
  }
  getCoreInfo() {
    return {
      version: this.coreVersion,
      supportedTypes: this.getSupportedAgentTypes(),
      globalCorePath: GLOBAL_CORE,
      globalCorePresent: fs.existsSync(path.join(GLOBAL_CORE, "package.json"))
    };
  }
  reloadCore() {
    const cacheKeys = Object.keys(require.cache).filter(
      (k) => k.includes("agent-launcher") || k.includes("agent-connector") || k.includes("wwj")
    );
    for (const k of cacheKeys) delete require.cache[k];
    core = loadCore();
    if (core) {
      this._connector = this.createConnector();
    }
    this.clearCatalogCache();
    this._agentsCache = { value: [], at: 0 };
    this._healthByType.clear();
    return !!core;
  }
  get coreVersion() {
    try {
      const pkg = path.join(LOCAL_CORE$1, "package.json");
      if (fs.existsSync(pkg))
        return JSON.parse(fs.readFileSync(pkg, "utf-8")).version;
    } catch {
    }
    try {
      const pkg = path.join(GLOBAL_CORE, "package.json");
      if (fs.existsSync(pkg))
        return JSON.parse(fs.readFileSync(pkg, "utf-8")).version;
    } catch {
    }
    try {
      return require("@openagents-org/agent-launcher/package.json").version;
    } catch {
    }
    return null;
  }
  _ensureConnector() {
    if (!this._connector) {
      if (!this.reloadCore()) {
        throw new Error(
          "Core library not installed. Install an agent first via the Install tab."
        );
      }
    }
  }
  getAgents() {
    const now = Date.now();
    if (this._agentsCache.value.length > 0 && now - this._agentsCache.at < 1500) {
      return this._agentsCache.value;
    }
    if (!this._connector) return [];
    const listAgents = this._connector.listAgents;
    const agents = listAgents.call(this._connector);
    const status = this.getAllStatus();
    this._scheduleHealthRefresh(
      agents
    );
    const supportedTypes = new Set(this.getSupportedAgentTypes());
    const value = agents.map((a) => {
      const type = a.type || "openclaw";
      const runtimeMismatch = !supportedTypes.has(type);
      const runtimeMessage = runtimeMismatch ? `Agent runtime '${type}' is not available in the currently loaded core. Update Launcher and restart it.` : null;
      const statusEntry = status[a.name];
      const statusError = statusEntry?.last_error || null;
      return {
        ...a,
        state: statusEntry?.state || "stopped",
        restarts: statusEntry?.restarts || 0,
        lastError: statusError || runtimeMessage,
        health: this._reconcileAgentHealth(
          type,
          a.env,
          this._healthByType.get(type) || null
        ),
        runtimeMismatch,
        // Whether this agent type has an interactive CLI binary we can open a
        // terminal session against. API-only types (kimi, openclaw — run via the
        // core's generic LLM runner) resolve to no binary, so the renderer hides
        // the "Chat" action for them.
        hasCli: !!this.resolveBinary(type)
      };
    });
    this._agentsCache = { value, at: now };
    return value;
  }
  _scheduleHealthRefresh(agents) {
    const now = Date.now();
    if (now - this._lastHealthRefreshAt < 3e4) return;
    this._lastHealthRefreshAt = now;
    const types = [...new Set((agents || []).map((a) => a.type || "openclaw"))];
    for (const type of types) {
      if (this._healthRefreshInFlight.has(type)) continue;
      if (this._healthQueue.includes(type)) continue;
      this._healthRefreshInFlight.add(type);
      this._healthQueue.push(type);
    }
    this._processHealthQueue();
  }
  _processHealthQueue() {
    if (this._healthProcessing) return;
    this._healthProcessing = true;
    const tick = () => {
      const type = this._healthQueue.shift();
      if (!type) {
        this._healthProcessing = false;
        return;
      }
      setTimeout(() => {
        try {
          if (HOSTED_LOGIN_AGENTS[type]) {
            this._healthByType.set(type, this._hostedLoginHealth(type));
          } else {
            const healthCheck = this._connector?.healthCheck;
            const health = healthCheck ? healthCheck.call(this._connector, type) : null;
            this._healthByType.set(type, health);
            if (DUAL_LOGIN_AGENTS[type]) void this._probeHostedLogin(type);
          }
        } catch {
          this._healthByType.set(type, null);
        } finally {
          this._healthRefreshInFlight.delete(type);
        }
        setTimeout(tick, 250);
      }, 0);
    };
    tick();
  }
  /**
   * Correct a false "Not installed" from the core health check.
   *
   * The core resolves an agent's binary with `which`/`where` against PATH, but
   * agents the launcher installs live in isolated runtimes
   * (~/.openagents/runtimes/<type>/node_modules/.bin) that are NOT on the user's
   * PATH. So a freshly-installed agent can report `installed:false` ("Not
   * installed") from the health check even though the marketplace — which uses a
   * filesystem package.json check (getInstallInfo) — correctly shows it
   * installed. That mismatch surfaced in the Agents list as a confusing
   * "⚠ Not installed" badge on a working agent. Trust the filesystem: if the npm
   * package is present on disk, mark it installed and re-derive readiness from
   * saved credentials so the label reflects configuration, not binary lookup.
   */
  _reconcileHealth(type, health) {
    if (!health || typeof health !== "object") return health;
    const h = health;
    if (h.installed !== false) return health;
    if (!this.getInstalledVersion(type)) return health;
    const ready = this._hasConfiguredCredentials(type);
    return {
      ...h,
      installed: true,
      ready,
      reason: ready ? READY_REASON.READY : READY_REASON.LOGIN_REQUIRED,
      auth_mode: ready ? "api_key" : null,
      execution_mode: ready ? h.execution_mode || "direct" : "unavailable",
      // Binary confirmed on disk → never "not installed"; show login-required.
      message: ready ? "Ready" : this._loginRequiredMessage(type)
    };
  }
  /**
   * Per-agent health, fixing two false negatives in the core's per-TYPE check:
   *  1. "Not installed" — the core resolves binaries with `which`, which misses
   *     isolated-runtime installs (handled by _reconcileHealth via filesystem).
   *  2. "Not configured" — the core evaluates readiness against TYPE-level saved
   *     env (~/.openagents/env/<type>.env) ONLY. But Configure on an existing
   *     agent saves INSTANCE env into daemon.yaml (saveAgentInstanceEnv), so a
   *     fully-configured agent (valid key/base/model, Test connection passes)
   *     still shows "Not configured". Trust the instance's own env here.
   */
  _reconcileAgentHealth(type, instanceEnv, typeHealth) {
    const hostedLogin = HOSTED_LOGIN_AGENTS[type];
    if (hostedLogin) {
      const hasApiKey = !!(hostedLogin.apiKeyEnv && (instanceEnv?.[hostedLogin.apiKeyEnv] || "").trim()) || this._hasConfiguredCredentials(type);
      if (this._isInstalled(type) && hasApiKey) {
        return {
          installed: true,
          ready: true,
          reason: READY_REASON.READY,
          auth_mode: "api_key",
          execution_mode: "direct",
          message: "Ready"
        };
      }
      if (typeHealth && typeof typeHealth === "object") return typeHealth;
      return this._isInstalled(type) ? {
        installed: true,
        ready: true,
        reason: READY_REASON.READY,
        auth_mode: "cli_login",
        execution_mode: "subprocess",
        message: "Ready"
      } : {
        installed: false,
        ready: false,
        reason: READY_REASON.NOT_INSTALLED,
        auth_mode: null,
        execution_mode: "unavailable",
        message: this._notInstalledMessage(type)
      };
    }
    const health = this._reconcileHealth(type, typeHealth);
    const cliLoggedIn = DUAL_LOGIN_AGENTS[type] ? this._hostedLoginIsAuthed(type) === true : false;
    const hasKey = this._envHasApiKey(instanceEnv) || this._hasConfiguredCredentials(type);
    const hasCreds = cliLoggedIn || hasKey;
    if (!health || typeof health !== "object") {
      if (hasCreds) {
        return {
          installed: true,
          ready: true,
          reason: READY_REASON.READY,
          auth_mode: hasKey ? "api_key" : "cli_login",
          execution_mode: "direct",
          message: "Ready"
        };
      }
      return health;
    }
    const h = health;
    if (h.installed === false || h.ready === true) return health;
    if (hasCreds) {
      return {
        ...h,
        installed: true,
        ready: true,
        reason: READY_REASON.READY,
        auth_mode: hasKey ? "api_key" : "cli_login",
        execution_mode: h.execution_mode && h.execution_mode !== "unavailable" ? h.execution_mode : "direct",
        message: "Ready"
      };
    }
    if (h.installed === true && h.ready !== true) {
      return {
        ...h,
        reason: READY_REASON.LOGIN_REQUIRED,
        message: this._loginRequiredMessage(type)
      };
    }
    return health;
  }
  /**
   * Health for hosted-login agents (e.g. Cursor). Install is confirmed with the
   * connector's isInstalled — the same check the marketplace's "Installed" badge
   * uses, so the two views never disagree. Readiness then follows the CLI's own
   * sign-in state (its `status` command): signed in ⇒ Ready; signed out ⇒ a
   * clear "click Login" hint rather than a misleading "Ready"; unknown (probe
   * failed/timed out) ⇒ optimistic Ready so a working agent is never blocked.
   */
  _hostedLoginHealth(type) {
    if (!this._isInstalled(type)) {
      return {
        installed: false,
        ready: false,
        reason: READY_REASON.NOT_INSTALLED,
        auth_mode: null,
        execution_mode: "unavailable",
        message: this._notInstalledMessage(type)
      };
    }
    if (this._hostedLoginIsAuthed(type) === false) {
      return {
        installed: true,
        ready: false,
        reason: READY_REASON.LOGIN_REQUIRED,
        auth_mode: null,
        execution_mode: "unavailable",
        message: "Not signed in — open Configure and click Login"
      };
    }
    return {
      installed: true,
      ready: true,
      reason: READY_REASON.READY,
      auth_mode: "cli_login",
      execution_mode: "subprocess",
      message: "Ready"
    };
  }
  /** Install check matching the marketplace's "Installed" badge (getInstallInfo). */
  _isInstalled(type) {
    try {
      const isInstalled = this._connector?.isInstalled;
      return !!isInstalled?.call(this._connector, type);
    } catch {
      return false;
    }
  }
  /**
   * Cached sign-in state for a hosted-login agent: true (signed in) / false
   * (signed out) / null (unknown — never probed, or the probe couldn't decide).
   * NON-BLOCKING: returns the cache immediately and kicks off a background probe
   * when the cache is stale (>30s). The CLI's `status` can take seconds (Hermes
   * ~2.5s), so it must never run on a sync path. The Configure dialog uses the
   * awaitable refreshHostedLogin() instead when it needs a guaranteed-fresh read.
   */
  _hostedLoginIsAuthed(type) {
    const spec = this._loginSpec(type);
    if (!spec) return null;
    const cached = this._hostedLoginAuth.get(type);
    const fresh = !!cached && Date.now() - cached.at < 3e4;
    if (!fresh) void this._probeHostedLogin(type);
    return cached ? cached.value : null;
  }
  /**
   * The CLI sign-in spec for an agent type, covering both pure hosted-login
   * agents (Cursor, Hermes) and dual-auth agents (Claude — API key OR CLI
   * login). Used by the shared `status`-probe machinery so a single code path
   * detects sign-in for either kind.
   */
  _loginSpec(type) {
    return HOSTED_LOGIN_AGENTS[type] || DUAL_LOGIN_AGENTS[type];
  }
  /**
   * Resolve an agent type's CLI to an ABSOLUTE binary path (via the core's
   * `installer.which`, which searches the enhanced PATH incl. the Cursor/Hermes
   * native install dirs). Returns null when the binary can't be located.
   */
  resolveBinary(type) {
    try {
      const installer = this._connector?.installer;
      const which = installer?.which;
      return which?.call(installer, type) || null;
    } catch {
      return null;
    }
  }
  /**
   * Rewrite a hosted-login command (e.g. "cursor-agent login", "hermes setup")
   * so its leading binary token becomes the resolved ABSOLUTE path. This is the
   * fix for the Windows "'cursor-agent' is not recognized as an internal or
   * external command" failure: the native installer drops the CLI under
   * %LOCALAPPDATA%\cursor-agent and only edits the *registry* PATH, which a
   * freshly-spawned login terminal inherits stale — so a bare `cursor-agent
   * login` dies. Resolving to an absolute path makes the login PATH-independent.
   * Returns the original command unchanged when it isn't a known hosted-login
   * binary or the binary can't be resolved (callers still inject PATH as a
   * fallback). The returned binary path is quoted so spaces in the home dir
   * (e.g. C:\Users\First Last\...) survive.
   */
  resolveLoginCommand(cmd) {
    if (!cmd || !cmd.trim()) return cmd;
    const trimmed = cmd.trim();
    const m = trimmed.match(/^("[^"]*"|'[^']*'|\S+)(\s+[\s\S]*)?$/);
    if (!m) return cmd;
    const rawFirst = m[1].replace(/^["']|["']$/g, "");
    const rest = m[2] || "";
    const base = rawFirst.replace(/\.(exe|cmd|ps1|bat)$/i, "").split(/[\\/]/).pop();
    const BINARY_TO_TYPE = {
      "cursor-agent": "cursor",
      agent: "cursor",
      hermes: "hermes",
      claude: "claude",
      amp: "amp",
      gemini: "gemini"
    };
    const type = base ? BINARY_TO_TYPE[base] : void 0;
    if (!type) return cmd;
    const abs = this.resolveBinary(type);
    if (!abs) return cmd;
    return `"${abs}"${rest}`;
  }
  /**
   * Run a FRESH sign-in probe for a hosted-login agent and resolve its health.
   * Awaitable — the Configure dialog calls this after the user confirms they
   * completed the terminal login, so the result reflects reality rather than an
   * optimistic guess.
   */
  async refreshHostedLogin(type) {
    if (!this._loginSpec(type)) return this.healthCheck(type);
    await this._probeHostedLogin(type, true);
    if (HOSTED_LOGIN_AGENTS[type]) return this._hostedLoginHealth(type);
    return this.healthCheck(type);
  }
  /**
   * Spawn the hosted-login CLI's `status` asynchronously and cache the parsed
   * sign-in state. Deduped per type (concurrent callers share one probe) and
   * throttled (no re-spawn within 2s unless `force`d) so polling can't pile up
   * CLI processes. On completion it refreshes the cached type health and busts
   * the agents cache so the Agents list picks up the new state.
   */
  _probeHostedLogin(type, force = false) {
    const spec = this._loginSpec(type);
    if (!spec) return Promise.resolve(null);
    const inflight = this._hostedLoginProbe.get(type);
    if (inflight) return inflight;
    const cached = this._hostedLoginAuth.get(type);
    if (!force && cached && Date.now() - cached.at < 2e3) {
      return Promise.resolve(cached.value);
    }
    const p = this._runHostedLoginProbe(type, spec);
    this._hostedLoginProbe.set(type, p);
    void p.finally(() => this._hostedLoginProbe.delete(type));
    return p;
  }
  /**
   * Child env for a launcher-side CLI probe, built the SAME way the daemon's
   * adapter builds it: the core's getEnhancedEnv adds nvm/fnm/volta/homebrew,
   * ~/.local/bin and ~/.amp/bin to PATH and (on Windows) forces UTF-8 output +
   * ComSpec. This is what makes `amp`/`amp.cmd` resolvable from a GUI-spawned
   * process whose PATH never inherited the installer's edits — so the Agents
   * list and the daemon agree on whether amp is runnable. Never a bare
   * process.env. `extra` (e.g. AMP_API_KEY/AMP_URL) is merged in, never logged.
   */
  _enhancedChildEnv(extra) {
    const base = { ...process.env, ...extra || {} };
    try {
      const paths = core?.paths;
      if (typeof paths?.getEnhancedEnv === "function")
        return paths.getEnhancedEnv(base);
    } catch {
    }
    return base;
  }
  /**
   * Spawn an agent CLI for a short-lived probe (status / usage), the SAME way
   * the daemon's adapter (_spawnAmp) does: shell:true for a Windows `.cmd`/`.bat`
   * shim — Node cannot launch those directly via CreateProcess, so a bare
   * spawn(bin) throws and the probe used to fall back to a misleading "Not
   * installed". Enhanced PATH + windowsHide round it out. The shell rule mirrors
   * the shared core helper (shouldUseShellForBinary) so launcher and daemon
   * never diverge on `.cmd`.
   */
  _spawnAgentCli(bin, args, extra) {
    const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
    return child_process.spawn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: this._enhancedChildEnv(extra),
      windowsHide: true,
      shell: useShell
    });
  }
  /** Saved type-level env for a probe (e.g. AMP_URL / AMP_API_KEY), never thrown. */
  _savedTypeEnvForProbe(type) {
    try {
      return this.getAgentEnv(type) || {};
    } catch {
      return {};
    }
  }
  _runHostedLoginProbe(type, spec) {
    return new Promise((resolve) => {
      let bin = null;
      try {
        const installer = this._connector?.installer;
        const which = installer?.which;
        bin = which?.call(installer, type) || null;
      } catch {
      }
      const settle = (value) => {
        this._hostedLoginAuth.set(type, { value, at: Date.now() });
        if (HOSTED_LOGIN_AGENTS[type]) {
          this._healthByType.set(type, this._hostedLoginHealth(type));
        }
        this._agentsCache = { value: [], at: 0 };
        resolve(value);
      };
      if (spec.credsFile) {
        let value = null;
        try {
          value = fs.existsSync(path.join(os.homedir(), spec.credsFile));
        } catch {
          value = null;
        }
        settle(value);
        return;
      }
      if (!bin) {
        settle(null);
        return;
      }
      try {
        const child = this._spawnAgentCli(
          bin,
          spec.statusArgs,
          this._savedTypeEnvForProbe(type)
        );
        let out = "";
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          settle(value);
        };
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
          }
          finish(null);
        }, 8e3);
        child.stdout?.on("data", (c) => out += c.toString("utf-8"));
        child.stderr?.on("data", (c) => out += c.toString("utf-8"));
        child.on("error", () => finish(null));
        child.on("close", (code) => {
          const definitive = !!out.trim() && code === 0;
          let value = null;
          if (spec.loggedInPattern) {
            value = spec.loggedInPattern.test(out) ? true : definitive ? false : null;
          } else if (spec.loggedOutPattern) {
            value = spec.loggedOutPattern.test(out) ? false : definitive ? true : null;
          }
          finish(value);
        });
      } catch {
        settle(null);
      }
    });
  }
  /**
   * Clear a hosted-login agent's stale env (e.g. CURSOR_API_KEY, CURSOR_MODEL)
   * from both the type-level and instance env. Cursor's CLI prefers an explicit
   * key/model over its own browser-login session and account defaults, so values
   * left over from the old setup wizard (an invalid key, a bogus model like
   * "gpt-5.4") make the agent fail — "API key is invalid" — even after a
   * successful `cursor-agent login`. When the user signs in via the browser flow
   * we wipe them so the login session + account defaults are what get used.
   * Saving an empty value removes the line (env.save filters out empties).
   */
  clearHostedLoginApiKey(type, agentName) {
    const keys = HOSTED_LOGIN_AGENTS[type]?.loginClearsEnv;
    if (!keys?.length) return;
    try {
      const typeEnv = this.getAgentEnv(type) || {};
      const drop = keys.filter((k) => (typeEnv[k] || "").trim());
      if (drop.length)
        this.saveAgentEnv(type, Object.fromEntries(drop.map((k) => [k, ""])));
    } catch {
    }
    if (agentName) {
      try {
        const instEnv = this.getAgentInstanceEnv(agentName) || {};
        const drop = keys.filter((k) => (instEnv[k] || "").trim());
        if (drop.length)
          this.saveAgentInstanceEnv(
            agentName,
            Object.fromEntries(drop.map((k) => [k, ""]))
          );
      } catch {
      }
    }
    this._agentsCache = { value: [], at: 0 };
  }
  /** True when an env map carries any non-empty API key (e.g. *_API_KEY). */
  _envHasApiKey(env) {
    if (!env || typeof env !== "object") return false;
    return Object.entries(env).some(
      ([k, v]) => /API_KEY$/.test(k) && !!(v || "").trim()
    );
  }
  /** True when saved TYPE-level env for this agent carries any non-empty key. */
  _hasConfiguredCredentials(type) {
    try {
      return this._envHasApiKey(
        this.getAgentEnv(type)
      );
    } catch {
      return false;
    }
  }
  /** Registry's not-ready hint for an agent type, with a sensible fallback. */
  _notReadyMessage(type) {
    try {
      const entry = this._getRegistryEntry(type);
      const checkReady = entry?.check_ready;
      if (checkReady?.not_ready_message) return checkReady.not_ready_message;
    } catch {
    }
    return "Not configured — add an API key in Configure";
  }
  /**
   * Message for an agent that IS installed but not yet usable (signed out / no
   * API key). Reuses the registry's not_ready hint when it reads as a login
   * prompt, but NEVER surfaces a stale "not installed" wording for a resolved
   * binary — that would re-introduce the exact bug this fix removes.
   */
  _loginRequiredMessage(type) {
    const msg = this._notReadyMessage(type);
    if (msg && !/not\s+installed/i.test(msg)) return msg;
    return "Installed · Login required — sign in or add an API key";
  }
  /**
   * Message for a genuinely-missing executable. Reuses the registry hint only
   * when it actually says "not installed"; otherwise a plain "Not installed".
   * (amp's not_ready_message now describes a login state, so it must NOT be used
   * for the not-installed case.)
   */
  _notInstalledMessage(type) {
    const msg = this._notReadyMessage(type);
    if (msg && /not\s+installed/i.test(msg)) return msg;
    return "Not installed";
  }
  async addAgent(agentConfig) {
    const name = agentConfig.name;
    const type = agentConfig.type || "openclaw";
    const supportedTypes = this.getSupportedAgentTypes();
    if (supportedTypes.length > 0 && !supportedTypes.includes(type)) {
      throw new Error(
        `Agent type '${type}' is not supported. Supported: ${supportedTypes.join(", ")}`
      );
    }
    const addAgent = this._connector.addAgent;
    addAgent.call(this._connector, {
      name,
      type,
      role: "worker",
      path: agentConfig.path,
      env: agentConfig.env
    });
    this._agentsCache = { value: [], at: 0 };
    return { success: true, agent: agentConfig };
  }
  async removeAgent(name) {
    try {
      await this.stopAgent(name);
    } catch {
    }
    const removeAgent = this._connector.removeAgent;
    removeAgent.call(this._connector, name);
    this._agentsCache = { value: [], at: 0 };
    return { success: true };
  }
  async updateAgent(name, updates) {
    if (updates.env) {
      const saveEnv = this._connector.saveAgentInstanceEnv;
      saveEnv.call(this._connector, name, normalizeEnvForSave(updates.env));
    }
    this._agentsCache = { value: [], at: 0 };
    return { success: true };
  }
  /**
   * Change an existing agent's working directory (its spawn cwd, stored as the
   * `path` field in daemon.yaml). The folder is created up-front — a missing
   * cwd makes the agent subprocess fail to spawn. The new cwd takes effect the
   * next time the agent starts; a running agent is asked to reload so the
   * daemon re-reads the config.
   *
   * The connector's published `config.updateAgent` is used directly here: the
   * top-level connector exposes no agent-path setter, and reimplementing the
   * daemon.yaml read-modify-write launcher-side would risk diverging from the
   * core's serializer. `config.updateAgent` has shipped in the core for a long
   * time, so it's a safe internal to lean on.
   */
  async setAgentWorkingDir(name, dirPath) {
    const p = (dirPath || "").trim();
    if (!p) throw new Error("A working directory is required.");
    try {
      fs.mkdirSync(p, { recursive: true });
    } catch (e) {
      throw new Error(
        `Could not create the agent folder '${p}': ${e.message}`
      );
    }
    const config = this._connector?.config;
    if (!config?.updateAgent) {
      throw new Error(
        "Updating the working directory isn't supported by the installed core. Please update, then try again."
      );
    }
    config.updateAgent(name, { path: p });
    this._agentsCache = { value: [], at: 0 };
    try {
      const sendCmd = this._connector.sendDaemonCommand;
      sendCmd?.call(this._connector, "reload");
    } catch {
    }
    return { success: true, path: p };
  }
  clearCatalogCache() {
    this._catalogCache = { value: null, at: 0, inFlight: null };
    this._updatesCache = { value: [], at: 0, inFlight: null };
    try {
      const clearCache = this._connector?.clearCatalogCache;
      clearCache?.call(this._connector);
    } catch {
    }
  }
  async getCatalog(force = false) {
    const now = Date.now();
    const ttl = process.platform === "win32" ? 6e4 : 1e4;
    const cached = this._catalogCache.value;
    const haveFresh = Array.isArray(cached) && cached.length > 0 && now - this._catalogCache.at < ttl;
    if (!force && haveFresh) return cached;
    if (!force && this._catalogCache.inFlight)
      return this._catalogCache.inFlight;
    const load = this._loadCatalog().then((catalog) => {
      const value = Array.isArray(catalog) && catalog.length > 0 ? catalog : this._fallbackCatalog();
      this._catalogCache = {
        value,
        // Pin the cache only when we got a real catalog. A fallback result
        // (connector still warming up) should keep retrying so the UI
        // updates as soon as the connector recovers.
        at: value === catalog ? Date.now() : 0,
        inFlight: null
      };
      return value;
    }).catch(() => {
      this._catalogCache.inFlight = null;
      return this._fallbackCatalog();
    });
    this._catalogCache.inFlight = load;
    return load;
  }
  /**
   * Bundled fallback when the connector hasn't loaded yet. Annotates each
   * entry with `installed: false` so the UI treats them as "needs install".
   */
  _fallbackCatalog() {
    const entries = Array.isArray(BUNDLED_REGISTRY) ? BUNDLED_REGISTRY : [];
    return entries.map((e) => {
      const spec = this._loginSpec(e.name);
      const check_ready = spec ? {
        ...e.check_ready || {},
        login_command: spec.loginCommand
      } : e.check_ready;
      return {
        ...e,
        check_ready,
        installed: false,
        managed: false,
        location: null
      };
    });
  }
  async _loadCatalog() {
    if (!this._connector) return [];
    let catalog;
    try {
      const getCatalog = this._connector.getCatalog;
      catalog = await getCatalog.call(this._connector);
    } catch {
      try {
        const registry = this._connector.registry;
        const getCatalogSync = registry.getCatalogSync;
        const installer = this._connector.installer;
        const getInstallInfo = installer.getInstallInfo;
        catalog = getCatalogSync.call(registry).map((e) => {
          const entry = e;
          const info = getInstallInfo.call(installer, entry.name);
          return {
            ...entry,
            installed: info.installed,
            managed: info.managed,
            location: info.location
          };
        });
      } catch {
        return [];
      }
    }
    try {
      const registry = this._connector.registry;
      const loadBundled = registry._loadBundled;
      const bundled = loadBundled.call(registry);
      for (const entry of catalog) {
        const e = entry;
        const b = bundled.find(
          (x) => x.name === e.name
        );
        if (b) {
          if (!e.check_ready && b.check_ready) e.check_ready = b.check_ready;
          if ((!e.env_config || !e.env_config.length) && b.env_config?.length)
            e.env_config = b.env_config;
          if (b.install) e.install = { ...b.install };
          if (!e.launch && b.launch) e.launch = b.launch;
        }
      }
    } catch {
    }
    for (const entry of catalog) {
      const e = entry;
      const spec = this._loginSpec(e.name);
      if (!spec) continue;
      const checkReady = e.check_ready || {};
      e.check_ready = { ...checkReady, login_command: spec.loginCommand };
    }
    for (const entry of catalog) {
      const e = entry;
      const idx = CORE_AGENT_ORDER.get(e.name);
      e.comingSoon = idx === void 0;
      e.coreOrder = idx ?? 999;
    }
    return catalog;
  }
  async getEnvFields(agentType) {
    if (HOSTED_LOGIN_AGENTS[agentType]) return [];
    const override = launcherAuthFields(agentType);
    if (override) return override;
    try {
      this._ensureConnector();
      const getEnvFields = this._connector.getEnvFields;
      const fields = getEnvFields.call(this._connector, agentType);
      if (Array.isArray(fields)) return fields;
    } catch {
    }
    return this._fallbackEnvFields(agentType);
  }
  /**
   * env_config from the bundled registry for a single agent. Used when the
   * connector isn't loaded yet so onboarding's API-key step still renders the
   * right fields. Mirrors _fallbackCatalog.
   */
  _fallbackEnvFields(agentType) {
    const entries = Array.isArray(BUNDLED_REGISTRY) ? BUNDLED_REGISTRY : [];
    const entry = entries.find((e) => e.name === agentType);
    const env = entry?.env_config;
    return Array.isArray(env) ? env : [];
  }
  getAgentEnv(agentType) {
    const getAgentEnv = this._connector.getAgentEnv;
    return getAgentEnv.call(this._connector, agentType);
  }
  getAgentInstanceEnv(agentName) {
    const getInstanceEnv = this._connector.getAgentInstanceEnv;
    return getInstanceEnv.call(this._connector, agentName);
  }
  deleteAgentEnv(agentType) {
    const deleteEnv = this._connector.deleteAgentEnv;
    return deleteEnv.call(this._connector, agentType);
  }
  saveAgentEnv(agentType, env) {
    env = normalizeEnvForSave(env);
    const saveEnv = this._connector.saveAgentEnv;
    saveEnv.call(this._connector, agentType, env);
    try {
      if (agentType === "openclaw") {
        const OpenClawAdapter = require("@openagents-org/agent-launcher/src/adapters/openclaw");
        OpenClawAdapter.configureNativeAuth(env);
      }
    } catch {
    }
    this.signalReload();
    return { success: true };
  }
  saveAgentInstanceEnv(agentName, env) {
    env = normalizeEnvForSave(env);
    const saveEnv = this._connector.saveAgentInstanceEnv;
    saveEnv.call(this._connector, agentName, env);
    this.signalReload();
    return { success: true };
  }
  async testLLM(env) {
    if ((env.AMP_API_KEY || "").trim()) {
      return this._testAmpConnection(env);
    }
    return testLLMConnection(env);
  }
  /**
   * Verify an Amp API key the way Amp itself does. Amp authenticates against
   * Sourcegraph's own service (no OpenAI-style endpoint to probe), so we run the
   * installed CLI's `amp usage` with the key injected: it prints the account's
   * credit balance for a valid token and AMP_LOGGED_OUT's error otherwise. Falls
   * back to an honest message when the CLI isn't installed yet — install Amp
   * first, then test (or run `amp login`).
   */
  _testAmpConnection(env) {
    return new Promise((resolve) => {
      const bin = this.resolveBinary("amp");
      if (!bin) {
        resolve({
          success: false,
          error: "Amp CLI not found — install Amp first, then test (or run `amp login`)."
        });
        return;
      }
      const extra = {};
      const key = (env.AMP_API_KEY || "").trim();
      if (key) extra.AMP_API_KEY = key;
      const url = (env.AMP_URL || "").trim();
      if (url) extra.AMP_URL = url;
      let out = "";
      let settled = false;
      const done = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      let child;
      try {
        child = this._spawnAgentCli(bin, ["usage"], extra);
      } catch (e) {
        done({
          success: false,
          error: e?.message || "Failed to run amp"
        });
        return;
      }
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
        }
        done({ success: false, error: "Request timed out" });
      }, 15e3);
      child.stdout?.on("data", (c) => out += c.toString("utf-8"));
      child.stderr?.on("data", (c) => out += c.toString("utf-8"));
      child.on(
        "error",
        (e) => done({ success: false, error: e?.message || "Failed to run amp" })
      );
      child.on("close", () => {
        if (AMP_LOGGED_OUT.test(out)) {
          done({
            success: false,
            error: "Invalid or missing Amp API key — check the key or run `amp login`."
          });
          return;
        }
        const clean = out.replace(/\x1b\[[0-9;=?]*[a-zA-Z]/g, "").replace(/\s+/g, " ").trim();
        done({ success: true, model: "amp", response: clean.slice(0, 80) });
      });
    });
  }
  signalReload() {
    const getDaemonPid = this._connector.getDaemonPid;
    const pid = getDaemonPid.call(this._connector);
    if (!pid) return;
    if (process.platform === "win32") {
      const sendCmd = this._connector.sendDaemonCommand;
      sendCmd.call(this._connector, "reload");
    } else {
      try {
        process.kill(pid, "SIGHUP");
      } catch {
      }
    }
  }
  getNetworks() {
    const listWorkspaces = this._connector.listWorkspaces;
    return listWorkspaces.call(this._connector);
  }
  async createWorkspace(name) {
    const createWorkspace = this._connector.createWorkspace;
    return createWorkspace.call(this._connector, {
      name: name || "My Workspace"
    });
  }
  // Extract the bare token from an official workspace.openagents.org link.
  // Accepts both ?token=<t> and /<t> (first path segment) forms. Returns null
  // for non-official hosts (handled by parseCustomWorkspaceUrl) or bare tokens.
  extractOfficialWorkspaceToken(urlStr) {
    try {
      const u = new URL(urlStr.trim());
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      if (u.hostname.toLowerCase() !== "workspace.openagents.org") return null;
      const fromQuery = u.searchParams.get("token");
      if (fromQuery) return fromQuery.trim();
      const firstSegment = u.pathname.replace(/^\//, "").split("/")[0];
      return firstSegment ? firstSegment.trim() : null;
    } catch {
      return null;
    }
  }
  parseCustomWorkspaceUrl(urlStr) {
    try {
      const u = new URL(urlStr.trim());
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      const host = u.hostname.toLowerCase();
      if (host === "workspace.openagents.org") {
        return null;
      }
      const endpoint = u.origin;
      const slug = u.pathname.replace(/^\//, "").split("/")[0] || void 0;
      const token = u.searchParams.get("token") || void 0;
      return { endpoint, slug, token };
    } catch {
      return null;
    }
  }
  async registerWorkspaceFromToken(input) {
    const officialUrlToken = input.url ? this.extractOfficialWorkspaceToken(input.url) : null;
    const tokenOrSlug = (input.token || input.slug || officialUrlToken || input.url || "").trim();
    if (!tokenOrSlug) throw new Error("Missing workspace URL or token");
    const customParsed = input.url ? this.parseCustomWorkspaceUrl(input.url) : null;
    if (customParsed) {
      const slug2 = input.slug || customParsed.slug;
      const token = input.token || customParsed.token;
      if (!slug2)
        throw new Error(
          "Custom workspace URL must include slug (first path segment) or provide slug explicitly"
        );
      if (!token)
        throw new Error(
          "Custom workspace URL must include token query parameter or provide token explicitly"
        );
      const config2 = this._connector.config;
      const addNetwork2 = config2.addNetwork;
      addNetwork2.call(config2, {
        id: slug2,
        slug: slug2,
        name: slug2,
        endpoint: customParsed.endpoint,
        token
      });
      this.signalReload();
      return {
        id: slug2,
        slug: slug2,
        name: slug2,
        endpoint: customParsed.endpoint,
        token
      };
    }
    const resolveToken = this._connector.resolveToken;
    const info = await resolveToken.call(this._connector, tokenOrSlug);
    const slug = info.slug || info.workspace_id || input.slug;
    if (!slug) throw new Error("Could not resolve workspace from input");
    const endpoint = info.endpoint || this.configuredWorkspaceEndpoint();
    const config = this._connector.config;
    const addNetwork = config.addNetwork;
    addNetwork.call(config, {
      id: info.workspace_id || slug,
      slug,
      name: info.name || slug,
      endpoint,
      token: input.token || tokenOrSlug
    });
    this.signalReload();
    return {
      id: info.workspace_id || slug,
      slug,
      name: info.name || slug,
      endpoint,
      token: input.token || tokenOrSlug
    };
  }
  async connectWorkspace(agentName, tokenOrSlug) {
    const connectWorkspace = this._connector.connectWorkspace;
    const networks = this.getNetworks();
    const known = networks.find(
      (network) => network.slug === tokenOrSlug || network.id === tokenOrSlug
    );
    if (known) {
      connectWorkspace.call(
        this._connector,
        agentName,
        known.slug || tokenOrSlug
      );
      this.signalReload();
      return { success: true };
    }
    const resolveToken = this._connector.resolveToken;
    const info = await resolveToken.call(this._connector, tokenOrSlug);
    const slug = info.slug || info.workspace_id;
    const wsName = info.name || slug;
    const endpoint = info.endpoint || this.configuredWorkspaceEndpoint();
    const addNetwork = this._connector.config.addNetwork;
    addNetwork.call(this._connector.config, {
      id: info.workspace_id || slug,
      slug,
      name: wsName,
      endpoint,
      token: tokenOrSlug
    });
    connectWorkspace.call(this._connector, agentName, slug);
    this.signalReload();
    return { success: true };
  }
  async disconnectWorkspace(agentName) {
    const disconnectWorkspace = this._connector.disconnectWorkspace;
    disconnectWorkspace.call(this._connector, agentName);
    this.signalReload();
    return { success: true };
  }
  async removeWorkspace(slug) {
    const removeWorkspace = this._connector.removeWorkspace;
    const result = await removeWorkspace.call(this._connector, slug);
    this.signalReload();
    return result;
  }
  // ─── Onboarding ───────────────────────────────────────────────
  //
  // The onboarding flow used to drive provisioning from the renderer with three
  // separate IPC calls (createWorkspace → addAgent → connectWorkspace) and
  // swallowed errors. That was the source of the "Agent 'x-1' not found" toast:
  // the picker offered agents the loaded core couldn't run, addAgent threw
  // "not supported", the renderer ate the error, and the follow-up bind failed
  // because the agent was never persisted. The two methods below replace that
  // with a runnable-only picker and a single atomic, verified provisioning step.
  /**
   * Agents to offer in onboarding. Returns ONLY types the loaded core can
   * actually run (intersection with ADAPTER_MAP) and resolves each agent's auth
   * requirements from the bundled registry first (authoritative), then the live
   * catalog. Returns [] when the core hasn't finished installing yet so the
   * renderer keeps polling instead of rendering a wrong empty/again state.
   */
  async getOnboardingAgents() {
    const supported = this.getSupportedAgentTypes();
    if (supported.length === 0) return [];
    let catalog = [];
    try {
      catalog = await this.getCatalog(false);
    } catch {
    }
    const catalogByName = new Map(
      catalog.map((c) => [c.name, c])
    );
    const bundled = Array.isArray(BUNDLED_REGISTRY) ? BUNDLED_REGISTRY : [];
    const bundledByName = new Map(
      bundled.map((b) => [b.name, b])
    );
    const result = supported.filter((type) => CORE_AGENTS.includes(type)).map((type) => {
      const cat = catalogByName.get(type);
      const reg = bundledByName.get(type);
      const regEnv = reg?.env_config || [];
      const catEnv = cat?.env_config || [];
      const checkReady = reg?.check_ready || cat?.check_ready || {};
      const override = launcherAuthFields(type);
      const hostedLogin = HOSTED_LOGIN_AGENTS[type];
      const dualLogin = DUAL_LOGIN_AGENTS[type];
      const keyOptionalLogin = KEY_OPTIONAL_LOGIN_AGENTS.has(type);
      const envFields = hostedLogin ? [] : override || (regEnv.length > 0 ? regEnv : catEnv);
      const loginCommand = hostedLogin ? hostedLogin.loginCommand : dualLogin ? dualLogin.loginCommand : override ? keyOptionalLogin ? checkReady.login_command || null : null : checkReady.login_command || null;
      const preferLogin = (!!checkReady.prefer_login || !!dualLogin || keyOptionalLogin) && !!loginCommand;
      const authMode = preferLogin ? "login" : envFields.length > 0 ? "env" : loginCommand ? "login" : "none";
      return {
        name: type,
        label: cat?.label || reg?.label || type,
        description: cat?.description || reg?.description || "",
        featured: !!(cat?.featured ?? reg?.featured),
        order: cat?.order ?? reg?.order ?? 99,
        installed: !!cat?.installed,
        authMode,
        loginCommand,
        envFields,
        docsUrl: cat?.homepage || cat?.docs || reg?.homepage || null,
        notReadyMessage: checkReady.not_ready_message || null
      };
    });
    result.sort((a, b) => {
      if ((b.featured ? 1 : 0) !== (a.featured ? 1 : 0))
        return (b.featured ? 1 : 0) - (a.featured ? 1 : 0);
      return a.order - b.order;
    });
    return result;
  }
  /**
   * Atomically provision the onboarding agent and (optionally) a workspace.
   * Ordering and verification live here in the main process so failures surface
   * as precise errors instead of a misleading "not found" downstream:
   *   1. validate the type is runnable
   *   2. ensure the agent instance exists in daemon.yaml (idempotent) + verify
   *   3. if a workspace name is given, create it, persist the network locally,
   *      and bind the agent by SLUG. This step is best-effort: the agent is
   *      already usable, so a workspace-service failure returns a warning
   *      rather than aborting onboarding.
   */
  async provisionFirstAgent(opts) {
    this._ensureConnector();
    const type = (opts.agentType || "").trim();
    const name = (opts.agentName || "").trim();
    if (!type) throw new Error("No agent type was selected");
    if (!name) throw new Error("Missing agent name");
    const supported = this.getSupportedAgentTypes();
    if (supported.length > 0 && !supported.includes(type)) {
      throw new Error(
        `Agent type '${type}' isn't supported by the installed runtime. Update the Launcher and try again.`
      );
    }
    const listAgents = this._connector.listAgents;
    const agentExists = () => (listAgents.call(this._connector) || []).some((a) => a.name === name);
    const agentPath = (opts.path || "").trim();
    if (agentPath) {
      try {
        fs.mkdirSync(agentPath, { recursive: true });
      } catch (e) {
        throw new Error(
          `Could not create the agent folder '${agentPath}': ${e.message}`
        );
      }
    }
    if (!agentExists()) {
      const addAgent = this._connector.addAgent;
      addAgent.call(this._connector, {
        name,
        type,
        role: "worker",
        ...agentPath ? { path: agentPath } : {}
      });
      this._agentsCache = { value: [], at: 0 };
    }
    if (!agentExists()) {
      throw new Error(
        `Failed to register agent '${name}' — the runtime did not persist it.`
      );
    }
    const wsName = (opts.workspaceName || "").trim();
    if (!wsName) {
      this.signalReload();
      return {
        agentName: name,
        workspaceSlug: null,
        workspaceName: null,
        warning: null
      };
    }
    try {
      const createWorkspace = this._connector.createWorkspace;
      const ws = await createWorkspace.call(this._connector, { name: wsName });
      const slug = ws?.slug;
      if (!slug) throw new Error("workspace service returned no slug");
      const config = this._connector.config;
      const addNetwork = config.addNetwork;
      addNetwork.call(config, {
        // The workspace service may return only a slug (no id). Persisting
        // id: null makes the daemon adapter join a null network → every
        // poll/heartbeat fails "Network not found". Fall back to the slug,
        // which is the server's canonical workspace identifier.
        id: ws.id || slug,
        slug,
        name: ws.name || wsName,
        endpoint: ws.endpoint || this.configuredWorkspaceEndpoint(),
        token: ws.token
      });
      const connect = this._connector.connectWorkspace;
      connect.call(this._connector, name, slug);
      this.signalReload();
      return {
        agentName: name,
        workspaceSlug: slug,
        workspaceName: ws.name || wsName,
        warning: null
      };
    } catch (e) {
      this.signalReload();
      return {
        agentName: name,
        workspaceSlug: null,
        workspaceName: null,
        warning: `Agent is ready, but workspace setup failed: ${e.message}. You can create one later from the Workspaces tab.`
      };
    }
  }
  async checkAgentType(agentType) {
    const isInstalled = this._connector.isInstalled;
    const installed = isInstalled.call(this._connector, agentType);
    const installer = this._connector.installer;
    const which = installer.which;
    const binary = installed ? which.call(installer, agentType) : null;
    return { installed, binary: binary || null };
  }
  async installAgentType(agentType) {
    const install = this._connector.install;
    const result = await install.call(this._connector, agentType);
    this._recordInstall(agentType);
    this.clearCatalogCache();
    return result;
  }
  async installAgentTypeStreaming(agentType, onData) {
    const installer = this._connector.installer;
    const installStreaming = installer.installStreaming;
    const result = await installStreaming.call(installer, agentType, onData);
    this._recordInstall(agentType);
    this.clearCatalogCache();
    return result;
  }
  async uninstallAgentType(agentType) {
    const uninstall = this._connector.uninstall;
    const result = await uninstall.call(this._connector, agentType);
    this._recordUninstall(agentType);
    this.clearCatalogCache();
    return result;
  }
  async uninstallAgentTypeStreaming(agentType, onData) {
    const installer = this._connector.installer;
    const uninstallStreaming = installer.uninstallStreaming;
    const result = await uninstallStreaming.call(installer, agentType, onData);
    this._recordUninstall(agentType);
    this.clearCatalogCache();
    return result;
  }
  /** Read installed package version by inspecting runtime prefix package.json. */
  getInstalledVersion(agentType) {
    try {
      const entry = this._getRegistryEntry(agentType);
      const npmPkg = this._resolveNpmPackage(entry);
      if (!npmPkg) return null;
      const candidates = [
        path.join(
          CONFIG_DIR,
          "runtimes",
          agentType,
          "node_modules",
          npmPkg,
          "package.json"
        ),
        path.join(CONFIG_DIR, "nodejs", "node_modules", npmPkg, "package.json")
      ];
      for (const c of candidates) {
        try {
          if (fs.existsSync(c)) {
            const pkg = JSON.parse(fs.readFileSync(c, "utf-8"));
            if (pkg?.version) return pkg.version;
          }
        } catch {
        }
      }
    } catch {
    }
    return null;
  }
  _getRegistryEntry(agentType) {
    try {
      const registry = this._connector?.registry;
      if (!registry) return null;
      const getEntry = registry.getEntry;
      const entry = getEntry ? getEntry.call(registry, agentType) : null;
      return entry || null;
    } catch {
      return null;
    }
  }
  _resolveNpmPackage(entry) {
    if (!entry) return null;
    const install = entry.install;
    if (!install) return null;
    if (install.npm_package) return install.npm_package;
    const cmd = install[Installer.platformKey()] || install.command || install.npm;
    if (!cmd) return install.binary;
    const m = cmd.match(
      /npm install\s+(?:-g\s+)?(@?[\w-]+(?:\/[\w-]+)?)(?:@\S*)?$/
    );
    if (m) return m[1];
    return install.binary || null;
  }
  getInstalledHistory() {
    try {
      if (fs.existsSync(INSTALLED_HISTORY_FILE)) {
        const data = JSON.parse(
          fs.readFileSync(INSTALLED_HISTORY_FILE, "utf-8")
        );
        if (data && typeof data === "object") return data;
      }
    } catch {
    }
    return {};
  }
  _writeInstalledHistory(data) {
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      fs.writeFileSync(
        INSTALLED_HISTORY_FILE,
        JSON.stringify(data, null, 2),
        "utf-8"
      );
    } catch {
    }
  }
  _recordInstall(agentType) {
    try {
      const data = this.getInstalledHistory();
      const version = this.getInstalledVersion(agentType);
      const prev = data[agentType];
      const history = prev?.history ? [...prev.history] : [];
      const versionChanged = !!(prev?.version && version && prev.version !== version);
      if (versionChanged) {
        history.unshift({
          version: prev.version,
          installedAt: prev.installedAt
        });
      }
      const nextPreviousVersion = versionChanged ? prev.version : prev?.previousVersion && prev.previousVersion !== version ? prev.previousVersion : null;
      data[agentType] = {
        name: agentType,
        version,
        installedAt: (/* @__PURE__ */ new Date()).toISOString(),
        previousVersion: nextPreviousVersion,
        history: history.slice(0, 10)
      };
      this._writeInstalledHistory(data);
    } catch {
    }
  }
  _recordUninstall(agentType) {
    try {
      const data = this.getInstalledHistory();
      if (data[agentType]) {
        delete data[agentType];
        this._writeInstalledHistory(data);
      }
    } catch {
    }
  }
  listInstalledAgents() {
    const data = this.getInstalledHistory();
    const out = [];
    for (const name of Object.keys(data)) {
      const r = data[name];
      const version = r.version || this.getInstalledVersion(name);
      const cleanHistory = (r.history || []).filter(
        (h) => h.version && h.version !== version
      );
      const cleanPrev = r.previousVersion && r.previousVersion !== version ? r.previousVersion : null;
      out.push({
        ...r,
        version,
        history: cleanHistory,
        previousVersion: cleanPrev
      });
    }
    return out;
  }
  /**
   * Install an npm-backed agent at an arbitrary version specifier (semver
   * version, dist-tag, or anything `npm install pkg@<spec>` accepts).
   * Powers both rollback (previous version) and update-channel installs
   * (stage.md §2.5 — Beta / Nightly).
   */
  async _installAtVersionTag(agentType, target, onData) {
    const entry = this._getRegistryEntry(agentType);
    const npmPkg = this._resolveNpmPackage(entry);
    if (!npmPkg)
      return {
        success: false,
        version: null,
        error: "Cannot determine npm package"
      };
    const { spawn: spawn2 } = require("child_process");
    const prefixDir = path.join(CONFIG_DIR, "runtimes", agentType);
    fs.mkdirSync(prefixDir, { recursive: true });
    const args = [
      "install",
      "--save",
      "--prefix",
      prefixDir,
      `${npmPkg}@${target}`
    ];
    const inv = resolveNpmInvocation$1();
    const portableNodeDir = path.join(CONFIG_DIR, "nodejs");
    if (onData) onData(`$ npm ${args.join(" ")}

`);
    return new Promise((resolve) => {
      const proc = spawn2(inv.cmd, [...inv.preArgs, ...args], {
        shell: inv.useShell,
        cwd: prefixDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: withPathEnv(portableNodeDir + path.delimiter + readPathEnv()),
        windowsHide: true
      });
      proc.stdout?.setEncoding("utf-8");
      proc.stderr?.setEncoding("utf-8");
      proc.stdout?.on("data", (d) => onData && onData(d));
      proc.stderr?.on("data", (d) => onData && onData(d));
      proc.on(
        "error",
        (err) => resolve({ success: false, version: null, error: err.message })
      );
      proc.on("close", (code) => {
        if (code === 0) {
          this._recordInstall(agentType);
          this.clearCatalogCache();
          const resolved = this.getInstalledVersion(agentType) || target;
          if (onData) onData(`
Installed ${npmPkg}@${resolved}.
`);
          resolve({ success: true, version: resolved });
        } else {
          resolve({
            success: false,
            version: null,
            error: `Install failed with code ${code}`
          });
        }
      });
    });
  }
  /**
   * Wrapper that exposes the version-tag installer to the install IPC.
   * Used by the AgentDetail update channel selector (stable / beta / nightly).
   */
  async installAgentTypeAtVersionStreaming(agentType, target, onData) {
    return this._installAtVersionTag(agentType, target, onData);
  }
  async rollbackAgentType(agentType, onData) {
    const data = this.getInstalledHistory();
    const record = data[agentType];
    const current = record?.version || this.getInstalledVersion(agentType);
    const candidates = [
      ...(record?.history || []).map((h) => h.version),
      record?.previousVersion || null
    ].filter((v) => !!v && v !== current);
    const target = candidates[0];
    if (!target)
      return {
        success: false,
        version: null,
        error: "No previous version to roll back to"
      };
    return this._installAtVersionTag(agentType, target, onData);
  }
  async checkAgentUpdates(options = {}) {
    const now = Date.now();
    const ttl = 60 * 60 * 1e3;
    const cacheFresh = this._updatesCache.value.length > 0 && now - this._updatesCache.at < ttl;
    if (!options.force && cacheFresh) {
      return this._updatesCache.value;
    }
    if (this._updatesCache.inFlight) return this._updatesCache.inFlight;
    this._updatesCache.inFlight = this._loadAgentUpdates().then((updates) => {
      this._updatesCache = { value: updates, at: Date.now(), inFlight: null };
      return updates;
    }).catch((err) => {
      this._updatesCache.inFlight = null;
      throw err;
    });
    return this._updatesCache.inFlight;
  }
  async _loadAgentUpdates() {
    const catalog = await this.getCatalog();
    const installedEntries = catalog.filter((e) => e.installed === true);
    const historyByName = new Map(
      this.listInstalledAgents().map((r) => [r.name, r.version])
    );
    const results = await Promise.all(
      installedEntries.map(async (entry) => {
        const name = entry.name;
        const npmPkg = this._resolveNpmPackage(entry);
        const current = historyByName.get(name) || this.getInstalledVersion(name);
        if (!npmPkg) return { name, current, latest: null };
        const info = await fetchNpmInfo(npmPkg).catch(() => null);
        return { name, current, latest: resolveLatestVersion(info) };
      })
    );
    return results;
  }
  async getAgentChangelog(agentType) {
    const entry = this._getRegistryEntry(agentType);
    const homepage = entry?.homepage || void 0;
    const npmPkg = this._resolveNpmPackage(entry);
    if (!npmPkg)
      return { versions: [], homepage, latest: null, error: "No npm package" };
    try {
      const info = await fetchNpmInfo(npmPkg);
      const time = info.time || {};
      const versions = sortedPublishedVersions(info, {
        includePreRelease: true
      }).slice(0, 12).map((v) => ({ version: v, date: time[v] }));
      return { versions, homepage, latest: resolveLatestVersion(info) };
    } catch (e) {
      return {
        versions: [],
        homepage,
        latest: null,
        error: e.message
      };
    }
  }
  async startAgent(name) {
    const ready = await this._ensureDaemon();
    if (!ready)
      throw new Error(
        "Daemon failed to start. Check the Logs page for details."
      );
    const sendCmd = this._connector.sendDaemonCommand;
    sendCmd.call(this._connector, `start:${name}`);
    this._statusCache = { value: {}, at: 0 };
    return { success: true, message: `Start command sent for ${name}` };
  }
  async stopAgent(name) {
    const pid = this._getLiveDaemonPid();
    if (!pid) return { success: true, message: "Daemon not running" };
    const sendCmd = this._connector.sendDaemonCommand;
    sendCmd.call(this._connector, `stop:${name}`);
    this._statusCache = { value: {}, at: 0 };
    return { success: true, message: `Stop command sent for ${name}` };
  }
  async startAll() {
    const ready = await this._ensureDaemon();
    if (!ready)
      throw new Error(
        "Daemon failed to start. Check the Logs page for details."
      );
    const sendCmd = this._connector.sendDaemonCommand;
    sendCmd.call(this._connector, "reload");
    return { success: true, message: "Start all command sent" };
  }
  async stopAll() {
    const stopDaemon = this._connector.stopDaemon;
    const stopped = stopDaemon.call(this._connector);
    return {
      success: stopped,
      message: stopped ? "Daemon stopped" : "Daemon not running"
    };
  }
  async _ensureDaemon() {
    const pid = this._getLiveDaemonPid();
    if (pid) return true;
    const result = await this._startDaemon();
    if (!result.success) appendDaemonLog(result.message);
    return !!(result.success && result.pid);
  }
  getAllStatus() {
    const now = Date.now();
    if (this._statusCache.value && now - this._statusCache.at < 1e3) {
      return this._statusCache.value;
    }
    let value = {};
    if (this._getLiveDaemonPid()) {
      const getDaemonStatus = this._connector.getDaemonStatus;
      try {
        value = getDaemonStatus.call(this._connector);
      } catch {
        value = {};
      }
    }
    this._statusCache = { value, at: now };
    return value;
  }
  getLogs(name, lines = 200) {
    const getLogs = this._connector.getLogs;
    const logLines = getLogs.call(this._connector, name, lines);
    return { lines: logLines };
  }
  tailLogs(name, lines = 200, offset = 0) {
    const config = this._connector.config;
    const tailLogs = config.tailLogs;
    return tailLogs.call(config, { agent: name || void 0, lines, offset });
  }
  clearLogsInRange(start, end) {
    const startTime = normalizeTimeValue(start);
    const endTime = normalizeTimeValue(end);
    if (!startTime || !endTime) {
      throw new Error("Start time and end time are required");
    }
    if (startTime.getTime() > endTime.getTime()) {
      throw new Error("Start time must be before end time");
    }
    const logFile = path.join(CONFIG_DIR, "daemon.log");
    if (!fs.existsSync(logFile)) return { removed: 0, remaining: 0 };
    const content = fs.readFileSync(logFile, "utf-8");
    const hasTrailingNewline = content.endsWith("\n");
    const allLines = content.split("\n");
    if (hasTrailingNewline) allLines.pop();
    const { keptLines, removed } = filterLogsByTimeRange(
      allLines,
      startTime,
      endTime
    );
    const nextContent = keptLines.join("\n") + (hasTrailingNewline && keptLines.length > 0 ? "\n" : "");
    const nextBytes = Buffer.from(nextContent, "utf-8");
    const fd = fs.openSync(logFile, "r+");
    try {
      if (nextBytes.length > 0)
        fs.writeSync(fd, nextBytes, 0, nextBytes.length, 0);
      fs.ftruncateSync(fd, nextBytes.length);
    } finally {
      fs.closeSync(fd);
    }
    return { removed, remaining: keptLines.length };
  }
  healthCheck(type) {
    if (HOSTED_LOGIN_AGENTS[type]) return this._hostedLoginHealth(type);
    const healthCheck = this._connector.healthCheck;
    const core2 = healthCheck.call(this._connector, type);
    if (DUAL_LOGIN_AGENTS[type]) return this._dualLoginHealth(type, core2);
    return core2;
  }
  /**
   * Combine a dual-auth agent's core (API-key) health with its CLI sign-in
   * state. `logged_in` is the cached probe value (true / false / null-unknown);
   * the read is non-blocking and kicks a background `status` probe when stale.
   * Ready = installed AND (signed in OR an API key is configured).
   */
  _dualLoginHealth(type, core2) {
    const h = core2 && typeof core2 === "object" ? core2 : {};
    const loggedIn = this._hostedLoginIsAuthed(type);
    const installed = this._isInstalled(type) || h.installed === true;
    const hasKey = h.ready === true || h.auth_mode === "api_key" || this._hasConfiguredCredentials(type);
    const ready = installed && (loggedIn === true || hasKey);
    return {
      ...h,
      installed,
      ready,
      logged_in: loggedIn,
      reason: ready ? READY_REASON.READY : !installed ? READY_REASON.NOT_INSTALLED : READY_REASON.LOGIN_REQUIRED,
      auth_mode: loggedIn === true ? "cli_login" : hasKey ? "api_key" : h.auth_mode ?? null,
      // Installed-but-signed-out is Login-required, not "not installed". Uses the
      // agent's own registry hint (e.g. amp → "run: amp login or set
      // AMP_API_KEY") instead of a Claude-specific string.
      message: ready ? "Ready" : !installed ? this._notInstalledMessage(type) : this._loginRequiredMessage(type)
    };
  }
  /**
   * Daemon liveness from the launcher's perspective, independent of whether
   * any agents are configured. Used by the sidebar status dot — relying on
   * agent state means "no agents" looks identical to "daemon dead", which
   * makes the launcher feel broken on first run / after every install
   * failure.
   */
  getDaemonState() {
    const pid = this._getLiveDaemonPid();
    if (pid) return { state: "online", pid };
    try {
      const raw = fs.readFileSync(DAEMON_PID_FILE, "utf-8").trim();
      const candidatePid = parseInt(raw, 10);
      if (Number.isFinite(candidatePid) && isPidAlive(candidatePid)) {
        const age = Date.now() - fs.statSync(DAEMON_PID_FILE).mtimeMs;
        if (age < 15e3) return { state: "starting", pid: candidatePid };
      }
    } catch {
    }
    return { state: "offline", pid: null };
  }
  _getLiveDaemonPid() {
    try {
      const getDaemonPid = this._connector?.getDaemonPid;
      const pidFromFile = getDaemonPid ? getDaemonPid.call(this._connector) : null;
      const pidFileAge = (() => {
        try {
          return Date.now() - fs.statSync(DAEMON_PID_FILE).mtimeMs;
        } catch {
          return Number.POSITIVE_INFINITY;
        }
      })();
      const statusInfo = (() => {
        try {
          const stat = fs.statSync(DAEMON_STATUS_FILE);
          const raw = JSON.parse(
            fs.readFileSync(DAEMON_STATUS_FILE, "utf-8")
          );
          return { pid: raw.pid || null, age: Date.now() - stat.mtimeMs };
        } catch {
          return { pid: null, age: Number.POSITIVE_INFINITY };
        }
      })();
      const startupGraceMs = 15e3;
      const statusFreshMs = 2e4;
      const candidates = [];
      if (pidFromFile) candidates.push(pidFromFile);
      if (statusInfo.pid && statusInfo.pid !== pidFromFile)
        candidates.push(statusInfo.pid);
      for (const pid of candidates) {
        const hasFreshMatchingStatus = statusInfo.pid === pid && statusInfo.age < statusFreshMs;
        if (isPidAlive(pid) && (pidFileAge < startupGraceMs || hasFreshMatchingStatus)) {
          if (pidFromFile !== pid) {
            try {
              fs.writeFileSync(DAEMON_PID_FILE, String(pid), "utf-8");
            } catch {
            }
          }
          return pid;
        }
      }
      if (pidFromFile || statusInfo.pid) {
        appendDaemonLog(
          `removing stale daemon pid ${pidFromFile || statusInfo.pid}`
        );
      }
      for (const file of [
        DAEMON_PID_FILE,
        DAEMON_STATUS_FILE,
        DAEMON_CMD_FILE
      ]) {
        try {
          fs.unlinkSync(file);
        } catch {
        }
      }
      this._statusCache = { value: {}, at: 0 };
      return null;
    } catch {
      return null;
    }
  }
  _startDaemon() {
    try {
      const stopDaemon = this._connector.stopDaemon;
      stopDaemon.call(this._connector);
    } catch {
    }
    const { spawn: spawn2 } = require("child_process");
    const portableNodeDir = path.join(CONFIG_DIR, "nodejs");
    const openagentsDir = CONFIG_DIR;
    const extraDirs = [portableNodeDir, path.join(portableNodeDir, "bin")];
    const runtimesDir = path.join(openagentsDir, "runtimes");
    try {
      for (const d of fs.readdirSync(runtimesDir, { withFileTypes: true })) {
        if (d.isDirectory())
          extraDirs.push(path.join(runtimesDir, d.name, "node_modules", ".bin"));
      }
    } catch {
    }
    extraDirs.push(path.join(openagentsDir, "core", "node_modules", ".bin"));
    extraDirs.push(path.join(portableNodeDir, "node_modules", ".bin"));
    if (process.platform === "win32") {
      extraDirs.push(path.join(process.env.APPDATA || "", "npm"));
      try {
        const { execSync: _exec } = require("child_process");
        const npmPrefix = _exec("npm config get prefix", {
          encoding: "utf-8",
          timeout: 5e3,
          windowsHide: true
        }).trim();
        if (npmPrefix && !extraDirs.includes(npmPrefix))
          extraDirs.push(npmPrefix);
      } catch {
      }
    }
    const enhancedPath = [...extraDirs, process.env.PATH || ""].join(
      path.delimiter
    );
    let bundledCli = null;
    try {
      const pkg = require.resolve("@openagents-org/agent-launcher/package.json");
      let p = path.join(path.dirname(pkg), "bin", "agent-connector.js");
      if (p.includes("app.asar") && !p.includes("app.asar.unpacked"))
        p = p.replace("app.asar", "app.asar.unpacked");
      bundledCli = p;
    } catch {
    }
    let cliPath = null;
    const cliCandidates = [
      path.join(LOCAL_CORE$1, "bin", "agent-connector.js"),
      path.join(
        portableNodeDir,
        "node_modules",
        "@openagents-org",
        "agent-launcher",
        "bin",
        "agent-connector.js"
      ),
      ...bundledCli ? [bundledCli] : []
    ];
    for (const c of cliCandidates) {
      try {
        if (fs.existsSync(c)) {
          cliPath = c;
          break;
        }
      } catch {
      }
    }
    if (!cliPath) {
      appendDaemonLog(
        `agent-launcher CLI not found; checked ${cliCandidates.join(", ")}`
      );
      return {
        success: false,
        message: "agent-launcher CLI not found. Install an agent first via the Install tab."
      };
    }
    let nodeBin = resolveWorkingNode(portableNodeDir, enhancedPath);
    const daemonEnv = { ...process.env };
    if (!nodeBin) {
      nodeBin = process.execPath;
      daemonEnv.ELECTRON_RUN_AS_NODE = "1";
      appendDaemonLog(
        `no portable/system node usable; running daemon via Electron-as-node (${nodeBin})`
      );
    }
    try {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      const logFd = fs.openSync(DAEMON_LOG_FILE, "a");
      appendDaemonLog(`starting daemon: node="${nodeBin}" cli="${cliPath}"`);
      const proc = spawn2(nodeBin, [cliPath, "up", "--foreground"], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: withPathEnv(enhancedPath, daemonEnv),
        windowsHide: true
      });
      proc.once("error", (err) => {
        appendDaemonLog(`daemon spawn error: ${err.message}`);
      });
      proc.once(
        "exit",
        (code, signal) => {
          appendDaemonLog(
            `daemon process exited early: code=${code ?? "null"} signal=${signal ?? "null"}`
          );
        }
      );
      proc.unref();
      fs.writeFileSync(DAEMON_PID_FILE, String(proc.pid), "utf-8");
      fs.closeSync(logFd);
      return {
        success: true,
        pid: proc.pid,
        message: `Daemon started (PID ${proc.pid})`
      };
    } catch (e) {
      return {
        success: false,
        message: `Failed to start daemon: ${e.message}`
      };
    }
  }
  // ─────────────────────────────────────────────────────────
  // Stage 3.1 — Workspace chat (send / get / poll messages)
  // Mirrors the legacy launcher's pattern: chat lives on AgentManager
  // and is invoked from the main process via IPC.
  // ─────────────────────────────────────────────────────────
  _getWorkspaceClient() {
    if (!this._connector) return null;
    const ws = this._connector.workspace;
    if (!ws) return null;
    return ws;
  }
  _resolveChatWorkspace(workspaceId) {
    const list = this.getNetworks();
    const match = list.find(
      (w) => w.id === workspaceId || w.slug === workspaceId
    );
    if (!match) return null;
    return {
      id: match.id || match.slug,
      slug: match.slug || match.id,
      name: match.name,
      endpoint: match.endpoint,
      token: match.token || ""
    };
  }
  async sendChatMessage(input) {
    const ws = this._resolveChatWorkspace(input.workspaceId);
    if (!ws)
      return { success: false, messageId: "", error: "Workspace not found" };
    if (!ws.token)
      return { success: false, messageId: "", error: "Workspace has no token" };
    const client = this._getWorkspaceClient();
    if (!client)
      return {
        success: false,
        messageId: "",
        error: "Workspace client unavailable"
      };
    const channelName = input.channelName || DEFAULT_CHAT_CHANNEL;
    const mentions = input.mentions || extractMentions(input.content);
    const targetAgents = mentions.length > 0 ? mentions : input.agentId ? [input.agentId] : void 0;
    try {
      const result = await client.sendMessage(
        ws.id,
        channelName,
        ws.token,
        input.content,
        {
          senderType: "human",
          senderName: "user",
          messageType: "chat",
          metadata: targetAgents ? { target_agents: targetAgents, mentions } : { mentions },
          attachments: attachmentsToServer(input.attachments)
        }
      );
      this._touchChatSession(
        ws,
        channelName,
        input.content || (input.attachments?.[0]?.filename ?? "")
      );
      return { success: true, messageId: result.id || "" };
    } catch (e) {
      return { success: false, messageId: "", error: e.message };
    }
  }
  async getChatMessages(workspaceId, channelName, limit = 100) {
    const ws = this._resolveChatWorkspace(workspaceId);
    if (!ws) return [];
    const client = this._getWorkspaceClient();
    if (!client) return [];
    const ch = channelName || DEFAULT_CHAT_CHANNEL;
    try {
      const messages = await client.getRecentMessages(
        ws.id,
        ch,
        ws.token,
        limit
      );
      return messages.map(normalizeIncomingMessage);
    } catch {
      return [];
    }
  }
  async listChatParticipants(workspaceId) {
    const ws = this._resolveChatWorkspace(workspaceId);
    if (!ws) return [];
    const client = this._getWorkspaceClient();
    if (!client) return [];
    try {
      return await client.getAgents(ws.id, ws.token);
    } catch {
      return [];
    }
  }
  startChatPolling(workspaceId, channelName) {
    const ws = this._resolveChatWorkspace(workspaceId);
    if (!ws) return null;
    const ch = channelName || DEFAULT_CHAT_CHANNEL;
    const key = `${ws.id}:${ch}`;
    const existing = this._chatPolls.get(key);
    if (existing) {
      existing.refs += 1;
      return { key };
    }
    const state = {
      workspaceId: ws.id,
      channelName: ch,
      token: ws.token,
      cursor: null,
      seenIds: /* @__PURE__ */ new Set(),
      timer: null,
      refs: 1,
      inFlight: false,
      workspace: ws
    };
    void this._seedChatCursor(state);
    state.timer = setInterval(() => {
      void this._pollChatOnce(state);
    }, CHAT_POLL_INTERVAL_MS);
    this._chatPolls.set(key, state);
    return { key };
  }
  stopChatPolling(workspaceId, channelName) {
    const ws = this._resolveChatWorkspace(workspaceId);
    if (!ws) return;
    const ch = channelName || DEFAULT_CHAT_CHANNEL;
    const key = `${ws.id}:${ch}`;
    const state = this._chatPolls.get(key);
    if (!state) return;
    state.refs -= 1;
    if (state.refs <= 0) {
      if (state.timer) clearInterval(state.timer);
      this._chatPolls.delete(key);
    }
  }
  stopAllChatPolling() {
    for (const state of this._chatPolls.values()) {
      if (state.timer) clearInterval(state.timer);
    }
    this._chatPolls.clear();
  }
  async _seedChatCursor(state) {
    const client = this._getWorkspaceClient();
    if (!client) return;
    try {
      const recent = await client.getRecentMessages(
        state.workspaceId,
        state.channelName,
        state.token,
        50
      );
      for (const m of recent) {
        if (m.messageId) state.seenIds.add(m.messageId);
      }
      if (recent.length > 0)
        state.cursor = recent[recent.length - 1].messageId || null;
    } catch {
    }
  }
  async _pollChatOnce(state) {
    if (state.inFlight) return;
    state.inFlight = true;
    try {
      const client = this._getWorkspaceClient();
      if (!client) return;
      const messages = await client.pollMessages(
        state.workspaceId,
        state.channelName,
        state.token,
        {
          after: state.cursor || void 0,
          limit: 50
        }
      );
      let lastId = state.cursor;
      for (const m of messages) {
        if (!m.messageId || state.seenIds.has(m.messageId)) continue;
        state.seenIds.add(m.messageId);
        lastId = m.messageId;
        const enriched = normalizeIncomingMessage(m);
        this.emit("chat-event", {
          type: "message",
          channel: state.channelName,
          workspaceId: state.workspaceId,
          message: enriched
        });
        if (m.senderType !== "human") {
          this._touchChatSession(
            state.workspace,
            state.channelName,
            m.content || ""
          );
        }
      }
      if (lastId) state.cursor = lastId;
    } catch (e) {
      this.emit("chat-event", {
        type: "error",
        channel: state.channelName,
        workspaceId: state.workspaceId,
        error: e.message
      });
    } finally {
      state.inFlight = false;
    }
  }
  listChatSessions(workspaceId) {
    ensureDir(LAUNCHER_SESSIONS_DIR);
    const out = [];
    let wsDirs;
    try {
      wsDirs = fs.readdirSync(LAUNCHER_SESSIONS_DIR);
    } catch {
      return [];
    }
    for (const wsDir of wsDirs) {
      if (workspaceId && wsDir !== workspaceId) continue;
      const dir = path.join(LAUNCHER_SESSIONS_DIR, wsDir);
      let files;
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        try {
          const data = JSON.parse(
            fs.readFileSync(path.join(dir, f), "utf-8")
          );
          out.push(data);
        } catch {
        }
      }
    }
    out.sort((a, b) => {
      const ta = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
      const tb = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
      return tb - ta;
    });
    return out;
  }
  loadChatSession(workspaceId, channelName) {
    try {
      return JSON.parse(
        fs.readFileSync(sessionFilePath(workspaceId, channelName), "utf-8")
      );
    } catch {
      return null;
    }
  }
  deleteChatSession(workspaceId, channelName) {
    try {
      fs.unlinkSync(sessionFilePath(workspaceId, channelName));
      return true;
    } catch {
      return false;
    }
  }
  clearChatSessions(workspaceId) {
    let removed = 0;
    for (const s of this.listChatSessions(workspaceId)) {
      if (this.deleteChatSession(s.workspaceId, s.channelName)) removed++;
    }
    return removed;
  }
  createChatSession(workspaceId) {
    const ws = this._resolveChatWorkspace(workspaceId);
    if (!ws) throw new Error("Workspace not found");
    const dir = path.join(LAUNCHER_SESSIONS_DIR, ws.id);
    ensureDir(dir);
    let channelName = "";
    let file = "";
    do {
      channelName = `chat-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      file = path.join(dir, `${channelName}.json`);
    } while (fs.existsSync(file));
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const meta = {
      id: `${ws.id}:${channelName}`,
      workspaceId: ws.id,
      workspaceSlug: ws.slug,
      workspaceName: ws.name,
      channelName,
      title: ws.name || ws.slug || channelName,
      lastMessageAt: null,
      lastMessagePreview: null,
      messageCount: 0,
      participants: [],
      createdAt: now
    };
    fs.writeFileSync(file, JSON.stringify(meta, null, 2), "utf-8");
    return meta;
  }
  _touchChatSession(ws, channelName, preview) {
    try {
      const dir = path.join(LAUNCHER_SESSIONS_DIR, ws.id);
      ensureDir(dir);
      const file = path.join(dir, `${channelName}.json`);
      const existing = (() => {
        try {
          return JSON.parse(fs.readFileSync(file, "utf-8"));
        } catch {
          return null;
        }
      })();
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const cleaned = preview.replace(/\s+/g, " ").trim().slice(0, 140);
      const meta = {
        id: `${ws.id}:${channelName}`,
        workspaceId: ws.id,
        workspaceSlug: ws.slug,
        workspaceName: ws.name,
        channelName,
        title: existing?.title || ws.name || ws.slug || channelName,
        lastMessageAt: now,
        lastMessagePreview: cleaned || existing?.lastMessagePreview || null,
        messageCount: (existing?.messageCount || 0) + 1,
        participants: existing?.participants || [],
        createdAt: existing?.createdAt || now
      };
      fs.writeFileSync(file, JSON.stringify(meta, null, 2), "utf-8");
    } catch {
    }
  }
  async uploadChatFile(workspaceId, filename, contentBase64, opts = {}) {
    const ws = this._resolveChatWorkspace(workspaceId);
    if (!ws) return { success: false, error: "Workspace not found" };
    const client = this._getWorkspaceClient();
    if (!client)
      return { success: false, error: "Workspace client unavailable" };
    try {
      const res = await client.uploadFile(
        ws.id,
        ws.token,
        filename,
        contentBase64,
        {
          contentType: opts.contentType || "application/octet-stream",
          source: "human:user",
          channelName: opts.channelName
        }
      );
      const r = res;
      const fileId = r.id || r.file_id || r.fileId || r.key || void 0;
      return {
        success: true,
        fileId,
        url: r.url || void 0,
        filename: r.filename || filename
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  async listChatFiles(workspaceId, opts = {}) {
    const ws = this._resolveChatWorkspace(workspaceId);
    if (!ws) return { files: [] };
    const client = this._getWorkspaceClient();
    if (!client) return { files: [] };
    try {
      return await client.listFiles(ws.id, ws.token, opts);
    } catch {
      return { files: [] };
    }
  }
  async readChatFile(workspaceId, fileId) {
    const ws = this._resolveChatWorkspace(workspaceId);
    if (!ws) return { success: false, error: "Workspace not found" };
    const client = this._getWorkspaceClient();
    if (!client)
      return { success: false, error: "Workspace client unavailable" };
    try {
      const buf = await client.readFile(ws.id, ws.token, fileId);
      return {
        success: true,
        contentBase64: Buffer.from(buf).toString("base64")
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
  async deleteChatFile(workspaceId, fileId) {
    const ws = this._resolveChatWorkspace(workspaceId);
    if (!ws) return { success: false, error: "Workspace not found" };
    const client = this._getWorkspaceClient();
    if (!client)
      return { success: false, error: "Workspace client unavailable" };
    try {
      await client.deleteFile(ws.id, ws.token, fileId);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
}
class Installer {
  static platformKey() {
    if (process.platform === "darwin") return "macos";
    if (process.platform === "win32") return "windows";
    return "linux";
  }
}
function fetchNpmInfo(pkg) {
  return new Promise((resolve, reject) => {
    const url = `${npmRegistryBase()}/${encodeURIComponent(pkg).replace("%40", "@")}`;
    const req = https.get(
      url,
      { headers: { Accept: "application/json" } },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchNpmInfo(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let data = "";
        res.setEncoding("utf-8");
        res.on("data", (c) => {
          data += c;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(1e4, () => req.destroy(new Error("npm registry timeout")));
  });
}
function compareVersionsDesc(a, b) {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return y - x;
  }
  return 0;
}
function isPreRelease(version) {
  return version.includes("-");
}
function sortedPublishedVersions(info, opts = {}) {
  return Object.keys(info?.versions || {}).filter((v) => /^\d/.test(v)).filter((v) => opts.includePreRelease ? true : !isPreRelease(v)).sort(compareVersionsDesc);
}
function resolveLatestVersion(info) {
  const tagged = info?.["dist-tags"]?.latest;
  if (tagged) return tagged;
  return sortedPublishedVersions(info)[0] || null;
}
function normalizeTimeValue(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}
function filterLogsByTimeRange(lines, start, end) {
  const headerTimes = resolveLogHeaderTimestamps(lines, end);
  let activeRemove = false;
  let removed = 0;
  const keptLines = [];
  for (let index = 0; index < lines.length; index++) {
    const headerTime = headerTimes[index];
    if (headerTime) {
      const time = headerTime.getTime();
      activeRemove = time >= start.getTime() && time <= end.getTime();
    }
    if (activeRemove) {
      removed++;
    } else {
      keptLines.push(lines[index]);
    }
  }
  return { keptLines, removed };
}
function resolveLogHeaderTimestamps(lines, referenceTime) {
  const resolved = new Array(lines.length).fill(null);
  let currentDay = startOfLocalDay(referenceTime);
  let lastClockSeconds = null;
  for (let index = lines.length - 1; index >= 0; index--) {
    const token = parseLogTimestampToken(lines[index]);
    if (!token) continue;
    if (token.kind === "iso") {
      resolved[index] = token.date;
      currentDay = startOfLocalDay(token.date);
      lastClockSeconds = token.date.getHours() * 3600 + token.date.getMinutes() * 60 + token.date.getSeconds();
      continue;
    }
    if (lastClockSeconds !== null && token.seconds > lastClockSeconds) {
      currentDay = addLocalDays(currentDay, -1);
    }
    resolved[index] = withLocalClock(currentDay, token.seconds);
    lastClockSeconds = token.seconds;
  }
  return resolved;
}
function parseLogTimestampToken(line) {
  if (!line) return null;
  const isoMatch = line.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2}))/
  );
  if (isoMatch) {
    const date = new Date(isoMatch[1]);
    if (!Number.isNaN(date.getTime())) return { kind: "iso", date };
  }
  const clockMatch = line.match(/^\[(\d{2}):(\d{2}):(\d{2})\]/);
  if (clockMatch) {
    return {
      kind: "clock",
      seconds: Number(clockMatch[1]) * 3600 + Number(clockMatch[2]) * 60 + Number(clockMatch[3])
    };
  }
  return null;
}
function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
function addLocalDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}
function withLocalClock(day, seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  const secs = seconds % 60;
  return new Date(
    day.getFullYear(),
    day.getMonth(),
    day.getDate(),
    hours,
    minutes,
    secs
  );
}
let activeBackendUrl = process.env.ELECTRON_BACKEND_URL || "http://localhost:8000";
const listeners = /* @__PURE__ */ new Set();
function getBackendUrl() {
  return activeBackendUrl;
}
function setBackendUrl(url) {
  if (activeBackendUrl === url) return;
  activeBackendUrl = url;
  listeners.forEach((listener) => {
    try {
      listener(url);
    } catch (err) {
      console.error("[backend-config] Error in backend URL listener:", err);
    }
  });
}
function onBackendUrlChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
class BackendManager {
  constructor() {
    this.childProcess = null;
    this.currentUrl = "http://localhost:8000";
  }
  getRuntimeDirectory() {
    const isPackaged = electron.app.isPackaged;
    const workspaceRoot = isPackaged ? path.join(process.resourcesPath, "workspace") : path.resolve(__dirname, "../../../../workspace");
    return path.join(workspaceRoot, ".dev-sqlite");
  }
  getPidFilePath() {
    return path.join(this.getRuntimeDirectory(), "backend.pid");
  }
  /**
   * Verifies if the target PID actually corresponds to a 52hzAgent backend server process.
   */
  isMatchingBackendProcess(pid, expectedName) {
    try {
      const allowedNames = /* @__PURE__ */ new Set([
        expectedName.toLowerCase().trim(),
        "server.exe",
        "server",
        "go.exe",
        "go"
      ]);
      if (process.platform === "win32") {
        const stdout = child_process.execSync(`tasklist /FI "PID eq ${pid}" /FO CSV`, { encoding: "utf8" }).trim();
        const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        for (const line of lines) {
          if (line.toLowerCase().startsWith('"image name"')) continue;
          const parts = line.split('","');
          if (parts.length > 0) {
            const imageName = parts[0].replace(/^"/, "").replace(/"$/, "").trim().toLowerCase();
            if (allowedNames.has(imageName)) {
              return true;
            }
          }
        }
        return false;
      } else {
        let comm = "";
        try {
          if (fs.existsSync(`/proc/${pid}/comm`)) {
            comm = fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim().toLowerCase();
          } else {
            comm = child_process.execSync(`ps -p ${pid} -o comm=`, { encoding: "utf8" }).trim().toLowerCase();
          }
        } catch {
          return false;
        }
        const baseComm = path.basename(comm);
        return allowedNames.has(baseComm) || allowedNames.has(comm);
      }
    } catch {
      return false;
    }
  }
  /**
   * Cleans up orphaned backend server processes from previous launcher runs.
   */
  async cleanupOrphans() {
    const pidFile = this.getPidFilePath();
    if (!fs.existsSync(pidFile)) return;
    try {
      const content = fs.readFileSync(pidFile, "utf8").trim();
      let pid = 0;
      let expectedName = "server";
      if (content.startsWith("{")) {
        const record = JSON.parse(content);
        pid = record.pid;
        expectedName = record.name || "server";
        if (record.time && Date.now() - record.time > 14 * 24 * 60 * 60 * 1e3) {
          console.log(`[BackendManager] PID record file is older than 14 days (${new Date(record.time).toISOString()}); ignoring stale record.`);
          pid = 0;
        }
      } else {
        pid = parseInt(content, 10);
      }
      if (!isNaN(pid) && pid > 0) {
        if (this.isMatchingBackendProcess(pid, expectedName)) {
          console.log(`[BackendManager] Verified orphan process PID ${pid} (${expectedName}); terminating process tree...`);
          if (process.platform === "win32") {
            child_process.spawn("taskkill", ["/pid", pid.toString(), "/T", "/F"], { stdio: "ignore" });
          } else {
            try {
              process.kill(-pid, "SIGKILL");
            } catch {
              try {
                process.kill(pid, "SIGKILL");
              } catch {
              }
            }
          }
          await new Promise((r) => setTimeout(r, 500));
        } else {
          console.log(`[BackendManager] PID ${pid} is not a verified backend process; skipping kill.`);
        }
      }
    } catch (err) {
      console.warn("[BackendManager] Failed to clean up orphan PID file:", err);
    } finally {
      try {
        if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
      } catch {
      }
    }
  }
  /**
   * Probe whether a backend is responding with HTTP 200/health at the target URL.
   */
  async probeHealth(url, timeoutMs = 2e3) {
    return new Promise((resolve) => {
      try {
        const healthUrl = `${url.replace(/\/$/, "")}/v1/health`;
        const req = http.get(healthUrl, { timeout: timeoutMs }, (res) => {
          if (res.statusCode === 200) {
            resolve(true);
          } else {
            resolve(false);
          }
        });
        req.on("error", () => resolve(false));
        req.on("timeout", () => {
          req.destroy();
          resolve(false);
        });
      } catch {
        resolve(false);
      }
    });
  }
  /**
   * Main entrypoint: Ensure a backend is active.
   * Probes default port 8000 first (reuse mode).
   * Spawns Go server if no active backend is found.
   */
  async ensureBackend() {
    const defaultUrl = "http://localhost:8000";
    const isAlive = await this.probeHealth(defaultUrl);
    if (isAlive) {
      this.currentUrl = defaultUrl;
      setBackendUrl(defaultUrl);
      console.log(`[BackendManager] Reusing existing backend at ${defaultUrl}`);
      return defaultUrl;
    }
    await this.cleanupOrphans();
    console.log("[BackendManager] No active backend detected. Spawning Go backend server...");
    await this.spawnBackendServer();
    const deadline = Date.now() + 3e4;
    while (Date.now() < deadline) {
      if (await this.probeHealth(defaultUrl, 1e3)) {
        this.currentUrl = defaultUrl;
        setBackendUrl(defaultUrl);
        console.log(`[BackendManager] Successfully spawned & verified backend at ${defaultUrl}`);
        return defaultUrl;
      }
      await new Promise((r) => setTimeout(r, 1e3));
    }
    console.warn(`[BackendManager] Backend spawn timeout; falling back to default ${defaultUrl}`);
    this.currentUrl = defaultUrl;
    setBackendUrl(defaultUrl);
    return defaultUrl;
  }
  /**
   * Spawns the Go backend binary or go run command with appropriate environment variables.
   */
  async spawnBackendServer() {
    const isPackaged = electron.app.isPackaged;
    const workspaceRoot = isPackaged ? path.join(process.resourcesPath, "workspace") : path.resolve(__dirname, "../../../../workspace");
    const runtimePath = path.join(workspaceRoot, ".dev-sqlite");
    const dbPath = path.join(runtimePath, "workspace.db");
    const filesPath = path.join(runtimePath, "files");
    if (!fs.existsSync(runtimePath)) {
      fs.mkdirSync(runtimePath, { recursive: true });
    }
    if (!fs.existsSync(filesPath)) {
      fs.mkdirSync(filesPath, { recursive: true });
    }
    const env = {
      ...process.env,
      CGO_ENABLED: "0",
      DATABASE_URL: `sqlite://${dbPath.replace(/\\/g, "/")}`,
      AUTH_MODE: process.env.AUTH_MODE || "workspace_token",
      CORS_ORIGINS: process.env.CORS_ORIGINS || "http://localhost:3005,http://localhost:3001,http://localhost:3000,app://.",
      FILE_STORAGE_PATH: filesPath,
      REQUESTS_PER_MINUTE: process.env.REQUESTS_PER_MINUTE || "1000",
      ROUTER_LLM_ENABLED: process.env.ROUTER_LLM_ENABLED || "true"
    };
    const binaryName = process.platform === "win32" ? "server.exe" : "server";
    const packagedBinary = path.join(process.resourcesPath, "bin", binaryName);
    const localBackendDir = path.join(workspaceRoot, "backend");
    const isGoRun = !fs.existsSync(packagedBinary) && fs.existsSync(localBackendDir);
    const recordedName = isGoRun ? process.platform === "win32" ? "go.exe" : "go" : binaryName;
    const spawnOpts = {
      env,
      stdio: "ignore",
      detached: process.platform !== "win32"
      // Detached process group on POSIX for clean tree kills
    };
    if (fs.existsSync(packagedBinary)) {
      this.childProcess = child_process.spawn(packagedBinary, [], spawnOpts);
    } else if (fs.existsSync(localBackendDir)) {
      const goCmd = process.platform === "win32" ? "go.exe" : "go";
      this.childProcess = child_process.spawn(goCmd, ["run", "./cmd/server"], {
        cwd: localBackendDir,
        ...spawnOpts
      });
    } else {
      console.error("[BackendManager] Neither binary nor backend source directory found!");
      return;
    }
    if (this.childProcess && this.childProcess.pid) {
      const pidRecord = {
        pid: this.childProcess.pid,
        name: recordedName,
        time: Date.now()
      };
      try {
        fs.writeFileSync(this.getPidFilePath(), JSON.stringify(pidRecord), "utf8");
      } catch (err) {
        console.warn("[BackendManager] Failed to record backend PID:", err);
      }
      this.childProcess.on("exit", (code) => {
        console.log(`[BackendManager] Backend child process exited with code ${code}`);
        this.childProcess = null;
        try {
          const pidFile = this.getPidFilePath();
          if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
        } catch {
        }
      });
    }
  }
  /**
   * Cleanly terminates the spawned child process on app exit.
   */
  stopBackend() {
    if (this.childProcess && this.childProcess.pid) {
      console.log("[BackendManager] Terminating spawned backend child process...");
      try {
        if (process.platform === "win32") {
          child_process.spawn("taskkill", ["/pid", this.childProcess.pid.toString(), "/T", "/F"], { stdio: "ignore" });
        } else {
          try {
            process.kill(-this.childProcess.pid, "SIGKILL");
          } catch {
            this.childProcess.kill("SIGKILL");
          }
        }
      } catch (err) {
        console.error("[BackendManager] Error stopping child process:", err);
      }
      this.childProcess = null;
    }
    try {
      const pidFile = this.getPidFilePath();
      if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    } catch {
    }
  }
}
const backendManager = new BackendManager();
class EmbeddedViewManager {
  constructor() {
    this.view = null;
    this.parentWindow = null;
    this.currentUrl = "http://localhost:3005";
    this.currentBackendUrl = "";
    this.customBounds = null;
    this.isVisible = false;
    this.onResize = null;
    this.unsubscribeBackendChange = null;
    this.unsubscribeBackendChange = onBackendUrlChange((newBackendUrl) => {
      if (this.view && this.currentBackendUrl !== newBackendUrl) {
        console.log(`[EmbeddedViewManager] Live backend URL changed to ${newBackendUrl}; recreating WebContentsView`);
        const parent = this.parentWindow;
        const targetUrl = this.currentUrl;
        const bounds = this.customBounds;
        const wasVisible = this.isVisible;
        this.destroyView();
        if (parent && !parent.isDestroyed() && wasVisible) {
          this.attach(parent, targetUrl);
          this.show(bounds ?? void 0);
        }
      }
    });
  }
  /**
   * Calculates and applies bounds dynamically. Prevents overflow when window is narrow.
   */
  updateBounds() {
    if (!this.view || !this.parentWindow || this.parentWindow.isDestroyed()) return;
    const parentBounds = this.parentWindow.getContentBounds();
    if (this.customBounds) {
      const clampedWidth = Math.min(this.customBounds.width, Math.max(0, parentBounds.width - this.customBounds.x));
      const clampedHeight = Math.min(this.customBounds.height, Math.max(0, parentBounds.height - this.customBounds.y));
      this.view.setBounds({
        x: this.customBounds.x,
        y: this.customBounds.y,
        width: Math.max(0, clampedWidth),
        height: Math.max(0, clampedHeight)
      });
    } else {
      const width = Math.max(0, parentBounds.width - 240);
      this.view.setBounds({
        x: 240,
        y: 0,
        width,
        height: parentBounds.height
      });
    }
  }
  /**
   * Destroys ONLY the WebContentsView instance without resetting parentWindow reference.
   */
  destroyView() {
    this.isVisible = false;
    if (this.view) {
      if (this.parentWindow && !this.parentWindow.isDestroyed()) {
        try {
          this.parentWindow.contentView.removeChildView(this.view);
        } catch {
        }
      }
      if (!this.view.webContents.isDestroyed()) {
        this.view.webContents.close();
      }
      this.view = null;
    }
    this.currentBackendUrl = "";
  }
  /**
   * Initializes or updates the embedded WebContentsView attached to the parent window.
   */
  attach(parentWindow, targetUrl) {
    const activeBackend = getBackendUrl();
    const urlToLoad = targetUrl || process.env.ELECTRON_FRONTEND_URL || "http://localhost:3005";
    this.currentUrl = urlToLoad;
    if (this.parentWindow && this.parentWindow !== parentWindow && this.onResize && !this.parentWindow.isDestroyed()) {
      this.parentWindow.removeListener("resize", this.onResize);
      this.onResize = null;
    }
    this.parentWindow = parentWindow;
    if (this.view && this.currentBackendUrl !== activeBackend) {
      console.log(`[EmbeddedViewManager] Backend URL updated to ${activeBackend}; recreating WebContentsView`);
      this.destroyView();
    }
    if (!this.view) {
      this.currentBackendUrl = activeBackend;
      const preloadPath = path.join(__dirname, "../preload/embedded.js");
      this.view = new electron.WebContentsView({
        webPreferences: {
          preload: preloadPath,
          additionalArguments: [`--backend-url=${activeBackend}`],
          backgroundThrottling: false,
          contextIsolation: true,
          nodeIntegration: false
        }
      });
      this.view.webContents.loadURL(urlToLoad).catch((err) => {
        console.warn("[EmbeddedViewManager] Failed to load URL:", err.message);
      });
    }
    if (!this.onResize && this.parentWindow && !this.parentWindow.isDestroyed()) {
      this.onResize = () => this.updateBounds();
      this.parentWindow.on("resize", this.onResize);
    }
    return this.view;
  }
  /**
   * Shows the embedded WebContentsView over the specified bounds of the parent window.
   */
  show(bounds) {
    if (!this.view || !this.parentWindow || this.parentWindow.isDestroyed()) return;
    this.isVisible = true;
    this.customBounds = bounds ?? null;
    if (!this.parentWindow.contentView.children.includes(this.view)) {
      this.parentWindow.contentView.addChildView(this.view);
    }
    this.updateBounds();
    if (!this.onResize && this.parentWindow && !this.parentWindow.isDestroyed()) {
      this.onResize = () => this.updateBounds();
      this.parentWindow.on("resize", this.onResize);
    }
  }
  /**
   * Hides the embedded WebContentsView from the parent window.
   */
  hide() {
    this.isVisible = false;
    if (this.view && this.parentWindow && !this.parentWindow.isDestroyed()) {
      try {
        this.parentWindow.contentView.removeChildView(this.view);
      } catch {
      }
    }
    if (this.parentWindow && this.onResize && !this.parentWindow.isDestroyed()) {
      this.parentWindow.removeListener("resize", this.onResize);
      this.onResize = null;
    }
  }
  /**
   * Reloads the embedded WebContentsView with a new target URL or workspace context.
   */
  navigate(targetUrl) {
    this.currentUrl = targetUrl;
    if (this.view && !this.view.webContents.isDestroyed()) {
      this.view.webContents.loadURL(targetUrl).catch(() => {
      });
    }
  }
  /**
   * Destroys the view instance cleanly using public Electron APIs.
   */
  destroy() {
    this.hide();
    this.destroyView();
    if (this.unsubscribeBackendChange) {
      this.unsubscribeBackendChange();
      this.unsubscribeBackendChange = null;
    }
    this.parentWindow = null;
    this.customBounds = null;
  }
}
const embeddedViewManager = new EmbeddedViewManager();
const GIT_TIMEOUT_MS = 15e3;
const MAX_BUFFER = 32 * 1024 * 1024;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
function runGit(cwd, args) {
  return new Promise((resolve) => {
    child_process.execFile(
      "git",
      ["-c", "core.quotepath=false", ...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
      }
    );
  });
}
function unquotePath(raw) {
  const value = raw.trim();
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const body = value.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      bytes.push(...Array.from(Buffer.from(ch, "utf8")));
      continue;
    }
    const next = body[++i];
    if (next === void 0) break;
    if (next >= "0" && next <= "7") {
      const octal = next + (body[i + 1] ?? "") + (body[i + 2] ?? "");
      bytes.push(parseInt(octal, 8));
      i += 2;
      continue;
    }
    const escapes = { n: 10, t: 9, r: 13, b: 8, f: 12, a: 7, v: 11 };
    bytes.push(escapes[next] ?? next.charCodeAt(0));
  }
  return Buffer.from(bytes).toString("utf8");
}
function statusFromCodes(index, worktree) {
  if (index === "?" || worktree === "?") return "untracked";
  if (index === "U" || worktree === "U" || index === "A" && worktree === "A" || index === "D" && worktree === "D") {
    return "conflicted";
  }
  const codes = `${index}${worktree}`;
  if (codes.includes("R")) return "renamed";
  if (codes.includes("C")) return "copied";
  if (codes.includes("T")) return "typechange";
  if (index === "A") return "added";
  if (codes.includes("D")) return "deleted";
  return "modified";
}
async function repoInfo(dir) {
  const empty = { isRepo: false, root: null, branch: null, upstream: null, ahead: 0, behind: 0 };
  if (!dir) return { ...empty, error: "no directory" };
  try {
    if (!fs.statSync(dir).isDirectory()) return { ...empty, error: "not a directory" };
  } catch {
    return { ...empty, error: "directory not found" };
  }
  const root = await runGit(dir, ["rev-parse", "--show-toplevel"]);
  if (root.code !== 0) {
    return { ...empty, error: root.stderr.trim() || "not a git repository" };
  }
  const rootPath = root.stdout.trim();
  const branchResult = await runGit(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchResult.code === 0 ? branchResult.stdout.trim() : null;
  const upstreamResult = await runGit(rootPath, [
    "rev-parse",
    "--abbrev-ref",
    "--symbolic-full-name",
    "@{u}"
  ]);
  const upstream = upstreamResult.code === 0 ? upstreamResult.stdout.trim() : null;
  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = await runGit(rootPath, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
    if (counts.code === 0) {
      const [behindRaw, aheadRaw] = counts.stdout.trim().split(/\s+/);
      behind = Number(behindRaw) || 0;
      ahead = Number(aheadRaw) || 0;
    }
  }
  return { isRepo: true, root: rootPath, branch, upstream, ahead, behind };
}
async function numstat(root) {
  const out = /* @__PURE__ */ new Map();
  const head = await runGit(root, ["rev-parse", "--verify", "HEAD"]);
  const args = head.code === 0 ? ["diff", "--numstat", "--find-renames", "HEAD", "--"] : ["diff", "--numstat", "--find-renames", "--cached", "--"];
  const result = await runGit(root, args);
  if (result.code !== 0) return out;
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [addRaw, delRaw, ...rest] = line.split("	");
    const target = rest[rest.length - 1];
    if (!target) continue;
    const binary = addRaw === "-" || delRaw === "-";
    out.set(unquotePath(target), {
      additions: binary ? 0 : Number(addRaw) || 0,
      deletions: binary ? 0 : Number(delRaw) || 0,
      binary
    });
  }
  return out;
}
function countLines(absPath) {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return { additions: 0, binary: false };
    if (stat.size > MAX_DIFF_BYTES) return { additions: 0, binary: false };
    const buffer = fs.readFileSync(absPath);
    if (buffer.subarray(0, 8e3).includes(0)) return { additions: 0, binary: true };
    if (buffer.length === 0) return { additions: 0, binary: false };
    const text = buffer.toString("utf8");
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return { additions: lines.length, binary: false };
  } catch {
    return { additions: 0, binary: false };
  }
}
async function gitStatus(dir) {
  const info = await repoInfo(dir);
  if (!info.isRepo || !info.root) {
    return { ...info, files: [], additions: 0, deletions: 0 };
  }
  const root = info.root;
  const status = await runGit(root, ["status", "--porcelain=v1", "--untracked-files=all", "--find-renames"]);
  if (status.code !== 0) {
    return { ...info, files: [], additions: 0, deletions: 0, error: status.stderr.trim() || "git status failed" };
  }
  const stats = await numstat(root);
  const files = [];
  for (const line of status.stdout.split("\n")) {
    if (line.length < 4) continue;
    const index = line[0];
    const worktree = line[1];
    const rest = line.slice(3);
    const fileStatus = statusFromCodes(index, worktree);
    let filePath;
    let oldPath;
    const arrow = rest.indexOf(" -> ");
    if (arrow !== -1 && (fileStatus === "renamed" || fileStatus === "copied")) {
      oldPath = unquotePath(rest.slice(0, arrow));
      filePath = unquotePath(rest.slice(arrow + 4));
    } else {
      filePath = unquotePath(rest);
    }
    const stat = stats.get(filePath);
    let additions = stat?.additions ?? 0;
    let deletions = stat?.deletions ?? 0;
    let binary = stat?.binary ?? false;
    if (fileStatus === "untracked") {
      const counted = countLines(path.join(root, filePath));
      additions = counted.additions;
      deletions = 0;
      binary = counted.binary;
    }
    files.push({
      path: filePath,
      ...oldPath ? { oldPath } : {},
      status: fileStatus,
      staged: index !== " " && index !== "?",
      unstaged: worktree !== " " && worktree !== "?",
      additions,
      deletions,
      binary
    });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    ...info,
    files,
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0)
  };
}
function parseUnifiedDiff(raw) {
  const hunks = [];
  let current = null;
  let oldNumber = 0;
  let newNumber = 0;
  let binary = false;
  for (const line of raw.split("\n")) {
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      binary = true;
      continue;
    }
    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      oldNumber = match ? Number(match[1]) : 0;
      newNumber = match ? Number(match[2]) : 0;
      current = { header: match ? (match[3] ?? "").trim() : line, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+")) {
      current.lines.push({ type: "add", content: line.slice(1), oldNumber: null, newNumber: newNumber++ });
    } else if (line.startsWith("-")) {
      current.lines.push({ type: "del", content: line.slice(1), oldNumber: oldNumber++, newNumber: null });
    } else if (line.startsWith("\\")) {
      current.lines.push({ type: "meta", content: line.slice(2), oldNumber: null, newNumber: null });
    } else if (line.startsWith(" ")) {
      current.lines.push({
        type: "context",
        content: line.slice(1),
        oldNumber: oldNumber++,
        newNumber: newNumber++
      });
    }
  }
  return { hunks, binary };
}
async function gitDiff(dir, filePath, opts) {
  const empty = { path: filePath, binary: false, tooLarge: false, hunks: [] };
  const info = await repoInfo(dir);
  if (!info.isRepo || !info.root) return { ...empty, error: info.error ?? "not a git repository" };
  const root = info.root;
  const context = Math.max(0, Math.min(20, opts?.context ?? 3));
  const tracked = await runGit(root, ["ls-files", "--error-unmatch", "--", filePath]);
  if (tracked.code !== 0) {
    const abs = path.join(root, filePath);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      return { ...empty, error: "file not found" };
    }
    if (stat.size > MAX_DIFF_BYTES) return { ...empty, tooLarge: true };
    const buffer = fs.readFileSync(abs);
    if (buffer.subarray(0, 8e3).includes(0)) return { ...empty, binary: true };
    const lines = buffer.toString("utf8").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return {
      ...empty,
      hunks: [
        {
          header: "",
          lines: lines.map((content, i) => ({
            type: "add",
            content,
            oldNumber: null,
            newNumber: i + 1
          }))
        }
      ]
    };
  }
  const head = await runGit(root, ["rev-parse", "--verify", "HEAD"]);
  const args = [
    "diff",
    "--no-color",
    "--find-renames",
    `-U${context}`,
    ...head.code === 0 ? ["HEAD"] : ["--cached"],
    "--",
    filePath
  ];
  const result = await runGit(root, args);
  if (result.code !== 0 && !result.stdout) {
    return { ...empty, error: result.stderr.trim() || "git diff failed" };
  }
  const parsed = parseUnifiedDiff(result.stdout);
  return { ...empty, hunks: parsed.hunks, binary: parsed.binary };
}
async function gitFileList(dir) {
  const info = await repoInfo(dir);
  if (!info.isRepo || !info.root) return { root: null, entries: [], error: info.error ?? "not a git repository" };
  const root = info.root;
  const cached = await runGit(root, ["ls-files", "-z"]);
  const others = await runGit(root, ["ls-files", "-z", "--others", "--exclude-standard"]);
  const split = (value) => value.split("\0").filter(Boolean);
  const entries = [
    ...split(cached.stdout).map((p) => ({ path: p, untracked: false })),
    ...split(others.stdout).map((p) => ({ path: p, untracked: true }))
  ];
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { root, entries };
}
async function gitReadFile(dir, filePath) {
  const info = await repoInfo(dir);
  if (!info.isRepo || !info.root) return { content: null, binary: false, tooLarge: false, error: "not a git repository" };
  const root = info.root;
  const abs = path.resolve(root, filePath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return { content: null, binary: false, tooLarge: false, error: "path outside repository" };
  }
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return { content: null, binary: false, tooLarge: false, error: "not a file" };
    if (stat.size > MAX_DIFF_BYTES) return { content: null, binary: false, tooLarge: true };
    const buffer = fs.readFileSync(abs);
    if (buffer.subarray(0, 8e3).includes(0)) return { content: null, binary: true, tooLarge: false };
    return { content: buffer.toString("utf8"), binary: false, tooLarge: false };
  } catch (err) {
    return { content: null, binary: false, tooLarge: false, error: err.message };
  }
}
function registerGitHandlers(ipcMain) {
  ipcMain.handle("git:status", (_e, dir) => gitStatus(dir));
  ipcMain.handle(
    "git:diff",
    (_e, dir, filePath, opts) => gitDiff(dir, filePath, opts)
  );
  ipcMain.handle("git:file-list", (_e, dir) => gitFileList(dir));
  ipcMain.handle("git:read-file", (_e, dir, filePath) => gitReadFile(dir, filePath));
  ipcMain.handle("git:repo-info", (_e, dir) => repoInfo(dir));
}
const FILE_NAME$1 = "connections.json";
function fsId() {
  return crypto.randomBytes(8).toString("hex");
}
class ConnectionsStore {
  constructor() {
    this._path = null;
    this._data = { version: 1, connections: [] };
    this._loaded = false;
  }
  _ensure() {
    if (this._loaded) return;
    this._path = path.join(electron.app.getPath("userData"), FILE_NAME$1);
    try {
      if (fs.existsSync(this._path)) {
        const raw = fs.readFileSync(this._path, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.connections)) {
          this._data = { version: 1, connections: parsed.connections };
        }
      }
    } catch (err) {
      console.error("Failed to load connections.json:", err);
    }
    this._loaded = true;
  }
  _save() {
    if (!this._path) return;
    try {
      fs.mkdirSync(path.dirname(this._path), { recursive: true });
      fs.writeFileSync(this._path, JSON.stringify(this._data, null, 2), "utf-8");
    } catch (err) {
      console.error("Failed to save connections.json:", err);
    }
  }
  list() {
    this._ensure();
    return this._data.connections.map((c) => ({ ...c }));
  }
  get(id2) {
    this._ensure();
    return this._data.connections.find((c) => c.id === id2) || null;
  }
  upsert(record) {
    this._ensure();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    if (record.id) {
      const idx = this._data.connections.findIndex((c) => c.id === record.id);
      if (idx >= 0) {
        const merged = {
          ...this._data.connections[idx],
          ...record,
          id: this._data.connections[idx].id,
          createdAt: this._data.connections[idx].createdAt,
          updatedAt: now
        };
        this._data.connections[idx] = merged;
        this._save();
        return merged;
      }
    }
    const created = {
      id: record.id || fsId(),
      platform: record.platform,
      account: record.account,
      label: record.label,
      status: record.status || "disconnected",
      authKind: record.authKind,
      scopes: record.scopes,
      credentialId: record.credentialId,
      meta: record.meta,
      lastSyncAt: record.lastSyncAt,
      lastError: record.lastError,
      createdAt: now,
      updatedAt: now
    };
    this._data.connections.push(created);
    this._save();
    return created;
  }
  remove(id2) {
    this._ensure();
    const before = this._data.connections.length;
    this._data.connections = this._data.connections.filter((c) => c.id !== id2);
    if (this._data.connections.length !== before) {
      this._save();
      return true;
    }
    return false;
  }
  setStatus(id2, status, lastError) {
    this._ensure();
    const idx = this._data.connections.findIndex((c) => c.id === id2);
    if (idx < 0) return null;
    this._data.connections[idx] = {
      ...this._data.connections[idx],
      status,
      lastError,
      lastSyncAt: (/* @__PURE__ */ new Date()).toISOString(),
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this._save();
    return this._data.connections[idx];
  }
  /** Drop any connection pointing at a credential that's being deleted. */
  unlinkCredential(credentialId) {
    this._ensure();
    let n = 0;
    for (const c of this._data.connections) {
      if (c.credentialId === credentialId) {
        c.credentialId = void 0;
        c.status = "unauthorized";
        c.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
        n++;
      }
    }
    if (n > 0) this._save();
    return n;
  }
}
const CRED_FILE = "credentials.json";
class CredentialsStore {
  constructor() {
    this._path = null;
    this._data = { version: 1, credentials: [] };
    this._loaded = false;
    this._key = null;
  }
  _ensure() {
    if (this._loaded) return;
    this._path = path.join(electron.app.getPath("userData"), CRED_FILE);
    try {
      if (fs.existsSync(this._path)) {
        const raw = fs.readFileSync(this._path, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.credentials)) {
          this._data = parsed;
        }
      }
    } catch (err) {
      console.error("Failed to load credentials.json:", err);
    }
    this._ensureKey();
    this._loaded = true;
  }
  /**
   * Whether to wrap the credentials key with the OS keychain via Electron's
   * safeStorage. DISABLED by default.
   *
   * safeStorage stores a master key in the OS keychain ("OpenAgents Launcher
   * Safe Storage"), whose access ACL is bound to the running binary's code
   * signature. That makes macOS pop a "wants to access the keychain" prompt
   * repeatedly — every Electron upgrade / unsigned dev run changes the
   * signature and re-triggers it — and a denied/locked keychain previously
   * bricked the stored credentials. The security upside is marginal (the key
   * sits next to the data either way), so we keep the master key in the
   * 0600-permission credentials file instead. Opt back in with
   * OPENAGENTS_USE_KEYCHAIN=1 if you specifically want OS-level wrapping.
   */
  _useKeychain() {
    if (process.env.OPENAGENTS_USE_KEYCHAIN !== "1") return false;
    try {
      return electron.safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }
  _ensureKey() {
    const useKeychain = this._useKeychain();
    if (this._data.wrappedKey) {
      if (useKeychain) {
        try {
          const keyB642 = electron.safeStorage.decryptString(
            Buffer.from(this._data.wrappedKey, "base64")
          );
          this._key = Buffer.from(keyB642, "base64");
        } catch (err) {
          this._key = null;
          console.error(
            "safeStorage decrypt failed; credentials locked:",
            err.message
          );
        }
      } else {
        this._key = Buffer.from(this._data.wrappedKey, "base64");
      }
      if (this._key) return;
      if (this._data.credentials.length > 0) return;
    }
    this._key = crypto.randomBytes(32);
    const keyB64 = this._key.toString("base64");
    if (useKeychain) {
      try {
        this._data.wrappedKey = electron.safeStorage.encryptString(keyB64).toString("base64");
      } catch {
        this._data.wrappedKey = keyB64;
      }
    } else {
      this._data.wrappedKey = keyB64;
    }
    this._save();
  }
  _save() {
    if (!this._path) return;
    try {
      fs.mkdirSync(path.dirname(this._path), { recursive: true });
      fs.writeFileSync(this._path, JSON.stringify(this._data, null, 2), "utf-8");
      fs.chmodSync(this._path, 384);
    } catch (err) {
      console.error("Failed to save credentials.json:", err);
    }
  }
  _encrypt(plaintext) {
    if (!this._key) throw new Error("Credentials key not initialized");
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this._key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]).toString("base64");
  }
  _decrypt(cipherB64) {
    if (!this._key) throw new Error("Credentials key not initialized");
    const buf = Buffer.from(cipherB64, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", this._key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf-8");
  }
  _redact(c) {
    let len = 0;
    try {
      len = this._decrypt(c.secretCipher).length;
    } catch {
    }
    const visible = len > 4 ? 4 : Math.max(0, len - 1);
    const mask = "•".repeat(Math.max(0, len - visible));
    return {
      ...c,
      // Never expose ciphertext to the renderer either
      secretMasked: `${mask}${visible > 0 ? "****" : ""}`,
      secretCipher: void 0
    };
  }
  list() {
    this._ensure();
    return this._data.credentials.map((c) => this._redact(c));
  }
  reveal(id2) {
    this._ensure();
    const cred = this._data.credentials.find((c) => c.id === id2);
    if (!cred) return { ok: false, error: "Credential not found" };
    try {
      return { ok: true, secret: this._decrypt(cred.secretCipher) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  /** Internal-only — used by connection testers / env resolvers. */
  getSecret(id2) {
    this._ensure();
    const cred = this._data.credentials.find((c) => c.id === id2);
    if (!cred) return null;
    try {
      return this._decrypt(cred.secretCipher);
    } catch {
      return null;
    }
  }
  upsert(input) {
    this._ensure();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    if (input.id) {
      const idx = this._data.credentials.findIndex((c) => c.id === input.id);
      if (idx < 0) return { ok: false, error: "Credential not found" };
      const prev = this._data.credentials[idx];
      const next = {
        ...prev,
        provider: input.provider,
        kind: input.kind,
        label: input.label,
        shared: input.shared ?? prev.shared,
        scopes: input.scopes ?? prev.scopes,
        usedByAgents: input.usedByAgents ?? prev.usedByAgents,
        updatedAt: now,
        secretCipher: input.secret ? this._encrypt(input.secret) : prev.secretCipher,
        lastTestedAt: input.secret ? void 0 : prev.lastTestedAt,
        lastTestOk: input.secret ? void 0 : prev.lastTestOk,
        lastTestError: input.secret ? void 0 : prev.lastTestError
      };
      this._data.credentials[idx] = next;
      this._save();
      return { ok: true, record: this._redact(next) };
    }
    if (!input.secret) return { ok: false, error: "Secret is required when creating a credential" };
    const created = {
      id: fsId(),
      provider: input.provider,
      kind: input.kind,
      label: input.label,
      secretCipher: this._encrypt(input.secret),
      shared: input.shared ?? false,
      scopes: input.scopes,
      usedByAgents: input.usedByAgents,
      usedByConnections: [],
      createdAt: now,
      updatedAt: now
    };
    this._data.credentials.push(created);
    this._save();
    return { ok: true, record: this._redact(created) };
  }
  remove(id2) {
    this._ensure();
    const before = this._data.credentials.length;
    this._data.credentials = this._data.credentials.filter((c) => c.id !== id2);
    if (this._data.credentials.length !== before) {
      this._save();
      return true;
    }
    return false;
  }
  recordTest(id2, ok, error) {
    this._ensure();
    const idx = this._data.credentials.findIndex((c) => c.id === id2);
    if (idx < 0) return;
    this._data.credentials[idx] = {
      ...this._data.credentials[idx],
      lastTestedAt: (/* @__PURE__ */ new Date()).toISOString(),
      lastTestOk: ok,
      lastTestError: error,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this._save();
  }
  syncConnectionUsage(connectionId, prevCredentialId, nextCredentialId) {
    this._ensure();
    if (prevCredentialId === nextCredentialId) return;
    if (prevCredentialId) {
      const p = this._data.credentials.find((c) => c.id === prevCredentialId);
      if (p) {
        p.usedByConnections = (p.usedByConnections || []).filter((x) => x !== connectionId);
        p.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      }
    }
    if (nextCredentialId) {
      const n = this._data.credentials.find((c) => c.id === nextCredentialId);
      if (n) {
        const set = new Set(n.usedByConnections || []);
        set.add(connectionId);
        n.usedByConnections = Array.from(set);
        n.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      }
    }
    this._save();
  }
}
async function safeFetch(url, init = {}) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8e3);
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    clearTimeout(t);
    return r;
  } catch {
    return null;
  }
}
function fromStatus(res) {
  if (!res) return "offline";
  if (res.status === 401 || res.status === 403) return "unauthorized";
  if (res.status === 429) return "rate_limited";
  if (res.status >= 500) return "error";
  if (res.ok) return "connected";
  return "error";
}
async function probeGitHub(token) {
  const res = await safeFetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "OpenAgents-Launcher"
    }
  });
  const status = fromStatus(res);
  if (status === "connected" && res) {
    try {
      const j = await res.json();
      return { ok: true, status, account: j.login };
    } catch {
    }
  }
  return { ok: status === "connected", status };
}
async function probeSlack(token) {
  const res = await safeFetch("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res) return { ok: false, status: "offline" };
  try {
    const j = await res.json();
    if (j.ok) return { ok: true, status: "connected", account: [j.team, j.user].filter(Boolean).join("/") };
    if (j.error === "ratelimited") return { ok: false, status: "rate_limited" };
    if (j.error === "token_expired") return { ok: false, status: "expired" };
    if (j.error === "invalid_auth" || j.error === "not_authed") return { ok: false, status: "unauthorized" };
    return { ok: false, status: "error", detail: j.error };
  } catch {
    return { ok: false, status: "error" };
  }
}
async function probeDiscord(token) {
  const res = await safeFetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bot ${token}` }
  });
  const status = fromStatus(res);
  if (status === "connected" && res) {
    try {
      const j = await res.json();
      return { ok: true, status, account: j.username || j.id };
    } catch {
    }
  }
  return { ok: status === "connected", status };
}
async function probeTelegram(token) {
  const res = await safeFetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`);
  if (!res) return { ok: false, status: "offline" };
  try {
    const j = await res.json();
    if (j.ok) return { ok: true, status: "connected", account: j.result?.username };
    return { ok: false, status: "unauthorized" };
  } catch {
    return { ok: false, status: "error" };
  }
}
async function probeNotion(token) {
  const res = await safeFetch("https://api.notion.com/v1/users/me", {
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2022-06-28" }
  });
  const status = fromStatus(res);
  if (status === "connected" && res) {
    try {
      const j = await res.json();
      return { ok: true, status, account: j.name };
    } catch {
    }
  }
  return { ok: status === "connected", status };
}
async function probeLinear(token) {
  const res = await safeFetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify({ query: "{ viewer { name email } }" })
  });
  if (!res) return { ok: false, status: "offline" };
  if (res.status === 401 || res.status === 403) return { ok: false, status: "unauthorized" };
  if (res.status === 429) return { ok: false, status: "rate_limited" };
  try {
    const j = await res.json();
    if (j.data?.viewer) return { ok: true, status: "connected", account: j.data.viewer.email || j.data.viewer.name };
    return { ok: false, status: "unauthorized" };
  } catch {
    return { ok: false, status: "error" };
  }
}
async function probeOpenAI(token) {
  const res = await safeFetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${token}` }
  });
  return { ok: !!res?.ok, status: fromStatus(res) };
}
async function probeAnthropic(token) {
  const res = await safeFetch("https://api.anthropic.com/v1/models", {
    headers: { "x-api-key": token, "anthropic-version": "2023-06-01" }
  });
  return { ok: !!res?.ok, status: fromStatus(res) };
}
async function probeGoogle(token) {
  const res = await safeFetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(token)}`
  );
  return { ok: !!res?.ok, status: fromStatus(res) };
}
async function probe(platform, secret) {
  switch (platform.toLowerCase()) {
    case "github":
      return probeGitHub(secret);
    case "slack":
      return probeSlack(secret);
    case "discord":
      return probeDiscord(secret);
    case "telegram":
      return probeTelegram(secret);
    case "notion":
      return probeNotion(secret);
    case "linear":
      return probeLinear(secret);
    case "openai":
      return probeOpenAI(secret);
    case "anthropic":
      return probeAnthropic(secret);
    case "google":
      return probeGoogle(secret);
    default:
      return { ok: false, status: "error", detail: `Unknown platform: ${platform}` };
  }
}
const { autoUpdater } = electronUpdater;
const GITHUB_RELEASES_URL = "https://github.com/openagents-org/openagents/releases";
function resolveDownloadUrl() {
  if (process.platform === "win32") {
    return "https://openagents.org/api/download/launcher/windows";
  }
  if (process.platform === "darwin") {
    return process.arch === "arm64" ? "https://openagents.org/api/download/launcher/mac" : "https://openagents.org/api/download/launcher/mac-intel";
  }
  return GITHUB_RELEASES_URL;
}
let _state = {
  status: "idle",
  currentVersion: "0.0.0",
  latestVersion: null,
  percent: 0,
  bytesPerSecond: 0,
  releaseNotes: null,
  error: null,
  supported: false,
  downloadUrl: resolveDownloadUrl()
};
let _getWindow = () => null;
let _log = () => {
};
let _ipcRegistered = false;
let _isAutoUpdateEnabled = () => false;
let _onDownloaded = () => {
};
let _beforeInstall = async () => {
};
function emit(patch) {
  _state = { ..._state, ...patch };
  const win = _getWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send("updater:event", _state);
  }
}
function normalizeReleaseNotes(notes) {
  if (!notes) return null;
  if (typeof notes === "string") return notes;
  return notes.map((n) => n.note ? `## ${n.version}
${n.note}` : `## ${n.version}`).join("\n\n");
}
function wireEvents() {
  autoUpdater.on("checking-for-update", () => {
    emit({ status: "checking", error: null });
  });
  autoUpdater.on("update-available", (info) => {
    _log(`[updater] update available: v${info.version}`);
    emit({
      status: "available",
      latestVersion: info.version,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes),
      error: null
    });
  });
  autoUpdater.on("update-not-available", (info) => {
    emit({
      status: "not-available",
      latestVersion: info.version,
      error: null
    });
  });
  autoUpdater.on("download-progress", (p) => {
    emit({
      status: "downloading",
      percent: Math.round(p.percent),
      bytesPerSecond: Math.round(p.bytesPerSecond)
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    _log(`[updater] update downloaded: v${info.version}`);
    emit({
      status: "downloaded",
      percent: 100,
      latestVersion: info.version,
      releaseNotes: normalizeReleaseNotes(info.releaseNotes)
    });
    try {
      _onDownloaded(info.version);
    } catch {
    }
  });
  autoUpdater.on("error", (err) => {
    _log(`[updater] error: ${err.message}`);
    emit({ status: "error", error: err.message });
  });
}
async function quitAndInstallSafely() {
  electron.app.isQuitting = true;
  try {
    await _beforeInstall();
  } catch (err) {
    _log(`[updater] beforeInstall failed: ${err.message}`);
  }
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
}
function registerIpc() {
  if (_ipcRegistered) return;
  _ipcRegistered = true;
  electron.ipcMain.handle("updater:get-state", () => _state);
  electron.ipcMain.handle("updater:check", async () => {
    if (!_state.supported) return _state;
    try {
      autoUpdater.autoDownload = false;
      await autoUpdater.checkForUpdates();
    } catch (err) {
      emit({ status: "error", error: err.message });
    }
    return _state;
  });
  electron.ipcMain.handle("updater:download", async () => {
    if (!_state.supported) return _state;
    if (_state.status === "downloaded") return _state;
    try {
      emit({ status: "downloading", percent: 0, error: null });
      await autoUpdater.downloadUpdate();
    } catch (err) {
      emit({ status: "error", error: err.message });
    }
    return _state;
  });
  electron.ipcMain.handle("updater:install", async () => {
    if (!_state.supported || _state.status !== "downloaded") return false;
    await quitAndInstallSafely();
    return true;
  });
}
function setupAutoUpdater(opts) {
  _getWindow = opts.getWindow;
  _log = opts.log;
  _isAutoUpdateEnabled = opts.isAutoUpdateEnabled;
  _onDownloaded = opts.onDownloaded;
  _beforeInstall = opts.beforeInstall;
  _state.currentVersion = electron.app.getVersion();
  if (!electron.app.isPackaged) {
    emit({ supported: false, status: "idle" });
    registerIpc();
    return;
  }
  emit({ supported: true });
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.logger = {
    info: (m) => _log(`[updater] ${String(m)}`),
    warn: (m) => _log(`[updater] WARN ${String(m)}`),
    error: (m) => _log(`[updater] ERROR ${String(m)}`),
    debug: () => {
    }
  };
  wireEvents();
  registerIpc();
}
async function checkForUpdatesOnStartup() {
  if (!_state.supported) return;
  try {
    autoUpdater.autoDownload = _isAutoUpdateEnabled();
    await autoUpdater.checkForUpdates();
  } catch (err) {
    _log(`[updater] startup check failed: ${err.message}`);
  }
}
function getUpdaterState() {
  return _state;
}
function installDownloadedUpdate() {
  if (!_state.supported || _state.status !== "downloaded") return false;
  void quitAndInstallSafely();
  return true;
}
const LOCAL_CORE = path.resolve(__dirname, "../../../wwj");
let _ctor = null;
function loadCtor() {
  if (_ctor) return _ctor;
  try {
    const mod = require(LOCAL_CORE);
    _ctor = mod.GitHubClient;
    return _ctor;
  } catch {
    const mod = require("@openagents-org/agent-launcher");
    _ctor = mod.GitHubClient;
    return _ctor;
  }
}
let _client = null;
function getGitHubClient() {
  if (_client) return _client;
  const Ctor = loadCtor();
  _client = new Ctor();
  return _client;
}
function parseGitHubRepo(input) {
  return loadCtor().parseRepo(input);
}
const FILE_NAME = "github-bindings.json";
class GitHubBindingsStore {
  constructor() {
    this._path = null;
    this._data = { version: 1, bindings: [] };
    this._loaded = false;
  }
  _ensure() {
    if (this._loaded) return;
    this._path = path.join(electron.app.getPath("userData"), FILE_NAME);
    try {
      if (fs.existsSync(this._path)) {
        const raw = fs.readFileSync(this._path, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.bindings)) {
          this._data = { version: 1, bindings: parsed.bindings };
        }
      }
    } catch (err) {
      console.error("Failed to load github-bindings.json:", err);
    }
    this._loaded = true;
  }
  _save() {
    if (!this._path) return;
    try {
      fs.mkdirSync(path.dirname(this._path), { recursive: true });
      fs.writeFileSync(
        this._path,
        JSON.stringify(this._data, null, 2),
        "utf-8"
      );
    } catch (err) {
      console.error("Failed to save github-bindings.json:", err);
    }
  }
  list() {
    this._ensure();
    return this._data.bindings.map((b) => ({ ...b }));
  }
  get(agentName) {
    this._ensure();
    return this._data.bindings.find((b) => b.agentName === agentName) || null;
  }
  upsert(input) {
    this._ensure();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const idx = this._data.bindings.findIndex(
      (b) => b.agentName === input.agentName
    );
    if (idx >= 0) {
      const prev = this._data.bindings[idx];
      const next = {
        ...prev,
        owner: input.owner,
        repo: input.repo,
        credentialId: input.credentialId,
        updatedAt: now
      };
      this._data.bindings[idx] = next;
      this._save();
      return next;
    }
    const created = {
      agentName: input.agentName,
      owner: input.owner,
      repo: input.repo,
      credentialId: input.credentialId,
      createdAt: now,
      updatedAt: now
    };
    this._data.bindings.push(created);
    this._save();
    return created;
  }
  remove(agentName) {
    this._ensure();
    const before = this._data.bindings.length;
    this._data.bindings = this._data.bindings.filter(
      (b) => b.agentName !== agentName
    );
    if (this._data.bindings.length === before) return false;
    this._save();
    return true;
  }
  unlinkCredential(credentialId) {
    this._ensure();
    const before = this._data.bindings.length;
    this._data.bindings = this._data.bindings.filter(
      (b) => b.credentialId !== credentialId
    );
    if (this._data.bindings.length !== before) this._save();
  }
}
let _mainWindow = null;
const _records = [];
const MAX = 200;
function setNotificationsWindow(win) {
  _mainWindow = win;
}
function id() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function listNotifications() {
  return _records.slice().reverse();
}
function markRead(idValue) {
  const r = _records.find((n) => n.id === idValue);
  if (r) {
    r.read = true;
    broadcast();
  }
}
function markAllRead() {
  for (const r of _records) r.read = true;
  broadcast();
}
function clearAll() {
  _records.length = 0;
  broadcast();
}
function clearOne(idValue) {
  const idx = _records.findIndex((n) => n.id === idValue);
  if (idx >= 0) {
    _records.splice(idx, 1);
    broadcast();
  }
}
let _prefs = {
  enabled: true,
  soundEnabled: true,
  mutedKinds: [],
  mutedSources: [],
  quietHours: null
};
function getPrefs() {
  return { ..._prefs, mutedKinds: [..._prefs.mutedKinds], mutedSources: [..._prefs.mutedSources] };
}
function setPrefs(next) {
  _prefs = { ..._prefs, ...next };
  return getPrefs();
}
function broadcast() {
  if (!_mainWindow || _mainWindow.isDestroyed()) return;
  try {
    _mainWindow.webContents.send("notifications:updated", listNotifications());
  } catch {
  }
}
function inQuietHours() {
  if (!_prefs.quietHours) return false;
  const [start, end] = _prefs.quietHours;
  const h = (/* @__PURE__ */ new Date()).getHours();
  if (start === end) return false;
  if (start < end) return h >= start && h < end;
  return h >= start || h < end;
}
function shouldShowOSToast(n) {
  if (!_prefs.enabled) return false;
  if (n.silent) return false;
  if (_prefs.mutedKinds.includes(n.kind)) return false;
  if (n.source && _prefs.mutedSources.includes(n.source)) return false;
  if ((n.priority || "normal") !== "critical" && inQuietHours()) return false;
  return true;
}
function pushNotification(input) {
  const record = {
    ...input,
    id: id(),
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    read: false
  };
  _records.push(record);
  while (_records.length > MAX) _records.shift();
  if (shouldShowOSToast(input)) {
    try {
      if (electron.Notification.isSupported()) {
        const n = new electron.Notification({
          title: input.title,
          body: input.body,
          silent: !_prefs.soundEnabled,
          urgency: input.priority === "critical" ? "critical" : input.priority === "low" ? "low" : "normal"
        });
        n.on("click", () => {
          if (_mainWindow && !_mainWindow.isDestroyed()) {
            if (_mainWindow.isMinimized()) _mainWindow.restore();
            _mainWindow.focus();
            try {
              _mainWindow.webContents.send("notifications:clicked", record);
            } catch {
            }
          }
        });
        n.show();
      }
    } catch (err) {
      console.error("Failed to show OS notification:", err);
    }
  }
  broadcast();
  return record;
}
function execFileAsync(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    child_process.execFile(
      file,
      args,
      {
        timeout: opts.timeout || 1e4,
        env: opts.env,
        encoding: "utf-8",
        maxBuffer: opts.maxBuffer
      },
      (err, stdout) => {
        if (err) reject(err);
        else resolve((stdout || "").toString().trim());
      }
    );
  });
}
function ensureBundledRuntimeFirstOnPath() {
  if (process.platform !== "win32") return;
  if (!fs.existsSync(PORTABLE_NODE_DIR)) return;
  const sep = ";";
  const target = PORTABLE_NODE_DIR.toLowerCase();
  const parts = readPathEnv().split(sep);
  if (parts.length > 0 && parts[0].toLowerCase() === target) return;
  const filtered = parts.filter((p) => p.toLowerCase() !== target);
  writePathEnv([PORTABLE_NODE_DIR, ...filtered].join(sep));
}
function canExecuteNodeBinary(binaryPath) {
  try {
    const r = child_process.spawnSync(binaryPath, ["--version"], {
      timeout: 5e3,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return r.status === 0 && !r.error;
  } catch {
    return false;
  }
}
electron.app.setName("OpenAgents Launcher");
electron.app.commandLine.appendSwitch("use-mock-keychain");
const isHeadless = process.argv.includes("--headless");
if (process.argv.includes("--disable-gpu") || isHeadless) {
  electron.app.disableHardwareAcceleration();
}
const PORTABLE_NODE_DIR = path.join(os.homedir(), ".openagents", "nodejs");
const GLOBAL_MODULES = path.join(PORTABLE_NODE_DIR, "node_modules");
const CORE_PKG = "@openagents-org/agent-launcher";
if (fs.existsSync(GLOBAL_MODULES) && !require("module").globalPaths.includes(GLOBAL_MODULES)) {
  require("module").globalPaths.push(GLOBAL_MODULES);
}
const store = new Store();
if (store.get("gpuAcceleration") === false) {
  electron.app.disableHardwareAcceleration();
}
const connectionsStore = new ConnectionsStore();
const credentialsStore = new CredentialsStore();
const githubBindingsStore = new GitHubBindingsStore();
let mainWindow = null;
let tray = null;
let agentManager = null;
let coreVersion = null;
let _lastUpdateNotifiedVersion = null;
let _launcherVersionCache = null;
function getLauncherVersion() {
  if (_launcherVersionCache) return _launcherVersionCache;
  try {
    _launcherVersionCache = require("../../package.json").version;
  } catch {
    _launcherVersionCache = "0.0.0";
  }
  return _launcherVersionCache;
}
const _runtimeCache = {
  value: {
    nodeVersion: null,
    npmVersion: null,
    coreVersion: null,
    latestVersion: null
  },
  stableAt: 0,
  latestAt: 0,
  refreshing: false
};
const RUNTIME_STABLE_TTL = 6e4 * 30;
const RUNTIME_LATEST_TTL = 6e4 * 10;
const STARTUP_LOG = path.join(os.homedir(), ".openagents", "startup.log");
function slog(msg) {
  try {
    fs.mkdirSync(path.dirname(STARTUP_LOG), { recursive: true });
    fs.appendFileSync(STARTUP_LOG, `${(/* @__PURE__ */ new Date()).toISOString()} ${msg}
`);
  } catch {
  }
  console.log("[startup]", msg);
}
async function downloadFile(https2, url, destPath, onProgress) {
  const tmpPath = destPath + ".part";
  try {
    fs.unlinkSync(tmpPath);
  } catch {
  }
  const resolveResponse = (u, hops = 0) => new Promise((resolve, reject) => {
    if (hops > 5) {
      reject(new Error("Too many redirects"));
      return;
    }
    const req = https2.get(u, (res) => {
      const status = res.statusCode || 0;
      if ((status === 301 || status === 302 || status === 307 || status === 308) && res.headers.location) {
        res.resume();
        resolveResponse(res.headers.location, hops + 1).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error(`HTTP ${status} for ${u}`));
        return;
      }
      resolve(res);
    });
    req.on("error", reject);
    req.setTimeout(
      6e4,
      () => req.destroy(new Error(`Request timed out: ${u}`))
    );
  });
  try {
    const res = await resolveResponse(url);
    const total = parseInt(res.headers["content-length"] || "0", 10) || 0;
    let downloaded = 0;
    res.on("data", (chunk) => {
      downloaded += chunk.length;
      if (onProgress && total)
        onProgress(
          Math.round(downloaded / total * 100),
          `${(downloaded / 1e6).toFixed(1)} MB`
        );
    });
    await promises.pipeline(res, fs.createWriteStream(tmpPath));
    if (total && downloaded !== total) {
      throw new Error(`Short read: got ${downloaded} of ${total} bytes`);
    }
    fs.renameSync(tmpPath, destPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
    }
    throw err;
  }
}
function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (c) => hash.update(c));
    stream.on("end", () => resolve(hash.digest("hex").toLowerCase()));
    stream.on("error", reject);
  });
}
function fetchShasumFrom(https2, url, relativePath) {
  return new Promise((resolve) => {
    https2.get(url, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        resolve(null);
        return;
      }
      let body = "";
      res.setEncoding("utf-8");
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => {
        for (const line of body.split(/\r?\n/)) {
          const [sum, file] = line.trim().split(/\s+/);
          if (file === relativePath && sum) {
            resolve(sum.toLowerCase());
            return;
          }
        }
        resolve(null);
      });
      res.on("error", () => resolve(null));
    }).on("error", () => resolve(null));
  });
}
async function fetchNodeShasum(https2, nodeVersion, relativePath) {
  for (const url of nodeDistUrls(`${nodeVersion}/SHASUMS256.txt`)) {
    const sum = await fetchShasumFrom(https2, url, relativePath);
    if (sum) return sum;
  }
  return null;
}
function nodeDistArch() {
  if (process.arch === "arm64") return "arm64";
  return "x64";
}
async function downloadAndVerify(https2, url, destPath, expectedSha, onProgress) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await downloadFile(https2, url, destPath, onProgress);
      if (expectedSha) {
        const actual = await sha256OfFile(destPath);
        if (actual !== expectedSha) {
          try {
            fs.unlinkSync(destPath);
          } catch {
          }
          throw new Error(
            `SHA256 mismatch for ${path.basename(destPath)}: expected ${expectedSha.slice(0, 12)}…, got ${actual.slice(0, 12)}…`
          );
        }
      }
      return;
    } catch (e) {
      lastErr = e;
      slog(`download attempt ${attempt} failed for ${url}: ${lastErr.message}`);
    }
  }
  throw lastErr || new Error("download failed");
}
async function downloadVerifyCandidates(https2, urls, destPath, expectedSha, onProgress) {
  let lastErr = null;
  for (const url of urls) {
    try {
      await downloadAndVerify(https2, url, destPath, expectedSha, onProgress);
      return;
    } catch (e) {
      lastErr = e;
      slog(`mirror candidate failed (${url}): ${lastErr.message}`);
    }
  }
  throw lastErr || new Error("download failed (all mirrors)");
}
function extractTarball(archivePath, destDir, opts = {}) {
  child_process.execFileSync(
    "tar",
    [
      opts.xz ? "-xJf" : "-xzf",
      archivePath,
      "-C",
      destDir,
      "--strip-components=1"
    ],
    { timeout: opts.timeout ?? 6e4, stdio: "pipe" }
  );
}
async function downloadNodejs(nodejsDir, onProgress) {
  const https2 = require("https");
  const nodeVersion = "v22.22.3";
  const arch = nodeDistArch();
  try {
    fs.rmSync(nodejsDir, { recursive: true, force: true });
  } catch {
  }
  fs.mkdirSync(nodejsDir, { recursive: true });
  slog(
    `downloadNodejs: platform=${process.platform} arch=${arch} dir=${nodejsDir}`
  );
  if (process.platform === "win32") {
    const nodeRelative = `win-${arch}/node.exe`;
    const nodeExeUrls = nodeDistUrls(`${nodeVersion}/${nodeRelative}`);
    const nodeExeDest = path.join(nodejsDir, "node.exe");
    const expectedSha = await fetchNodeShasum(https2, nodeVersion, nodeRelative);
    if (!expectedSha)
      slog(`SHASUMS256.txt unavailable — proceeding without hash verification`);
    await downloadVerifyCandidates(
      https2,
      nodeExeUrls,
      nodeExeDest,
      expectedSha,
      onProgress
    );
    if (!canExecuteNodeBinary(nodeExeDest)) {
      try {
        fs.unlinkSync(nodeExeDest);
      } catch {
      }
      throw new Error(
        "Bundled node.exe failed smoke test (--version did not exit cleanly). The download may be corrupt or blocked by security software."
      );
    }
    const npmVersion = "10.9.8";
    const npmCandidates = npmUrls(`npm/-/npm-${npmVersion}.tgz`);
    const npmTgz = path.join(os.tmpdir(), `npm-${npmVersion}.tgz`);
    const npmModDir = path.join(nodejsDir, "node_modules", "npm");
    if (onProgress) onProgress(85, "Installing npm...");
    await downloadVerifyCandidates(https2, npmCandidates, npmTgz, null, null);
    fs.mkdirSync(npmModDir, { recursive: true });
    extractTarball(npmTgz, npmModDir);
    try {
      fs.unlinkSync(npmTgz);
    } catch {
    }
    const npmCliPath = path.join(npmModDir, "bin", "npm-cli.js");
    if (fs.existsSync(npmCliPath)) {
      fs.writeFileSync(
        path.join(nodejsDir, "npm.cmd"),
        `@echo off\r
"%~dp0node.exe" "%~dp0node_modules\\npm\\bin\\npm-cli.js" %*\r
`
      );
      fs.writeFileSync(
        path.join(nodejsDir, "npx.cmd"),
        `@echo off\r
"%~dp0node.exe" "%~dp0node_modules\\npm\\bin\\npx-cli.js" %*\r
`
      );
    }
  } else {
    const platName = process.platform === "darwin" ? "darwin" : "linux";
    const ext = process.platform === "darwin" ? "tar.gz" : "tar.xz";
    const nodeRelative = `node-${nodeVersion}-${platName}-${arch}.${ext}`;
    const urls = nodeDistUrls(`${nodeVersion}/${nodeRelative}`);
    const tarPath = path.join(os.tmpdir(), `node-${nodeVersion}.${ext}`);
    await downloadVerifyCandidates(https2, urls, tarPath, null, onProgress);
    if (onProgress) onProgress(90, "Extracting...");
    extractTarball(tarPath, nodejsDir, {
      xz: ext !== "tar.gz",
      timeout: 12e4
    });
    try {
      fs.unlinkSync(tarPath);
    } catch {
    }
    const binDir = path.join(nodejsDir, "bin");
    for (const name of ["node", "npm", "npx"]) {
      const src = path.join(binDir, name);
      const dest = path.join(nodejsDir, name);
      if (fs.existsSync(src) && !fs.existsSync(dest)) {
        try {
          fs.symlinkSync(src, dest);
        } catch {
        }
      }
    }
  }
  if (onProgress) onProgress(100, "Done");
}
function findNpmCommand() {
  const nodeUnified = path.join(
    PORTABLE_NODE_DIR,
    process.platform === "win32" ? "node.exe" : "node"
  );
  const nodeBin = fs.existsSync(nodeUnified) ? nodeUnified : path.join(PORTABLE_NODE_DIR, "bin", "node");
  if (!fs.existsSync(nodeBin)) return null;
  const candidates = [
    path.join(PORTABLE_NODE_DIR, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(
      PORTABLE_NODE_DIR,
      "lib",
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js"
    )
  ];
  const npmCli = candidates.find((p) => fs.existsSync(p));
  if (npmCli) return `"${nodeBin}" "${npmCli}"`;
  if (process.platform !== "win32") {
    const npmBin = path.join(PORTABLE_NODE_DIR, "bin", "npm");
    if (fs.existsSync(npmBin)) return `"${npmBin}"`;
  }
  return null;
}
function _addToPrefixPackageJson(pkg, version) {
  const pkgJsonPath = path.join(PORTABLE_NODE_DIR, "package.json");
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
  } catch {
  }
  if (!data.dependencies) data.dependencies = {};
  data.dependencies[pkg] = version;
  try {
    fs.writeFileSync(pkgJsonPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  } catch {
  }
}
let _updateSplash = null;
async function ensureCoreLibrary() {
  const corePkgPath = path.join(GLOBAL_MODULES, CORE_PKG, "package.json");
  let installedVersion = null;
  if (fs.existsSync(corePkgPath)) {
    try {
      installedVersion = JSON.parse(
        fs.readFileSync(corePkgPath, "utf-8")
      ).version;
    } catch {
    }
  }
  const https2 = require("https");
  try {
    const fetchLatestFrom = (url) => new Promise((res, rej) => {
      https2.get(url, (r) => {
        let d = "";
        r.on("data", (c) => d += c);
        r.on("end", () => {
          try {
            res(JSON.parse(d).version);
          } catch {
            rej(new Error("parse error"));
          }
        });
      }).on("error", rej);
    });
    let latestVersion = null;
    let latestErr = null;
    for (const url of npmUrls(`${CORE_PKG}/latest`)) {
      try {
        latestVersion = await fetchLatestFrom(url);
        break;
      } catch (e) {
        latestErr = e;
        slog(`core latest lookup failed (${url}): ${latestErr.message}`);
      }
    }
    if (!latestVersion)
      throw latestErr || new Error("core latest lookup failed");
    if (!installedVersion) {
      slog("Core library not found — installing v" + latestVersion + "...");
      if (_updateSplash)
        _updateSplash("Installing core library...", 65, "v" + latestVersion);
    } else if (latestVersion !== installedVersion) {
      slog("Core library update: v" + installedVersion + " → v" + latestVersion);
      if (_updateSplash)
        _updateSplash(
          "Updating core library...",
          65,
          "v" + installedVersion + " → v" + latestVersion
        );
    } else {
      slog("Core library v" + installedVersion + " (already latest)");
      if (_updateSplash)
        _updateSplash("Core library up to date", 80, "v" + installedVersion);
    }
    if (!installedVersion || latestVersion !== installedVersion) {
      const tgzUrls = npmUrls(
        `${CORE_PKG}/-/agent-launcher-${latestVersion}.tgz`
      );
      const tgzPath = path.join(
        os.tmpdir(),
        `agent-launcher-${latestVersion}.tgz`
      );
      const destDir = path.join(GLOBAL_MODULES, CORE_PKG);
      await downloadVerifyCandidates(https2, tgzUrls, tgzPath, null, null);
      try {
        fs.rmSync(destDir, { recursive: true, force: true });
      } catch {
      }
      fs.mkdirSync(destDir, { recursive: true });
      extractTarball(tgzPath, destDir);
      try {
        fs.unlinkSync(tgzPath);
      } catch {
      }
      const newVersion = (() => {
        try {
          return JSON.parse(fs.readFileSync(corePkgPath, "utf-8")).version;
        } catch {
          return null;
        }
      })();
      if (newVersion) {
        slog("Core library installed: v" + newVersion);
        if (_updateSplash)
          _updateSplash("Core library ready", 80, "v" + newVersion);
        installedVersion = newVersion;
        _addToPrefixPackageJson(CORE_PKG, newVersion);
      }
    }
  } catch (e) {
    slog("Core update failed: " + e.message);
    if (!installedVersion) {
      slog("Falling back to npm...");
      const npmCmd = findNpmCommand();
      if (npmCmd) {
        try {
          child_process.execSync(
            `${npmCmd} install --prefix "${PORTABLE_NODE_DIR}" ${CORE_PKG}@latest --ignore-scripts --registry ${npmRegistryBase()}`,
            {
              stdio: "pipe",
              timeout: 12e4,
              env: withPathEnv(
                PORTABLE_NODE_DIR + (process.platform === "win32" ? ";" : ":") + readPathEnv()
              )
            }
          );
          try {
            installedVersion = JSON.parse(
              fs.readFileSync(corePkgPath, "utf-8")
            ).version;
          } catch {
          }
        } catch {
        }
      }
    }
  }
  coreVersion = installedVersion;
  const npmCheck = path.join(
    PORTABLE_NODE_DIR,
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js"
  );
  if (!fs.existsSync(npmCheck)) {
    slog("npm was removed by --prefix install — reinstalling...");
    try {
      const npmTgz = path.join(os.tmpdir(), "npm-reinstall.tgz");
      const npmDir = path.join(PORTABLE_NODE_DIR, "node_modules", "npm");
      await downloadVerifyCandidates(
        https2,
        npmUrls("npm/-/npm-10.9.8.tgz"),
        npmTgz,
        null,
        null
      );
      fs.mkdirSync(npmDir, { recursive: true });
      extractTarball(npmTgz, npmDir);
      try {
        fs.unlinkSync(npmTgz);
      } catch {
      }
      slog("npm reinstalled");
    } catch (e) {
      slog("npm reinstall failed: " + e.message);
    }
  }
  if (installedVersion && agentManager) {
    agentManager.reloadCore();
  }
}
async function checkCoreUpdate() {
  const npmCmd = findNpmCommand();
  if (!npmCmd) return;
  try {
    const latest = child_process.execSync(`${npmCmd} view ${CORE_PKG} version`, {
      encoding: "utf-8",
      timeout: 15e3,
      env: withPathEnv(
        PORTABLE_NODE_DIR + (process.platform === "win32" ? ";" : ":") + readPathEnv()
      )
    }).trim();
    if (coreVersion && latest && latest !== coreVersion) {
      if (mainWindow) {
        mainWindow.webContents.send("core-update-available", {
          current: coreVersion,
          latest
        });
      }
    }
  } catch {
  }
}
function createWindow() {
  if (mainWindow) {
    if (process.platform === "darwin" && electron.app.dock) electron.app.dock.show();
    mainWindow.show();
    mainWindow.focus();
    return;
  }
  mainWindow = new electron.BrowserWindow({
    minWidth: 1200,
    minHeight: 800,
    width: 1200,
    height: 800,
    title: "OpenAgents Launcher",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    },
    show: false
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  setNotificationsWindow(mainWindow);
  mainWindow.once("ready-to-show", () => {
    if (process.platform === "darwin" && electron.app.dock) electron.app.dock.show();
    mainWindow.show();
    if (process.platform === "win32") {
      mainWindow.focus();
      mainWindow.moveTop();
    }
    if (!electron.app.isPackaged) {
      mainWindow.webContents.openDevTools({ mode: "detach" });
    }
  });
  if (!electron.app.isPackaged) {
    mainWindow.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const isToggle = input.key === "F12" || input.key.toLowerCase() === "i" && (process.platform === "darwin" && input.meta && input.alt || process.platform !== "darwin" && input.control && input.shift);
      if (isToggle) {
        event.preventDefault();
        const wc = mainWindow.webContents;
        if (wc.isDevToolsOpened()) wc.closeDevTools();
        else wc.openDevTools({ mode: "detach" });
      }
    });
  }
  mainWindow.on("close", (e) => {
    const toTray = store.get("minimizeToTray") !== false;
    if (toTray && !electron.app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      if (process.platform === "darwin" && electron.app.dock) electron.app.dock.hide();
    }
  });
  mainWindow.on("closed", () => {
    try {
      embeddedViewManager.destroy();
    } catch {
    }
    mainWindow = null;
  });
}
function applyStartOnBoot() {
  try {
    electron.app.setLoginItemSettings({
      openAtLogin: store.get("startOnBoot") === true
    });
  } catch {
  }
}
function applyProxyFromSettings() {
  const http2 = (store.get("httpProxy") || "").trim();
  const https2 = (store.get("httpsProxy") || "").trim();
  const no = (store.get("noProxy") || "").trim();
  const setOrClear = (name, value) => {
    if (value) {
      process.env[name] = value;
      process.env[name.toLowerCase()] = value;
    } else {
      delete process.env[name];
      delete process.env[name.toLowerCase()];
    }
  };
  setOrClear("HTTP_PROXY", http2);
  setOrClear("HTTPS_PROXY", https2);
  setOrClear("NO_PROXY", no);
  if (electron.session?.defaultSession) {
    const rules = [http2 && `http=${http2}`, https2 && `https=${https2}`].filter(Boolean).join(";");
    void electron.session.defaultSession.setProxy(
      rules ? { proxyRules: rules, proxyBypassRules: no || void 0 } : { mode: "direct" }
    );
  }
}
function createPlaceholderIcon() {
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);
  const cx = 7.5, cy = 7.5, r = 7, ri = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (d <= r) {
        if (d <= ri) {
          canvas[i] = 255;
          canvas[i + 1] = 255;
          canvas[i + 2] = 255;
          canvas[i + 3] = 255;
        } else {
          canvas[i] = 108;
          canvas[i + 1] = 99;
          canvas[i + 2] = 255;
          canvas[i + 3] = 255;
        }
      }
    }
  }
  return electron.nativeImage.createFromBuffer(canvas, { width: size, height: size });
}
function createTray() {
  const assetsDir = path.join(__dirname, "../../assets");
  let trayIcon = electron.nativeImage.createFromPath(
    path.join(assetsDir, "tray-icon-light.png")
  );
  if (!trayIcon || trayIcon.isEmpty()) trayIcon = createPlaceholderIcon();
  tray = new electron.Tray(trayIcon);
  tray.setToolTip("OpenAgents Launcher");
  updateTrayMenu();
  tray.on("click", () => createWindow());
}
let _pendingAgentUpdates = [];
function updateTrayMenu() {
  if (!tray) return;
  const agents = agentManager ? agentManager.getAgents() : [];
  const agentItems = agents.length > 0 ? agents.map((a) => ({ label: `${a.name} (${a.state})`, enabled: false })) : [{ label: "No agents configured", enabled: false }];
  const updateItems = _pendingAgentUpdates.length > 0 ? [
    { type: "separator" },
    {
      label: `Updates available (${_pendingAgentUpdates.length})`,
      enabled: false
    },
    ..._pendingAgentUpdates.slice(0, 5).map(
      (u) => ({
        label: `${u.name}: v${u.current ?? "?"} → v${u.latest ?? "?"}`,
        click: () => {
          createWindow();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send("navigate-to-install", u.name);
          }
        }
      })
    )
  ] : [];
  const launcherUpdate = getUpdaterState();
  const launcherUpdateItems = launcherUpdate.status === "downloaded" ? [
    { type: "separator" },
    {
      label: `Restart to update (v${launcherUpdate.latestVersion ?? "?"})`,
      click: () => {
        installDownloadedUpdate();
      }
    }
  ] : [];
  const menu = electron.Menu.buildFromTemplate([
    { label: "Open Dashboard", click: () => createWindow() },
    { type: "separator" },
    ...agentItems,
    ...updateItems,
    ...launcherUpdateItems,
    { type: "separator" },
    {
      label: "Quit OpenAgents",
      click: async () => {
        const { dialog } = require("electron");
        const result = await dialog.showMessageBox({
          type: "question",
          buttons: ["Quit", "Cancel"],
          defaultId: 1,
          title: "Quit OpenAgents Launcher",
          message: "Quit OpenAgents Launcher?",
          detail: "The daemon will stop and all connected agents will go offline."
        });
        if (result.response === 0) {
          electron.app.isQuitting = true;
          try {
            if (agentManager) await agentManager.stopAll();
          } catch {
          }
          electron.app.quit();
        }
      }
    }
  ]);
  tray.setContextMenu(menu);
  if (_pendingAgentUpdates.length > 0) {
    tray.setToolTip(
      `OpenAgents Launcher · ${_pendingAgentUpdates.length} update${_pendingAgentUpdates.length > 1 ? "s" : ""} available`
    );
  } else {
    tray.setToolTip("OpenAgents Launcher");
  }
}
async function refreshAgentUpdates() {
  if (!agentManager) return;
  try {
    const all = await agentManager.checkAgentUpdates({ force: true });
    _pendingAgentUpdates = all.filter(
      (u) => u.current && u.latest && u.current !== u.latest
    );
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("agent-updates-changed", _pendingAgentUpdates);
    }
    updateTrayMenu();
  } catch {
  }
}
function broadcastInstallProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("install:progress", payload);
  }
}
function installStepLabel(phase, verb) {
  if (phase === "downloading") return "downloading";
  if (phase === "verifying") return "verifying the installation";
  if (phase === "installing") {
    if (verb === "uninstall") return "removing files";
    if (verb === "rollback") return "rolling back";
    if (verb === "update") return "installing the update";
    return "running the installer";
  }
  if (phase === "preparing" || phase === "idle")
    return "preparing the installer";
  return "finishing the installation";
}
function userFacingInstallError(err, phase, verb) {
  const raw = err instanceof Error ? err.message : String(err || "");
  const text = raw.toLowerCase();
  const step = installStepLabel(phase, verb);
  let reason = "The installer stopped before it could finish.";
  let hint = "Open the log for details, then try again.";
  if (text.includes("not recognized as an internal or external command") || text.includes("not recognized") || text.includes("enoent") || text.includes("command not found")) {
    reason = "A required command could not be started.";
    hint = "Check that the required tool is installed and available, then try again.";
  } else if (text.includes("short read") || text.includes("ssl") || text.includes("handshake") || text.includes("network") || text.includes("timeout") || text.includes("econnreset") || text.includes("unable to get local issuer certificate")) {
    reason = "The download connection failed.";
    hint = "Check your network, proxy, or VPN, then retry the install.";
  } else if (text.includes("permission") || text.includes("access is denied") || text.includes("access denied") || text.includes("executionpolicy")) {
    reason = "The installer did not have permission to complete.";
    hint = "Check system permissions and retry.";
  } else if (text.includes("not found") || text.includes("not installed")) {
    reason = "The installed command could not be found.";
    hint = "Open the log to see which command was missing.";
  }
  return `Failed while ${step}. ${reason} ${hint}`;
}
function classifyInstallChunk(chunk, verb) {
  const line = chunk.toLowerCase();
  if (verb === "uninstall") {
    if (line.includes("removed") || line.includes("uninstall"))
      return { phase: "installing", detail: "Removing files" };
    if (line.includes("done!"))
      return { phase: "verifying", detail: "Cleaning shims" };
    return {};
  }
  if (line.includes("downloading") || /\b\d+\s*%/.test(line) || line.includes("mb")) {
    return { phase: "downloading", detail: chunk.trim().slice(0, 80) };
  }
  if (line.includes("extracting") || line.includes("expanding")) {
    return { phase: "installing", detail: "Extracting archive" };
  }
  if (line.includes("npm warn") || line.includes("npm http")) {
    return { phase: "installing" };
  }
  if (line.includes("added ") && line.includes("package")) {
    return { phase: "verifying", detail: chunk.trim().slice(0, 80) };
  }
  if (line.includes("done!") || line.includes("installed.")) {
    return { phase: "verifying", detail: "Finalizing" };
  }
  return {};
}
async function runInstallWithPhases(agent, verb, runner) {
  let currentPhase = "preparing";
  broadcastInstallProgress({
    agent,
    verb,
    phase: "preparing",
    detail: "Resolving dependencies"
  });
  const onData = (data) => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send("install:output", data);
    const { phase, detail } = classifyInstallChunk(data, verb);
    if (phase && phase !== currentPhase) {
      currentPhase = phase;
      broadcastInstallProgress({ agent, verb, phase, detail });
    } else if (detail) {
      broadcastInstallProgress({ agent, verb, phase: currentPhase, detail });
    }
  };
  try {
    const result = await runner(onData);
    broadcastInstallProgress({ agent, verb, phase: "done", detail: "Complete" });
    return result;
  } catch (e) {
    const friendlyError = userFacingInstallError(e, currentPhase, verb);
    broadcastInstallProgress({
      agent,
      verb,
      phase: "error",
      detail: friendlyError,
      error: friendlyError
    });
    throw new Error(friendlyError);
  }
}
function resolveBundledNode() {
  const candidates = [
    path.join(
      PORTABLE_NODE_DIR,
      process.platform === "win32" ? "node.exe" : "node"
    ),
    path.join(PORTABLE_NODE_DIR, "bin", "node")
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}
function resolveNpmInvocation() {
  const nodeBin = resolveBundledNode();
  if (!nodeBin) return null;
  const candidates = [
    path.join(PORTABLE_NODE_DIR, "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(
      PORTABLE_NODE_DIR,
      "lib",
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js"
    )
  ];
  const npmCli = candidates.find((p) => fs.existsSync(p));
  if (npmCli) return { node: nodeBin, args: [npmCli] };
  if (process.platform !== "win32") {
    const npmBin = path.join(PORTABLE_NODE_DIR, "bin", "npm");
    if (fs.existsSync(npmBin)) return { node: npmBin, args: [] };
  }
  return null;
}
async function refreshRuntimeInfo(force = false) {
  const now = Date.now();
  const info = _runtimeCache.value;
  info.coreVersion = coreVersion || info.coreVersion || null;
  if (_runtimeCache.refreshing) return info;
  const needStable = force || !info.nodeVersion || !info.npmVersion || now - _runtimeCache.stableAt > RUNTIME_STABLE_TTL;
  const needLatest = force || !info.latestVersion || now - _runtimeCache.latestAt > RUNTIME_LATEST_TTL;
  if (!needStable && !needLatest) return info;
  _runtimeCache.refreshing = true;
  try {
    const env = withPathEnv(
      PORTABLE_NODE_DIR + (process.platform === "win32" ? ";" : ":") + readPathEnv()
    );
    const npm = resolveNpmInvocation();
    if (needStable) {
      const nodeBin = resolveBundledNode();
      if (nodeBin) {
        try {
          info.nodeVersion = await execFileAsync(nodeBin, ["--version"], {
            timeout: 5e3
          });
        } catch {
        }
      } else {
        info.nodeVersion = null;
      }
      if (npm) {
        try {
          info.npmVersion = await execFileAsync(
            npm.node,
            [...npm.args, "--version"],
            { timeout: 5e3, env }
          );
        } catch {
        }
      } else {
        info.npmVersion = null;
      }
      _runtimeCache.stableAt = now;
    }
    if (needLatest) {
      if (npm) {
        try {
          info.latestVersion = await execFileAsync(
            npm.node,
            [...npm.args, "view", CORE_PKG, "version"],
            { timeout: 1e4, env }
          );
        } catch {
        }
      }
      _runtimeCache.latestAt = now;
    }
  } finally {
    _runtimeCache.refreshing = false;
  }
  return info;
}
function setupIPC() {
  electron.ipcMain.handle("python:status", () => ({
    pythonPath: null,
    pythonFound: true,
    sdkInstalled: true,
    sdkVersion: coreVersion || "not installed",
    launcherVersion: getLauncherVersion(),
    runtime: "node"
  }));
  electron.ipcMain.handle("python:install", () => ({
    success: true,
    message: "No installation needed — using Node.js agent-connector"
  }));
  electron.ipcMain.handle("runtime:info", async (_e, opts) => {
    const force = !!(opts && opts.force);
    const info = _runtimeCache.value;
    const needStable = force || !info.nodeVersion || !info.npmVersion;
    if (needStable && !_runtimeCache.refreshing) {
      _runtimeCache.refreshing = true;
      try {
        const env = withPathEnv(
          PORTABLE_NODE_DIR + (process.platform === "win32" ? ";" : ":") + readPathEnv()
        );
        const npm = resolveNpmInvocation();
        const nodeBin = resolveBundledNode();
        if (nodeBin) {
          try {
            info.nodeVersion = await execFileAsync(nodeBin, ["--version"], {
              timeout: 5e3
            });
          } catch {
          }
        } else {
          info.nodeVersion = null;
        }
        if (npm) {
          try {
            info.npmVersion = await execFileAsync(
              npm.node,
              [...npm.args, "--version"],
              { timeout: 5e3, env }
            );
          } catch {
          }
        } else {
          info.npmVersion = null;
        }
        _runtimeCache.stableAt = Date.now();
      } finally {
        _runtimeCache.refreshing = false;
      }
    }
    info.coreVersion = coreVersion || info.coreVersion || null;
    const needLatest = force || !info.latestVersion || Date.now() - _runtimeCache.latestAt > RUNTIME_LATEST_TTL;
    if (needLatest) {
      void refreshRuntimeInfo(force).catch(() => {
      });
    }
    return { ...info };
  });
  const requireManager = () => {
    if (!agentManager)
      throw new Error("Launcher is still initializing, please wait a moment");
    return agentManager;
  };
  electron.ipcMain.handle(
    "agents:list",
    () => agentManager ? agentManager.getAgents() : []
  );
  electron.ipcMain.handle(
    "agents:supported-types",
    () => agentManager ? agentManager.getSupportedAgentTypes() : []
  );
  electron.ipcMain.handle(
    "agents:core-info",
    () => agentManager ? agentManager.getCoreInfo() : { version: null, supportedTypes: [], globalCorePresent: false }
  );
  electron.ipcMain.handle(
    "agents:add",
    (_e, config) => requireManager().addAgent(config)
  );
  electron.ipcMain.handle(
    "agents:remove",
    (_e, name) => requireManager().removeAgent(name)
  );
  electron.ipcMain.handle(
    "agents:update",
    (_e, name, config) => requireManager().updateAgent(name, config)
  );
  electron.ipcMain.handle(
    "agents:set-workdir",
    (_e, name, dir) => requireManager().setAgentWorkingDir(name, dir)
  );
  electron.ipcMain.handle(
    "agents:start",
    (_e, name) => requireManager().startAgent(name)
  );
  electron.ipcMain.handle("agents:stop", (_e, name) => requireManager().stopAgent(name));
  electron.ipcMain.handle("agents:start-all", () => requireManager().startAll());
  electron.ipcMain.handle("agents:stop-all", () => requireManager().stopAll());
  electron.ipcMain.handle(
    "agents:status",
    () => agentManager ? agentManager.getAllStatus() : {}
  );
  electron.ipcMain.handle("agents:daemon-status", () => {
    if (!agentManager) return { state: "starting", pid: null };
    try {
      return agentManager.getDaemonState();
    } catch {
      return { state: "offline", pid: null };
    }
  });
  electron.ipcMain.handle(
    "agents:logs",
    (_e, name, lines) => requireManager().getLogs(name, lines)
  );
  electron.ipcMain.handle("agents:tail-logs", (_e, name, lines, offset) => {
    if (!agentManager) return { lines: [], size: 0 };
    try {
      return agentManager.tailLogs(name, lines, offset);
    } catch {
      return { lines: [], size: 0 };
    }
  });
  electron.ipcMain.handle(
    "agents:clear-logs-range",
    (_e, start, end) => requireManager().clearLogsInRange(start, end)
  );
  electron.ipcMain.handle("agents:install-type", (_e, agentType) => {
    ensureBundledRuntimeFirstOnPath();
    return requireManager().installAgentType(agentType);
  });
  electron.ipcMain.handle("agents:install-type-streaming", async (_e, agentType) => {
    ensureBundledRuntimeFirstOnPath();
    const verb = agentManager?.getInstalledVersion(agentType) ? "update" : "install";
    try {
      const result = await runInstallWithPhases(
        agentType,
        verb,
        (cb) => requireManager().installAgentTypeStreaming(agentType, cb)
      );
      await refreshAgentUpdates().catch(() => {
      });
      return result;
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  electron.ipcMain.handle("agents:uninstall-type", (_e, agentType) => {
    ensureBundledRuntimeFirstOnPath();
    return requireManager().uninstallAgentType(agentType);
  });
  electron.ipcMain.handle("agents:uninstall-type-streaming", async (_e, agentType) => {
    ensureBundledRuntimeFirstOnPath();
    try {
      const result = await runInstallWithPhases(
        agentType,
        "uninstall",
        (cb) => requireManager().uninstallAgentTypeStreaming(agentType, cb)
      );
      await refreshAgentUpdates().catch(() => {
      });
      return result;
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  electron.ipcMain.handle(
    "agents:installed-list",
    () => agentManager ? agentManager.listInstalledAgents() : []
  );
  electron.ipcMain.handle("agents:check-updates", async () => {
    if (!agentManager) return [];
    try {
      return await agentManager.checkAgentUpdates();
    } catch {
      return [];
    }
  });
  electron.ipcMain.handle(
    "agents:install-at-version-streaming",
    async (_e, agentType, target) => {
      if (!agentManager)
        return { success: false, error: "Launcher initializing" };
      ensureBundledRuntimeFirstOnPath();
      const verb = agentManager.getInstalledVersion(agentType) ? "update" : "install";
      try {
        const result = await runInstallWithPhases(
          agentType,
          verb,
          (cb) => agentManager.installAgentTypeAtVersionStreaming(
            agentType,
            target,
            cb
          )
        );
        await refreshAgentUpdates().catch(() => {
        });
        return result;
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
  );
  electron.ipcMain.handle("agents:rollback", async (_e, agentType) => {
    if (!agentManager) return { success: false, error: "Launcher initializing" };
    ensureBundledRuntimeFirstOnPath();
    try {
      const result = await runInstallWithPhases(
        agentType,
        "rollback",
        (cb) => agentManager.rollbackAgentType(agentType, cb)
      );
      await refreshAgentUpdates().catch(() => {
      });
      return result;
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  electron.ipcMain.handle("agents:changelog", async (_e, agentType) => {
    if (!agentManager) return { versions: [], error: "Launcher initializing" };
    try {
      return await agentManager.getAgentChangelog(agentType);
    } catch (e) {
      return { versions: [], error: e.message };
    }
  });
  electron.ipcMain.handle("agents:check-type", (_e, agentType) => {
    if (!agentManager) return { installed: false, binary: null };
    try {
      return agentManager.checkAgentType(agentType);
    } catch {
      return { installed: false, binary: null };
    }
  });
  electron.ipcMain.handle("agents:catalog", async (_e, force) => {
    if (!agentManager) return [];
    try {
      return await agentManager.getCatalog(!!force);
    } catch (err) {
      slog(`agents:catalog failed: ${err?.message || err}`);
      return [];
    }
  });
  electron.ipcMain.handle(
    "agents:env-fields",
    (_e, agentType) => requireManager().getEnvFields(agentType)
  );
  electron.ipcMain.handle(
    "agents:get-env",
    (_e, agentType) => requireManager().getAgentEnv(agentType)
  );
  electron.ipcMain.handle(
    "agents:save-env",
    (_e, agentType, env) => requireManager().saveAgentEnv(agentType, env)
  );
  electron.ipcMain.handle(
    "agents:delete-env",
    (_e, agentType) => requireManager().deleteAgentEnv(agentType)
  );
  electron.ipcMain.handle(
    "agents:get-instance-env",
    (_e, agentName) => requireManager().getAgentInstanceEnv(agentName)
  );
  electron.ipcMain.handle(
    "agents:save-instance-env",
    (_e, agentName, env) => requireManager().saveAgentInstanceEnv(agentName, env)
  );
  electron.ipcMain.handle("agents:test-llm", (_e, env) => requireManager().testLLM(env));
  electron.ipcMain.handle("agents:signal-reload", () => requireManager().signalReload());
  electron.ipcMain.handle(
    "workspace:send-message",
    (_e, input) => requireManager().sendChatMessage(input)
  );
  electron.ipcMain.handle(
    "workspace:get-messages",
    (_e, workspaceId, channelName, limit) => requireManager().getChatMessages(workspaceId, channelName, limit)
  );
  electron.ipcMain.handle("workspace:start-polling", (_e, workspaceId, channelName) => {
    const res = requireManager().startChatPolling(workspaceId, channelName);
    return res ? { success: true, key: res.key } : { success: false };
  });
  electron.ipcMain.handle("workspace:stop-polling", (_e, workspaceId, channelName) => {
    agentManager?.stopChatPolling(workspaceId, channelName);
    return { success: true };
  });
  electron.ipcMain.handle(
    "workspace:list-participants",
    (_e, workspaceId) => requireManager().listChatParticipants(workspaceId)
  );
  electron.ipcMain.handle(
    "workspace:upload-file",
    (_e, workspaceId, filename, contentBase64, opts) => requireManager().uploadChatFile(
      workspaceId,
      filename,
      contentBase64,
      opts || {}
    )
  );
  electron.ipcMain.handle(
    "workspace:list-files",
    (_e, workspaceId, opts) => requireManager().listChatFiles(workspaceId, opts || {})
  );
  electron.ipcMain.handle(
    "workspace:read-file",
    (_e, workspaceId, fileId) => requireManager().readChatFile(workspaceId, fileId)
  );
  electron.ipcMain.handle(
    "workspace:delete-file",
    (_e, workspaceId, fileId) => requireManager().deleteChatFile(workspaceId, fileId)
  );
  electron.ipcMain.handle(
    "session:list",
    (_e, workspaceId) => requireManager().listChatSessions(workspaceId)
  );
  electron.ipcMain.handle(
    "session:create",
    (_e, workspaceId) => requireManager().createChatSession(workspaceId)
  );
  electron.ipcMain.handle(
    "session:load",
    (_e, workspaceId, channelName) => requireManager().loadChatSession(workspaceId, channelName)
  );
  electron.ipcMain.handle(
    "session:delete",
    (_e, workspaceId, channelName) => requireManager().deleteChatSession(workspaceId, channelName)
  );
  electron.ipcMain.handle(
    "session:clear",
    (_e, workspaceId) => requireManager().clearChatSessions(workspaceId)
  );
  registerGitHandlers(electron.ipcMain);
  electron.ipcMain.handle(
    "workspace:connect",
    (_e, agentName, slug) => requireManager().connectWorkspace(agentName, slug)
  );
  electron.ipcMain.handle(
    "workspace:disconnect",
    (_e, agentName) => requireManager().disconnectWorkspace(agentName)
  );
  electron.ipcMain.handle(
    "workspace:remove",
    (_e, slug) => requireManager().removeWorkspace(slug)
  );
  electron.ipcMain.handle(
    "workspace:list",
    () => agentManager ? agentManager.getNetworks() : []
  );
  electron.ipcMain.handle("app:get-api-url", () => getBackendUrl());
  electron.ipcMain.handle(
    "embedded-view:show",
    (_e, bounds, url) => {
      if (!mainWindow) return;
      embeddedViewManager.attach(mainWindow, url);
      embeddedViewManager.show(bounds);
    }
  );
  electron.ipcMain.handle("embedded-view:hide", () => {
    embeddedViewManager.hide();
  });
  electron.ipcMain.handle("embedded-view:navigate", (_e, url) => {
    embeddedViewManager.navigate(url);
  });
  electron.ipcMain.handle("workspace:get-token", (_e, slug) => {
    if (!agentManager) return null;
    const networks = agentManager.getNetworks();
    if (networks.length === 0) return null;
    if (slug) {
      const target = networks.find((n) => n.slug === slug || n.id === slug);
      if (target?.token) return target.token;
      console.warn(`[workspace:get-token] Token resolution failed for slug/id "${slug}". Configured networks:`, networks.map((n) => ({ slug: n.slug, id: n.id })));
      return null;
    }
    if (networks.length === 1) {
      return networks[0]?.token || null;
    }
    return null;
  });
  electron.ipcMain.handle(
    "workspace:create",
    (_e, name) => requireManager().createWorkspace(name)
  );
  electron.ipcMain.handle(
    "dialog:select-directory",
    async (_e, defaultPath) => {
      const { dialog } = require("electron");
      const win = electron.BrowserWindow.getFocusedWindow() || mainWindow;
      const opts = {
        properties: ["openDirectory", "createDirectory"],
        ...defaultPath ? { defaultPath } : {}
      };
      const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      if (result.canceled || !result.filePaths?.length) return null;
      return result.filePaths[0];
    }
  );
  electron.ipcMain.handle("onboarding:agents", async () => {
    if (!agentManager) return [];
    try {
      return await agentManager.getOnboardingAgents();
    } catch (err) {
      slog(`onboarding:agents failed: ${err?.message || err}`);
      return [];
    }
  });
  electron.ipcMain.handle(
    "onboarding:provision",
    (_e, opts) => requireManager().provisionFirstAgent(opts)
  );
  electron.ipcMain.handle("onboarding:consume-reset", () => {
    const pending = !!store.get("pendingOnboardingReset");
    if (pending) store.delete("pendingOnboardingReset");
    return pending;
  });
  electron.ipcMain.handle(
    "workspace:register-from-token",
    (_e, input) => requireManager().registerWorkspaceFromToken(input)
  );
  electron.ipcMain.handle("settings:get", (_e, key) => store.get(key));
  electron.ipcMain.handle("settings:set", (_e, key, value) => {
    store.set(key, value);
    if (key === "workspaceEndpoint" && agentManager) {
      agentManager.reloadCore();
    }
    if (key === "startOnBoot") applyStartOnBoot();
    if (key === "httpProxy" || key === "httpsProxy" || key === "noProxy") {
      applyProxyFromSettings();
    }
  });
  electron.ipcMain.handle("connections:list", () => connectionsStore.list());
  electron.ipcMain.handle(
    "connections:upsert",
    (_e, record) => connectionsStore.upsert(record)
  );
  electron.ipcMain.handle("connections:remove", (_e, id2) => connectionsStore.remove(id2));
  electron.ipcMain.handle(
    "connections:set-status",
    (_e, id2, status, lastError) => connectionsStore.setStatus(id2, status, lastError)
  );
  electron.ipcMain.handle("connections:test", async (_e, id2) => {
    const conn = connectionsStore.get(id2);
    if (!conn)
      return { ok: false, status: "error", detail: "Connection not found" };
    if (!conn.credentialId) {
      connectionsStore.setStatus(id2, "unauthorized", "No credential linked");
      return {
        ok: false,
        status: "unauthorized",
        detail: "No credential linked"
      };
    }
    const secret = credentialsStore.getSecret(conn.credentialId);
    if (!secret) {
      connectionsStore.setStatus(id2, "unauthorized", "Credential missing");
      return { ok: false, status: "unauthorized", detail: "Credential missing" };
    }
    const result = await probe(conn.platform, secret);
    connectionsStore.setStatus(
      id2,
      result.status,
      result.detail
    );
    if (result.account) {
      connectionsStore.upsert({
        id: id2,
        platform: conn.platform,
        account: result.account
      });
    }
    credentialsStore.recordTest(conn.credentialId, result.ok, result.detail);
    return result;
  });
  const assertSenderIsMain = (e) => {
    if (mainWindow && e.sender.id !== mainWindow.webContents.id) {
      throw new Error("Unauthorized IPC sender");
    }
  };
  electron.ipcMain.handle("credentials:list", (e) => {
    assertSenderIsMain(e);
    return credentialsStore.list();
  });
  electron.ipcMain.handle("credentials:upsert", (e, input) => {
    assertSenderIsMain(e);
    return credentialsStore.upsert(input);
  });
  electron.ipcMain.handle("credentials:remove", (e, id2) => {
    assertSenderIsMain(e);
    const removed = credentialsStore.remove(id2);
    if (removed) {
      connectionsStore.unlinkCredential(id2);
      githubBindingsStore.unlinkCredential(id2);
    }
    return removed;
  });
  electron.ipcMain.handle("credentials:reveal", (e, id2) => {
    assertSenderIsMain(e);
    return credentialsStore.reveal(id2);
  });
  electron.ipcMain.handle(
    "credentials:test",
    async (e, payload) => {
      assertSenderIsMain(e);
      let secret = payload.secret;
      if (!secret && payload.id)
        secret = credentialsStore.getSecret(payload.id) || void 0;
      if (!secret)
        return { ok: false, status: "error", detail: "No secret provided" };
      const result = await probe(payload.provider, secret);
      if (payload.id)
        credentialsStore.recordTest(payload.id, result.ok, result.detail);
      return result;
    }
  );
  electron.ipcMain.handle(
    "credentials:apply-to-agents",
    async (_e, payload) => {
      const { credentialId, envKey, agentTypes } = payload;
      if (!credentialId || !envKey || !Array.isArray(agentTypes) || agentTypes.length === 0) {
        return {
          ok: false,
          error: "Missing credentialId / envKey / agentTypes"
        };
      }
      const secret = credentialsStore.getSecret(credentialId);
      if (!secret) return { ok: false, error: "Credential not found" };
      if (!agentManager) return { ok: false, error: "Agent manager not ready" };
      const written = [];
      const errors = [];
      for (const type of agentTypes) {
        try {
          const existing = agentManager.getAgentEnv(type) || {};
          const next = { ...existing, [envKey]: secret };
          agentManager.saveAgentEnv(type, next);
          written.push(type);
        } catch (e) {
          errors.push(`${type}: ${e.message}`);
        }
      }
      try {
        const all = credentialsStore.list().find((c) => c.id === credentialId);
        const next = /* @__PURE__ */ new Set([...all?.usedByAgents || [], ...written]);
        credentialsStore.upsert({
          id: credentialId,
          provider: all.provider,
          kind: all.kind,
          label: all.label,
          shared: all.shared,
          scopes: all.scopes,
          usedByAgents: Array.from(next)
        });
      } catch {
      }
      return { ok: errors.length === 0, written, errors };
    }
  );
  const resolveGitHubToken = (credentialId) => credentialsStore.getSecret(credentialId);
  electron.ipcMain.handle(
    "github:probe",
    async (_e, payload) => {
      const token = payload.secret || (payload.credentialId ? resolveGitHubToken(payload.credentialId) : null);
      if (!token) return { ok: false, error: "Missing GitHub token" };
      try {
        const r = await getGitHubClient().probe(token);
        return { ...r, ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
  );
  electron.ipcMain.handle(
    "github:parse-repo",
    (_e, input) => parseGitHubRepo(input)
  );
  electron.ipcMain.handle("github:list-bindings", () => githubBindingsStore.list());
  electron.ipcMain.handle(
    "github:bind-repo",
    async (_e, payload) => {
      const parsed = parseGitHubRepo(payload.repo);
      if (!parsed)
        return {
          ok: false,
          error: "Could not parse repo (use owner/name or URL)"
        };
      const token = resolveGitHubToken(payload.credentialId);
      if (!token) return { ok: false, error: "Credential not found" };
      try {
        await getGitHubClient().getRepo(parsed.owner, parsed.name, token);
      } catch (e) {
        return {
          ok: false,
          error: `Cannot access ${parsed.owner}/${parsed.name}: ${e.message}`
        };
      }
      const binding = githubBindingsStore.upsert({
        agentName: payload.agentName,
        owner: parsed.owner,
        repo: parsed.name,
        credentialId: payload.credentialId
      });
      return { ok: true, binding };
    }
  );
  electron.ipcMain.handle(
    "github:unbind-repo",
    (_e, agentName) => githubBindingsStore.remove(agentName)
  );
  electron.ipcMain.handle(
    "github:list-issues",
    async (_e, payload) => {
      const binding = githubBindingsStore.get(payload.agentName);
      if (!binding) return { ok: false, error: "Agent is not bound to a repo" };
      const token = resolveGitHubToken(binding.credentialId);
      if (!token)
        return { ok: false, error: "Credential missing for this binding" };
      try {
        const items = await getGitHubClient().listIssues(
          binding.owner,
          binding.repo,
          {
            state: payload.state,
            perPage: payload.perPage,
            page: payload.page
          },
          token
        );
        return { ok: true, items };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
  );
  electron.ipcMain.handle(
    "github:list-pull-requests",
    async (_e, payload) => {
      const binding = githubBindingsStore.get(payload.agentName);
      if (!binding) return { ok: false, error: "Agent is not bound to a repo" };
      const token = resolveGitHubToken(binding.credentialId);
      if (!token)
        return { ok: false, error: "Credential missing for this binding" };
      try {
        const items = await getGitHubClient().listPullRequests(
          binding.owner,
          binding.repo,
          {
            state: payload.state,
            perPage: payload.perPage,
            page: payload.page
          },
          token
        );
        return { ok: true, items };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
  );
  electron.ipcMain.handle(
    "github:comment",
    async (_e, payload) => {
      const binding = githubBindingsStore.get(payload.agentName);
      if (!binding) return { ok: false, error: "Agent is not bound to a repo" };
      const token = resolveGitHubToken(binding.credentialId);
      if (!token)
        return { ok: false, error: "Credential missing for this binding" };
      if (!payload.body || !payload.body.trim()) {
        return { ok: false, error: "Comment body is empty" };
      }
      try {
        const result = await getGitHubClient().createIssueComment(
          binding.owner,
          binding.repo,
          payload.issueNumber,
          payload.body,
          token
        );
        return { ok: true, result };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
  );
  electron.ipcMain.handle("notifications:list", () => listNotifications());
  electron.ipcMain.handle("notifications:push", (_e, input) => pushNotification(input));
  electron.ipcMain.handle("notifications:mark-read", (_e, id2) => {
    markRead(id2);
    return true;
  });
  electron.ipcMain.handle("notifications:mark-all-read", () => {
    markAllRead();
    return true;
  });
  electron.ipcMain.handle("notifications:clear", (_e, id2) => {
    if (id2) clearOne(id2);
    else clearAll();
    return true;
  });
  electron.ipcMain.handle("notifications:get-prefs", () => getPrefs());
  electron.ipcMain.handle("notifications:set-prefs", (_e, prefs) => setPrefs(prefs));
  electron.ipcMain.handle("paths:list", () => ({
    userData: electron.app.getPath("userData"),
    logs: electron.app.getPath("logs"),
    downloads: electron.app.getPath("downloads"),
    home: electron.app.getPath("home"),
    cache: electron.app.getPath("sessionData"),
    portableNode: PORTABLE_NODE_DIR,
    openagentsHome: path.join(os.homedir(), ".openagents")
  }));
  electron.ipcMain.handle("paths:show", (_e, p) => {
    try {
      electron.shell.showItemInFolder(p);
      return true;
    } catch {
      return false;
    }
  });
  electron.ipcMain.handle("settings:get-all", () => store.get());
  electron.ipcMain.handle("settings:export", () => {
    return JSON.stringify(store.get(), null, 2);
  });
  electron.ipcMain.handle("settings:import", (_e, json) => {
    try {
      const parsed = JSON.parse(json);
      if (!parsed || typeof parsed !== "object") {
        return { ok: false, error: "Expected an object" };
      }
      for (const [k, v] of Object.entries(parsed)) {
        store.set(k, v);
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  electron.ipcMain.handle("settings:reset", () => {
    const all = store.get();
    for (const k of Object.keys(all)) store.delete(k);
    return true;
  });
  electron.ipcMain.handle("agents:health-check", (_e, type) => {
    if (!agentManager) return null;
    try {
      return agentManager.healthCheck(type);
    } catch {
      return null;
    }
  });
  electron.ipcMain.handle("agents:login-refresh", async (_e, type) => {
    if (!agentManager) return null;
    try {
      return await agentManager.refreshHostedLogin(type);
    } catch {
      return null;
    }
  });
  electron.ipcMain.handle("agents:login-clear-key", (_e, type, agentName) => {
    if (!agentManager) return { success: false };
    try {
      agentManager.clearHostedLoginApiKey(type, agentName || void 0);
      return { success: true };
    } catch {
      return { success: false };
    }
  });
  electron.ipcMain.handle("core:update", async () => {
    const npm = resolveNpmInvocation();
    if (!npm) return { success: false, error: "npm runtime not found" };
    try {
      await execFileAsync(
        npm.node,
        [
          ...npm.args,
          "install",
          "--prefix",
          PORTABLE_NODE_DIR,
          `${CORE_PKG}@latest`,
          "--ignore-scripts"
        ],
        {
          timeout: 12e4,
          maxBuffer: 64 * 1024 * 1024,
          env: withPathEnv(
            PORTABLE_NODE_DIR + (process.platform === "win32" ? ";" : ":") + readPathEnv()
          )
        }
      );
      const corePkgPath = path.join(GLOBAL_MODULES, CORE_PKG, "package.json");
      try {
        coreVersion = JSON.parse(fs.readFileSync(corePkgPath, "utf-8")).version;
      } catch {
      }
      if (agentManager) {
        try {
          await agentManager.stopAll();
        } catch {
        }
        agentManager._ensureDaemon().catch(() => {
        });
      }
      return { success: true, version: coreVersion };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });
  electron.ipcMain.handle("shell:open-external", (_e, url) => electron.shell.openExternal(url));
  const runTerminal = (cmd, cwd) => {
    const { spawn } = require("child_process");
    const resolvedCmd = agentManager ? agentManager.resolveLoginCommand(cmd) : cmd;
    if (process.platform === "win32") {
      const { execSync: exec } = require("child_process");
      const home = process.env.USERPROFILE || os.homedir();
      const portableNode = path.join(home, ".openagents", "nodejs");
      const npmBin = path.join(process.env.APPDATA || "", "npm");
      const runtimeBins = [];
      try {
        const rd = path.join(home, ".openagents", "runtimes");
        for (const d of fs.readdirSync(rd, { withFileTypes: true })) {
          if (d.isDirectory())
            runtimeBins.push(path.join(rd, d.name, "node_modules", ".bin"));
        }
      } catch {
      }
      const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
      const cliBins = [
        // Cursor: native win32 installer → %LOCALAPPDATA%\cursor-agent (the
        // executables are copied to the root, not the versions\ subdir). The
        // curl|bash layout uses ~/.local\bin or ~/.cursor\bin.
        path.join(localAppData, "cursor-agent"),
        path.join(home, ".local", "bin"),
        path.join(home, ".cursor", "bin"),
        // Hermes: native (no-WSL) installer puts hermes.exe in the portable
        // venv's Scripts dir and the uv shim in %LOCALAPPDATA%\hermes\bin.
        path.join(localAppData, "hermes", "hermes-agent", "venv", "Scripts"),
        path.join(localAppData, "hermes", "bin")
      ];
      const allBins = [
        ...runtimeBins,
        path.join(portableNode, "node_modules", ".bin"),
        portableNode,
        npmBin,
        ...cliBins
      ].filter((d) => {
        try {
          return !!d && fs.existsSync(d);
        } catch {
          return false;
        }
      }).join(";");
      try {
        const lines = [
          "@echo off",
          "chcp 65001 >nul",
          `set "PATH=${allBins};%PATH%"`,
          ...cwd ? [`cd /d "${cwd}"`] : [],
          resolvedCmd
        ];
        const tmpCmd = path.join(
          os.tmpdir(),
          `openagents-login-${Date.now()}.cmd`
        );
        fs.writeFileSync(tmpCmd, "\uFEFF" + lines.join("\r\n"), "utf-8");
        exec(`start "OpenAgents Login" cmd /K "${tmpCmd}"`, {
          stdio: "ignore",
          shell: true
        });
      } catch {
      }
    } else if (process.platform === "darwin") {
      const home = os.homedir();
      const portableNode = path.join(home, ".openagents", "nodejs");
      const portableNodeBin = path.join(portableNode, "bin");
      const runtimeBins = [];
      try {
        const rd = path.join(home, ".openagents", "runtimes");
        for (const d of fs.readdirSync(rd, { withFileTypes: true })) {
          if (d.isDirectory())
            runtimeBins.push(path.join(rd, d.name, "node_modules", ".bin"));
        }
      } catch {
      }
      const allBins = [
        ...runtimeBins,
        path.join(portableNode, "node_modules", ".bin"),
        portableNodeBin,
        portableNode,
        "/usr/local/bin"
      ].join(":");
      const setPath = `export PATH=${allBins}:$PATH`;
      const cdPart = cwd ? `cd "${cwd}" && ` : "";
      const fullCmd = `${setPath} && ${cdPart}${resolvedCmd}`.replace(
        /"/g,
        '\\"'
      );
      spawn(
        "osascript",
        ["-e", `tell app "Terminal" to do script "${fullCmd}"`],
        { detached: true, stdio: "ignore" }
      );
    } else {
      const terminals = ["x-terminal-emulator", "gnome-terminal", "xterm"];
      for (const term of terminals) {
        try {
          spawn(term, ["-e", resolvedCmd], {
            detached: true,
            stdio: "ignore",
            ...cwd ? { cwd } : {}
          });
          return;
        } catch {
        }
      }
    }
  };
  electron.ipcMain.handle("shell:open-terminal", (_e, cmd) => runTerminal(cmd));
  electron.ipcMain.handle("shell:open-agent-terminal", (_e, agentName) => {
    if (!agentManager) throw new Error("Agent manager not ready");
    const agents = agentManager.getAgents();
    const agent = agents.find((a) => a.name === agentName);
    if (!agent) throw new Error(`Agent '${agentName}' not found`);
    const type = agent.type || "";
    const binary = agentManager.resolveBinary(type);
    if (!binary)
      throw new Error(`Agent type '${type}' has no interactive CLI to open.`);
    const cwd = agent.path || os.homedir();
    try {
      fs.mkdirSync(cwd, { recursive: true });
    } catch {
    }
    runTerminal(/\s/.test(binary) ? `"${binary}"` : binary, cwd);
  });
  electron.ipcMain.handle("shell:exec", (_e, cmd) => {
    const { execSync: exec } = require("child_process");
    const sh = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : true;
    return exec(cmd, { encoding: "utf-8", timeout: 3e4, shell: sh });
  });
  electron.ipcMain.handle("icons:get-dir", () => {
    const coreIconsDir = path.join(GLOBAL_MODULES, CORE_PKG, "icons");
    if (fs.existsSync(coreIconsDir)) return coreIconsDir;
    return null;
  });
  electron.ipcMain.handle("icons:get-path", (_e, name) => {
    const slug = (name || "").toLowerCase().replace(/[^a-z0-9-]/g, "");
    const coreIcon = path.join(GLOBAL_MODULES, CORE_PKG, "icons", `${slug}.svg`);
    if (fs.existsSync(coreIcon)) return coreIcon;
    return null;
  });
  electron.ipcMain.handle("debug:env", () => ({
    ComSpec: process.env.ComSpec,
    SystemRoot: process.env.SystemRoot,
    PATH: (process.env.PATH || "").slice(0, 500),
    platform: process.platform
  }));
}
const gotLock = electron.app.requestSingleInstanceLock();
if (!gotLock) {
  electron.app.quit();
} else {
  electron.app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}
electron.app.whenReady().then(async () => {
  if (process.platform !== "darwin") electron.Menu.setApplicationMenu(null);
  applyStartOnBoot();
  applyProxyFromSettings();
  setRegionPreference(store.get("downloadRegion"));
  if (useChinaMirror()) {
    process.env.npm_config_registry = npmRegistryBase();
    slog(`download region: china mirror (registry=${npmRegistryBase()})`);
  }
  setupIPC();
  setupAutoUpdater({
    getWindow: () => mainWindow,
    log: slog,
    // "Automatic updates" ON (default) = background checks auto-download and
    // electron-updater installs on the next quit. OFF = no check at all.
    isAutoUpdateEnabled: () => store.get("autoUpdate") !== false,
    // Stop chat polling + the daemon/agent subprocesses before the installer
    // runs. On Windows a live daemon holds locks under the install dir, so the
    // NSIS overwrite silently fails and the relaunch comes back on the old
    // version. before-quit also calls stopAll, but that fires without being
    // awaited during quit — here we await it so teardown completes first.
    beforeInstall: async () => {
      try {
        if (agentManager) agentManager.stopAllChatPolling();
      } catch {
      }
      try {
        if (agentManager) await agentManager.stopAll();
      } catch {
      }
    },
    onDownloaded: (version) => {
      updateTrayMenu();
      if (_lastUpdateNotifiedVersion === version) return;
      _lastUpdateNotifiedVersion = version;
      slog(`[updater] auto-update v${version} downloaded — ready to install`);
      try {
        pushNotification({
          kind: "system",
          title: "Update ready",
          body: `OpenAgents Launcher v${version} will install when you restart.`,
          source: "launcher-update"
        });
      } catch {
      }
    }
  });
  createTray();
  const bundledNodePath = process.platform === "win32" ? path.join(PORTABLE_NODE_DIR, "node.exe") : path.join(PORTABLE_NODE_DIR, "node");
  const altUnixNode = path.join(PORTABLE_NODE_DIR, "bin", "node");
  let nodeExists = false;
  if (fs.existsSync(bundledNodePath)) {
    if (canExecuteNodeBinary(bundledNodePath)) {
      nodeExists = true;
    } else {
      slog(
        `bundled node at ${bundledNodePath} failed smoke test — wiping for re-download`
      );
      try {
        fs.rmSync(PORTABLE_NODE_DIR, { recursive: true, force: true });
      } catch {
      }
    }
  } else if (process.platform !== "win32" && fs.existsSync(altUnixNode)) {
    nodeExists = canExecuteNodeBinary(altUnixNode);
    if (!nodeExists) {
      slog(
        `bundled node at ${altUnixNode} failed smoke test — wiping for re-download`
      );
      try {
        fs.rmSync(PORTABLE_NODE_DIR, { recursive: true, force: true });
      } catch {
      }
    }
  }
  let splash = null;
  if (isHeadless && process.platform === "darwin" && electron.app.dock) electron.app.dock.hide();
  if (!isHeadless) {
    splash = new electron.BrowserWindow({
      width: 420,
      height: 260,
      frame: false,
      resizable: false,
      center: true,
      alwaysOnTop: true,
      transparent: false,
      skipTaskbar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    const splashHtml = `data:text/html,
      <html><body style="margin:0;font-family:system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:%23f5f5f7;color:%23333;">
        <div style="font-size:28px;font-weight:700;margin-bottom:8px;">OpenAgents Launcher</div>
        <div id="msg" style="font-size:14px;color:%23888;margin-bottom:20px;">${!nodeExists ? "Preparing first launch..." : "Starting..."}</div>
        <div style="width:240px;height:6px;background:%23e0e0e0;border-radius:3px;overflow:hidden;">
          <div id="bar" style="width:10%25;height:100%25;background:%236C63FF;border-radius:3px;transition:width 0.5s;"></div>
        </div>
        <div id="detail" style="font-size:11px;color:%23aaa;margin-top:8px;"></div>
      </body></html>`;
    splash.loadURL(splashHtml);
    splash.show();
  }
  const updateSplash = (msg, pct, detail) => {
    if (splash && !splash.isDestroyed()) {
      splash.webContents.executeJavaScript(
        `
        document.getElementById('msg').textContent='${msg.replace(/'/g, "\\'")}';
        document.getElementById('bar').style.width='${pct}%';
        document.getElementById('detail').textContent='${(detail || "").replace(/'/g, "\\'")}';
      `
      ).catch(() => {
      });
    }
  };
  if (!nodeExists) {
    slog("Node.js not found — starting download");
    updateSplash("Downloading Node.js runtime...", 20, "This only happens once");
    try {
      await downloadNodejs(PORTABLE_NODE_DIR, (pct, detail) => {
        updateSplash("Downloading Node.js...", 20 + pct * 0.5, detail);
      });
      updateSplash("Node.js installed", 70);
    } catch (e) {
      slog(`Node.js install FAILED: ${e.message}`);
      updateSplash(
        "Setup failed: " + e.message,
        50,
        "Check ~/.openagents/startup.log"
      );
      await new Promise((r) => setTimeout(r, 5e3));
    }
  } else {
    updateSplash("Starting...", 50);
  }
  const npmCliPath = path.join(
    PORTABLE_NODE_DIR,
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js"
  );
  if (!fs.existsSync(npmCliPath)) {
    slog("npm not found — installing...");
    updateSplash("Installing npm...", 55);
    try {
      const https2 = require("https");
      const npmVersion = "10.9.8";
      const npmTgz = path.join(os.tmpdir(), `npm-${npmVersion}.tgz`);
      const npmModDir = path.join(PORTABLE_NODE_DIR, "node_modules", "npm");
      await downloadVerifyCandidates(
        https2,
        npmUrls(`npm/-/npm-${npmVersion}.tgz`),
        npmTgz,
        null,
        null
      );
      fs.mkdirSync(npmModDir, { recursive: true });
      extractTarball(npmTgz, npmModDir);
      try {
        fs.unlinkSync(npmTgz);
      } catch {
      }
      if (process.platform === "win32") {
        fs.writeFileSync(
          path.join(PORTABLE_NODE_DIR, "npm.cmd"),
          `@echo off\r
"%~dp0node.exe" "%~dp0node_modules\\npm\\bin\\npm-cli.js" %*\r
`
        );
      }
      slog("npm installed");
    } catch (e) {
      slog("npm install failed: " + e.message);
    }
  }
  updateSplash("Checking for updates...", 60);
  _updateSplash = updateSplash;
  if (process.platform === "win32") {
    const currentPath = readPathEnv();
    const pathDirs = currentPath.toLowerCase().split(";");
    const candidates = [
      PORTABLE_NODE_DIR,
      path.join(process.env.APPDATA || "", "npm"),
      path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs"),
      path.join(process.env.LOCALAPPDATA || "", "Programs", "nodejs")
    ].filter((d) => {
      try {
        return d && fs.existsSync(d) && !pathDirs.includes(d.toLowerCase());
      } catch {
        return false;
      }
    });
    if (candidates.length) {
      writePathEnv(candidates.join(";") + ";" + currentPath);
    }
  } else {
    const binDir = path.join(PORTABLE_NODE_DIR, "bin");
    const currentPath = readPathEnv();
    if (fs.existsSync(binDir) && !currentPath.includes(binDir)) {
      writePathEnv(binDir + ":" + currentPath);
    }
  }
  await ensureCoreLibrary();
  if (fs.existsSync(GLOBAL_MODULES) && !require("module").globalPaths.includes(GLOBAL_MODULES)) {
    require("module").globalPaths.push(GLOBAL_MODULES);
  }
  if (!isHeadless) createWindow();
  backendManager.ensureBackend().catch((err) => console.error("[BackendManager] ensureBackend failed:", err));
  if (splash && !splash.isDestroyed()) {
    splash.webContents.executeJavaScript(
      `
      document.getElementById('msg').textContent='Ready!';
      document.getElementById('bar').style.width='100%';
    `
    ).catch(() => {
    });
    await new Promise((r) => setTimeout(r, 500));
    splash.close();
    splash = null;
  }
  agentManager = new AgentManager(store);
  const networks = agentManager.getNetworks();
  const initEndpoint = store.get("workspaceEndpoint") || networks[0]?.endpoint;
  if (initEndpoint) {
    setBackendUrl(initEndpoint);
  }
  agentManager._ensureDaemon().catch(() => {
  });
  agentManager.on("chat-event", (ev) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("chat:event", ev);
    }
  });
  setInterval(() => updateTrayMenu(), 5e3);
  const FOUR_HOURS = 4 * 60 * 60 * 1e3;
  const ONE_HOUR = 60 * 60 * 1e3;
  setInterval(() => checkCoreUpdate().catch(() => {
  }), FOUR_HOURS);
  setTimeout(() => checkCoreUpdate().catch(() => {
  }), 3e4);
  const THIRTY_MIN = 30 * 60 * 1e3;
  let _lastLauncherUpdateCheck = 0;
  const launcherUpdateCheck = (minGapMs = 0) => {
    if (store.get("autoUpdate") === false) return;
    const now = Date.now();
    if (minGapMs > 0 && now - _lastLauncherUpdateCheck < minGapMs) return;
    _lastLauncherUpdateCheck = now;
    checkForUpdatesOnStartup().catch(() => {
    });
  };
  setTimeout(() => launcherUpdateCheck(), 2e4);
  setInterval(() => launcherUpdateCheck(), THIRTY_MIN);
  const onWindowForeground = () => launcherUpdateCheck(10 * 60 * 1e3);
  electron.app.on("browser-window-focus", onWindowForeground);
  setTimeout(() => refreshAgentUpdates(), 45e3);
  setInterval(() => refreshAgentUpdates(), ONE_HOUR);
});
electron.app.on("window-all-closed", () => {
});
electron.app.on("activate", () => {
  if (!isHeadless) createWindow();
});
electron.app.on("before-quit", () => {
  electron.app.isQuitting = true;
  try {
    embeddedViewManager.destroy();
  } catch {
  }
  try {
    backendManager.stopBackend();
  } catch {
  }
  try {
    if (agentManager) agentManager.stopAllChatPolling();
  } catch {
  }
  try {
    if (agentManager) agentManager.stopAll();
  } catch {
  }
});
exports.getBackendUrl = getBackendUrl;
exports.setBackendUrl = setBackendUrl;
