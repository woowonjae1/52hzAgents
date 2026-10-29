const crypto = require("crypto");
const { streamModel } = require("./model-stream");
const { RuntimeTools } = require('./runtime-tools');
const {projectSnapshot,changesSince} = require('./project-evidence');
const {normalizeUrl} = require('./config-manager');
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
    { env = process.env, stream = null, piRuntime = runPi, timeoutMs = 900_000, configManager = null } = {},
  ) {
    this.store = store;
    this.broadcaster = broadcaster;
    this.env = env;
    this.stream = stream;
    this.piRuntime = piRuntime;
    this.configManager = configManager;
    this.tools = new RuntimeTools(store, broadcaster);
    this.timeoutMs = timeoutMs;
    this.active = new Map();
    this.queues = new Map();
    this.turns = new Map();
    store.data.runtime_runs ||= [];
    for(const row of store.data.runtime_runs) if(!row.outcome) {row.phase='finished';row.outcome='interrupted';row.ended_at=Date.now();}
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
  async handleUserMessage(event) {
    if (
      !event.source?.startsWith("human:") ||
      typeof event.payload?.content !== "string" ||
      !event.payload.content.trim()
      || event.metadata?.tool_approval_response
    )
      return;
    const channel = event.target.replace(/^channel\//, "");
    if (!this.store.getChannel(channel)) return;
    if (this.active.has(channel)) {
      const queue = this.queues.get(channel) || [];
      if (queue.length >= 20) {
        this.post(
          channel,
          "system",
          "The session queue is full. Wait for a response before sending more messages.",
          { runtime_status: true },
        );
        return;
      }
      queue.push(event);
      this.queues.set(channel, queue);
      return;
    }
    return this.run(channel, event);
  }
  async run(channel, event, {compactOnly=false}={}) {
    const config = this.validateConfig(this.config(channel)),
      agent = config.provider;
    const workingDir = this.store.getChannel(channel)?.working_dir || null;
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
    const record={id:run.runId,channel,snapshot:run.snapshot,phase:compactOnly?'compacting':'preparing',outcome:null,started_at:Date.now(),context:null};
    this.store.data.runtime_runs.push(record);
    if(this.store.data.runtime_runs.length>200) {const index=this.store.data.runtime_runs.findIndex(row=>row.outcome);if(index>=0)this.store.data.runtime_runs.splice(index,1);}
    const phase = value => {record.phase=value;this.store.save();this.broadcaster.broadcast({type:'workspace.runtime.run.updated',target:`channel/${channel}`,payload:record});};
    const evidence = async outcome => {
      const after=run.baseline?.available ? await projectSnapshot(this.store,channel).catch(()=>({available:false})) : {available:false};
      for(const name of changesSince(run.baseline,after)) run.evidence.filesModified.add(name);
      return {run_id:run.runId,files_modified:[...run.evidence.filesModified],commands:run.evidence.commands,outcome,
        file_observation:run.baseline?.available && after.available?'git-visible':'write-tools-only',
        denied:outcome==='denied',interrupted:['cancelled','interrupted'].includes(outcome),limited:outcome==='limited'};
    };
    run.done = new Promise(resolve => { run.resolve = resolve; });
    this.active.set(channel, run);
    this.updateTurn(channel, agent, "running");
    this.broadcaster.broadcastComposing(channel, agent);
    const timer = setTimeout(() => {
      run.timedOut = true;
      run.controller.abort();
    }, this.timeoutMs);
    let lastPublish = 0;
    try {
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
      const result = (compactOnly || config.mode !== 'chat' || !this.stream) ? await this.piRuntime({
        config: { ...config, protocol },
        channel,
        userDataPath: this.store.userDataPath,
        projectDir: run.snapshot.workingDir,
        prompt: event.payload.content,
        promptId: compactOnly ? undefined : event.id,
        compactOnly,
        history: compactOnly ? messages : messages.slice(0, -1),
        confirmedContextWindow: conn?.defaultModel === config.model ? conn?.confirmedContextWindow : conn?.models?.find(model=>model.id===config.model)?.confirmedContextWindow,
        baseUrl: base,
        apiKey: key || 'ollama',
        signal: run.controller.signal,
        onDelta: content=>{if(record.phase!=='generating')phase('generating');onDelta(content);},
        onUsage: usage=>{run.usage=usage;},
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
      this.updateTurn(channel, agent, "idle");
    } catch (error) {
      const stopped = run.controller.signal.aborted && !run.timedOut;
      const message = stopped
        ? "Response stopped by user."
        : run.timedOut
          ? "The run timed out. Completed changes are preserved."
          : error.message;
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
      this.updateTurn(
        channel,
        agent,
        stopped ? "idle" : "error",
        stopped ? "" : message,
      );
    } finally {
      clearTimeout(timer);
      this.tools.cancel(run);
      record.ended_at=Date.now();phase('finished');
      this.active.delete(channel);
      run.resolve();
      const queue = this.queues.get(channel) || [],
        next = queue.shift();
      if (!queue.length) this.queues.delete(channel);
      if (next) void this.run(channel, next);
    }
  }
  stop(channel) {
    const queued = this.queues.get(channel)?.length || 0;
    for (const event of this.queues.get(channel) || [])
      event.metadata = { ...event.metadata, interrupted: true };
    if (queued) this.store.save();
    this.queues.delete(channel);
    const run = this.active.get(channel);
    run?.controller.abort();
    return { stopped: Boolean(run), cancelled_queued: queued };
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
}
module.exports = { AgentRunner, PROVIDERS };
