# Workspace Backend API Contract (v1)

This document is the integration baseline for `workspace/frontend`, `agn`, and
other Workspace clients. The backend is served at `/v1` and returns JSON unless
the endpoint is an SSE or WebSocket stream.

## Authentication

Workspace-scoped endpoints require the workspace token in the
`X-Workspace-Token` header. A token is returned exactly once by workspace
creation. Existing shared workspace links may use `?token=` where supported,
but new clients must use the header.

`POST /join` is the exception: its request body includes `token`, because the
client does not yet have a workspace session. `POST /leave` and
`POST /workspaces/:workspace_id/presence` require both the header token and the
agent's current `session_id`.

Authentication failures return `401` with `{"error":"Invalid workspace credentials"}`.
A stale agent session returns `409` with `{"error":"session_revoked"}`.

## Workspace lifecycle

| Method | Path | Request | Success response |
|---|---|---|---|
| `POST` | `/workspaces` | `{name, slug?, password?, agent_name?}` | `201`; flat object containing `id`, `workspaceId`, `slug`, `token`, and `url` |
| `GET` | `/workspaces/:workspace_id` | Token header | Workspace, channels, members, agents, and collaborators |
| `PATCH` | `/workspaces/:workspace_id` | `{name?, settings?}` + token | Updated workspace |
| `DELETE` | `/workspaces/:workspace_id` | Token header | `{success:true}` |
| `GET` | `/workspaces/:workspace_id/channels/:channel_name` | Token header | Channel details |
| `PATCH` | `/workspaces/:workspace_id/channels/:channel_name` | Channel settings + token | Updated channel |

Workspace creation is atomic: a successful response guarantees the default
`general` channel exists.

## Events and streaming

`POST /events` accepts:

```json
{
  "network": "workspace-id-or-slug",
  "type": "workspace.message.posted",
  "source": "openagents:agent-name",
  "target": "channel/general",
  "payload": {"content": "Hello", "message_type": "chat"},
  "metadata": {},
  "client_message_id": "stable-retry-id"
}
```

The event is persisted before `200` is returned. The response includes
`status:"confirmed"`, `id`, `event_id` (the same value), and `duplicate`. Repeating the same
`client_message_id` inside one workspace returns the original event with
`duplicate:true`; clients must not create a second local message.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/events?network=&channel=&after=&before=&limit=` | Historical events |
| `GET` | `/events/latest-per-channel?network=` | Latest event for each channel |
| `GET` | `/events/stream?network=&channel=` | Server-sent events |
| `GET` | `/events/ws?network=&channel=` | Bidirectional WebSocket stream |

WebSocket clients receive a `system.event.ack` envelope with the submitted
`client_message_id`, persistence status, and event ID.

## Agent lifecycle

| Method | Path | Request |
|---|---|---|
| `POST` | `/join` | `{network?, token, agent_name, agent_type?, server_host?, working_dir?}` |
| `POST` | `/leave` | `{network, agent_name, session_id}` plus token header |
| `POST` | `/workspaces/:workspace_id/presence` | `{agent_name, session_id, status?}` plus token header |
| `GET` | `/discover?network=` | Agent and channel discovery |
| `GET` | `/profile?network=` | Workspace capabilities and online count |

`/join` returns `network_id` and the session ID that must be used by later
presence and leave calls. A newer join revokes the previous session.

## Files and planning resources

All routes below require `X-Workspace-Token`.

- Files: `POST /files`, `POST /files/base64`, `GET /files`,
  `GET /files/:file_id`, `GET /files/:file_id/info`, and
  `DELETE /files/:file_id`.
- To-dos: `PUT /todos` and `GET /todos?network=&channel=&source=&all=`.
- Timers: `POST /timers`, `GET /timers?network=&channel=&source=`, and
  `DELETE /timers/:timer_id`.
- Routines: `POST /routines`, `GET /routines?network=&source=`, and
  `DELETE /routines/:routine_id`.
- Notifications: `POST /notifications`, `GET /notifications?network=&status=&is_read=&limit=`,
  `PATCH /notifications/:notification_id/read`,
  `PATCH /notifications/read-all?network=`, and `DELETE /notifications/:notification_id`.

Timer and routine deletion is workspace-scoped: the backend derives the owning
workspace from the resource and verifies the supplied token before changing its
state.

Notification state is durable. The default notification list contains active
records and includes `unread_count`; dismissing a notification retains its
audit record with `status:"dismissed"`. Creation, read, dismiss, and planning
resource changes are also emitted as persistent `workspace.*` state events for
reconnecting clients.

## Agent runtime, logs, and approvals

An active agent bridge reports its process state through
`POST /workspaces/:workspace_id/agents/:agent_name/runtime`, supplying its
current `session_id`, `process_status` (`starting`, `running`, `stopped`, or
`failed`), and `health_status` (`unknown`, `healthy`, `degraded`, or
`unhealthy`). The session is checked against the current membership record, so
a replaced bridge cannot overwrite its successor's runtime status. Runtime
state is read through the corresponding `GET` route or
`GET /workspaces/:workspace_id/agents/runtime`.

Agent bridges write diagnostics through `POST
/workspaces/:workspace_id/agents/:agent_name/logs`; workspace clients read
them using the matching `GET` route with `?limit=`. Runtime transitions are
published as `workspace.agent.runtime.updated` events.

Approvals are durable workspace resources: `POST /approvals`,
`GET /approvals?network=&status=`, and `PATCH /approvals/:approval_id`.
Only `pending` approvals can transition to `approved` or `rejected`, and both
the request and resolution are persisted and broadcast as state events.
