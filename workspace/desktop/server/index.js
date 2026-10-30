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
const { Worktrees } = require('./worktrees');
const { getVersionInfo } = require('./version');
const { McpManager, isMcpToolReadOnly } = require('./mcp-client');
const { SchedulerEngine } = require('./scheduler');

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

function parseBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        req.destroy();
        return reject(Object.assign(new Error('Request payload exceeds size limit (10MB)'), { status: 413 }));
      }
      body += chunk;
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(Object.assign(new Error('Invalid JSON payload in request body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function startServer({ port = 8000, userDataPath, staticDir, apiToken, runtimeOptions = {} }) {
  const store = new Store(userDataPath);
  const sseClients = new Set();
  const credentialVault = new CredentialVault(userDataPath, runtimeOptions?.safeStorage, runtimeOptions?.credentialsCache);
  const configManager = new ConfigManager(userDataPath, credentialVault, runtimeOptions?.env || process.env);
  const connectionTester = new ConnectionTester(configManager);

  const broadcaster = {
    broadcast(event) {
      const data = event?.seq ? `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n` : `data: ${JSON.stringify(event)}\n\n`;
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

  const mcpManager = new McpManager({ storage: store.storage });
  const agentRunner = new AgentRunner(store, broadcaster, { ...runtimeOptions, configManager, mcpManager });
  const worktrees = new Worktrees(store,agentRunner,broadcaster);
  const scheduler = new SchedulerEngine({ storage: store.storage, agentRunner, broadcaster });
  scheduler.start();

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

    // Authentication Guard (only enforce on /v1/ API endpoints, allowing static assets and HTML to load)
    const expectedToken = apiToken || runtimeOptions?.apiToken || process.env.OPENAGENTS_API_TOKEN;
    if (expectedToken && pathname.startsWith('/v1/')) {
      const authHeader = req.headers['authorization'];
      const workspaceToken = req.headers['x-workspace-token'] || query.token;
      const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;
      const providedToken = bearerToken || workspaceToken;

      if (!providedToken || providedToken !== expectedToken) {
        return sendJson(res, 401, { error: 'Unauthorized: valid X-Workspace-Token or Bearer token is required.' });
      }
    }

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

      const rawAfterSeq = req.headers['last-event-id'] || query.after_seq || query.after || null;
      const afterSeq = rawAfterSeq !== null ? parseInt(rawAfterSeq, 10) : NaN;
      if (!isNaN(afterSeq) && afterSeq >= 0 && store.storage) {
        try {
          const missedEvents = store.storage.events.list({
            sessionId: query.channel || null,
            afterSeq,
            limit: 501,
          });
          const eventsToSend = missedEvents.slice(0, 500);
          for (const evt of eventsToSend) {
            res.write(`id: ${evt.seq}\ndata: ${JSON.stringify(evt)}\n\n`);
          }
          if (missedEvents.length > 500) {
            res.write(`event: sync_required\ndata: ${JSON.stringify({
              type: 'sync_required',
              reason: 'backlog_exceeded',
              afterSeq,
              lastSentSeq: eventsToSend[eventsToSend.length - 1]?.seq,
              channel: query.channel || null,
            })}\n\n`);
          }
        } catch (_) {}
      }
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
        if(pathname==='/v1/runtime/worktree') {
          if(req.method==='GET')return sendJson(res,200,await worktrees.state(query.channel));
          if(req.method==='POST'){
            const body=await parseBody(req);
            if(typeof body.channel!=='string')return sendJson(res,400,{error:'请选择会话。'});
            const actions={create:()=>worktrees.create(body.channel),enter:()=>worktrees.switch(body.channel,true),leave:()=>worktrees.switch(body.channel,false),review:()=>worktrees.review(body.channel),apply:()=>worktrees.apply(body.channel,body.revision),remove:()=>worktrees.remove(body.channel),forget:()=>worktrees.forget(body.channel)};
            if(!Object.hasOwn(actions,body.action))return sendJson(res,400,{error:'未知工作区操作。'});
            return sendJson(res,200,await actions[body.action]());
          }
          return sendJson(res,405,{error:'Method not allowed.'});
        }
        if (req.method !== 'GET' && (/\/skills(\/|$)|\/skill-catalog$/.test(pathname))) {
          return sendJson(res,501,{supported:false,error:'此桌面版本尚未提供技能管理，请在会话中启动任务。'});
        }
        if (pathname === '/v1/runtime/recovery' && req.method === 'GET') {
          const runs=store.data.runtime_runs.filter(row=>row.channel===query.channel).slice(-20);
          return sendJson(res,200,{storage:store.recovery || null,runs:await Promise.all(runs.map(async row=>({...row,checkpoint:await (async()=>{const checkpoint=await agentRunner.checkpoints.describe(row.id,query.channel);if(!checkpoint)return null;let root='';try{root=fs.realpathSync.native(store.getChannel(query.channel)?.working_dir||'');}catch{}return {...checkpoint,root_matches:process.platform==='win32'?root.toLowerCase()===checkpoint.root.toLowerCase():root===checkpoint.root};})()})))});
        }
        if (pathname === '/v1/runtime/restore' && req.method === 'POST') {
          const body=await parseBody(req);
          return sendJson(res,200,await agentRunner.restore(body.channel,body.run_id));
        }
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
            if (agentRunner.active.has(channel) || agentRunner.workspaceOperations.has(channel)) return sendJson(res, 409, { error: 'Stop the current response before changing its model or mode.' });
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
            const saved = await configManager.saveConnection(body);
            return sendJson(res, 200, { connection: saved });
          }
          if (req.method === 'DELETE') {
            const id = query.id || (await parseBody(req)).id;
            if (!id) return sendJson(res, 400, { error: 'Connection ID required' });
            return sendJson(res, 200, await configManager.deleteConnection(id));
          }
          return sendJson(res, 405, { error: 'Method not allowed' });
        }
        if (pathname === '/v1/settings/connections/test' && req.method === 'POST') {
          const body = await parseBody(req);
          const result = await connectionTester.test(body);
          return sendJson(res, 200, result);
        }
        if (pathname === '/v1/settings/pricing') {
          if (!store.storage) return sendJson(res, 200, { pricing: [] });
          if (req.method === 'GET') {
            return sendJson(res, 200, { pricing: store.storage.pricing.list({ provider: query.provider }) });
          }
          if (req.method === 'POST') {
            const body = await parseBody(req);
            const saved = store.storage.pricing.setCustomPrice(body);
            return sendJson(res, 200, { rule: saved });
          }
          return sendJson(res, 405, { error: 'Method not allowed' });
        }
        if (pathname === '/v1/settings/budgets') {
          if (!store.storage) return sendJson(res, 200, { budget: null });
          const targetSession = query.sessionId || query.channel || 'global';
          if (req.method === 'GET') {
            return sendJson(res, 200, { budget: store.storage.budgets.getForSession(targetSession) });
          }
          if (req.method === 'POST') {
            const body = await parseBody(req);
            const saved = store.storage.budgets.setForSession(body.sessionId || targetSession, body);
            return sendJson(res, 200, { budget: saved });
          }
          return sendJson(res, 405, { error: 'Method not allowed' });
        }
        if (pathname === '/v1/settings/capabilities') {
          if (!store.storage) return sendJson(res, 200, { capabilities: [] });
          if (query.connectionId) {
            return sendJson(res, 200, { capabilities: store.storage.capabilities.listByConnection(query.connectionId) });
          }
          const cap = store.storage.capabilities.get(query.provider || query.connection, query.model);
          return sendJson(res, 200, { capability: cap });
        }
        if (pathname === '/v1/usage/summary' && req.method === 'GET') {
          const channel = query.channel || query.sessionId;
          if (!channel) return sendJson(res, 400, { error: 'Channel or sessionId required' });
          if (store.storage) {
            return sendJson(res, 200, store.storage.usage.getSummaryForSession(channel));
          }
          return sendJson(res, 200, { totalTokens: 0, estimatedCost: null, hasUnknownCost: true });
        }
        if ((pathname === '/v1/system/version' || pathname === '/v1/app/version') && req.method === 'GET') {
          return sendJson(res, 200, getVersionInfo({
            storage: store.storage,
            userDataPath: store.userDataPath || store.dir,
          }));
        }
        // Workspace endpoints
        // Empty read models are explicit; unsupported mutations still fail below.
        if (req.method === 'GET') {
          if (pathname === '/v1/browser/tabs') return sendJson(res, 200, { tabs: [], supported: false });
          if (pathname === '/v1/browser/contexts') return sendJson(res, 200, { contexts: [], supported: false });
        }
          // Knowledge API (Package L)
          if (pathname === '/v1/knowledge' && req.method === 'GET') {
            if (!store.storage) return sendJson(res, 200, { entries: [], total: 0, supported: false });
            const list = store.storage.knowledge.list({
              category: query.category,
              q: query.q,
              limit: query.limit ? parseInt(query.limit, 10) : 50,
              offset: query.offset ? parseInt(query.offset, 10) : 0,
            });
            return sendJson(res, 200, { entries: list.entries, total: list.total, supported: true });
          }
          if (pathname === '/v1/knowledge/search' && req.method === 'GET') {
            if (!store.storage) return sendJson(res, 200, { query: '', total_matches: 0, results: [], supported: false });
            const searchRes = store.storage.knowledge.search({
              q: query.q || query.query,
              category: query.category,
              limit: query.limit ? parseInt(query.limit, 10) : 20,
            });
            return sendJson(res, 200, { ...searchRes, supported: true });
          }
          if (pathname.startsWith('/v1/knowledge/') && req.method === 'GET') {
            const id = pathname.slice('/v1/knowledge/'.length);
            if (!store.storage) return sendJson(res, 404, { error: 'Knowledge not found' });
            const entry = store.storage.knowledge.get(id);
            if (!entry) return sendJson(res, 404, { error: 'Knowledge not found' });
            return sendJson(res, 200, entry);
          }
          if (pathname === '/v1/knowledge' && req.method === 'POST') {
            if (!store.storage) return sendJson(res, 501, { error: 'Storage unavailable' });
            const body = await parseBody(req);
            const created = store.storage.knowledge.create(body);
            return sendJson(res, 200, created);
          }
          if (pathname.startsWith('/v1/knowledge/') && req.method === 'PUT') {
            const id = pathname.slice('/v1/knowledge/'.length);
            if (!store.storage) return sendJson(res, 501, { error: 'Storage unavailable' });
            const body = await parseBody(req);
            const updated = store.storage.knowledge.update(id, body);
            return sendJson(res, 200, updated);
          }
          if (pathname.startsWith('/v1/knowledge/') && req.method === 'DELETE') {
            const id = pathname.slice('/v1/knowledge/'.length);
            if (!store.storage) return sendJson(res, 501, { error: 'Storage unavailable' });
            store.storage.knowledge.delete(id);
            return sendJson(res, 200, { deleted: true });
          }

          // MCP API (Package J)
          if (pathname === '/v1/mcp/servers' && req.method === 'GET') {
            if (!store.storage) return sendJson(res, 200, { servers: [] });
            return sendJson(res, 200, { servers: store.storage.mcp.listServers() });
          }
          if (pathname === '/v1/mcp/servers' && req.method === 'POST') {
            if (!store.storage) return sendJson(res, 501, { error: 'Storage unavailable' });
            const body = await parseBody(req);
            const server = store.storage.mcp.registerServer(body);
            return sendJson(res, 200, server);
          }
          if (pathname.startsWith('/v1/mcp/servers/') && req.method === 'DELETE') {
            const id = pathname.slice('/v1/mcp/servers/'.length);
            if (!store.storage) return sendJson(res, 501, { error: 'Storage unavailable' });
            mcpManager.stopServer(id);
            store.storage.mcp.deleteServer(id);
            return sendJson(res, 200, { deleted: true });
          }
          if (/^\/v1\/mcp\/servers\/[^/]+\/start$/.test(pathname) && req.method === 'POST') {
            const name = pathname.split('/')[4];
            if (!store.storage) return sendJson(res, 501, { error: 'Storage unavailable' });
            const serverConfig = store.storage.mcp.getServer(name);
            if (!serverConfig) return sendJson(res, 404, { error: `Server not found: ${name}` });
            try {
              const client = await mcpManager.startServer(serverConfig);
              return sendJson(res, 200, { status: 'running', tools: client.tools });
            } catch (err) {
              return sendJson(res, 500, { error: err.message });
            }
          }
          if (/^\/v1\/mcp\/servers\/[^/]+\/stop$/.test(pathname) && req.method === 'POST') {
            const name = pathname.split('/')[4];
            mcpManager.stopServer(name);
            return sendJson(res, 200, { status: 'stopped' });
          }
          if (pathname === '/v1/mcp/tools' && req.method === 'GET') {
            if (!store.storage) return sendJson(res, 200, { tools: [] });
            return sendJson(res, 200, { tools: store.storage.mcp.listTools(query.serverId || null) });
          }
          if (pathname === '/v1/mcp/tools/call' && req.method === 'POST') {
            const body = await parseBody(req);
            const { serverName, toolName, arguments: args, approvalId } = body;
            if (!serverName || !toolName) return sendJson(res, 400, { error: 'serverName and toolName required' });
            const server = store.storage?.mcp?.getServer(serverName);
            const cachedTools = server ? store.storage?.mcp?.listTools(server.id) : [];
            const toolDef = cachedTools?.find(t => t.name === toolName);
            const isTrustedServer = server?.trusted === 1 || Boolean(server?.trusted);
            const isReadOnly = toolDef ? isMcpToolReadOnly(toolDef, { trusted: isTrustedServer, serverName }) : false;
            if (!isReadOnly) {
              const argsHash = crypto.createHash('sha256').update(JSON.stringify(args || {})).digest('hex');
              if (!approvalId) {
                const pendingId = 'appr_mcp_' + crypto.randomUUID();
                const pendingApproval = {
                  id: pendingId,
                  type: 'mcp',
                  serverName,
                  toolName,
                  parameters_hash: argsHash,
                  status: 'pending',
                  decision: 'pending',
                  created_at: new Date().toISOString(),
                  expires_at: Date.now() + 5 * 60 * 1000,
                };
                store.addApproval(pendingApproval);
                return sendJson(res, 403, {
                  error: 'External mutating MCP tool execution requires explicit server approval.',
                  requires_approval: true,
                  approval_id: pendingId,
                  serverName,
                  toolName,
                  parameters_hash: argsHash,
                });
              }

              const approval = store.getApprovals().find(a => a.id === approvalId);
              if (!approval) {
                return sendJson(res, 403, { error: 'Approval record not found', requires_approval: true });
              }
              if (approval.status !== 'approved' || approval.decision !== 'approved') {
                return sendJson(res, 403, { error: 'Approval not granted for this tool call', status: approval.status });
              }
              if (approval.serverName !== serverName || approval.toolName !== toolName) {
                return sendJson(res, 403, { error: 'Approval does not match target MCP server or tool' });
              }
              if (approval.parameters_hash !== argsHash) {
                return sendJson(res, 403, { error: 'Arguments do not match approved parameters' });
              }
              if (approval.expires_at && Date.now() > approval.expires_at) {
                return sendJson(res, 403, { error: 'Approval has expired' });
              }
              if (approval.used) {
                return sendJson(res, 403, { error: 'Approval has already been used' });
              }
              approval.used = true;
              store.save();
              if (store.storage && approval.tool_call_id && approval.session_id) {
                try {
                  store.storage.tools.recordApproval({
                    id: approval.id,
                    toolCallId: approval.tool_call_id,
                    sessionId: approval.session_id,
                    decision: 'approved',
                    decidedAt: Date.now(),
                    expiresAt: approval.expires_at,
                  });
                } catch (recErr) {
                  console.error('[MCP Approval Record Error]', recErr.message);
                }
              }
            }
            try {
              const result = await mcpManager.callTool(serverName, toolName, args || {});
              return sendJson(res, 200, { result });
            } catch (err) {
              return sendJson(res, 500, { error: err.message });
            }
          }

          // Artifacts & Attachments API (Package K)
          if (pathname === '/v1/artifacts' && req.method === 'GET') {
            if (!store.storage) return sendJson(res, 200, { artifacts: [] });
            if (query.sessionId) {
              return sendJson(res, 200, { artifacts: store.storage.artifacts.listForSession(query.sessionId) });
            }
            if (query.runId) {
              return sendJson(res, 200, { artifacts: store.storage.artifacts.listForRun(query.runId) });
            }
            return sendJson(res, 200, { artifacts: [] });
          }
          if (pathname === '/v1/artifacts' && req.method === 'POST') {
            if (!store.storage) return sendJson(res, 501, { error: 'Storage unavailable' });
            const body = await parseBody(req);
            const recorded = store.storage.artifacts.record(body);
            return sendJson(res, 200, recorded);
          }
          if (pathname === '/v1/attachments' && req.method === 'GET') {
            if (!store.storage) return sendJson(res, 200, { attachments: [] });
            return sendJson(res, 200, { attachments: store.storage.attachments.listForSession(query.sessionId || null) });
          }
          if (pathname === '/v1/attachments' && req.method === 'POST') {
            if (!store.storage) return sendJson(res, 501, { error: 'Storage unavailable' });
            const body = await parseBody(req);
            const recorded = store.storage.attachments.record(body);
            return sendJson(res, 200, recorded);
          }
          if (pathname === '/v1/events/conversations') return sendJson(res, 200, { conversations: [], supported: false });
          if (/\/agents\/[^/]+\/usage$/.test(pathname)) return sendJson(res, 200, null);
          if (pathname.endsWith('/agent-turns')) return sendJson(res, 200, { turns: [...agentRunner.turns.values()] });

        // Pipeline API (Package M)
        if (/^\/v1\/channels\/[^/]+\/pipeline$/.test(pathname)) {
          const chName = pathname.split('/')[3];
          if (req.method === 'GET') {
            const pl = store.storage?.pipelines ? store.storage.pipelines.get(chName) : { active: false, supported: true };
            return sendJson(res, 200, pl);
          }
          if (req.method === 'POST') {
            const body = await parseBody(req);
            if (!store.storage?.pipelines) return sendJson(res, 501, { error: 'Pipeline storage unavailable' });
            const created = store.storage.pipelines.save(chName, body);
            if (agentRunner?.dispatchPipelineStep) {
              agentRunner.dispatchPipelineStep(chName, created);
            }
            return sendJson(res, 200, created);
          }
        }
        if (/^\/v1\/channels\/[^/]+\/pipeline\/halt$/.test(pathname) && req.method === 'POST') {
          const chName = pathname.split('/')[3];
          if (!store.storage?.pipelines) return sendJson(res, 501, { error: 'Pipeline storage unavailable' });
          const halted = store.storage.pipelines.halt(chName);
          return sendJson(res, 200, halted);
        }
        if (/^\/v1\/channels\/[^/]+\/pipeline\/resume$/.test(pathname) && req.method === 'POST') {
          const chName = pathname.split('/')[3];
          if (!store.storage?.pipelines) return sendJson(res, 501, { error: 'Pipeline storage unavailable' });
          const resumed = store.storage.pipelines.resume(chName);
          if (agentRunner?.dispatchPipelineStep) {
            agentRunner.dispatchPipelineStep(chName, resumed);
          }
          return sendJson(res, 200, resumed);
        }

        // -------------------------------------------------------------
        // Database Backup & Disaster Recovery API (Package B)
        // -------------------------------------------------------------
        if (pathname === '/v1/backups' && req.method === 'GET') {
          if (!store.storage?.backupManager) return sendJson(res, 501, { error: 'Backup manager unavailable' });
          const backups = store.storage.backupManager.listBackups();
          return sendJson(res, 200, { backups });
        }
        if (pathname === '/v1/backups' && req.method === 'POST') {
          if (!store.storage?.backupManager) return sendJson(res, 501, { error: 'Backup manager unavailable' });
          try {
            const body = await parseBody(req);
            const backupResult = await store.storage.backupManager.createBackup(body || {});
            return sendJson(res, 201, backupResult);
          } catch (err) {
            return sendJson(res, 500, { error: err.message });
          }
        }
        if (pathname === '/v1/backups/integrity' && req.method === 'GET') {
          if (!store.storage?.backupManager) return sendJson(res, 501, { error: 'Backup manager unavailable' });
          const integrity = store.storage.backupManager.checkIntegrity();
          return sendJson(res, 200, integrity);
        }
        if (pathname === '/v1/backups/restore' && req.method === 'POST') {
          if (!store.storage?.backupManager) return sendJson(res, 501, { error: 'Backup manager unavailable' });
          const body = await parseBody(req);
          const backupPath = body?.path || body?.backupPath || body?.backup_path;
          if (!backupPath) return sendJson(res, 400, { error: 'backupPath is required' });
          try {
            const restored = store.storage.backupManager.restoreFromBackup(backupPath);
            store.data = store.load();
            return sendJson(res, 200, { success: true, restored });
          } catch (err) {
            return sendJson(res, 500, { error: err.message });
          }
        }

        // -------------------------------------------------------------
        // Multi-Agent Orchestration & Parallel Batch API (Package N)
        // -------------------------------------------------------------
        if (pathname === '/v1/parallel-batch' && req.method === 'GET') {
          const channel = query.channel || query.channelName || 'general';
          if (store.storage?.orchestration) {
            return sendJson(res, 200, store.storage.orchestration.getParallelBatch(channel));
          }
          return sendJson(res, 200, {
            mode: 'agent',
            state: 'idle',
            total: 0,
            done: 0,
            workers: [],
            conflicts: [],
            isolated: false,
            review_agent: '',
            run: null,
          });
        }
        if (pathname === '/v1/parallel-batch/start' && req.method === 'POST') {
          const body = await parseBody(req);
          if (!store.storage?.orchestration) return sendJson(res, 501, { error: 'Orchestration storage unavailable' });
          const channel = body.channel_name || body.channel || 'general';
          const batch = store.storage.orchestration.createBatch({
            ...body,
            channel_name: channel,
          });
          return sendJson(res, 200, batch);
        }

        // Parallel batch control actions
        const batchActionMatch = pathname.match(/^\/v1\/workspaces\/([^/]+)\/parallel-batches\/([^/]+)\/(merge|discard|stop)$/);
        if (batchActionMatch && req.method === 'POST') {
          const [, ws, batchId, action] = batchActionMatch;
          if (!store.storage?.orchestration) return sendJson(res, 501, { error: 'Orchestration storage unavailable' });
          let result;
          if (action === 'merge') result = store.storage.orchestration.mergeParallelBatch(batchId);
          else if (action === 'discard') result = store.storage.orchestration.discardParallelBatch(batchId);
          else if (action === 'stop') result = store.storage.orchestration.stopParallelBatch(batchId);
          return sendJson(res, 200, result || { success: true });
        }

        // Parallel batch lane actions
        const laneActionMatch = pathname.match(/^\/v1\/workspaces\/([^/]+)\/parallel-batches\/([^/]+)\/lanes\/([^/]+)\/(retry|review|send-back|complete)$/);
        if (laneActionMatch && req.method === 'POST') {
          const [, ws, batchId, rawAgent, action] = laneActionMatch;
          const agent = decodeURIComponent(rawAgent);
          if (!store.storage?.orchestration) return sendJson(res, 501, { error: 'Orchestration storage unavailable' });

          if (action === 'retry') {
            const updated = store.storage.orchestration.retryParallelLane(batchId, agent);
            return sendJson(res, 200, updated);
          }
          if (action === 'review') {
            store.storage.orchestration.retryLaneReview(batchId, agent);
            return sendJson(res, 200, { success: true });
          }
          if (action === 'send-back') {
            store.storage.orchestration.sendBackParallelLane(batchId, agent);
            return sendJson(res, 200, { success: true });
          }
          if (action === 'complete') {
            const body = await parseBody(req);
            const updated = store.storage.orchestration.completeLane(batchId, agent, body);
            return sendJson(res, 200, updated);
          }
        }

        // Parallel batch lane review complete
        const reviewCompleteMatch = pathname.match(/^\/v1\/workspaces\/([^/]+)\/parallel-batches\/([^/]+)\/lanes\/([^/]+)\/review\/complete$/);
        if (reviewCompleteMatch && req.method === 'POST') {
          const [, ws, batchId, rawAgent] = reviewCompleteMatch;
          const agent = decodeURIComponent(rawAgent);
          if (!store.storage?.orchestration) return sendJson(res, 501, { error: 'Orchestration storage unavailable' });
          const body = await parseBody(req);
          store.storage.orchestration.completeLaneReview(batchId, agent, {
            status: body.verdict || body.status || 'approved',
            notes: body.notes || '',
            reviewer: body.reviewer || 'reviewer',
          });
          return sendJson(res, 200, { success: true });
        }

        // Work Profiles API
        const profilesMatch = pathname.match(/^\/v1\/workspaces\/([^/]+)\/profiles(?:\/([^/]+))?$/);
        if (profilesMatch) {
          const [, ws, profileId] = profilesMatch;
          if (req.method === 'GET') {
            if (!store.storage?.orchestration) return sendJson(res, 200, { profiles: [] });
            return sendJson(res, 200, { profiles: store.storage.orchestration.listProfiles({ workspaceId: ws }) });
          }
          if (req.method === 'POST' && !profileId) {
            const body = await parseBody(req);
            if (!store.storage?.orchestration) return sendJson(res, 501, { error: 'Storage unavailable' });
            const created = store.storage.orchestration.createProfile({ ...body, workspace_id: ws });
            return sendJson(res, 200, created);
          }
          if (req.method === 'PATCH' && profileId) {
            const body = await parseBody(req);
            if (!store.storage?.orchestration) return sendJson(res, 501, { error: 'Storage unavailable' });
            const updated = store.storage.orchestration.updateProfile(decodeURIComponent(profileId), body);
            return sendJson(res, 200, updated);
          }
          if (req.method === 'DELETE' && profileId) {
            if (!store.storage?.orchestration) return sendJson(res, 501, { error: 'Storage unavailable' });
            store.storage.orchestration.deleteProfile(decodeURIComponent(profileId));
            return sendJson(res, 200, { success: true });
          }
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
            if(agentRunner.workspaceOperations.has(chName))return sendJson(res,409,{error:'工作区操作尚未完成。'});
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
        if (pathname === '/v1/search' && req.method === 'GET') {
          const q = (query.q || query.query || '').trim();
          const channel = query.channel || query.session_id || null;
          const limit = Math.max(1, Math.min(100, parseInt(query.limit, 10) || 20));
          const results = store.searchMessages(q, { sessionId: channel, limit });
          return sendJson(res, 200, { results });
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
              status: 'offline',
              connection_configured: p.configured,
              health_status: 'unknown',
              capabilities: ['chat', 'plan', 'agent', 'project-tools', 'command-approval'],
              description: p.id === 'ollama' ? 'Local Ollama endpoint; availability is checked when sending.' : `${p.label} direct API; ${p.configured ? 'API key configured' : 'API key missing'}.`,
            })),
            channels: ws.channels.filter(c => c.status !== 'deleted').map(c => ({ ...c, channel_name: c.name })),
          });
        }
        if (pathname === '/v1/profile') {
          return sendJson(res, 200, {
            capabilities: ['chat', 'streaming', 'session-models', 'local-llm', 'pi-agent', 'project-tools', 'command-approval'],
            online_count: 0,
            configured_connections: agentRunner.providers().filter(p => p.configured).length,
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
            if (store.storage?.timers) {
              const added = store.storage.timers.create(body);
              return sendJson(res, 200, added);
            }
            const added = store.addTimer(body);
            return sendJson(res, 200, added);
          }
          if (store.storage?.timers) {
            return sendJson(res, 200, { timers: store.storage.timers.list(query) });
          }
          return sendJson(res, 200, { timers: store.getTimers() });
        }
        if (pathname.startsWith('/v1/timers/') && req.method === 'DELETE') {
          const tId = pathname.replace('/v1/timers/', '');
          if (store.storage?.timers) {
            store.storage.timers.delete(tId);
          } else {
            store.deleteTimer(tId);
          }
          return sendJson(res, 200, { success: true });

        }
        if (pathname === '/v1/routines') {
          if (req.method === 'POST') {
            const body = await parseBody(req);
            if (store.storage?.routines) {
              const added = store.storage.routines.create(body);
              return sendJson(res, 200, added);
            }
            const added = store.addRoutine(body);
            return sendJson(res, 200, added);
          }
          if (store.storage?.routines) {
            return sendJson(res, 200, { routines: store.storage.routines.list(query) });
          }
          return sendJson(res, 200, { routines: store.getRoutines() });
        }
        if (pathname.startsWith('/v1/routines/')) {
          const parts = pathname.split('/');
          const rId = parts[3];
          const subAction = parts[4];
          if (subAction === 'toggle' && req.method === 'PATCH') {
            if (!store.storage?.routines) return sendJson(res, 501, { error: 'Routine storage unavailable' });
            const updated = store.storage.routines.toggle(rId);
            return sendJson(res, 200, updated);
          }
          if (subAction === 'run' && req.method === 'POST') {
            await scheduler.triggerRoutineNow(rId);
            return sendJson(res, 200, { success: true });
          }
          if (subAction === 'approve' && req.method === 'POST') {
            if (!store.storage?.routines) return sendJson(res, 501, { error: 'Routine storage unavailable' });
            const approved = store.storage.routines.approve(rId);
            return sendJson(res, 200, approved);
          }
          if (subAction === 'reject' && req.method === 'POST') {
            if (!store.storage?.routines) return sendJson(res, 501, { error: 'Routine storage unavailable' });
            const rejected = store.storage.routines.reject(rId);
            return sendJson(res, 200, rejected);
          }
          if (!subAction && req.method === 'PATCH') {
            const body = await parseBody(req);
            if (!store.storage?.routines) return sendJson(res, 501, { error: 'Routine storage unavailable' });
            const updated = store.storage.routines.update(rId, body);
            return sendJson(res, 200, updated);
          }
          if (!subAction && req.method === 'DELETE') {
            if (store.storage?.routines) {
              store.storage.routines.delete(rId);
            } else {
              store.deleteRoutine(rId);
            }
            return sendJson(res, 200, { success: true });
          }
        }
        if (pathname === '/v1/routine-runs' && req.method === 'GET') {
          if (!store.storage?.routines) return sendJson(res, 200, { runs: [] });
          const limit = Math.max(1, Math.min(200, parseInt(query.limit, 10) || 50));
          const runs = store.storage.routines.listRuns(query.routine_id || null, limit);
          return sendJson(res, 200, { runs });
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
            if (body && (
              (body.status && body.status !== 'pending') ||
              (body.decision && body.decision !== 'pending') ||
              body.used
            )) {
              return sendJson(res, 400, { error: 'New approval records can only be created in pending status' });
            }
            const added = store.addApproval(body || {});
            return sendJson(res, 200, added);
          }
          return sendJson(res, 200, { approvals: store.getApprovals(query) });
        }
        if (pathname.startsWith('/v1/approvals/') && req.method === 'PATCH') {
          const aId = pathname.replace('/v1/approvals/', '');
          if (store.data.runtime_tools.some(row => row.approval_id === aId)) return sendJson(res, 409, { error: 'Use the session command approval controls.' });
          const body = await parseBody(req);
          const nextStatus = body?.status || 'approved';
          if (nextStatus !== 'approved' && nextStatus !== 'denied') {
            return sendJson(res, 400, { error: 'Approval status must be either approved or denied' });
          }
          try {
            const updated = store.updateApproval(aId, nextStatus);
            return sendJson(res, 200, updated || { success: true });
          } catch (apprErr) {
            return sendJson(res, 409, { error: apprErr.message });
          }
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

  server.scheduler = scheduler;
  server.store = store;
  server.agentRunner = agentRunner;
  server.on('close', () => {
    scheduler.stop();
    agentRunner.close();
  });
  server.importPiConnections = () => require('./pi-config-import').importPiConnections(configManager);
  server.shutdown = async () => {
    scheduler.stop();
    await agentRunner.close();
    for (const client of sseClients) client.end();
    if (store?.storage?.db) {
      try {
        store.storage.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        store.storage.db.close();
      } catch (_) {}
    }
    server.closeAllConnections?.();
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
