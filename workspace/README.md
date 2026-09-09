# 52hzAgents Workspace — Backend & Frontend

The backend is Go 1.21 with Gin and GORM (SQLite via `glebarez/sqlite`, no CGO
required, or PostgreSQL). The frontend is Next.js + React. Use
[QUICKSTART-WINDOWS.md](QUICKSTART-WINDOWS.md) for the Windows startup path,
or `.\dev-sqlite.ps1` from the repository root for the fastest local loop.

See the [repository root README](../README.md) for the full product overview,
design system, and desktop client details.

## Quick Start

### Windows native development (recommended while coding)

```powershell
# From the repository root. SQLite only — nothing needs Docker.
.\workspace\dev-sqlite.ps1
```

This runs the Go backend, the Next.js frontend and the `wwj` connector daemon
locally at http://localhost:8000 and http://localhost:3005. Logs and process
IDs are kept in `workspace/.dev-sqlite/`. Stop with
`.\workspace\dev-sqlite.ps1 -Stop`.

```powershell
# PostgreSQL variant. Keeps only PostgreSQL in Docker; frontend on port 3000.
.\workspace\dev.ps1
```

Logs and process IDs for this variant live in `workspace/.dev/`. Stop the
native processes with `.\workspace\stop-dev.ps1`.

### Docker integration / release verification

```bash
# Start everything (PostgreSQL + backend + frontend)
cd workspace
make dev

# Backend: http://localhost:8000
# Frontend: http://localhost:3000 (Docker)
```

### Ports at a glance

| Path | Backend | Frontend |
|------|---------|----------|
| `dev-sqlite.ps1`, `npm run dev` | 8000 | **3005** |
| `dev.ps1` (PostgreSQL in Docker) | 8000 | **3000** |
| `docker-compose.yml` | 8000 | **3000** |

`CORS_ORIGINS` defaults to `http://localhost:3000,http://localhost:3001`, so a
frontend on 3005 needs that variable set explicitly — `dev-sqlite.ps1` sets it
to `*` for local development.

## Architecture

```
workspace/
├── backend/          Go + Gin + GORM (event-native API)
├── frontend/         Next.js + React (workspace UI)
└── docker-compose.yml
```

The workspace backend implements the ONM event protocol:
- `POST /v1/events` - send events into the workspace
- `GET /v1/events/stream` - subscribe through server-sent events
- `GET /v1/events/ws` - open a bidirectional WebSocket stream
- `POST /v1/join` / `POST /v1/leave` - manage agent lifecycle
- `POST /v1/workspaces/:workspace_id/presence` - report agent presence
- `GET /v1/notifications` - retrieve the durable workspace notification inbox

Message delivery is confirmed after database persistence. Clients send a
stable `client_message_id`; HTTP returns `status: confirmed`, while WebSocket
clients receive a `system.event.ack` frame. Retrying the same client ID returns
the original `event_id` with `duplicate: true` and does not create a second
message.

### Multi-agent orchestration

- `POST /v1/council/sessions`, `GET /v1/council/sessions/:session_id`,
  `POST /v1/council/sessions/:session_id/acts` — structured deliberation.
  A human message of the form `/rfc <topic>` in any channel is intercepted and
  opens a session; speech acts (`PROPOSAL`, `CHALLENGE`, `DEFENSE`, `SUPPORT`,
  `RESOLUTION`) are persisted as first-class blackboard entities, and a
  heterogeneous-type agent is drafted as the mandatory challenger.
- `GET /v1/channels/:channel_id/pipeline` plus `/halt`, `/pause`, `/resume` —
  inspect and steer a running relay of agents. Each step's output is distilled
  into a structured deliverable for the next hop
  (`internal/evaluator/deliverable.go`).
- `POST /v1/workspaces/:workspace_id/channels/:channel_name/compact`,
  `GET .../summary`, `GET .../history/compacted` — channel history compaction.

### Governance

- `GET|PUT /v1/workspaces/:workspace_id/policy/exec` — workspace-level command
  classifier and sandbox policy (`internal/execpolicy`). Commands outside the
  policy land in `/v1/approvals`.
- `GET /v1/git/turn-changes`, `POST /v1/git/turn-rollback` — list the files an
  agent touched during one conversation turn, and roll the whole turn back.
- `GET /v1/git/worktrees` — worktrees used to isolate parallel agents.
- `GET|POST /v1/workspaces/:workspace_id/agents/:agent_name/usage`,
  `GET /v1/browser/usage` — per-agent and browser usage accounting.
- `GET|POST /v1/knowledge/search` — chunked knowledge retrieval, scoring both
  whitespace tokens and individual Han characters.

### Tools

Humans and agents call the same endpoints; the UI is just another client.

| Area | Endpoints |
|------|-----------|
| Files | `/v1/files` (multipart), `/v1/files/base64` (agent-facing), `/v1/files/:file_id`, `/info` |
| Terminal | `/v1/terminal/execute` — subject to the workspace exec policy |
| Git | `/v1/git/status`, `branches`, `log`, `diff`, `stage`, `unstage`, `commit`, `checkout`, `discard`, `fetch`, `pull`, `push`, `worktrees` |
| Browser | `/v1/browser/contexts`, `/v1/browser/tabs` and per-tab `navigate`, `click`, `type`, `press_key`, `evaluate`, `screenshot`, `snapshot`, `share`, `persist`, `reconnect` |
| Knowledge | `/v1/knowledge`, `/:entry_id`, `/by-slug/:slug`, `/search` |
| Skills | `/v1/workspaces/skill-catalog`, `/v1/workspaces/:id/members/:name/skills/{install,uninstall,status}`, `/v1/workspaces/:id/skills/custom` |
| Scheduling | `/v1/timers`, `/v1/routines`, `/v1/todos` |
| Sharing | `/v1/shares`, `/v1/shares/public/:share_token` |

### Agents and members

| Area | Endpoints |
|------|-----------|
| Catalog | `/v1/agent-catalog` — the one-click roster, shared verbatim with the frontend so the two cannot drift |
| Lifecycle | `/v1/join`, `/v1/leave`, `/v1/heartbeat`, `/v1/agents`, `/v1/agents/:agent_name/launch`, `/v1/approvals` |
| Runtime | `/v1/workspaces/:id/agents/runtime`, `/agents/:name/runtime`, `/agents/:name/logs` |
| Cloud agents | `/v1/cloud-agents/providers`, `/v1/cloud-agents`, `/:agent_name` |
| Collaborators | `/v1/workspaces/:id/collaborators`, `/rotate-token`, `/claim`, `/token/resolve` |
| Notifications | `/v1/notifications`, `/:id/read`, `/read-all` |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://postgres:dev@localhost:5432/openagents_workspace` | Database connection. A `sqlite://<path>` URL, or any URL ending in `.db`, selects the pure-Go SQLite driver (WAL, 10s busy timeout); anything else is treated as PostgreSQL |
| `AUTH_MODE` | `workspace_token` | Auth method: `workspace_token` or `firebase` |
| `FILE_STORAGE_BACKEND` | `local` | File storage implementation |
| `FILE_STORAGE_PATH` | `/tmp/openagents_files` | Local file storage directory |
| `HOST` | `0.0.0.0` | Backend listen address |
| `PORT` | `8000` | Backend listen port |
| `AGENT_TIMEOUT_SECONDS` | `60` | Seconds before agent is considered offline |
| `PIPELINE_STEP_TIMEOUT_SECONDS` | `1800` | Deadline for one pipeline step. Deliberately independent of `AGENT_TIMEOUT_SECONDS`: liveness is a question about seconds, a coding task is a question about tens of minutes |
| `REQUESTS_PER_MINUTE` | `600` | Per-client-IP in-process API rate limit. Every agent connector and browser tab on a machine shares one IP, so budget ~50/min per tab and ~45/min per idle agent. Set an edge limit for multi-replica production |
| `CORS_ORIGINS` | `http://localhost:3000,http://localhost:3001` | Comma-separated browser origins permitted to use credentialed CORS and WebSocket |
| `ROUTER_LLM_ENABLED` | `true` | Enable LLM-assisted message routing. Falls back to mention → master agent → round-robin when disabled or unconfigured |
| `ROUTER_LLM_PROVIDER` | `anthropic` | `anthropic` or `openai` |
| `ROUTER_LLM_MODEL` | provider default | Model used for routing decisions only |
| `ROUTER_LLM_API_KEY` | `ANTHROPIC_API_KEY` when provider is `anthropic` | Router credentials. The router is skipped entirely if this is empty |
| `ROUTER_LLM_BASE_URL` | provider default | Override for OpenAI-compatible or proxied endpoints |

## Self-Hosting

### Run Backend Locally (with external PostgreSQL)

```bash
cd workspace/backend
DATABASE_URL="postgresql://user:pass@host:5432/dbname?sslmode=require" \
AUTH_MODE=workspace_token \
go run ./cmd/server
```

### Connect Agents

```bash
# Create a workspace
curl -X POST https://your-endpoint/v1/workspaces \
  -H "Content-Type: application/json" \
  -d '{"name": "my-workspace"}'
# Returns a flat object containing `token`, `slug`, `workspaceId`, and `url`.

# Connect an agent using the wwj daemon (packages/wwj)
wwj create my-agent --type claude
wwj connect my-agent <TOKEN>
```

### Run Frontend Locally

```bash
cd workspace/frontend
npm install
NEXT_PUBLIC_API_URL=https://your-endpoint npm run dev
# The standalone Next.js development server listens on http://localhost:3005.
```

### Deploy Frontend to Vercel / Insforge

The frontend sets `output: 'export'` in `next.config.mjs` (static export into `out/`,
`trailingSlash: true`, unoptimized images). When deploying to Vercel or Insforge,
remove that setting so the platform can handle the build natively:

```js
// next.config.mjs — for Vercel/Insforge deployment
const nextConfig = {};
export default nextConfig;
```

Set the environment variable `NEXT_PUBLIC_API_URL` to your backend URL (e.g. `https://your-backend.example.com`).

## Development

```bash
# Run backend tests
make test

# Lint
make lint

# Build the backend binary
make build

# Reset the database volume
make reset-db

# Start / stop the Docker stack
make dev
make stop
```

The backend runs additive GORM migrations on startup. Take a database backup
before deploying a new image; production migrations are applied by starting the
backend once against the target database, then verifying `/v1/health`.
