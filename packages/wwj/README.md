# WWJ Launcher

Agent management CLI and library for your self-hosted Workspace — install, configure, and run AI coding agents from your terminal.

## Install

```bash
npm install -g ./wwj-0.1.0.tgz
```

## CLI Usage

```bash
# Browse available agents
wwj search

# Install an agent runtime
wwj install openclaw
wwj install claude

# Create and configure an agent
wwj create my-agent --type openclaw
wwj env openclaw --set LLM_API_KEY=sk-...
wwj env openclaw --set LLM_BASE_URL=https://api.openai.com/v1

# Start the daemon (runs agents in background)
wwj up

# Check status
wwj status

# View logs
wwj logs

# Connect to a workspace
wwj connect my-agent <token>

# Stop
wwj down
```

Run `wwj help` for the full command list.

## Library Usage

```js
const { AgentConnector } = require('wwj');

const connector = new AgentConnector();

// Browse catalog
const catalog = await connector.getCatalog();

// Install a runtime
await connector.install('openclaw');

// Agent CRUD
connector.addAgent({ name: 'my-agent', type: 'openclaw' });
connector.saveAgentEnv('openclaw', { LLM_API_KEY: 'sk-...' });

// Daemon lifecycle
const daemon = connector.createDaemon();
await daemon.start();
```

## Supported Agents

| Agent | Type | Install |
|-------|------|---------|
| [OpenClaw](https://github.com/openagents/openclaw) | `openclaw` | npm |
| [Claude Code](https://claude.ai/claude-code) | `claude` | npm |
| [Codex](https://github.com/openai/codex) | `codex` | npm |
| [Aider](https://aider.chat) | `aider` | curl |
| [Goose](https://github.com/block/goose) | `goose` | curl |
| [Amp](https://ampcode.com) | `amp` | curl |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `gemini` | npm |
| And more... | | |

## Requirements

- Node.js 18+
- No Python required

## License

MIT
