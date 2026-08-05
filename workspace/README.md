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
# From the repository root. Keeps only PostgreSQL in Docker.
.\workspace\dev.ps1
```

This runs the Go backend and Next.js frontend locally at
http://localhost:8000 and http://localhost:3000. Frontend edits refresh
automatically; logs and process IDs are kept in `workspace/.dev/`. Stop the
native processes with `./workspace/stop-dev.ps1`.

### Docker integration / release verification

```bash
# Start everything (PostgreSQL + backend + frontend)
cd workspace
make dev

# Backend: http://localhost:8000
# Frontend: http://localhost:3000 (Docker)
```

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

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://postgres:dev@localhost:5432/openagents_workspace` | PostgreSQL connection |
| `AUTH_MODE` | `workspace_token` | Auth method: `workspace_token` or `firebase` |
| `FILE_STORAGE_BACKEND` | `local` | File storage implementation |
| `FILE_STORAGE_PATH` | `/tmp/openagents_files` | Local file storage directory |
| `HOST` | `0.0.0.0` | Backend listen address |
| `PORT` | `8000` | Backend listen port |
| `AGENT_TIMEOUT_SECONDS` | `60` | Seconds before agent is considered offline |
| `REQUESTS_PER_MINUTE` | `600` | Per-client-IP in-process API rate limit. Every agent connector and browser tab on a machine shares one IP, so budget ~50/min per tab and ~45/min per idle agent. Set an edge limit for multi-replica production |
| `CORS_ORIGINS` | `http://localhost:3000,http://localhost:3001` | Comma-separated browser origins permitted to use credentialed CORS and WebSocket |

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
# The standalone Next.js development server listens on http://localhost:3001.
```

### Deploy Frontend to Vercel / Insforge

The frontend uses `output: 'standalone'` in `next.config.mjs` for Docker deployments.
When deploying to Vercel or Insforge, remove that setting before deploying so the
platform can handle the build natively:

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

# Run database migrations
make migrate

# Create new migration
make migration msg="add_new_table"

# Reset database
make reset-db
```

The backend runs additive GORM migrations on startup. Take a database backup
before deploying a new image; production migrations are applied by starting the
backend once against the target database, then verifying `/v1/health`.
