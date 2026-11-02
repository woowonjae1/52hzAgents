const crypto = require("crypto");
const { streamModel } = require("./model-stream");
const { RuntimeTools } = require('./runtime-tools');
const {projectSnapshot,changesSince} = require('./project-evidence');
const {normalizeUrl} = require('./config-manager');
const { Checkpoints } = require('./checkpoints');
const { categorizeError } = require('./connection-tester');
const { DEFAULT_AGENT_ID } = require('./storage/repositories/agent-definitions');
const { policyOf, restrictMode, toolAllowed, checkAgentBudget } = require('./agent-policy');
const fs = require('node:fs');
const path = require('node:path');
const projectKey = value => {
  if (!value) return null;
  try { value = fs.realpathSync.native(value); } catch { value = path.resolve(value); }
  return process.platform === 'win32' ? value.toLowerCase() : value;
};
const overlaps = (left, right) => left && right && (left === right || left.startsWith(right + path.sep) || right.startsWith(left + path.sep));
let piModule;
const runPi = async options => (await (piModule ||= import('./pi-engine.mjs'))).runPiAgent(options);
const PROVIDERS = {
  deepseek: {
    label: "DeepSeek",
    key: "DEEPSEEK_API_KEY",
    base: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
  },
  openai: {
    label: "OpenAI",
    key: "OPENAI_API_KEY",
    base: "https://api.openai.com/v1",
    model: "gpt-4o",
  },
  claude: {
    label: "Claude",
    key: "ANTHROPIC_API_KEY",
    base: "https://api.anthropic.com/v1",
    model: "claude-3-7-sonnet-20250219",
  },
  gemini: {
    label: "Gemini",
    key: "GEMINI_API_KEY",
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
  },
  ollama: {
    label: "Ollama",
    base: "http://127.0.0.1:11434",
    model: "llama3:latest",
  },
};
class AgentRunner {
  constructor(
    store,
    broadcaster,
    { env = process.env, stream = null, piRuntime = runPi, timeoutMs = 900_000, configManager = null, mcpManager = null } = {},
  ) {
    this.store = store;
    this.broadcaster = broadcaster;
    this.env = env;
    this.stream = stream;
    this.piRuntime = piRuntime;
    this.configManager = configManager;
      this.mcpManager = mcpManager || null;
    this.tools = new RuntimeTools(store, broadcaster);
    this.checkpoints = new Checkpoints(store.userDataPath);
    this.restoring = new Set();
    this.workspaceOperations = new Set();
    this.timeoutMs = timeoutMs;
    this.active = new Map();
    this.queues = new Map();
    this.turns = new Map();
    store.data.runtime_runs ||= [];
    for (const event of store.data.events) if (event.metadata?.runtime_queued) {
      event.metadata.interrupted = true; delete event.metadata.runtime_queued;
    }
    for(const row of store.data.runtime_runs) if(!row.outcome) {
      row.phase='finished';row.outcome='interrupted';row.ended_at=Date.now();
      const tools=store.data.runtime_tools.filter(tool=>tool.run_id===row.id);
      row.evidence={run_id:row.id,outcome:'interrupted',interrupted:true,
        files_modified:[...new Set(tools.filter(tool=>tool.path).map(tool=>tool.path))],
        commands:tools.filter(tool=>['powershell','bash'].includes(tool.tool)).map(tool=>({command:tool.args?.command,exitCode:tool.result?.exit_code})),
        file_observation:'write-tools-only'};
    }
    if (store.storage) {
      try {
        store.storage.runs.recoverInterrupted();
      } catch (_) {}
    }
    store.save();
    for (const event of store.data.events)
      if (event.type === "workspace.agent.turn.updated")
        this.turns.set(
          `${event.payload.execution_key || event.payload.channel_name}/${event.payload.agent_name}`,
          event.payload,
        );
    for (const row of [...this.turns.values()])
      if (row.state === "running")
        this.updateTurn(
          row.channel_name,
          row.agent_name,
          "error",
          "The previous response was interrupted by an app restart.",
          null,
          row.execution_key || row.channel_name,
        );
  }
  providers() {
    if (this.configManager) {
      return this.configManager.getConnections().map((c) => ({
        id: c.id,
        label: c.name,
        configured: c.hasCredential,
        model: c.defaultModel || (c.models?.[0]?.id) || '',
        models: c.models || [],
        protocol: c.protocol,
        source: c.source,
      }));
    }
    return Object.entries(PROVIDERS).map(([id, p]) => ({
      id,
      label: p.label,
      configured: !p.key || Boolean(this.env[p.key]),
      model:
        this.env[`${id.toUpperCase()}_MODEL`] ||
        this.env[`${p.key?.replace("_API_KEY", "")}_MODEL`] ||
        p.model,
    }));
  }
  config(channel, identity = this.identity(channel)) {
    const policy = policyOf(identity);
    const saved = this.store.getChannel(channel)?.runtime_config;
    const provider =
      this.providers().find((p) => p.configured && p.id !== "ollama")?.id ||
      "ollama";
    const defaults = {
      provider: policy.modelResource?.connectionId || provider,
      model: policy.modelResource?.modelId || this.providers().find((p) => p.id === provider)?.model || 'deepseek-chat',
      mode: policy.defaultMode,
    };
    const effective = saved?.inheritAgent ? { ...defaults, ...(saved.mode ? { mode: saved.mode } : {}), autoCompact: saved.autoCompact !== false }
      : saved ? { ...saved } : defaults;
    effective.mode = restrictMode(effective.mode, policy.maxMode);
    return effective;
  }
  validateSessionConfig(input) {
    if (input?.inheritAgent === true) {
      if (Object.keys(input).some(key => !['inheritAgent', 'mode', 'autoCompact'].includes(key)) ||
          (input.mode !== undefined && !['chat', 'plan', 'agent'].includes(input.mode))) {
        throw Object.assign(new Error('Agent inheritance accepts only mode and autoCompact overrides.'), { status: 400 });
      }
      return { inheritAgent: true, ...(input.mode ? { mode: input.mode } : {}), autoCompact: input.autoCompact !== false };
    }
    return this.validateConfig(input);
  }
  validateDefinitionResource(input) {
    if (!input?.modelResource) return;
    const id = input.modelResource.connectionId;
    const known = this.configManager ? Boolean(this.configManager.getConnection(id)) : Object.hasOwn(PROVIDERS, id || '');
    if (!known) throw Object.assign(new Error('Choose an existing model connection for this Agent.'), { status: 400 });
  }
  identity(channel, { requireActive = false } = {}) {
    const repository = this.store.storage?.agentDefinitions;
    if (!repository) throw Object.assign(new Error('Agent storage unavailable.'), { status: 503 });
    const id = this.store.getChannel(channel)?.agent_id || DEFAULT_AGENT_ID;
    const agent = requireActive ? repository.requireActive(id) : repository.get(id);
    if (!agent) throw Object.assign(new Error('The session Agent no longer exists.'), { status: 409 });
    return agent;
  }
  validateConfig(config) {
    const providerId = config?.provider || config?.connectionId;
    const known = this.configManager
      ? Boolean(this.configManager.getConnection(providerId))
      : Object.hasOwn(PROVIDERS, providerId);
    if (
      !config ||
      !known ||
      typeof config.model !== "string" ||
      !config.model.trim() ||
      config.model.length > 200 ||
      !["chat", "plan", "agent"].includes(config.mode)
    ) {
      const error = new Error(
        "Choose a supported provider, a model ID and Chat, Plan or Agent mode.",
      );
      error.status = 400;
      throw error;
    }
    return {
      provider: providerId,
      model: config.model.trim(),
      mode: config.mode,
      autoCompact: config.autoCompact !== false,
    };
  }
  conversation(target, throughId) {
    const end = throughId
      ? this.store.data.events.findIndex((e) => e.id === throughId)
      : -1;
    const events = this.store.data.events;
    const allowed = new Set(
      (end >= 0 ? events.slice(0, end + 1) : events).map((e) => e.id),
    );
    const usable = events.filter(
      (e) =>
        e.target === target &&
        e.type === "workspace.message.posted" &&
        typeof e.payload?.content === "string" &&
        !e.metadata?.interrupted &&
        !e.metadata?.runtime_status &&
        !e.metadata?.runtime_tool &&
        e.metadata?.model !== "embedded-assistant" &&
        (e.source.startsWith("human:") || e.source.startsWith("52hz:")),
    );
    const ordered = [];
    for (const item of usable) {
      if (!allowed.has(item.id) || item.metadata?.in_reply_to) continue;
      ordered.push(item);
      if (item.source.startsWith("human:"))
        ordered.push(
          ...usable.filter((e) => e.metadata?.in_reply_to === item.id),
        );
    }
    return ordered
      .slice(-40)
      .map((e) => ({
        id: e.id,
        nativePi: e.metadata?.engine === 'pi-1.4.0' || Boolean(e.metadata?.runtime_intermediate),
        role: e.source.startsWith("human:") ? "user" : "assistant",
        content: e.payload.content,
      }));
  }
  post(channel, agent, content, metadata = {}, id) {
    const event = this.store.addEvent({
      ...(id ? { id } : {}),
      type: "workspace.message.posted",
      source: `52hz:${agent}`,
      target: `channel/${channel}`,
      payload: { content, sender_name: metadata.agent_identity?.name || agent, sender_type: "agent" },
      metadata,
    });
    this.broadcaster.broadcast(event);
    return event;
  }
  updateTurn(channel, agent, state, error = "", identity = null, executionKey = channel) {
    const previous = this.turns.get(`${executionKey}/${agent}`),
      now = new Date().toISOString();
    const row = {
      channel_name: channel,
      agent_name: agent,
      execution_key: executionKey,
      ...(identity ? { agent_id: identity.id, display_name: identity.name, agent_revision: identity.revision } : {}),
      state,
      error,
      updated_at: now,
      started_at: state === "running" ? now : previous?.started_at || now,
      ended_at: state === "running" ? null : now,
    };
    this.turns.set(`${executionKey}/${agent}`, row);
    this.broadcaster.broadcast(
      this.store.addEvent({
        type: "workspace.agent.turn.updated",
        source: `52hz:${agent}`,
        target: `channel/${channel}`,
        payload: row,
      }),
    );
  }
  snapshot(channel, executionKey = channel) {
    const run = this.active.get(executionKey) || [...this.active.values()].find(run => run.snapshot.channel === channel);
    return run?.content
      ? {
          event_id: run.id,
          type: "workspace.message.streaming",
          source: `52hz:${run.agent}`,
          target: `channel/${channel}`,
          timestamp: run.timestamp,
          payload: {
            content: run.content,
            sender_name: run.agentIdentity.name,
            sender_type: "agent",
          },
          metadata: { streaming: true, model: run.model, agent_identity: run.agentIdentity },
        }
      : null;
  }
  getConcurrentReservedCost(excludeRunId = null) {
    let reserved = 0;
    for (const activeRun of this.active.values()) {
      if (activeRun.runId !== excludeRunId) {
        let turnReservation = activeRun.reservedCost;
        if (typeof turnReservation !== 'number' && activeRun.reservedTokens > 0 && this.store.storage?.pricing) {
          const pricing = this.store.storage.pricing.calculateCost({
            provider: activeRun.pricingProvider || activeRun.snapshot?.connectionId || activeRun.protocol || activeRun.config?.provider || 'ollama',
            modelId: activeRun.model || activeRun.config?.model || 'default',
            promptTokens: activeRun.reservedPromptTokens ?? activeRun.reservedTokens,
            completionTokens: activeRun.reservedCompletionTokens ?? 0,
          });
          if (typeof pricing?.estimatedCost === 'number') {
            turnReservation = pricing.estimatedCost;
          }
        }
        reserved += (activeRun.accumulatedCost || 0) + (turnReservation || 0);
      }
    }
    return reserved;
  }
  async handleUserMessage(event) {
    if (
      (!event.source?.startsWith("human:") &&
       !event.source?.startsWith("scheduler:") &&
       !event.source?.startsWith("pipeline:") &&
       !event.source?.startsWith("orchestration:")) ||
      typeof event.payload?.content !== "string" ||
      !event.payload.content.trim()
      || event.metadata?.tool_approval_response
    )
      return;
    const channel = event.target.replace(/^channel\//, "");
    if (!this.store.getChannel(channel)) return;
    const execution = this.resolveExecution(event, channel);
    if (execution === false) return;
    const executionKey = execution?.executionKey || channel;

    if (this.active.has(executionKey)) {
      const queue = this.queues.get(executionKey) || [];
      if (queue.length >= 20) {
        this.post(
          channel,
          "system",
          "The session queue is full. Wait for a response before sending more messages.",
          { runtime_status: true },
        );
        if (this.store.storage && event.metadata?.routine_run_id) {
          try {
            this.store.storage.routines.completeRun(event.metadata.routine_run_id, {
              status: 'failed',
              error: 'Session queue is full',
              result: 'queue_full',
              outcome: 'failed',
              errorMessage: 'Session queue is full',
            });
          } catch (_) {}
        }
        if (this.store.storage && event.metadata?.pipeline_id) {
          try {
            const failed = this.store.storage.pipelines.failStep(channel, 'Session queue is full');
            if (failed.active && failed.status === 'running') {
              this.dispatchPipelineStep(channel, failed);
            }
          } catch (_) {}
        }
        return;
      }
      queue.push(event);
      event.metadata = { ...event.metadata, runtime_queued: true }; this.store.save();
      this.queues.set(executionKey, queue);
      return;
    }
    return this.run(channel, event, { executionKey, execution });
  }
  resolveExecution(event, channel) {
    if (!event.metadata?.lane_id && !event.metadata?.pipeline_id) return null;
    if (!this.collaboration) {
      if (event.metadata?.lane_id && !fs.existsSync(event.metadata.worktree_path || '')) return null;
      throw Object.assign(new Error('Collaboration dispatch is not bound to a saved Agent.'), { status: 409 });
    }
    return this.collaboration.resolve(event, channel) || false;
  }
  async run(channel, event, {compactOnly=false, executionKey=channel, execution}={}) {
    execution = execution === undefined ? this.resolveExecution(event, channel) : execution;
    if (execution === false) return;
    executionKey = execution?.executionKey || executionKey;
    const agentIdentity = execution?.actor || this.identity(channel, { requireActive: true });
    const executionPolicy = policyOf(agentIdentity);
    const config = this.validateConfig(execution?.config || this.config(channel, agentIdentity));
    config.mode = restrictMode(config.mode, executionPolicy.maxMode);
    const agent = agentIdentity.id;
    const laneWorktree = execution?.projectDir || event.metadata?.worktree_path;
    const isParallelLane = Boolean(event.metadata?.lane_id || event.metadata?.batch_id);
    const channelWorkingDir = this.store.getChannel(channel)?.working_dir || null;

    if (isParallelLane) {
      if (!laneWorktree || !fs.existsSync(laneWorktree)) {
        this.post(channel, 'system', `隔离工作区不存在或未就绪 (${laneWorktree || '未提供'})，已终止执行以保护主项目目录。`, { runtime_status: true });
        if (this.store.storage?.orchestration) {
          try {
            if (event.metadata?.batch_id && (event.metadata?.agent || event.metadata?.lane_id)) {
              this.store.storage.orchestration.completeLane(event.metadata.batch_id, event.metadata.agent || event.metadata.lane_id, {
                status: 'failed',
                error: `Worktree path missing or invalid: ${laneWorktree || 'none'}`,
              });
            }
          } catch (_) {}
        }
        return;
      }
    }
    const workingDir = execution?.projectDir || (isParallelLane ? laneWorktree : (channelWorkingDir || null));
    const key = projectKey(workingDir);
    if (this.workspaceOperations.has(channel) || key && ([...this.restoring].some(other => overlaps(other,key)) || [...this.active.values()].some(other => {
      return overlaps(projectKey(other.snapshot.workingDir), key) && (other.snapshot.mode === 'agent' || config.mode === 'agent');
    }))) {
      if (execution) throw Object.assign(new Error('Project is busy or restoring; collaboration task was not started.'), { status: 409 });
      this.post(channel, 'system', '此项目有任务正在执行或撤销。为避免文件冲突，请等待结束后重新发送。', { runtime_status: true });
      if (this.store.storage && event.metadata?.routine_run_id) {
        try {
          this.store.storage.routines.completeRun(event.metadata.routine_run_id, {
            status: 'failed',
            error: 'Project conflict: workspace busy or restoring',
            result: 'conflict',
            outcome: 'failed',
            errorMessage: 'Project conflict: workspace busy or restoring',
          });
        } catch (_) {}
      }
      if (this.store.storage && event.metadata?.pipeline_id) {
        try {
          this.store.storage.pipelines.failStep(channel, 'Project conflict: workspace busy or restoring');
        } catch (_) {}
      }
      return;
    }
    if (event.metadata?.runtime_queued) { delete event.metadata.runtime_queued; this.store.save(); }
    const identitySnapshot = { id: agentIdentity.id, name: agentIdentity.name, role: agentIdentity.role,
      revision: agentIdentity.revision, runtimeKind: agentIdentity.runtimeKind };
    const run = {
      runId: crypto.randomUUID(),
      controller: new AbortController(),
      id: `reply-${crypto.randomUUID()}`,
      agent,
      agentIdentity: identitySnapshot,
      model: config.model,
      content: "",
      timestamp: Date.now(),
      snapshot: {
        channel,
        executionKey,
        workingDir,
        mode: config.mode,
        connectionId: config.provider,
        model: config.model,
        agent: structuredClone(identitySnapshot),
        executionPolicy: structuredClone(executionPolicy),
        allowedTools: agentIdentity.profileTools || null,
        ...(execution ? { collaboration: { kind: execution.kind, batchId: execution.batchId, laneId: execution.laneId, pipelineId: execution.pipelineId, contextKey: execution.contextKey } } : {}),
      },
      evidence: {
        filesModified: new Set(),
        commands: [],
      },
    };
    if (execution && !this.collaboration?.begin(execution, run.runId)) return;
    const observationStore = Object.create(this.store);
    observationStore.getChannel = name => name === channel ? { ...this.store.getChannel(name), working_dir: workingDir } : this.store.getChannel(name);
    const record={id:run.runId,channel,prompt_id:event.id,snapshot:run.snapshot,phase:compactOnly?'compacting':'preparing',outcome:null,started_at:Date.now(),context:null};
    this.store.data.runtime_runs.push(record);
    if(this.store.data.runtime_runs.length>200) {const index=this.store.data.runtime_runs.findIndex(row=>row.outcome);if(index>=0)this.store.data.runtime_runs.splice(index,1);}
    if (this.store.storage) {
      try {
        this.store.storage.runs.create({
          id: run.runId,
          sessionId: channel,
          agentName: agentIdentity.name,
          modelId: config.model,
          mode: config.mode,
          clientMessageId: event.client_message_id || event.id,
          configSnapshot: run.snapshot,
          phase: compactOnly ? 'compacting' : 'preparing',
        });
      } catch (error) { if (execution) throw error; }
    }
    if (execution) this.collaboration.attach(execution, run.runId);
    const phase = value => {
      record.phase = value;
      this.store.save();
      if (this.store.storage) {
        try {
          this.store.storage.runs.transition(run.runId, {
            nextPhase: value,
            outcome: record.outcome,
            errorMessage: record.error?.message,
            evidence: record.evidence,
          });
        } catch (_) {}
      }
      this.broadcaster.broadcast({type:'workspace.runtime.run.updated',target:`channel/${channel}`,payload:record});
    };
    const evidence = async outcome => {
      const after=run.baseline?.available ? await projectSnapshot(observationStore,channel).catch(()=>({available:false})) : {available:false};
      for(const name of changesSince(run.baseline,after)) run.evidence.filesModified.add(name);
      return {run_id:run.runId,files_modified:[...run.evidence.filesModified],commands:run.evidence.commands,outcome,
        checkpoint:await this.checkpoints.describe(run.runId,channel),
        file_observation:run.baseline?.available && after.available?'git-visible':'write-tools-only',
        denied:outcome==='denied',interrupted:['cancelled','interrupted'].includes(outcome),limited:outcome==='limited'};
    };
    run.done = new Promise(resolve => { run.resolve = resolve; });
    this.active.set(executionKey, run);
    const effectiveTimeout = Math.min(this.timeoutMs, (executionPolicy.limits.maxDurationSeconds || Infinity) * 1000);
    run.snapshot.timeoutMs = effectiveTimeout;
    const timer = setTimeout(() => {
      run.timedOut = true;
      run.controller.abort();
    }, effectiveTimeout);
    let lastPublish = 0;
    try {
      this.updateTurn(channel, agent, "running", "", agentIdentity, executionKey);
      this.broadcaster.broadcastComposing(channel, agent);
      const conn = this.configManager ? this.configManager.getConnection(config.provider) : null;
      const provider = PROVIDERS[config.provider];
      const protocol = conn?.protocol || (config.provider === 'claude' ? 'anthropic' : config.provider === 'ollama' ? 'ollama' : 'openai');
      const isAnthropic = protocol === 'anthropic';
      const isOllama = protocol === 'ollama';
      const pricingProvider = this.store.storage?.pricing?.get?.(config.provider, config.model) ? config.provider : (conn?.protocol || config.provider);
      run.protocol = protocol;
      run.pricingProvider = pricingProvider;

      const key = this.configManager
        ? this.configManager.getConnectionSecret(config.provider)
        : (provider?.key ? this.env[provider.key] : null);

      if (!isOllama && !key) {
        throw new Error(
          `请先在设置中配置 ${conn?.name || provider?.label || config.provider} 的 API Key。`,
        );
      }
      const base = normalizeUrl((
        conn?.baseUrl ||
        this.env[`${config.provider.toUpperCase()}_BASE_URL`] ||
        this.env[`${provider?.key?.replace("_API_KEY", "")}_BASE_URL`] ||
        provider?.base ||
        ''
      ).replace(/\/+$/, ''),protocol);
      Object.assign(run.snapshot,{baseUrl:base,protocol,pricingProvider,connectionVersion:conn?.version || 0});
      run.baseline=config.mode==='agent' ? await projectSnapshot(observationStore,channel).catch(()=>({available:false})) : {available:false};
      const messages = execution ? [] : this.conversation(`channel/${channel}`, event.id);
      const instruction = ['You are a coding assistant. You can discuss code but have no filesystem or shell tools in this session. Never claim to have read local files, executed commands or applied edits.',
        `Agent: ${agentIdentity.name}. Role: ${agentIdentity.role}.`, executionPolicy.instructions].filter(Boolean).join('\n\n');
      const onDelta = content => {
        run.content = content;
        if (Date.now() - lastPublish >= 50) {
          lastPublish = Date.now(); const snapshot = this.snapshot(channel, executionKey); if (snapshot) this.broadcaster.broadcast(snapshot);
        }
      };
      if(run.controller.signal.aborted) throw new Error('Response stopped.');
      if (this.store.storage) {
        const sessionUsageSummary = this.store.storage.usage.getSummaryForSession(channel);
        const sessionCost = (sessionUsageSummary?.estimatedCost || 0) + (run.accumulatedCost || 0);
        const concurrentCost = this.getConcurrentReservedCost(run.runId);
        const budgetCheck = this.store.storage.budgets.checkPreflight({
          sessionId: channel,
          runId: run.runId,
          currentStepCount: run.tools?.size || 0,
          elapsedMs: Date.now() - (run.timestamp || Date.now()),
          runTokens: run.usage?.total_tokens || 0,
          sessionCost,
          concurrentReservedCost: concurrentCost,
        });
        if (!budgetCheck.allowed) {
          throw Object.assign(new Error(budgetCheck.message), { status: 429, code: 'BUDGET_EXCEEDED' });
        }
      }
      const extraTools = [];
      if (this.mcpManager && config.mode !== 'chat' && executionPolicy.permissions.mcp) {
        extraTools.push(...this.mcpManager.getPiTools({
          requestApproval: async (req, sig) => this.tools.approve(channel, run, req, sig),
        }));
      }
      if (this.store.storage && config.mode !== 'chat' && executionPolicy.permissions.knowledge) {
        extraTools.push({
          name: 'search_knowledge',
          description: 'Search the local project knowledge base and memory for documentation, conventions, or past decisions.',
          isReadOnly: true,
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search term or question to look up' },
              category: { type: 'string', description: 'Optional category filter' },
            },
            required: ['query'],
          },
          execute: async (...params) => {
            const toolCallId = params.length >= 2 && typeof params[0] === 'string' ? params[0] : null;
            const args = params.length >= 2 && typeof params[0] === 'string' ? params[1] : params[0] || {};
            const { query, category } = args;
            const searchRes = this.store.storage.knowledge.search({ q: query, category, limit: 5 });
            const text = !searchRes.results.length ? 'No matching knowledge entries found.' : searchRes.results.map(r => `[${r.category}] ${r.title}:\n${r.snippet}`).join('\n\n');
            if (toolCallId) return { content: [{ type: 'text', text }] };
            return text;
          },
        });
      }
      if (this.store.storage?.orchestration && config.mode !== 'chat' && executionPolicy.permissions.delegate) {
        extraTools.push({
          name: 'workspace_list_profiles',
          description: 'List saved agent profiles with their roles, models, and capabilities.',
          isReadOnly: true,
          parameters: {
            type: 'object',
            properties: {},
          },
          execute: async (...params) => {
            const toolCallId = params.length >= 2 && typeof params[0] === 'string' ? params[0] : null;
            const actors = this.store.storage.agentDefinitions.list();
            const text = JSON.stringify(actors.map(actor => ({ id: actor.id, name: actor.name, role: actor.role, description: actor.description, configured: Boolean(actor.modelResource) })));
            if (toolCallId) return { content: [{ type: 'text', text }] };
            return text;
          },
        });

        if (config.mode === 'agent') {
          extraTools.push({
            name: 'workspace_delegate',
            description: 'Delegate sub-tasks to multiple worker agents running in parallel with separate lanes and review checkpoints.',
            isReadOnly: false,
            parameters: {
              type: 'object',
              properties: {
                tasks: {
                  type: 'array',
                  description: 'List of sub-tasks to delegate',
                  items: {
                    type: 'object',
                    properties: {
                      agent: { type: 'string', description: 'Saved Agent ID from workspace_list_profiles' },
                      task: { type: 'string', description: 'Specific task instruction' },
                      scope: { type: 'string', description: 'Directory or file scope the agent owns' },
                    },
                    required: ['agent', 'task'],
                  },
                },
              },
              required: ['tasks'],
            },
            execute: async (...params) => {
              const toolCallId = params.length >= 2 && typeof params[0] === 'string' ? params[0] : null;
              const args = params.length >= 2 && typeof params[0] === 'string' ? params[1] : params[0] || {};
              const { tasks } = args;
              if (!Array.isArray(tasks) || tasks.length === 0) {
                const errText = 'Error: At least one task must be provided for delegation.';
                if (toolCallId) return { content: [{ type: 'text', text: errText }], isError: true };
                return errText;
              }
              if (!this.collaboration) throw new Error('Collaboration is unavailable.');
              const batch = this.collaboration.start(channel, { workers: tasks }, run);
              const text = `Delegated ${tasks.length} sub-tasks into parallel batch ${batch.run?.batch?.id || ''}. Current status: ${batch.state}.`;
              if (toolCallId) return { content: [{ type: 'text', text }] };
              return text;
            },
          });
        }
      }
      const usesPi = compactOnly || config.mode !== 'chat' || !this.stream || !agentIdentity.builtIn
        || Boolean(executionPolicy.instructions || executionPolicy.modelResource || Object.keys(executionPolicy.limits).length);
      const resource = executionPolicy.modelResource;
      const maxOutputTokens = resource?.connectionId === config.provider && resource.modelId === config.model ? resource.maxOutputTokens : undefined;
      run.snapshot.maxOutputTokens = maxOutputTokens || null;
      const result = usesPi ? await this.piRuntime({
        config: { ...config, protocol },
        contextKey: execution?.contextKey,
        allowedTools: agentIdentity.profileTools || undefined,
        agentPolicy: structuredClone(executionPolicy),
        agentName: agentIdentity.name,
        agentRole: agentIdentity.role,
        maxOutputTokens,
        maxToolCalls: executionPolicy.limits.maxStepsPerRun,
        channel,
        userDataPath: this.store.userDataPath,
        projectDir: run.snapshot.workingDir,
        prompt: event.payload.content,
        promptId: compactOnly ? undefined : event.id,
        compactOnly,
          extraTools,
        history: compactOnly ? messages : messages.slice(0, -1),
        confirmedContextWindow: conn?.defaultModel === config.model ? conn?.confirmedContextWindow : conn?.models?.find(model=>model.id===config.model)?.confirmedContextWindow,
        baseUrl: base,
        apiKey: key || 'ollama',
        signal: run.controller.signal,
        onDelta: content=>{if(record.phase!=='generating')phase('generating');onDelta(content);},
        onUsage: usage=>{run.usage=usage;},
        checkBudget: currentTurnUsage => {
          if (!this.store.storage) return { allowed: true };
          const sessionUsageSummary = this.store.storage.usage.getSummaryForSession(channel);
          const currentSessionCost = (sessionUsageSummary?.estimatedCost || 0) + (run.accumulatedCost || 0) + (currentTurnUsage?.estimatedCost || 0);
          const currentTokens = Math.max(run.usage?.total_tokens || 0, currentTurnUsage?.total_tokens || 0);
          const reservedPromptTokens = currentTurnUsage?.reservedPromptTokens ?? (currentTurnUsage?.reservedTokens || 0);
          const reservedCompletionTokens = currentTurnUsage?.reservedCompletionTokens ?? 0;
          const reservedTokens = currentTurnUsage?.reservedTokens ?? (reservedPromptTokens + reservedCompletionTokens);
          let reservedCost = currentTurnUsage?.reservedCost || 0;
          let reservationCostKnown = true;
          if (!reservedCost && (reservedPromptTokens > 0 || reservedCompletionTokens > 0)) {
            const pricing = this.store.storage.pricing.calculateCost({
              provider: pricingProvider,
              modelId: config.model,
              promptTokens: reservedPromptTokens,
              completionTokens: reservedCompletionTokens,
            });
            if (typeof pricing?.estimatedCost === 'number') {
              reservedCost = pricing.estimatedCost;
            }
            reservationCostKnown = typeof pricing?.estimatedCost === 'number' && pricing.currency === 'USD';
          }

          run.reservedPromptTokens = reservedPromptTokens;
          run.reservedCompletionTokens = reservedCompletionTokens;
          run.reservedTokens = reservedTokens;
          run.reservedCost = reservedCost;

          const concurrentCost = this.getConcurrentReservedCost(run.runId);
          const stepCount = Math.max(0, (run.tools?.size || 0) - (currentTurnUsage?.beforeToolCall && run.tools?.has(currentTurnUsage.toolCallId) ? 1 : 0));
          const agentBudget = checkAgentBudget(executionPolicy.limits, {
            tokens: currentTokens + reservedTokens, steps: stepCount,
            elapsedMs: Date.now() - run.timestamp,
            cost: (run.accumulatedCost || 0) + reservedCost,
            costKnown: reservationCostKnown && !run.hasUnknownCost,
          });
          if (!agentBudget.allowed) return agentBudget;
          if (execution && execution.kind !== 'pipeline') {
            const batchBudget = this.collaboration.reserve(execution, run, reservedTokens);
            if (!batchBudget.allowed) return batchBudget;
          }

          return this.store.storage.budgets.checkPreflight({
            sessionId: channel,
            runId: run.runId,
            currentStepCount: stepCount,
            elapsedMs: Date.now() - (run.timestamp || Date.now()),
            runTokens: currentTokens,
            sessionCost: currentSessionCost,
            concurrentReservedCost: concurrentCost,
            reservedCost,
            reservedTokens,
          });
        },
        onRequestUsage: reqUsage => {
          if (!this.store.storage) return;
          try {
            const pricingInfo = this.store.storage.pricing.calculateCost({
              provider: pricingProvider,
              modelId: config.model,
              promptTokens: reqUsage.promptTokens,
              completionTokens: reqUsage.completionTokens,
              cacheReadTokens: reqUsage.cacheReadTokens || 0,
            });
            const cost = reqUsage.usageKnown !== false && typeof pricingInfo?.estimatedCost === 'number' ? pricingInfo.estimatedCost : null;
            if (cost !== null) {
              run.accumulatedCost = (run.accumulatedCost || 0) + cost;
            }
            run.reservedCost = 0;
            run.reservedTokens = 0;
            run.reservedPromptTokens = 0;
            run.reservedCompletionTokens = 0;
            if (cost === null || pricingInfo.currency !== 'USD') {
              run.hasUnknownCost = true;
            }
            this.store.storage.usage.recordModelRequest({
              runId: run.runId,
              sessionId: channel,
              provider: pricingProvider,
              modelId: config.model,
              purpose: reqUsage.purpose || 'generate',
              promptTokens: reqUsage.promptTokens,
              completionTokens: reqUsage.completionTokens,
              cacheReadTokens: reqUsage.cacheReadTokens || 0,
              cacheWriteTokens: reqUsage.cacheWriteTokens || 0,
              totalTokens: reqUsage.totalTokens,
              latencyMs: reqUsage.latencyMs || 0,
              estimatedCost: cost,
              currency: pricingInfo?.currency || 'USD',
              pricingVersion: pricingInfo?.pricingVersion || null,
              rawUsageJson: reqUsage.rawUsage || null,
              status: reqUsage.status || 'completed',
            });
            run.requestUsageCount = (run.requestUsageCount || 0) + 1;
          } catch (err) {
            console.error('[AgentRunner] Error recording model request:', err.message);
          }
        },
        onContext: value=>{record.context=value;if(value.phase==='compacting')phase('compacting');},
        onTool: value => {
          if(value.phase==='start')phase('executing');
          this.tools.event(channel, run, value);
          if (value.phase === 'end' && (value.structuredContent?.exit_code !== undefined || value.result?.exit_code !== undefined)) {
            const exitCode = value.structuredContent?.exit_code ?? value.result?.exit_code;
            run.evidence.commands.push({
              command: run.tools.get(value.toolCallId)?.args?.command || '(command unavailable)',
              exitCode,
              durationMs: value.structuredContent?.wall_time_seconds*1000 || value.durationMs,
            });
          }
        },
        onApproval: async (request, signal) => {if (!toolAllowed(request.tool || '', executionPolicy.permissions)) return false;phase('waiting_approval');const allowed=await this.tools.approve(channel,run,request,signal);phase('executing');return allowed;},
        beforeMutation: change => {if(config.mode !== 'agent' || !executionPolicy.permissions.writeFiles) throw new Error('Agent cannot modify files.');return this.checkpoints.prepare(run.runId,channel,workingDir,change);},
        beforeCommand: () => {if(config.mode !== 'agent' || !executionPolicy.permissions.executeCommands) throw new Error('Agent cannot execute commands.');return this.checkpoints.beginCommand(run.runId,channel,workingDir);},
        afterCommand: () => this.checkpoints.endCommand(run.runId,channel),
        onMutation: change => {
          this.tools.mutation(channel, run, change);
          run.evidence.filesModified.add(change.path);
        },
        onAssistant: content => {
          this.post(channel, agent, content, { model: config.model, mode: config.mode, in_reply_to: event.id, runtime_intermediate: true, agent_identity: run.agentIdentity }, run.id);
          run.id = `reply-${crypto.randomUUID()}`; run.content = ''; run.timestamp = Date.now(); lastPublish = 0;
        },
      }) : await this.stream({
        url: `${base}${isAnthropic ? "/v1/messages" : isOllama ? "/api/chat" : "/chat/completions"}`,
        headers: isAnthropic
          ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
          : key
            ? { Authorization: `Bearer ${key}` }
            : {},
        body: {
          model: config.model,
          stream: true,
          ...(isAnthropic
            ? { system: instruction, max_tokens: 4096, messages }
            : {
                messages: [
                  { role: "system", content: instruction },
                  ...messages.map(({role,content})=>({role,content})),
                ],
              }),
          ...(!isAnthropic && !isOllama
            ? { stream_options: { include_usage: true } }
            : {}),
        },
        provider: protocol,
        signal: run.controller.signal,
        onDelta,
      });
      if (run.controller.signal.aborted) throw new Error("Aborted");
      if (result?.usage) run.usage = result.usage;
      if (this.store.storage && result?.usage) {
        try {
          const pricingInfo = this.store.storage.pricing.calculateCost({
            provider: pricingProvider,
            modelId: result.model || config.model,
            promptTokens: result.usage.prompt_tokens,
            completionTokens: result.usage.completion_tokens,
            cacheReadTokens: result.usage.cache_read_tokens || 0,
          });

          this.store.storage.usage.recordUsage({
            sessionId: channel,
            runId: run.runId,
            model: result.model || config.model,
            promptTokens: result.usage.prompt_tokens || 0,
            completionTokens: result.usage.completion_tokens || 0,
            cacheReadTokens: result.usage.cache_read_tokens || 0,
            cacheWriteTokens: result.usage.cache_write_tokens || 0,
            totalTokens: result.usage.total_tokens,
            estimatedCost: pricingInfo.estimatedCost,
            currency: pricingInfo.currency || 'USD',
          });

          if (!run.requestUsageCount) this.store.storage.usage.recordModelRequest({
            runId: run.runId,
            sessionId: channel,
            provider: pricingProvider,
            modelId: result.model || config.model,
            purpose: compactOnly ? 'compaction' : 'generate',
            promptTokens: result.usage.prompt_tokens,
            completionTokens: result.usage.completion_tokens,
            cacheReadTokens: result.usage.cache_read_tokens || 0,
            cacheWriteTokens: result.usage.cache_write_tokens || 0,
            totalTokens: result.usage.total_tokens,
            latencyMs: Date.now() - (run.timestamp || Date.now()),
            estimatedCost: pricingInfo.estimatedCost,
            currency: pricingInfo.currency || 'USD',
            pricingVersion: pricingInfo.pricingVersion,
            rawUsageJson: result.usage,
            status: 'completed',
          });
        } catch (_) {}
      }
      record.outcome=result.denied ? ([...run.tools?.values()||[]].some(row=>row.status==='expired')?'expired':'denied') : result.limited?'limited':'finished';
      if (execution) { this.collaboration.finish(execution, run, record, result); run.collaborationFinished = true; }
      if(record.outcome==='expired') result.content='Command approval expired. No pending command was executed.';
      const facts=await evidence(record.outcome);record.evidence=facts;
      this.post(
        channel,
        agent,
        result.content,
        {
          model: result.model,
          usage: result.usage,
          last_prompt_tokens: result.last_prompt_tokens,
          context_window: result.context_window,
          engine: result.sdk,
          mode: config.mode,
          in_reply_to: event.id,
          execution_evidence: facts,
          run_id:run.runId,
          agent_identity: run.agentIdentity,
        },
        run.id,
      );
      if (this.store.storage && event.metadata?.routine_run_id) {
        try {
          const isSuccess = record.outcome === 'finished' && !result.isError;
          this.store.storage.routines.completeRun(event.metadata.routine_run_id, {
            status: isSuccess ? 'completed' : 'failed',
            outcome: record.outcome,
            errorMessage: result.isError ? result.content : null,
          });
        } catch (_) {}
      }
      if (!execution && this.store.storage && event.metadata?.pipeline_id) {
        try {
          if (record.outcome === 'finished' && !result.isError) {
            const advanced = this.store.storage.pipelines.advance(channel, result.content);
            if (advanced && advanced.status === 'running') {
              this.dispatchPipelineStep(channel, advanced);
            }
          } else {
            this.store.storage.pipelines.failStep(channel, result.content || 'Step failed or was interrupted');
          }
        } catch (_) {}
      }
      if (!execution && this.store.storage && event.metadata?.batch_id && event.metadata?.agent) {
        try {
          const isSuccess = record.outcome === 'finished' && !result.isError;
          this.store.storage.orchestration.completeLane(event.metadata.batch_id, event.metadata.agent, {
            status: isSuccess ? 'done' : 'failed',
            reply: result.content || (isSuccess ? 'Task completed.' : 'Task failed.'),
            tokens: run.usage?.total_tokens || 0,
            error: result.isError ? (result.content || 'Execution failed') : '',
          });
        } catch (_) {}
      }
      this.updateTurn(channel, agent, "idle", "", agentIdentity, executionKey);
      return {
        outcome: record.outcome,
        content: result ? result.content : run.content,
        usage: result ? (result.usage || run.usage) : run.usage,
        isError: result ? result.isError : false,
      };
    } catch (error) {
      const stopped = run.controller.signal.aborted && !run.timedOut;
      const budgetExceeded = error.code === 'BUDGET_EXCEEDED';
      const classified = categorizeError(error.status,error.message);
      const message = budgetExceeded ? error.message : stopped
        ? "Response stopped by user."
        : run.timedOut
          ? "The run timed out. Completed changes are preserved."
          : classified.code !== 'PROTOCOL_ERROR' ? classified.message : error.message;
      record.error = { code: budgetExceeded ? 'BUDGET_EXCEEDED' : run.timedOut ? 'TIMEOUT' : stopped ? 'CANCELLED' : classified.code, message };
      record.outcome=budgetExceeded?'limited':run.timedOut?'timed_out':stopped?(run.shutdown?'interrupted':'cancelled'):'failed';
      const facts=await evidence(record.outcome);record.evidence=facts;
      this.post(
        channel,
        agent,
        run.content ? `${run.content}\n\n— ${message}` : message,
        {
          model: config.model,
          interrupted: true,
          runtime_status: !run.content,
          outcome: stopped ? "stopped" : "error",
          usage:run.usage,
          execution_evidence:facts,
          run_id:run.runId,
          agent_identity: run.agentIdentity,
        },
        run.id,
      );
      if (this.store.storage && event.metadata?.routine_run_id) {
        try {
          this.store.storage.routines.completeRun(event.metadata.routine_run_id, {
            status: 'failed',
            outcome: record.outcome,
            errorMessage: message,
          });
        } catch (_) {}
      }
      if (!execution && this.store.storage && event.metadata?.pipeline_id) {
        try {
          this.store.storage.pipelines.failStep(channel, message);
        } catch (_) {}
      }
      if (!execution && this.store.storage && event.metadata?.batch_id && event.metadata?.agent) {
        try {
          this.store.storage.orchestration.completeLane(event.metadata.batch_id, event.metadata.agent, {
            status: 'failed',
            error: message,
          });
        } catch (_) {}
      }
      this.updateTurn(
        channel,
        agent,
        stopped ? "idle" : "error",
        stopped ? "" : message,
        agentIdentity,
        executionKey,
      );
    } finally {
      clearTimeout(timer);
      try {
        if (execution && !run.collaborationFinished) this.collaboration.finish(execution, run, record, null);
        this.tools.cancel(run);
        record.ended_at=Date.now();phase('finished');
      } finally {
        this.active.delete(executionKey);
        run.resolve();
      }
      if (execution) this.collaboration.afterRun(execution);
      const queue = this.queues.get(executionKey) || [],
        next = queue.shift();
      if (!queue.length) this.queues.delete(executionKey);
      if (next) void this.run(channel, next, { executionKey }).catch(error => { console.error('[AgentRunner] Queued run failed:', error.message); });
    }
  }
  stop(channel) {
    this.collaboration?.cancelSession(channel);
    const queued = this.queues.get(channel)?.length || 0;
    for (const event of this.queues.get(channel) || []) {
      event.metadata = { ...event.metadata, interrupted: true };
      if (this.store.storage && event.metadata?.routine_run_id) {
        try {
          this.store.storage.routines.completeRun(event.metadata.routine_run_id, {
            status: 'failed',
            error: 'Cancelled while queued',
            result: 'cancelled',
            outcome: 'cancelled',
            errorMessage: 'Cancelled while queued',
          });
        } catch (_) {}
      }
      if (this.store.storage && event.metadata?.pipeline_id) {
        try {
          this.store.storage.pipelines.failStep(channel, 'Cancelled while queued');
        } catch (_) {}
      }
    }
    if (queued) this.store.save();
    this.queues.delete(channel);
    for (const [key, events] of this.queues) if (key.startsWith(`${channel}:lane:`)) {
      for (const event of events) event.metadata = { ...event.metadata, interrupted: true };
      this.queues.delete(key);
    }
    const run = this.active.get(channel);
    run?.controller.abort();
    let laneRunsStopped = 0;
    for (const [key, activeRun] of this.active.entries()) {
      if (key.startsWith(`${channel}:lane:`)) {
        activeRun?.controller.abort();
        laneRunsStopped++;
      }
    }
    if (this.store.storage?.orchestration) {
      try {
        const batch = this.store.storage.orchestration.getParallelBatch(channel);
        if (!this.collaboration && batch?.run?.batch?.id && batch.run.batch.status === 'running') {
          this.store.storage.orchestration.stopParallelBatch(batch.run.batch.id);
        }
      } catch (_) {}
    }
    return { stopped: Boolean(run) || laneRunsStopped > 0, cancelled_queued: queued };
  }
  restoreRoot(channel, run) {
    const saved = this.store.storage?.runs.get(run.id);
    if ((saved?.configSnapshot || run.snapshot)?.collaboration?.kind === 'lane') {
      if (!this.collaboration) throw Object.assign(new Error('Collaboration is unavailable.'), { status: 409 });
      return { ...this.collaboration.restoreTarget(channel, run.id), worktree: true };
    }
    return { root: this.store.getChannel(channel)?.working_dir, worktree: false };
  }
  async recoveryCheckpoint(channel, run) {
    const checkpoint = await this.checkpoints.describe(run.id, channel);
    if (!checkpoint) return null;
    try {
      const target = this.restoreRoot(channel, run), root = fs.realpathSync.native(target.root);
      const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
      return { ...checkpoint, worktree: target.worktree, root_matches: same(root, checkpoint.root) };
    } catch (error) {
      const snapshot = this.store.storage?.runs.get(run.id)?.configSnapshot || run.snapshot;
      return { ...checkpoint, worktree: snapshot?.collaboration?.kind === 'lane', root_matches: false, restore_error: error.message };
    }
  }
  async restore(channel, id) {
    const run=this.store.data.runtime_runs.find(row=>row.id===id && row.channel===channel);
    if(!run || !run.outcome) throw Object.assign(new Error('只能撤销此会话已经结束的任务。'),{status:409});
    const target = this.restoreRoot(channel, run), root = target.root, key=projectKey(root);
    if(!key || [...this.restoring].some(other=>overlaps(other,key)) || [...this.active.values()].some(item=>overlaps(projectKey(item.snapshot.workingDir),key))) throw Object.assign(new Error('请先停止此项目的全部任务再撤销。'),{status:409});
    this.restoring.add(key);
    try {
      const checkpoint=await this.checkpoints.restore(id,channel,root);
      if (target.worktree) this.collaboration.invalidateRestoredDelivery(channel, id);
      run.checkpoint=checkpoint;
      if(run.evidence) run.evidence.checkpoint=checkpoint;
      this.store.save();
      this.post(channel,'system',checkpoint.scope === 'project-files' ? '已恢复检查点覆盖的项目文件。忽略目录、超限文件、进程、数据库与外部服务操作不在撤销范围内。' : '已撤销此任务的文件工具修改。命令产生的文件、进程、数据库及外部服务变化不在撤销范围内。',{runtime_status:true});
      this.broadcaster.broadcast({type:'workspace.project.files.changed',target:`channel/${channel}`,payload:{}});
      return checkpoint;
    } finally {this.restoring.delete(key);}
  }
  compact(channel) {
    if(this.active.has(channel)) throw Object.assign(new Error('Stop the current run before compacting.'),{status:409});
    if(!this.store.getChannel(channel)) throw Object.assign(new Error('Session not found.'),{status:404});
    return this.run(channel,{payload:{content:''}}, {compactOnly:true});
  }
  async close() {
    const runs = [...this.active.values()];
    for (const run of runs) run.shutdown = true;
    for (const channel of new Set(runs.map(run => run.snapshot.channel))) this.stop(channel);
    await Promise.all(runs.map(run => run.done));
  }

  dispatchPipelineStep(channel) {
    if (!this.collaboration) throw new Error('Collaboration is unavailable.');
    return this.collaboration.dispatchPipeline(channel);
  }
  dispatchBatchLanes(channel, batch) {
    if (!this.collaboration) throw new Error('Collaboration is unavailable.');
    return this.collaboration.dispatch(batch.run?.batch?.id || batch.id);
  }

}

module.exports = { AgentRunner, PROVIDERS };
