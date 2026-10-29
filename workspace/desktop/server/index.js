const http = require('http');
const url = require('url');
const path = require('path');
const fs = require('fs');
const { Store } = require('./store');
const { AgentRunner } = require('./agent-runner');
const { serveStatic } = require('./static-handler');
const { sessionUsage } = require('./usage');
const crypto = require('crypto');
const projectReader = require('./project-reader');
const { CredentialVault } = require('./credential-vault');
const { ConfigManager } = require('./config-manager');
const { ConnectionTester } = require('./connection-tester');

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

function startServer({ port = 8000, userDataPath, staticDir, runtimeOptions = {} }) {
  const store = new Store(userDataPath);
  const sseClients = new Set();
  const credentialVault = new CredentialVault(userDataPath, runtimeOptions?.safeStorage);
  const configManager = new ConfigManager(userDataPath, credentialVault, runtimeOptions?.env || process.env);
  const connectionTester = new ConnectionTester(configManager);

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

  const agentRunner = new AgentRunner(store, broadcaster, { ...runtimeOptions, configManager });

  const server = http.createServer(async (req, res) => {
    // This server exposes local project data. A remote website must not use it
    // as a cross-origin file reader, including through DNS rebinding.
    const localPort = server.address()?.port;
    const hosts = [`127.0.0.1:${localPort}`, `localhost:${localPort}`];
    const origins = hosts.map(host => `http://${host}`);
    if (process.env.OPENAGENTS_DEV_ORIGIN) origins.push(process.env.OPENAGENTS_DEV_ORIGIN);
    if (!hosts.includes(req.headers.host) || (req.headers.origin && !origins.includes(req.headers.origin))) {
      return sendJson(res, 403, { error: 'This desktop server only accepts trusted local requests.' });
    }
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
      if (query.channel) {
        const snapshot = agentRunner.snapshot(query.channel);
        if (snapshot) res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      }

      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    // 2. REST API Routes (/v1/...)
    if (pathname.startsWith('/v1/')) {
      try {
        if (pathname === '/v1/runtime/tools' && req.method === 'GET') return sendJson(res, 200, { tools: agentRunner.tools.list(query.channel) });
        if (pathname.startsWith('/v1/runtime/tools/') && req.method === 'GET') return sendJson(res, 200, agentRunner.tools.get(pathname.slice('/v1/runtime/tools/'.length), query.channel));
        if (pathname.startsWith('/v1/runtime/approvals/') && req.method === 'POST') {
          const body = await parseBody(req);
          return sendJson(res, 200, agentRunner.tools.decide(pathname.slice('/v1/runtime/approvals/'.length), body.channel, body.granted));
        }
        if (req.method === 'GET' && pathname === '/v1/git/status') return sendJson(res, 200, await projectReader.gitStatus(store, query.channel));
        if (req.method === 'GET' && pathname === '/v1/git/diff') return sendJson(res, 200, await projectReader.gitDiff(store, query.channel, query.path));
        if (req.method === 'GET' && pathname === '/v1/fs/tree') return sendJson(res, 200, await projectReader.tree(store, query.channel, query.subpath));
        if (req.method === 'GET' && pathname === '/v1/fs/content') return sendJson(res, 200, await projectReader.readContent(await projectReader.projectRoot(store, query.channel), query.path));
        if (pathname === '/v1/runtime/session') {
          const channel = query.channel || 'general';
          if (req.method === 'PATCH') {
            if (!store.getChannel(channel)) return sendJson(res, 404, { error: 'Session not found.' });
            if (agentRunner.active.has(channel)) return sendJson(res, 409, { error: 'Stop the current response before changing its model or mode.' });
            const config = agentRunner.validateConfig(await parseBody(req));
            store.updateChannel(channel, { runtime_config: config });
          } else if (req.method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed.' });
          const lastRun=store.data.runtime_runs.filter(row=>row.channel===channel).at(-1);
          return sendJson(res, 200, { config: agentRunner.config(channel), providers: agentRunner.providers(),run:lastRun || null,
            running: agentRunner.active.has(channel), queued: agentRunner.queues.get(channel)?.length || 0 });
        }
        if (pathname === '/v1/runtime/stop' && req.method === 'POST') {
          const body = await parseBody(req);
          if (typeof body.channel !== 'string' || !body.channel) return sendJson(res, 400, { error: 'Choose a session to stop.' });
          return sendJson(res, 200, agentRunner.stop(body.channel));
        }
        if (pathname === '/v1/runtime/compact' && req.method === 'POST') {
          const body=await parseBody(req);
          void agentRunner.compact(body.channel).catch(()=>{});
          return sendJson(res,202,{started:true});
        }
        if (pathname === '/v1/settings/connections') {
          if (req.method === 'GET') {
            return sendJson(res, 200, { connections: configManager.getConnections() });
          }
          if (req.method === 'POST') {
            const body = await parseBody(req);
            const saved = configManager.saveConnection(body);
            return sendJson(res, 200, { connection: saved });
          }
          if (req.method === 'DELETE') {
            const id = query.id || (await parseBody(req)).id;
            if (!id) return sendJson(res, 400, { error: 'Connection ID required' });
            return sendJson(res, 200, configManager.deleteConnection(id));
          }
          return sendJson(res, 405, { error: 'Method not allowed' });
        }
        if (pathname === '/v1/settings/connections/test' && req.method === 'POST') {
          const body = await parseBody(req);
          const result = await connectionTester.test(body);
          return sendJson(res, 200, result);
        }
        // Workspace endpoints
        // Empty read models are explicit; unsupported mutations still fail below.
        if (req.method === 'GET') {
          if (pathname === '/v1/browser/tabs') return sendJson(res, 200, { tabs: [], supported: false });
          if (pathname === '/v1/browser/contexts') return sendJson(res, 200, { contexts: [], supported: false });
          if (pathname === '/v1/knowledge') return sendJson(res, 200, { entries: [], supported: false });
          if (pathname === '/v1/events/conversations') return sendJson(res, 200, { conversations: [], supported: false });
          if (/\/agents\/[^/]+\/usage$/.test(pathname)) return sendJson(res, 200, null);
          if (pathname.endsWith('/agent-turns')) return sendJson(res, 200, { turns: [...agentRunner.turns.values()] });
          if (/^\/v1\/channels\/[^/]+\/pipeline$/.test(pathname)) return sendJson(res, 200, { active: false, supported: false });
          if (pathname === '/v1/parallel-batch') return sendJson(res, 200, { supported: false, state: 'idle', total: 0, done: 0, workers: [], conflicts: [], isolated: false });
        }
        if (/^\/v1\/workspaces\/[^/]+\/session-usage$/.test(pathname)) {
          return sendJson(res, 200, sessionUsage(store.data.events, query.channel || 'general'));
        }
        if (/^\/v1\/workspaces\/[^/]+\/agent-contexts$/.test(pathname)) {
          const latest = new Map();
          for (const event of store.data.events) {
            if (!event.metadata?.usage || !event.source.startsWith('52hz:')) continue;
            const channel = event.target.replace(/^channel\//, '');
            if (query.channel && query.channel !== channel) continue;
            const agent = event.source.slice(5);
            latest.set(`${channel}/${agent}`, { agent_name: agent, channel_name: channel,
              prompt_tokens: event.metadata.last_prompt_tokens ?? event.metadata.usage.prompt_tokens,
              context_window: event.metadata.context_window || 0, window_source: event.metadata.context_window ? 'model_catalog' : '',
              model: event.metadata.model || '', updated_at: new Date(event.timestamp).toISOString() });
          }
          return sendJson(res, 200, { contexts: [...latest.values()] });
        }
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
            if (body.working_dir !== undefined && agentRunner.active.has(chName)) return sendJson(res, 409, { error: 'Stop the run before changing its project folder.' });
            if (body.runtime_config !== undefined) {
              if (agentRunner.active.has(chName)) return sendJson(res, 409, { error: 'Stop the current response before changing its model or mode.' });
              body.runtime_config = agentRunner.validateConfig(body.runtime_config);
            }
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
            runtimes: agentRunner.providers().map(p => ({ agent_name: p.id, process_status: 'stopped', health_status: 'unknown' })),
          });
        }

        // Events endpoints
        if (pathname === '/v1/events') {
          if (req.method === 'POST') {
            const body = await parseBody(req);
            // Create channels through the same event contract used by the frontend.
            if (body.type === 'network.channel.create') {
              const existing = body.client_message_id && store.data.events.find(e => e.client_message_id === body.client_message_id);
              if (existing) return sendJson(res, 200, { event_id: existing.event_id, timestamp: existing.timestamp, status: 'confirmed', metadata: existing.metadata, duplicate: true });
              const name = `session-${crypto.randomUUID()}`;
              const runtimeConfig = body.payload?.runtime_config ? agentRunner.validateConfig(body.payload.runtime_config) : agentRunner.config(name);
              store.updateChannel(name, { title: body.payload?.title || 'New Session', runtime_config: runtimeConfig,
                participants: body.payload?.participants || [], master: body.payload?.master || null,
                created_at: new Date().toISOString() });
              body.metadata = { ...body.metadata, channel_name: name };
            }
            const saved = store.addEvent(body);
            if (!saved.duplicate) broadcaster.broadcast(saved);
            if (!saved.duplicate && saved.type === 'workspace.agent.control' && saved.payload?.action === 'stop') {
              if (typeof saved.payload.channel === 'string') agentRunner.stop(saved.payload.channel);
            }
            
            // Trigger agent processing asynchronously
            if (!saved.duplicate && saved.type === 'workspace.message.posted') {
              agentRunner.handleUserMessage(saved).catch((err) => {
                console.error('[AgentRunner] Error handling message:', err);
              });
            }

            return sendJson(res, 200, {
              status: 'confirmed',
              id: saved.id,
              event_id: saved.id,
              duplicate: Boolean(saved.duplicate),
              timestamp: saved.timestamp,
              metadata: saved.metadata,
            });
          }
          const limit = Math.max(1, Math.min(5000, parseInt(query.limit, 10) || 100));
          const events = store.getEvents({ ...query, limit: 5001 });
          return sendJson(res, 200, { events: events.slice(0, limit), has_more: events.length > limit });
        }
        if (pathname === '/v1/events/latest-per-channel') {
          return sendJson(res, 200, { channels: store.getLatestPerChannel() });
        }
        if (pathname === '/v1/composing') {
          return sendJson(res, 200, { ok: true });
        }

        // Agent Discovery & Lifecycle
        if (pathname === '/v1/agent-catalog') return sendJson(res, 200, []);
        if (pathname === '/v1/discover') {
          const ws = store.getWorkspace();
          return sendJson(res, 200, {
            agents: agentRunner.providers().map((p) => ({
              name: p.id,
              agent_name: p.id,
              agent_type: 'embedded',
              status: p.configured ? 'online' : 'offline',
              capabilities: ['chat', 'plan', 'agent', 'project-tools', 'command-approval'],
              description: p.id === 'ollama' ? 'Local Ollama endpoint; availability is checked when sending.' : `${p.label} direct API; ${p.configured ? 'API key configured' : 'API key missing'}.`,
            })),
            channels: ws.channels.filter(c => c.status !== 'deleted').map(c => ({ ...c, channel_name: c.name })),
          });
        }
        if (pathname === '/v1/profile') {
          return sendJson(res, 200, {
            capabilities: ['chat', 'streaming', 'session-models', 'local-llm', 'pi-agent', 'project-tools', 'command-approval'],
            online_count: agentRunner.providers().filter(p => p.configured).length,
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
            available: false,
            reason: 'Git integration is not connected to the desktop runtime yet.',
            branch: '',
            files: [],
            ahead: 0,
            behind: 0,
          });
        }
        if (pathname === '/v1/git/diff') {
          return sendJson(res, 501, { error: 'Git diff is not connected to the desktop runtime yet.' });
        }
        if (pathname.startsWith('/v1/git/')) {
          return sendJson(res, 501, { error: 'This Git operation is not connected to the desktop runtime yet.' });
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
          if (store.data.runtime_tools.some(row => row.approval_id === aId)) return sendJson(res, 409, { error: 'Use the session command approval controls.' });
          const body = await parseBody(req);
          const updated = store.updateApproval(aId, body.status || 'approved');
          return sendJson(res, 200, updated || { success: true });
        }

        // Unmatched /v1 route
        return sendJson(res, 404, { error: 'This feature is not available in the desktop runtime yet.' });
      } catch (err) {
        console.error('[API Router Error]', err);
        return sendJson(res, err.status || 500, { error: err.message });
      }
    }

    // 3. Static Assets Handler
    serveStatic(req, res, staticDir);
  });

  server.on('close', () => agentRunner.close());
  server.importPiConnections = () => require('./pi-config-import').importPiConnections(configManager);
  server.shutdown = async () => {
    await agentRunner.close();
    for (const client of sseClients) client.end();
    await new Promise(resolve => server.close(resolve));
  };
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const actualPort = server.address().port;
      console.log(`[52hzAgents Embedded Server] Listening on http://127.0.0.1:${actualPort}`);
      resolve({ server, port: actualPort });
    });
  });
}

module.exports = { startServer };
