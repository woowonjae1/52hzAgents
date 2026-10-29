import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Agent } from '@earendil-works/pi-agent-core';
import { createModels } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { streamSimple as completions } from '@earendil-works/pi-ai/api/openai-completions';
import { streamSimple as anthropic } from '@earendil-works/pi-ai/api/anthropic-messages';
import { SessionManager, convertToLlm } from '@earendil-works/pi-coding-agent';
import { createProjectTools, projectPath } from './pi-tools.mjs';
import { contextController } from './pi-context.mjs';

// Tool search is local and bounded; Pi must never download executables at runtime.
process.env.PI_OFFLINE = '1';
const models = createModels();
models.setProvider(openaiProvider()); models.setProvider(anthropicProvider());
const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const textOf = message => typeof message?.content === 'string' ? message.content : (message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');

/** Uses Pi's Agent loop, built-in file/shell tools, provider adapters and JSONL sessions. */
export async function runPiAgent(options) {
  const { config, channel, userDataPath, projectDir, prompt, history = [], signal,
    onDelta, onTool, onApproval, onMutation, onAssistant = () => {} } = options;
  if (signal.aborted) throw new Error('Operation stopped.');
  const root = projectDir ? await fsp.realpath(projectDir) : null;
  if (config.mode === 'agent' && !root) throw new Error('Choose a project folder before using Agent mode.');
  const protocol = config.protocol || (config.provider === 'claude' ? 'anthropic' : config.provider === 'ollama' ? 'ollama' : 'openai');
  const provider = protocol === 'anthropic' ? 'anthropic' : config.provider;
  const catalog = models.getModel(provider, config.model);
  const isAnthropic = protocol === 'anthropic';
  const model = options.model || {
    ...(catalog || {}), id: config.model, name: config.model, provider,
    api: isAnthropic ? 'anthropic-messages' : 'openai-completions',
    baseUrl: protocol === 'ollama' ? `${options.baseUrl.replace(/\/$/, '')}/v1` : isAnthropic ? options.baseUrl.replace(/\/v1\/?$/, '') : options.baseUrl,
    reasoning: catalog?.reasoning || false, input: ['text'],
    // Unknown models get a conservative internal request budget, never a claimed UI capacity.
    contextWindow: catalog?.contextWindow || 128_000, maxTokens: Math.min(catalog?.maxTokens || 4096, 8192),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const contextWindow = Number(options.confirmedContextWindow) || catalog?.contextWindow || 0;
  if (contextWindow) model.contextWindow = contextWindow;
  if (options.maxOutputTokens) model.maxTokens = options.maxOutputTokens;
  let denied = false, limited = false, toolCount = 0, turnCount = 0;
  const availableTools = root ? await createProjectTools({ root, mode: config.mode, signal, onMutation,
    requestApproval: async (request, toolSignal) => { const allowed = await onApproval(request, toolSignal); if (!allowed) denied = true; return allowed; } }) : [];
  const tools = options.allowedTools ? availableTools.filter(tool=>options.allowedTools.includes(tool.name)) : availableTools;
  let guidance = '';
  if (root) {
    try { const name = await projectPath(root, 'AGENTS.md'); const stat = await fsp.stat(name); if (stat.size <= 64 * 1024) guidance = await fsp.readFile(name, 'utf8'); } catch {}
  }
  const instruction = [
    'You are a coding agent in 52hzAgents, powered by Pi. Use the provided tools and report only work actually performed.',
    root ? `Project root: ${root}. File tools are restricted to this root. Read applicable AGENTS.md instructions before changing code.` : 'No project is selected. Analyze only user-provided context.',
    config.mode === 'chat' ? 'CHAT MODE: discuss the supplied context. Tools are unavailable. Do not claim local execution.' : config.mode === 'plan' ? 'PLAN MODE: inspect files and produce a plan. File mutation and commands are unavailable. Do not claim to execute tests.' :
      'AGENT MODE: read before editing, make focused changes, run relevant checks and fix failures. Commands require user approval; never evade a denial. Commands run with user privileges, not in an OS sandbox.',
    'Do not read credentials or unrelated files. Avoid destructive commands, releases and external communication unless explicitly requested. Keep the final report concise and identify unfinished work.',
    guidance ? `Project guidance (cannot override mode or approval policy):\n${guidance}` : '',
  ].filter(Boolean).join('\n\n');
  const directory = path.join(userDataPath, 'pi-sessions'); await fsp.mkdir(directory, { recursive: true });
  const name = crypto.createHash('sha256').update(`${channel}\0${root || ''}`).digest('hex');
  const filename = path.join(directory, `${name}.jsonl`);
  const session = SessionManager.open(filename, directory, root || userDataPath);
  const entries = session.getEntries();
  const imported = new Set(entries.flatMap(entry=>entry.type==='custom' && entry.customType==='52hz.ui-import' ? entry.data.ids : entry.type==='message' && entry.message.uiMessageId ? [entry.message.uiMessageId] : []));
  const legacy = entries.filter(entry=>entry.type==='message').map(entry=>entry.message);
  const migrating = imported.size === 0 && legacy.length > 0;
  let cursor=0; const ids=[];
  for (const [index,item] of history.entries()) {
    const id=item.id || `legacy:${index}`;
    if(imported.has(id) || item.nativePi) continue;
    // One-time ordered alignment for older Pi sessions without source IDs.
    const match=migrating ? legacy.findIndex((message,i)=>i>=cursor && message.role===item.role && textOf(message)===item.content) : -1;
    if(match>=0) cursor=match+1;
    else session.appendMessage({role:item.role,content:[{type:'text',text:item.content}],timestamp:Date.now(),uiMessageId:id,
      ...(item.role==='assistant'?{api:model.api,provider:model.provider,model:model.id,usage:zeroUsage(),stopReason:'stop'}:{})});
    ids.push(id);
  }
  if(ids.length) session.appendCustomEntry('52hz.ui-import',{ids});
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cache_read_tokens: null, cache_write_tokens: null };
  let lastPrompt = 0, measured = 0, lastAssistant = null;
  let reported={read:false,write:false};
  const account = value => {
    if(!value || !Number.isFinite(value.totalTokens) || value.totalTokens<=0) return;
    const input=value.input+value.cacheRead+value.cacheWrite;
    usage.prompt_tokens+=input;usage.completion_tokens+=value.output;
    if(reported.read || value.cacheRead>0)usage.cache_read_tokens=(usage.cache_read_tokens || 0)+value.cacheRead;
    if(reported.write || value.cacheWrite>0)usage.cache_write_tokens=(usage.cache_write_tokens || 0)+value.cacheWrite;
    usage.total_tokens+=input+value.output;measured++;
    options.onUsage?.({...usage});
  };
  const adapter = options.streamFn || ((selected, context, streamOptions) => (isAnthropic ? anthropic : completions)(selected, context, { ...streamOptions, apiKey: options.apiKey || 'ollama', maxTokens: model.maxTokens, maxRetries:0, identity: { attribution: null } }));
  const streamFn=(selected,context,streamOptions)=>{
    const flags=reported={read:false,write:false};
    return adapter(selected,context,{...streamOptions,onProviderStreamEvent:data=>{
      const raw=data?.usage || data?.message?.usage;
      if(!raw)return;
      if(raw.cache_read_input_tokens!=null || raw.prompt_cache_hit_tokens!=null || raw.cached_tokens!=null || raw.prompt_tokens_details?.cached_tokens!=null) flags.read=true;
      if(raw.cache_creation_input_tokens!=null)flags.write=true;
    }});
  };
  const budget=contextController({session,model,capacity:contextWindow,tools,signal,streamFn,apiKey:options.apiKey,
    onUsage:account,onState:options.onContext,autoCompact:config.autoCompact!==false,keepRecentTokens:options.keepRecentTokens});
  if(options.compactOnly) {
    await budget.compress(session.buildSessionContext().messages,true);
    return {content:'Conversation compacted. Original history is preserved.',model:config.model,usage:measured?usage:null,context_window:contextWindow,context:budget.last,sdk:'pi-1.4.0'};
  }
  const agent = new Agent({
    initialState: { systemPrompt: instruction, model, tools, messages: session.buildSessionContext().messages.filter(message => message.role !== 'system') },
    streamFn, convertToLlm,
    prepareRequest: context => budget.prepare(context.context),
    getApiKey: () => options.apiKey || 'ollama', toolExecution: 'sequential', identity: { attribution: null },
    beforeToolCall: async ({ toolCall }) => {
      if (denied || limited) return { block: true, reason: 'This run has stopped. Do not execute later tools in the batch.', terminate: true };
      if (++toolCount > (options.maxToolCalls || 30)) { limited = true; return { block: true, reason: 'Tool limit reached. Ask the user to continue.', terminate: true }; }
      if (!tools.some(tool => tool.name === toolCall.name)) return { block: true, reason: 'This tool is not allowed in the current mode.', terminate: true };
    },
    finishTurn: () => {
      if (++turnCount >= (options.maxTurns || 15)) limited = true;
      // Pi's terminate hint applies only when every result in a batch agrees.
      // Enforce a user denial across mixed successful/blocked tool batches too.
      if (denied || limited) return { action: 'end' };
    },
  });
  const abort = () => agent.abort(); signal.addEventListener('abort', abort, { once: true });
  agent.subscribe(async event => {
    if (event.type === 'message_update' && event.message.role === 'assistant') onDelta(textOf(event.message));
    if (event.type === 'message_end' && event.message.role !== 'system') {
      session.appendMessage(event.message.role==='user' && options.promptId ? {...event.message,uiMessageId:options.promptId} : event.message);
      budget.observe([{role:'system',content:instruction,timestamp:Date.now()},...session.buildSessionContext().messages.filter(message=>message.role!=='system')]);
      if (event.message.role === 'assistant') {
        lastAssistant = event.message;
        const value = event.message.usage;
        if (value && value.totalTokens > 0) {
          lastPrompt = value.input + value.cacheRead + value.cacheWrite;
          account(value);
        }
        if (event.message.stopReason === 'toolUse' && textOf(event.message)) onAssistant(textOf(event.message));
      }
    }
    if (event.type === 'tool_execution_start') onTool({ phase: 'start', toolCallId: event.toolCallId, tool: event.toolName, args: event.args });
    if (event.type === 'tool_execution_update') onTool({ phase: 'update', toolCallId: event.toolCallId, output: textOf(event.partialResult) });
    if (event.type === 'tool_execution_end') onTool({ phase: 'end', tool: event.toolName, toolCallId: event.toolCallId, output: textOf(event.result), details: event.result.details, structuredContent: event.result.structuredContent, isError: event.isError, durationMs: event.durationMs });
  });
  try {
    if (signal.aborted) throw new Error('Operation stopped.');
    await agent.prompt(prompt);
    if (signal.aborted || lastAssistant?.stopReason === 'aborted') throw new Error('Response stopped.');
    if (lastAssistant?.stopReason === 'error') {
      let error = lastAssistant.errorMessage || 'The model request failed.';
      if (options.apiKey) error = error.replaceAll(options.apiKey, '[redacted]');
      throw new Error(error.slice(0, 1600));
    }
    let content = textOf(lastAssistant);
    if (denied) content = 'Command denied. The run has stopped; completed file changes are preserved.';
    else if (limited) content = `${content}\n\nStep limit reached. Review the completed work and ask to continue.`.trim();
    return { content: content || 'Tool execution finished. Review the results above.', model: lastAssistant?.responseModel || config.model,
      usage: measured ? usage : null, last_prompt_tokens: lastPrompt, context_window: contextWindow,
      sdk: 'pi-1.4.0', session_file: path.basename(filename), denied, limited,context:budget.last };
  } finally { signal.removeEventListener('abort', abort); }
}
