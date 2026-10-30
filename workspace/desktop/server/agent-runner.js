const crypto = require("crypto");
const { streamModel } = require("./model-stream");
const { RuntimeTools } = require('./runtime-tools');
const {projectSnapshot,changesSince} = require('./project-evidence');
const {normalizeUrl} = require('./config-manager');
const { Checkpoints } = require('./checkpoints');
const { categorizeError } = require('./connection-tester');
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
          `${event.payload.channel_name}/${event.payload.agent_name}`,
          event.payload,
        );
    for (const row of [...this.turns.values()])
      if (row.state === "running")
        this.updateTurn(
          row.channel_name,
          row.agent_name,
          "error",
          "The previous response was interrupted by an app restart.",
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
  config(channel) {
    const saved = this.store.getChannel(channel)?.runtime_config;
    if (saved) return saved;
    const provider =
      this.providers().find((p) => p.configured && p.id !== "ollama")?.id ||
      "ollama";
    return {
      provider,
      model: this.providers().find((p) => p.id === provider)?.model || "deepseek-chat",
      mode: "chat",
    };
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
      payload: { content, sender_name: agent, sender_type: "agent" },
      metadata,
    });
    this.broadcaster.broadcast(event);
    return event;
  }
  updateTurn(channel, agent, state, error = "") {
    const previous = this.turns.get(`${channel}/${agent}`),
      now = new Date().toISOString();
    const row = {
      channel_name: channel,
      agent_name: agent,
      state,
      error,
      updated_at: now,
      started_at: state === "running" ? now : previous?.started_at || now,
      ended_at: state === "running" ? null : now,
    };
    this.turns.set(`${channel}/${agent}`, row);
    this.broadcaster.broadcast(
      this.store.addEvent({
        type: "workspace.agent.turn.updated",
        source: `52hz:${agent}`,
        target: `channel/${channel}`,
        payload: row,
      }),
    );
  }
  snapshot(channel) {
    const run = this.active.get(channel);
    return run?.content
      ? {
          event_id: run.id,
          type: "workspace.message.streaming",
          source: `52hz:${run.agent}`,
          target: `channel/${channel}`,
          timestamp: run.timestamp,
          payload: {
            content: run.content,
            sender_name: run.agent,
            sender_type: "agent",
          },
          metadata: { streaming: true, model: run.model },
        }
      : null;
  }
  getConcurrentReservedCost(excludeRunId = null) {
    let reserved = 0;
    for (const activeRun of this.active.values()) {
      if (activeRun.runId !== excludeRunId) {
        let turnReservation = activeRun.reservedCost;
        if (typeof turnReservation !== 'number' && this.store.storage?.pricing) {
          const pricing = this.store.storage.pricing.calculateCost({
            provider: activeRun.protocol || activeRun.config?.provider || 'ollama',
            modelId: activeRun.model || activeRun.config?.model || 'default',
            promptTokens: activeRun.reservedPromptTokens ?? (activeRun.reservedTokens || 1000),
            completionTokens: activeRun.reservedCompletionTokens ?? 500,
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
    const executionKey = event.metadata?.lane_id
      ? `${channel}:lane:${event.metadata.lane_id}`
      : channel;

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
    return this.run(channel, event, { executionKey });
  }
  async run(channel, event, {compactOnly=false, executionKey=channel}={}) {
    const config = this.validateConfig(this.config(channel)),
      agent = config.provider;
    const laneWorktree = event.metadata?.worktree_path;
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
    const workingDir = isParallelLane ? laneWorktree : (channelWorkingDir || null);
    const key = projectKey(workingDir);
    if (this.workspaceOperations.has(channel) || key && ([...this.restoring].some(other => overlaps(other,key)) || [...this.active.values()].some(other => {
      if (other.snapshot?.executionKey && other.snapshot.executionKey !== executionKey && other.snapshot.workingDir !== workingDir) {
        return false;
      }
      return overlaps(projectKey(other.snapshot.workingDir), key) && (other.snapshot.mode === 'agent' || config.mode === 'agent');
    }))) {
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
    const run = {
      runId: crypto.randomUUID(),
      controller: new AbortController(),
      id: `reply-${crypto.randomUUID()}`,
      agent,
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
      },
      evidence: {
        filesModified: new Set(),
        commands: [],
      },
    };
    const record={id:run.runId,channel,prompt_id:event.id,snapshot:run.snapshot,phase:compactOnly?'compacting':'preparing',outcome:null,started_at:Date.now(),context:null};
    this.store.data.runtime_runs.push(record);
    if(this.store.data.runtime_runs.length>200) {const index=this.store.data.runtime_runs.findIndex(row=>row.outcome);if(index>=0)this.store.data.runtime_runs.splice(index,1);}
    if (this.store.storage) {
      try {
        this.store.storage.runs.create({
          id: run.runId,
          sessionId: channel,
          agentName: agent,
          modelId: config.model,
          mode: config.mode,
          clientMessageId: event.client_message_id || event.id,
          configSnapshot: run.snapshot,
          phase: compactOnly ? 'compacting' : 'preparing',
        });
      } catch (_) {}
    }
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
      const after=run.baseline?.available ? await projectSnapshot(this.store,channel).catch(()=>({available:false})) : {available:false};
      for(const name of changesSince(run.baseline,after)) run.evidence.filesModified.add(name);
      return {run_id:run.runId,files_modified:[...run.evidence.filesModified],commands:run.evidence.commands,outcome,
        checkpoint:await this.checkpoints.describe(run.runId,channel),
        file_observation:run.baseline?.available && after.available?'git-visible':'write-tools-only',
        denied:outcome==='denied',interrupted:['cancelled','interrupted'].includes(outcome),limited:outcome==='limited'};
    };
    run.done = new Promise(resolve => { run.resolve = resolve; });
    this.active.set(executionKey, run);
    const timer = setTimeout(() => {
      run.timedOut = true;
      run.controller.abort();
    }, this.timeoutMs);
    let lastPublish = 0;
    try {
      this.updateTurn(channel, agent, "running");
      this.broadcaster.broadcastComposing(channel, agent);
      const conn = this.configManager ? this.configManager.getConnection(config.provider) : null;
      const provider = PROVIDERS[config.provider];
      const protocol = conn?.protocol || (config.provider === 'claude' ? 'anthropic' : config.provider === 'ollama' ? 'ollama' : 'openai');
      const isAnthropic = protocol === 'anthropic';
      const isOllama = protocol === 'ollama';

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
      Object.assign(run.snapshot,{baseUrl:base,protocol,connectionVersion:conn?.version || 0});
      run.baseline=config.mode==='agent' ? await projectSnapshot(this.store,channel).catch(()=>({available:false})) : {available:false};
      const messages = this.conversation(`channel/${channel}`, event.id);
      const instruction = "You are a coding assistant. You can discuss code but have no filesystem or shell tools in this session. Never claim to have read local files, executed commands or applied edits.";
      const onDelta = content => {
        run.content = content;
        if (Date.now() - lastPublish >= 50) {
          lastPublish = Date.now(); const snapshot = this.snapshot(channel); if (snapshot) this.broadcaster.broadcast(snapshot);
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
      if (this.mcpManager && config.mode !== 'chat') {
        extraTools.push(...this.mcpManager.getPiTools({
          requestApproval: async (req, sig) => this.tools.approve(channel, run, req, sig),
        }));
      }
      if (this.store.storage && config.mode !== 'chat') {
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
      if (this.store.storage?.orchestration && config.mode !== 'chat') {
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
            const profiles = this.store.storage.orchestration.listProfiles();
            const text = !profiles.length ? 'No specialized profiles configured. Available embedded agents: pi-agent.' : JSON.stringify(profiles.map(p => ({ id: p.id, name: p.name, agent: p.agent, role: p.role, description: p.description, mode: p.mode })));
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
                      agent: { type: 'string', description: 'Agent or profile name to assign' },
                      task: { type: 'string', description: 'Specific task instruction' },
                      scope: { type: 'string', description: 'Directory or file scope the agent owns' },
                    },
                    required: ['task'],
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
              const batch = this.store.storage.orchestration.createBatch({
                channel_name: channel,
                origin: 'agent',
                delegated_by: run.agent || 'pi-agent',
                parent_run_id: run.id,
                workers: tasks.map(t => ({
                  agent: t.agent || 'worker',
                  task: t.task,
                  scope: t.scope || '',
                })),
              });
              this.dispatchBatchLanes(channel, batch);
              const text = `Delegated ${tasks.length} sub-tasks into parallel batch ${batch.run?.batch?.id || ''}. Current status: ${batch.state}.`;
              if (toolCallId) return { content: [{ type: 'text', text }] };
              return text;
            },
          });
        }
      }
        const result = (compactOnly || config.mode !== 'chat' || !this.stream) ? await this.piRuntime({
        config: { ...config, protocol },
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
          if (!reservedCost && (reservedPromptTokens > 0 || reservedCompletionTokens > 0)) {
            const pricing = this.store.storage.pricing.calculateCost({
              provider: conn?.protocol || config.provider,
              modelId: config.model,
              promptTokens: reservedPromptTokens,
              completionTokens: reservedCompletionTokens,
            });
            if (typeof pricing?.estimatedCost === 'number') {
              reservedCost = pricing.estimatedCost;
            }
          }

          run.reservedPromptTokens = reservedPromptTokens;
          run.reservedCompletionTokens = reservedCompletionTokens;
          run.reservedTokens = reservedTokens;
          run.reservedCost = reservedCost;

          const concurrentCost = this.getConcurrentReservedCost(run.runId);

          return this.store.storage.budgets.checkPreflight({
            sessionId: channel,
            runId: run.runId,
            currentStepCount: run.tools?.size || 0,
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
              provider: conn?.protocol || config.provider,
              modelId: config.model,
              promptTokens: reqUsage.promptTokens,
              completionTokens: reqUsage.completionTokens,
              cacheReadTokens: reqUsage.cacheReadTokens || 0,
            });
            const cost = typeof pricingInfo?.estimatedCost === 'number' ? pricingInfo.estimatedCost : null;
            if (cost !== null) {
              run.accumulatedCost = (run.accumulatedCost || 0) + cost;
              run.reservedCost = 0;
              run.reservedTokens = 0;
              run.reservedPromptTokens = 0;
              run.reservedCompletionTokens = 0;
            } else {
              run.hasUnknownCost = true;
            }
            this.store.storage.usage.recordModelRequest({
              runId: run.runId,
              sessionId: channel,
              provider: conn?.protocol || config.provider,
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
              status: 'completed',
            });
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
        onApproval: async (request, signal) => {phase('waiting_approval');const allowed=await this.tools.approve(channel,run,request,signal);phase('executing');return allowed;},
        beforeMutation: change => this.checkpoints.prepare(run.runId,channel,workingDir,change),
        beforeCommand: () => this.checkpoints.beginCommand(run.runId,channel,workingDir),
        afterCommand: () => this.checkpoints.endCommand(run.runId,channel),
        onMutation: change => {
          this.tools.mutation(channel, run, change);
          run.evidence.filesModified.add(change.path);
        },
        onAssistant: content => {
          this.post(channel, agent, content, { model: config.model, mode: config.mode, in_reply_to: event.id, runtime_intermediate: true }, run.id);
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
      if (this.store.storage && result?.usage) {
        try {
          const pricingInfo = this.store.storage.pricing.calculateCost({
            provider: conn?.protocol || config.provider,
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

          this.store.storage.usage.recordModelRequest({
            runId: run.runId,
            sessionId: channel,
            provider: conn?.protocol || config.provider,
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
      if (this.store.storage && event.metadata?.pipeline_id) {
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
      if (this.store.storage && event.metadata?.batch_id && event.metadata?.agent) {
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
      this.updateTurn(channel, agent, "idle");
      return {
        outcome: record.outcome,
        content: result ? result.content : run.content,
        usage: result ? (result.usage || run.usage) : run.usage,
        isError: result ? result.isError : false,
      };
    } catch (error) {
      const stopped = run.controller.signal.aborted && !run.timedOut;
      const classified = categorizeError(error.status,error.message);
      const message = stopped
        ? "Response stopped by user."
        : run.timedOut
          ? "The run timed out. Completed changes are preserved."
          : classified.code !== 'PROTOCOL_ERROR' ? classified.message : error.message;
      record.error = { code: run.timedOut ? 'TIMEOUT' : stopped ? 'CANCELLED' : classified.code, message };
      record.outcome=run.timedOut?'timed_out':stopped?(run.shutdown?'interrupted':'cancelled'):'failed';
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
      if (this.store.storage && event.metadata?.pipeline_id) {
        try {
          this.store.storage.pipelines.failStep(channel, message);
        } catch (_) {}
      }
      if (this.store.storage && event.metadata?.batch_id && event.metadata?.agent) {
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
      );
    } finally {
      clearTimeout(timer);
      try {
        this.tools.cancel(run);
        record.ended_at=Date.now();phase('finished');
      } finally {
        this.active.delete(executionKey);
        run.resolve();
      }
      const queue = this.queues.get(executionKey) || [],
        next = queue.shift();
      if (!queue.length) this.queues.delete(executionKey);
      if (next) void this.run(channel, next, { executionKey }).catch(error => { console.error('[AgentRunner] Queued run failed:', error.message); });
    }
  }
  stop(channel) {
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
        if (batch?.run?.batch?.id && batch.run.batch.status === 'running') {
          this.store.storage.orchestration.stopParallelBatch(batch.run.batch.id);
        }
      } catch (_) {}
    }
    return { stopped: Boolean(run) || laneRunsStopped > 0, cancelled_queued: queued };
  }
  async restore(channel, id) {
    const run=this.store.data.runtime_runs.find(row=>row.id===id && row.channel===channel);
    if(!run || !run.outcome) throw Object.assign(new Error('只能撤销此会话已经结束的任务。'),{status:409});
    const root=this.store.getChannel(channel)?.working_dir, key=projectKey(root);
    if(!key || [...this.restoring].some(other=>overlaps(other,key)) || [...this.active.values()].some(item=>overlaps(projectKey(item.snapshot.workingDir),key))) throw Object.assign(new Error('请先停止此项目的全部任务再撤销。'),{status:409});
    this.restoring.add(key);
    try {
      const checkpoint=await this.checkpoints.restore(id,channel,root);
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
    for (const [channel,run] of this.active) {run.shutdown=true;this.stop(channel);}
    await Promise.all(runs.map(run => run.done));
  }

  dispatchPipelineStep(channel, pipeline) {
    if (!pipeline || !pipeline.active || pipeline.status !== 'running') return;
    const step = pipeline.steps?.[pipeline.current_index];
    if (!step) return;

    const priorDeliverables = (pipeline.steps || [])
      .slice(0, pipeline.current_index)
      .map((s, idx) => 'Step ' + (idx + 1) + ' (' + s.agent + '):\n' + (s.deliverable || '(no deliverable)'))
      .join('\n\n');

    const prompt = priorDeliverables
      ? 'Prior step deliverables:\n' + priorDeliverables + '\n\nYour task for Step ' + (pipeline.current_index + 1) + ':\n' + step.instruction
      : step.instruction;

    const event = {
      type: 'workspace.message.posted',
      source: 'pipeline:' + pipeline.id,
      target: 'channel/' + channel,
      payload: {
        content: prompt,
        sender_name: step.agent || 'Pipeline',
        sender_type: 'pipeline',
      },
      metadata: {
        pipeline_id: pipeline.id,
        step_index: pipeline.current_index,
        agent: step.agent,
      },
    };

    const saved = this.store.addEvent(event);
    this.broadcaster.broadcast(saved);
    this.handleUserMessage(saved).catch(err => {
      console.error('[AgentRunner] Error executing pipeline step ' + pipeline.current_index + ':', err);
    });
  }

  dispatchBatchLanes(channel, batch) {
    if (!batch) return;
    const batchId = batch.run?.batch?.id || batch.id;
    const lanes = batch.run?.lanes || batch.lanes || [];
    if (!batchId || !lanes.length) return;

    for (const lane of lanes) {
      if (lane.status !== 'running') continue;
      const laneId = lane.id || lane.agent;
      const prompt = `[Multi-Agent Task: ${lane.agent} (${lane.role || 'implementer'})]\nTask: ${lane.task}${lane.scope ? `\nScope: ${lane.scope}` : ''}`;

      const event = {
        type: 'workspace.message.posted',
        source: `orchestration:lane:${laneId}`,
        target: `channel/${channel}`,
        payload: {
          content: prompt,
          sender_name: lane.agent || 'Worker',
          sender_type: 'agent',
        },
        metadata: {
          batch_id: batchId,
          lane_id: laneId,
          agent: lane.agent,
          worktree_path: lane.worktree_path || null,
          branch: lane.branch || null,
        },
      };

      const saved = this.store.addEvent(event);
      this.broadcaster.broadcast(saved);

      queueMicrotask(async () => {
        try {
          await this.handleUserMessage(saved);
        } catch (err) {
          if (this.store.storage?.orchestration) {
            this.store.storage.orchestration.completeLane(batchId, lane.agent, {
              status: 'failed',
              error: err.message,
            });
          }
        }
      });
    }
  }
}

module.exports = { AgentRunner, PROVIDERS };
