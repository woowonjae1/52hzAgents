'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { attachJsonlLineReader, serializeJsonLine } = require('../transports/jsonl');
const { fail, isFile, locate, buildSanitizedNativeEnv, stopChild } = require('./common');
const { piQuestion, writeNativeReply } = require('../native-questions');

const VALID_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);
const DIALOG_UI_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

function parseNativeModelSpec(rawSpec) {
  if (typeof rawSpec !== 'string' || !rawSpec.trim()) return null;
  let core = rawSpec.trim();
  let thinking = null;

  const colonIdx = core.lastIndexOf(':');
  if (colonIdx > 0) {
    const maybeThinking = core.slice(colonIdx + 1).trim();
    if (VALID_THINKING_LEVELS.has(maybeThinking)) {
      thinking = maybeThinking;
      core = core.slice(0, colonIdx).trim();
    }
  }

  const slashIdx = core.indexOf('/');
  if (slashIdx > 0) {
    return {
      provider: core.slice(0, slashIdx).trim(),
      modelId: core.slice(slashIdx + 1).trim(),
      thinking,
    };
  }
  return {
    provider: null,
    modelId: core,
    thinking,
  };
}

function extractTextBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part && part.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('');
}

function buildAllowedPiTools(mode, permissions = {}) {
  if (mode === 'chat') return [];
  const tools = ['read', 'grep', 'find', 'ls'];
  if (mode === 'agent') {
    if (permissions.writeFiles) tools.push('edit', 'write');
    // 原生 Pi CLI RPC 模式目前尚未建立真正的双向执行前受控拦截桥接；
    // 为保护宿主安全，默认禁用 bash 命令能力（无桥接默认禁用），防止未审批执行任意命令。
  }
  return tools;
}

/**
 * Run a task using the local Pi CLI in RPC mode (`pi --mode rpc`).
 *
 * Key guarantees (R2):
 * 1. Uses strict LF-only JSONL framing (does not split on U+2028 / U+2029).
 * 2. Isolates native sessions per (channel, contextKey, agentId, connectionId) and holds an exclusive write lock.
 * 3. `prompt` response only means accepted/queued; completion requires `agent_end` with a non-error stopReason.
 * 4. Per-task/member `nativeModel` is passed via CLI flags (`--provider` / `--model`), never via `set_model` RPC
 *    which would mutate the user's global `settings.json`.
 */
async function runNativePi(
  options,
  { launch = locate('pi', options?.env || process.env), spawnImpl = spawn } = {}
) {
  if (!launch) throw fail('Pi native client not found.');
  if (options.signal?.aborted) throw fail('Task cancelled.', 'ABORT_ERR');
  if (!options.projectDir || !fs.statSync(options.projectDir).isDirectory()) {
    throw fail('Choose an existing project directory.');
  }

  const mode = options.config?.mode || 'plan';
  const permissions = options.agentPolicy?.permissions || { readFiles: true };
  const allowedTools = buildAllowedPiTools(mode, permissions, { onApproval: options.onApproval });
  if (options.onHumanInteraction) allowedTools.push('workbench_ask_user');
  const writable = mode === 'agent' && Boolean(permissions.writeFiles || permissions.executeCommands);

  let binding = null;
  let resumedExistingSession = false;
  const sessionBindings = options.sessionBindings || null;
  const runId = options.runId || null;

  let sessionFileArg = options.sessionFile || null;
  let sessionDirArg = options.sessionDir || null;

  if (sessionBindings && options.channel && options.agentId && runId) {
    const baseDir = path.join(
      options.userDataPath || os.tmpdir(),
      'native-sessions',
      'pi',
      String(options.connection?.id || 'default').replace(/[^a-zA-Z0-9_-]/g, '_')
    );
    binding = sessionBindings.resolveOrCreate({
      channel: options.channel,
      contextKey: options.contextKey || null,
      agentId: options.agentId,
      connectionId: options.connection?.id || null,
      adapterKind: 'native-pi',
    });
    const dedicatedDir = path.join(baseDir, binding.id);
    fs.mkdirSync(dedicatedDir, { recursive: true });
    binding = sessionBindings.acquireWriteLock(binding.id, { runId });
    if (binding.nativeSessionFile && isFile(binding.nativeSessionFile)) {
      sessionFileArg = binding.nativeSessionFile;
      resumedExistingSession = true;
    } else {
      sessionDirArg = dedicatedDir;
    }
  }

  const parsedModel = parseNativeModelSpec(options.nativeModel);
  const cliArgs = [...launch.args, '--mode', 'rpc'];
  if (parsedModel) {
    if (parsedModel.provider) cliArgs.push('--provider', parsedModel.provider);
    if (parsedModel.modelId) cliArgs.push('--model', parsedModel.modelId);
    if (parsedModel.thinking) cliArgs.push('--thinking', parsedModel.thinking);
  }

  if (sessionFileArg) {
    cliArgs.push('--session', sessionFileArg);
  } else if (sessionDirArg) {
    cliArgs.push('--session-dir', sessionDirArg);
  } else {
    cliArgs.push('--no-session');
  }

  if (allowedTools.length === 0) {
    cliArgs.push('--no-tools');
  } else {
    cliArgs.push('--tools', allowedTools.join(','));
  }

  if (!options.allowExtensions || mode !== 'agent') {
    cliArgs.push('--no-extensions');
  }
  if (options.onHumanInteraction) cliArgs.push('--extension', path.join(__dirname, '..', 'extensions', 'workbench-questions.mjs'));

  if (options.agentPolicy?.instructions && String(options.agentPolicy.instructions).trim()) {
    cliArgs.push('--append-system-prompt', String(options.agentPolicy.instructions).trim());
  }

  const extraEnv = {};
  const configDir = options.connection?.configDir || options.connection?.configRoot;
  if (configDir) {
    extraEnv.PI_CODING_AGENT_DIR = configDir;
  }
  const childEnv = buildSanitizedNativeEnv(options.env || process.env, launch, extraEnv);

  let child;
  try {
    child = spawnImpl(launch.command, cliArgs, {
      cwd: options.projectDir,
      env: childEnv,
      windowsHide: true,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    if (binding && sessionBindings) {
      try {
        sessionBindings.releaseWriteLock(binding.id, { runId, nextState: 'idle' });
      } catch {}
    }
    throw fail(`Unable to start Pi client: ${err.message}`);
  }

  const pending = new Map();
  let sequence = 0;
  let completedMessages = [];
  let streamingDraft = '';
  let text = '';
  let usage = null;
  let costKnown = false;
  let estimatedCost = null;
  let contextWindow = null;
  let agentEnded = false;
  let promptAccepted = false;
  let checkpointStarted = false;
  let terminalError = null;
  let assistantError = null;
  let assistantAborted = false;
  let denied = false;
  let turnUsage = {
    prompt_tokens: 0,
    completion_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 0,
  };
  let turnCost = 0;
  let hasTurnUsage = false;
  const dialogs = new Set();
  const seenDialogs = new Set();
  let resolveTurn;
  let rejectTurn;

  const closed = new Promise(resolve => child.once('close', resolve));
  const completion = new Promise((resolve, reject) => {
    resolveTurn = resolve;
    rejectTurn = reject;
  });
  completion.catch(() => {});

  const send = payload => {
    if (!child.stdin.destroyed) {
      child.stdin.write(serializeJsonLine(payload));
    }
  };

  const request = (commandObj, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
      if (terminalError || options.signal?.aborted) return reject(terminalError || fail('Task cancelled.', 'ABORT_ERR'));
      const id = `req-${++sequence}`;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(fail(`Pi RPC ${commandObj.type} timed out.`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, command: commandObj.type });
      send({ ...commandObj, id });
    });

  const fatal = error => {
    terminalError ||= error;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(terminalError);
    }
    pending.clear();
    rejectTurn(terminalError);
  };

  const abort = () => {
    try {
      send({ type: 'abort' });
    } catch {}
    fatal(fail('Task cancelled.', 'ABORT_ERR'));
    void stopChild(child);
  };

  options.signal?.addEventListener('abort', abort, { once: true });
  child.on('error', () => fatal(fail('Unable to start Pi client.')));
  child.stdin.on('error', () => fatal(fail('Pi transport closed.')));
  child.stderr.on('data', () => {});
  child.once('close', code => {
    if (!agentEnded) {
      fatal(fail(`Pi exited before agent_end (exit ${code}).`, 'RUNTIME_PREMATURE_EXIT'));
    }
  });

  const publishText = () => {
    const combined = [...completedMessages, ...(streamingDraft ? [streamingDraft] : [])].join('\n\n');
    text = combined;
    if (combined) options.onDelta?.(combined);
  };

  const handleEvent = async event => {
    if (!event || typeof event !== 'object') return;

    if (event.type === 'response' && event.id !== undefined) {
      const entry = pending.get(event.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(event.id);
      if (!event.success) {
        entry.reject(fail(`Pi RPC ${event.command || entry.command} failed: ${event.error || 'unknown error'}`));
      } else {
        entry.resolve(event.data);
      }
      return;
    }

    if (event.type === 'extension_ui_request') {
      const method = event.method;
      if (!DIALOG_UI_METHODS.has(method)) {
        options.onExtensionNotification?.(event);
        return;
      }
      if (typeof options.onHumanInteraction === 'function') {
        if (typeof event.id !== 'string' || !event.id || seenDialogs.has(event.id)) throw fail('Pi 重复或无效的界面请求。', 'INVALID_NATIVE_QUESTION');
        seenDialogs.add(event.id);
        dialogs.add(event.id);
        try {
          const answer = await options.onHumanInteraction({ ...piQuestion(event), nativeSession: binding?.nativeSessionId || null });
          if (options.signal?.aborted) throw fail('Task cancelled.', 'ABORT_ERR');
          const response = answer.cancelled ? { cancelled: true } : event.method === 'confirm'
            ? { confirmed: answer.confirmed } : { value: answer.answers.value[0] };
          await writeNativeReply(child.stdin, { type: 'extension_ui_response', id: event.id, ...response });
          options.onHumanInteractionSent?.(answer.interactionId);
        } finally {
          dialogs.delete(event.id);
        }
        return;
      }
      if (typeof options.onExtensionUiRequest === 'function') {
        try {
          const response = await options.onExtensionUiRequest(event, options.signal);
          send({ type: 'extension_ui_response', id: event.id, ...(response || { cancelled: true }) });
        } catch {
          send({ type: 'extension_ui_response', id: event.id, cancelled: true });
        }
      } else {
        send({ type: 'extension_ui_response', id: event.id, cancelled: true });
      }
      return;
    }

    if (event.type === 'message_update') {
      if (!dialogs.size) options.onHumanInteractionProgress?.();
      const deltaEvent = event.assistantMessageEvent;
      if (deltaEvent?.type === 'text_start') {
        streamingDraft = streamingDraft || '';
      } else if (deltaEvent?.type === 'text_delta' && typeof deltaEvent.delta === 'string') {
        streamingDraft += deltaEvent.delta;
        publishText();
      }
      return;
    }

    if (event.type === 'message_end') {
      const msg = event.message;
      if (msg?.role === 'assistant') {
        const msgText = extractTextBlocks(msg.content);
        streamingDraft = '';
        if (msgText) {
          completedMessages.push(msgText);
          publishText();
        }
        if (msg.usage) {
          const u = msg.usage;
          const inp = Number(u.input || 0);
          const outp = Number(u.output || 0);
          const cr = Number(u.cacheRead || 0);
          const cw = Number(u.cacheWrite || 0);
          const tot = u.totalTokens ?? (inp + outp + cr + cw);

          turnUsage.prompt_tokens += inp;
          turnUsage.completion_tokens += outp;
          turnUsage.cache_read_tokens += cr;
          turnUsage.cache_write_tokens += cw;
          turnUsage.total_tokens += tot;
          hasTurnUsage = true;

          if (typeof u.cost?.total === 'number') {
            costKnown = true;
            turnCost += u.cost.total;
            estimatedCost = turnCost;
          }
          usage = { ...turnUsage };
          options.onUsage?.(usage);
        }
        if (msg.stopReason === 'error') {
          assistantError = msg.errorMessage || 'Assistant message terminated with stopReason=error';
        } else if (msg.stopReason === 'aborted') {
          assistantAborted = true;
        }
      }
      return;
    }

    if (
      event.type === 'tool_execution_start' ||
      event.type === 'tool_execution_update' ||
      event.type === 'tool_execution_end'
    ) {
      if (event.toolName === 'bash' && event.type === 'tool_execution_start' && typeof options.onApproval === 'function') {
        const allowed = await Promise.resolve(
          options.onApproval(
            {
              tool: 'bash',
              command: event.args?.command || '',
              path: event.args?.path || null,
            },
            options.signal
          )
        );
        if (!allowed) {
          denied = true;
          stopChild(child);
          return fatal(fail('原生客户端命令执行未获批准，已拒绝并中止。', 'COMMAND_DECLINED', 403));
        }
      }
      const phase =
        event.type === 'tool_execution_start'
          ? 'start'
          : event.type === 'tool_execution_update'
            ? 'update'
            : 'end';
      const output =
        phase === 'update'
          ? extractTextBlocks(event.partialResult?.content)
          : phase === 'end'
            ? extractTextBlocks(event.result?.content)
            : undefined;
      const toolPath = event.args?.path || event.args?.file_path;
      options.onTool?.({
        phase,
        toolCallId: event.toolCallId,
        tool: event.toolName,
        args: event.args || {},
        ...(toolPath ? { path: toolPath } : {}),
        ...(output !== undefined ? { output } : {}),
        isError: Boolean(event.isError),
        structuredContent: event.result?.details,
      });
      if (
        phase === 'end' &&
        !event.isError &&
        ['edit', 'write'].includes(event.toolName) &&
        typeof toolPath === 'string' &&
        toolPath.trim()
      ) {
        const resolved = path.resolve(options.projectDir, toolPath);
        const rel = path.relative(options.projectDir, resolved);
        options.onMutation?.({
          path: rel && !rel.startsWith('..') ? rel.replace(/\\/g, '/') : toolPath,
          tool: event.toolName,
          patch: String(event.result?.details?.diff || output || ''),
        });
      }
      return;
    }

    if (event.type === 'agent_end') {
      if (dialogs.size) return fatal(fail('Pi 在等待用户回答时提前报告结束。', 'INTERACTION_PENDING'));
      if (Array.isArray(event.messages)) {
        for (const msg of event.messages) {
          if (msg?.role === 'assistant') {
            if (msg.stopReason === 'error' && !assistantError) {
              assistantError = msg.errorMessage || 'Assistant message terminated with stopReason=error';
            }
            if (msg.stopReason === 'aborted') {
              assistantAborted = true;
            }
            const msgText = extractTextBlocks(msg.content);
            if (msgText && completedMessages.length === 0) {
              completedMessages.push(msgText);
              publishText();
            }
          }
        }
      }
      if (assistantAborted) {
        return fatal(fail('Task cancelled.', 'ABORT_ERR'));
      }
      if (assistantError) {
        return fatal(
          fail(
            `Pi turn failed (${assistantError}). 请在本地 Pi 配置中检查模型、凭据与配额状态。`,
            'RUNTIME_TURN_FAILED'
          )
        );
      }
      options.onHumanInteractionProgress?.();
      agentEnded = true;
      resolveTurn();
    }
  };

  const detachReader = attachJsonlLineReader(
    child.stdout,
    line => {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return fatal(fail('Invalid Pi RPC JSONL output.'));
      }
      Promise.resolve(handleEvent(parsed)).catch(fatal);
    },
    {
      onError: err => fatal(err),
    }
  );

  try {
    const state = await request({ type: 'get_state' });
    if (
      !state ||
      !state.model ||
      (state.model.id === 'unknown' && state.model.provider === 'unknown')
    ) {
      throw fail(
        '本机 Pi 未解析到当前生效模型（可能缺少对应供应商凭据或模型未定义），请检查 ~/.pi/agent/settings.json 与凭据配置。',
        'RUNTIME_MODEL_UNAVAILABLE'
      );
    }

    if (parsedModel) {
      const actualProvider = String(state.model.provider || '').toLowerCase();
      const actualId = String(state.model.id || '').toLowerCase();
      if (parsedModel.provider && actualProvider !== parsedModel.provider.toLowerCase()) {
        throw fail(
          `请求的客户端供应商 "${parsedModel.provider}" 与实际解析结果 "${state.model.provider}" 不一致，拒绝自动切换。`,
          'RUNTIME_MODEL_UNAVAILABLE'
        );
      }
      if (parsedModel.modelId && actualId !== parsedModel.modelId.toLowerCase()) {
        throw fail(
          `请求的客户端模型 "${parsedModel.modelId}" 不可用（客户端返回 "${state.model.id}"），拒绝自动切换。`,
          'RUNTIME_MODEL_UNAVAILABLE'
        );
      }
    }

    contextWindow = state.model.contextWindow || null;

    if (binding && sessionBindings) {
      sessionBindings.recordSessionHandshake(binding.id, {
        runId,
        nativeSessionId: state.sessionId || null,
        nativeSessionFile: state.sessionFile || sessionFileArg || null,
        effectiveModel: state.model.id || null,
        effectiveProvider: state.model.provider || null,
      });
    }

    if (terminalError || options.signal?.aborted) {
      throw terminalError || fail('Task cancelled.', 'ABORT_ERR');
    }

    if (writable && options.agentPolicy?.permissions?.executeCommands) {
      await options.beforeCommand?.();
      checkpointStarted = true;
    }

    const promptMessage =
      resumedExistingSession || !Array.isArray(options.history) || options.history.length === 0
        ? options.prompt
        : [...options.history.map(m => `${m.role}: ${m.content}`), options.prompt].filter(Boolean).join('\n\n');

    let initialStats = null;
    try {
      initialStats = await request({ type: 'get_session_stats' }, 3000);
    } catch (_) {}


    await request({ type: 'prompt', message: promptMessage });
    promptAccepted = true;

    // Wait for true `agent_end` event; `prompt` response only means accepted/queued.
    await completion;

    try {
      const stats = await request({ type: 'get_session_stats' }, 5000);
      if (stats?.contextUsage?.contextWindow) {
        contextWindow = stats.contextUsage.contextWindow;
      }
      if (stats?.tokens) {
        const hasValidInitialBaseline = Boolean(initialStats?.tokens);
        if (hasValidInitialBaseline) {
          const deltaInput = Math.max(0, Number(stats.tokens.input || 0) - Number(initialStats.tokens.input || 0));
          const deltaOutput = Math.max(0, Number(stats.tokens.output || 0) - Number(initialStats.tokens.output || 0));
          const deltaCacheRead = Math.max(0, Number(stats.tokens.cacheRead || 0) - Number(initialStats.tokens.cacheRead || 0));
          const deltaCacheWrite = Math.max(0, Number(stats.tokens.cacheWrite || 0) - Number(initialStats.tokens.cacheWrite || 0));
          const deltaTotal = Math.max(0, Number(stats.tokens.total || 0) - Number(initialStats.tokens.total || 0));

          if (!hasTurnUsage) {
            usage = {
              prompt_tokens: deltaInput,
              completion_tokens: deltaOutput,
              cache_read_tokens: deltaCacheRead,
              cache_write_tokens: deltaCacheWrite,
              total_tokens: deltaTotal,
            };
            options.onUsage?.(usage);
          }
          if (!costKnown && typeof stats.cost === 'number' && typeof initialStats.cost === 'number') {
            costKnown = true;
            estimatedCost = Math.max(0, stats.cost - initialStats.cost);
          }
        } else if (!hasTurnUsage) {
          // 初始统计不可用且消息流未提供 usage 时，用量和费用必须严格保留为未知；
          // 绝对不能将全会话累计累计值（如 1000 Token / $2）冒充为本次增量！
          usage = null;
          costKnown = false;
          estimatedCost = null;
        }
      }
    } catch {
      // Optional stats enrichment; keep turn usage from message_end if stats fails.
    }

    if (!text.trim()) {
      throw fail('Pi completed without an assistant response.');
    }

    const effectiveModelLabel = state.model.provider
      ? `${state.model.provider}/${state.model.id}`
      : state.model.id;

    return {
      content: text,
      usage,
      model: effectiveModelLabel,
      effectiveModel: state.model,
      thinkingLevel: state.thinkingLevel || null,
      context_window: contextWindow,
      sdk: 'pi-native-rpc',
      usageScope: 'native-turn',
      costKnown,
      estimatedCost,
      denied,
      promptAccepted,
      nativeSessionId: state.sessionId || null,
      nativeSessionFile: state.sessionFile || sessionFileArg || null,
      toolPolicy: {
        allowedTools,
        questionBridgeEnabled: Boolean(options.onHumanInteraction),
        extensionsEnabled: Boolean(options.allowExtensions && mode === 'agent'),
      },
    };
  } finally {
    options.signal?.removeEventListener('abort', abort);
    detachReader();
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(fail('Pi transport closed.'));
    }
    pending.clear();
    await stopChild(child);
    await closed;
    if (binding && sessionBindings) {
      try {
        sessionBindings.releaseWriteLock(binding.id, { runId, nextState: 'idle' });
      } catch {}
    }
    if (checkpointStarted) await options.afterCommand?.();
  }
}

module.exports = {
  parseNativeModelSpec,
  buildAllowedPiTools,
  runNativePi,
};
