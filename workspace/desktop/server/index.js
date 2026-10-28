const http = require('http');
const url = require('url');
const path = require('path');
const fs = require('fs');
const { Store } = require('./store');
const { AgentRunner } = require('./agent-runner');
const { serveStatic } = require('./static-handler');

function sendJson(res, statusCode, data) {
  const json = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Workspace-Token',
  });
  res.end(json);
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (_) {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function startServer({ port = 8000, userDataPath, staticDir }) {
  const store = new Store(userDataPath);
  const sseClients = new Set();

  const broadcaster = {
    broadcast(event) {
      const data = `data: ${JSON.stringify(event)}\n\n`;
      for (const client of sseClients) {
        try {
          client.write(data);
        } catch (_) {
          sseClients.delete(client);
        }
      }
    },
    broadcastComposing(channel, agentName) {
      const composingEvent = {
        type: 'workspace.agent.composing',
        source: `52hz:${agentName}`,
        target: `channel/${channel}`,
        payload: { agent_name: agentName },
        timestamp: Date.now(),
      };
      this.broadcast(composingEvent);
    },
  };

  const agentRunner = new AgentRunner(store, broadcaster);

  const server = http.createServer(async (req, res) => {
    // CORS Preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Workspace-Token',
      });
      res.end();
      return;
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname || '/';
    const query = parsedUrl.query || {};

    // 1. SSE Stream Route
    if (pathname === '/v1/events/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(': heartbeat\n\n');
      sseClients.add(res);

      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    // 2. REST API Routes (/v1/...)
    if (pathname.startsWith('/v1/')) {
      try {
        // Workspace endpoints
        if (pathname === '/v1/workspaces') {
          return sendJson(res, 200, { items: [store.getWorkspace()] });
        }
        if (pathname === '/v1/workspaces/52hz' || pathname === '/v1/workspaces/default') {
          if (req.method === 'PATCH') {
            const body = await parseBody(req);
            const ws = store.getWorkspace();
            Object.assign(ws, body);
            store.save();
            return sendJson(res, 200, ws);
          }
          return sendJson(res, 200, store.getWorkspace());
        }
        if (pathname.startsWith('/v1/workspaces/52hz/channels/')) {
          const chName = pathname.replace('/v1/workspaces/52hz/channels/', '');
          if (req.method === 'PATCH') {
            const body = await parseBody(req);
            const updated = store.updateChannel(chName, body);
            return sendJson(res, 200, updated);
          }
          const ch = store.getChannel(chName);
          return sendJson(res, 200, ch || { name: chName, title: chName, status: 'active' });
        }
        if (pathname.includes('/collaborators')) {
          return sendJson(res, 200, { collaborators: [], owner: 'human:user' });
        }
        if (pathname.includes('/skill-catalog')) {
          return sendJson(res, 200, []);
        }
        if (pathname.includes('/skills/custom')) {
          return sendJson(res, 200, { skills: [] });
        }
        if (pathname.includes('/agents/runtime')) {
          return sendJson(res, 200, {
            runtimes: [
              { agent_name: 'deepseek', process_status: 'running', health_status: 'healthy' },
              { agent_name: 'claude', process_status: 'running', health_status: 'healthy' },
              { agent_name: 'gemini', process_status: 'running', health_status: 'healthy' },
              { agent_name: 'ollama', process_status: 'running', health_status: 'healthy' },
            ],
          });
        }

        // Events endpoints
        if (pathname === '/v1/events') {
          if (req.method === 'POST') {
            const body = await parseBody(req);
            const saved = store.addEvent(body);
            broadcaster.broadcast(saved);
            
            // Trigger agent processing asynchronously
            if (saved.type === 'workspace.message.posted') {
              agentRunner.handleUserMessage(saved).catch((err) => {
                console.error('[AgentRunner] Error handling message:', err);
              });
            }

            return sendJson(res, 200, {
              status: 'confirmed',
              id: saved.id,
              event_id: saved.id,
              duplicate: Boolean(saved.duplicate),
            });
          }
          const events = store.getEvents(query);
          return sendJson(res, 200, { events, has_more: false });
        }
        if (pathname === '/v1/events/latest-per-channel') {
          return sendJson(res, 200, { channels: store.getLatestPerChannel() });
        }
        if (pathname === '/v1/composing') {
          return sendJson(res, 200, { ok: true });
        }

        // Agent Discovery & Lifecycle
        if (pathname === '/v1/discover') {
          const ws = store.getWorkspace();
          return sendJson(res, 200, {
            agents: ws.members.map((m) => ({
              name: m.name,
              agent_name: m.name,
              agent_type: 'embedded',
              status: 'online',
              capabilities: ['chat', 'code', 'file-ops'],
              description: m.description,
            })),
            channels: ws.channels.map((c) => c.name),
          });
        }
        if (pathname === '/v1/profile') {
          return sendJson(res, 200, {
            capabilities: ['chat', 'tools', 'git', 'files', 'local-llm'],
            online_count: 4,
          });
        }
        if (pathname === '/v1/join' || pathname === '/v1/leave' || pathname.includes('/presence')) {
          return sendJson(res, 200, { ok: true, session_id: 'local-session', network_id: '52hz' });
        }

        // Files
        if (pathname === '/v1/files') {
          if (req.method === 'POST') {
            const body = await parseBody(req);
            const fileMeta = store.addFile({
              id: `file-${Date.now()}`,
              filename: body.filename || 'file.bin',
              content_type: body.content_type || 'application/octet-stream',
              size: body.size || 0,
              uploaded_by: 'human:user',
              channel_name: body.channel_name || 'general',
              status: 'active',
              created_at: new Date().toISOString(),
            });
            return sendJson(res, 200, fileMeta);
          }
          const files = store.getFiles();
          return sendJson(res, 200, { files, total: files.length });
        }

        // Git integration
        if (pathname === '/v1/git/status') {
          return sendJson(res, 200, {
            branch: 'master',
            clean: true,
            files: [],
            ahead: 0,
            behind: 0,
          });
        }
        if (pathname === '/v1/git/diff') {
          return sendJson(res, 200, { status: 'ok', diff: '' });
        }
        if (pathname.startsWith('/v1/git/')) {
          return sendJson(res, 200, { status: 'ok', output: '' });
        }

        // Planning resources (Todos, Timers, Routines, Notifications, Approvals)
        if (pathname === '/v1/todos') {
          if (req.method === 'PUT') {
            const body = await parseBody(req);
            const updated = store.putTodos(body.todos || body);
            return sendJson(res, 200, { todos: updated });
          }
          return sendJson(res, 200, { todos: store.getTodos() });
        }
        if (pathname === '/v1/timers') {
          if (req.method === 'POST') {
            const body = await parseBody(req);
            const added = store.addTimer(body);
            return sendJson(res, 200, added);
          }
          return sendJson(res, 200, { timers: store.getTimers() });
        }
        if (pathname.startsWith('/v1/timers/') && req.method === 'DELETE') {
          const tId = pathname.replace('/v1/timers/', '');
          store.deleteTimer(tId);
          return sendJson(res, 200, { success: true });
        }
        if (pathname === '/v1/routines') {
          if (req.method === 'POST') {
            const body = await parseBody(req);
            const added = store.addRoutine(body);
            return sendJson(res, 200, added);
          }
          return sendJson(res, 200, { routines: store.getRoutines() });
        }
        if (pathname.startsWith('/v1/routines/') && req.method === 'DELETE') {
          const rId = pathname.replace('/v1/routines/', '');
          store.deleteRoutine(rId);
          return sendJson(res, 200, { success: true });
        }
        if (pathname === '/v1/notifications') {
          const list = store.getNotifications(query);
          return sendJson(res, 200, { notifications: list, unread_count: list.filter((x) => !x.is_read).length });
        }
        if (pathname.includes('/notifications/') && pathname.endsWith('/read')) {
          const nId = pathname.split('/')[3];
          const marked = store.markNotificationRead(nId);
          return sendJson(res, 200, marked || { success: true });
        }
        if (pathname === '/v1/approvals') {
          if (req.method === 'POST') {
            const body = await parseBody(req);
            const added = store.addApproval(body);
            return sendJson(res, 200, added);
          }
          return sendJson(res, 200, { approvals: store.getApprovals(query) });
        }
        if (pathname.startsWith('/v1/approvals/') && req.method === 'PATCH') {
          const aId = pathname.replace('/v1/approvals/', '');
          const body = await parseBody(req);
          const updated = store.updateApproval(aId, body.status || 'approved');
          return sendJson(res, 200, updated || { success: true });
        }

        // Unmatched /v1 route
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        console.error('[API Router Error]', err);
        return sendJson(res, 500, { error: err.message });
      }
    }

    // 3. Static Assets Handler
    serveStatic(req, res, staticDir);
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      console.log(`[52hzAgents Embedded Server] Listening on http://127.0.0.1:${actualPort}`);
      resolve({ server, port: actualPort });
    });
  });
}

module.exports = { startServer };
