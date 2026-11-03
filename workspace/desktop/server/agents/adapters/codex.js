'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { fail, locate, buildSanitizedNativeEnv, stopChild } = require('./common');
const { codexQuestion, writeNativeReply } = require('../native-questions');

const filePatch = item =>
  (item.changes || []).map(change => `File: ${change.path}\n${change.diff || ''}`).join('\n\n');

function safeFileChanges(item, root, grantRoot) {
  try {
    root = fs.realpathSync.native(root);
  } catch {
    return false;
  }
  const normalize = value => (process.platform === 'win32' ? value.toLowerCase() : value);
  const base = normalize(fs.realpathSync.native(root));
  const inside = value => normalize(value) === base || normalize(value).startsWith(base + path.sep);
  const safe = value => {
    if (typeof value !== 'string' || !value || value.includes('\0')) return false;
    const target = path.resolve(root, value);
    const relative = path.relative(root, target);
    if (
      !inside(target) ||
      !relative ||
      relative.split(path.sep).some(
        part =>
          part.toLowerCase() === '.git' ||
          (process.platform === 'win32' &&
            (/[.: ]$/.test(part) ||
              part.includes(':') ||
              /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
      )
    ) {
      return false;
    }
    let current = target;
    let stat;
    for (;;) {
      try {
        stat = fs.lstatSync(current);
        break;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
        const parent = path.dirname(current);
        if (parent === current) return false;
        current = parent;
      }
    }
    const actual = fs.realpathSync.native(current);
    return (
      inside(actual) &&
      !stat.isSymbolicLink() &&
      !path.relative(root, actual).split(path.sep).some(part => part.toLowerCase() === '.git')
    );
  };
  try {
    if (grantRoot && normalize(fs.realpathSync.native(grantRoot)) !== base) return false;
    return (
      item?.type === 'fileChange' &&
      item.changes?.length > 0 &&
      filePatch(item).length <= 120 * 1024 &&
      item.changes.every(
        change =>
          ['add', 'update', 'delete'].includes(change.kind?.type) &&
          safe(change.path) &&
          (!change.kind.move_path || safe(change.kind.move_path))
      )
    );
  } catch {
    return false;
  }
}

/**
 * One app-server per task: no global session reuse or second orchestration loop.
 */
async function runCodex(options, { launch = locate('codex', options?.env || process.env), spawnImpl = spawn } = {}) {
  if (!launch) throw fail('Codex client not found.');
  if (options.signal?.aborted) throw fail('Task cancelled.', 'ABORT_ERR');
  if (!options.projectDir || !fs.statSync(options.projectDir).isDirectory()) {
    throw fail('Choose an existing project directory.');
  }

  let binding = null;
  const sessionBindings = options.sessionBindings || null;
  const runId = options.runId || null;
  if (sessionBindings && options.channel && options.agentId && runId) {
    binding = sessionBindings.resolveOrCreate({
      channel: options.channel,
      contextKey: options.contextKey || null,
      agentId: options.agentId,
      connectionId: options.connection?.id || null,
      adapterKind: 'native-codex',
    });
    binding = sessionBindings.acquireWriteLock(binding.id, { runId });
  }

  const extraEnv = {};
  const configDir = options.connection?.configDir || options.connection?.configRoot;
  if (configDir) {
    extraEnv.CODEX_HOME = configDir;
  }
  const childEnv = buildSanitizedNativeEnv(options.env || process.env, launch, extraEnv);

  const child = spawnImpl(launch.command, [...launch.args, 'app-server', '--stdio'], {
    cwd: options.projectDir,
    env: childEnv,
    windowsHide: true,
    shell: false,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map();
  let sequence = 0;
  let text = '';
  let usage;
  let threadId;
  let turnId;
  let finished = false;
  let rejectTurn;
  let resolveTurn;
  const items = new Map();
  const dialogs = new Set();
  const seenDialogs = new Set();
  let pendingApprovals = 0;
  const messages = new Map();
  let terminalError;
  let finalText = '';
  let checkpointStarted = false;
  let denied = false;
  const closed = new Promise(resolve => child.once('close', resolve));
  const completion = new Promise((resolve, reject) => {
    resolveTurn = resolve;
    rejectTurn = reject;
  });
  completion.catch(() => {});

  const send = value => {
    if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(value) + '\n');
  };
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      if (terminalError || options.signal?.aborted) return reject(terminalError || fail('Task cancelled.', 'ABORT_ERR'));
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(fail(`Codex ${method} timed out.`));
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      send({ id, method, params });
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
    if (threadId && turnId) {
      send({ id: ++sequence, method: 'turn/interrupt', params: { threadId, turnId } });
    }
    fatal(fail('Task cancelled.', 'ABORT_ERR'));
    void stopChild(child);
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  child.on('error', () => fatal(fail('Unable to start Codex client.')));
  child.stdin.on('error', () => fatal(fail('Codex transport closed.')));
  child.stderr.on('data', () => {});
  child.once('close', code => {
    if (!finished) fatal(fail(`Codex exited before a completed turn (exit ${code}).`));
  });
  const reader = readline.createInterface({ input: child.stdout });
  const handle = async message => {
    if (message.id !== undefined && !message.method) {
      const entry = pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(message.id);
      if (message.error) entry.reject(fail(`Codex protocol request failed (${message.error.code}).`));
      else entry.resolve(message.result);
      return;
    }
    const p = message.params || {};
    if (message.id !== undefined) {
      if (message.method === 'item/tool/requestUserInput') {
        if (!options.onHumanInteraction || seenDialogs.has(String(message.id)) || p.threadId !== threadId || (turnId && p.turnId !== turnId)) {
          throw fail('Codex 提问无法关联到当前执行尝试。', 'INVALID_NATIVE_QUESTION');
        }
        seenDialogs.add(String(message.id));
        dialogs.add(String(message.id));
        try {
          const answer = await options.onHumanInteraction(codexQuestion(p, message.id));
          if (options.signal?.aborted) throw fail('Task cancelled.', 'ABORT_ERR');
          if (answer.cancelled) {
            await writeNativeReply(child.stdin, { id: message.id, error: { code: -32000, message: 'User cancelled input.' } });
            options.onHumanInteractionSent?.(answer.interactionId);
            abort();
          } else {
            const answers = Object.fromEntries(Object.entries(answer.answers).map(([id, values]) => [id, { answers: values }]));
            await writeNativeReply(child.stdin, { id: message.id, result: { answers } });
            options.onHumanInteractionSent?.(answer.interactionId);
          }
        } finally { dialogs.delete(String(message.id)); }
      } else if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) {
        pendingApprovals++;
        try {
        const tool = message.method.includes('commandExecution') ? 'bash' : 'write';
        const item = items.get(p.itemId);
        let allowed = false;
        if (tool === 'write' && options.config.mode === 'agent' && safeFileChanges(item, options.projectDir, p.grantRoot)) {
          options.onTool?.({ phase: 'update', toolCallId: p.itemId, tool, patch: filePatch(item), path: item.changes[0].path });
          allowed = Boolean(
            await options.onApproval?.(
              {
                toolCallId: p.itemId,
                tool,
                cwd: options.projectDir,
                command: item.changes.map(change => `${change.kind.type}: ${change.path}`).join('\n'),
              },
              options.signal
            )
          );
          allowed &&= !options.signal?.aborted && safeFileChanges(item, options.projectDir, p.grantRoot);
        }
        if (!allowed) {
          denied = true;
          options.onTool?.({
            phase: 'end',
            toolCallId: p.itemId,
            tool,
            args: { command: p.command || '' },
            output: '原生客户端操作未获授权或超出工作区，已拒绝。',
            isError: true,
          });
        }
        send({ id: message.id, result: { decision: allowed ? 'accept' : 'decline' } });
        } finally { pendingApprovals--; }
      } else if (message.method === 'item/permissions/requestApproval') {
        denied = true;
        send({ id: message.id, result: { permissions: {}, scope: 'turn' } });
      } else {
        send({ id: message.id, error: { code: -32601, message: 'Host does not grant this capability.' } });
      }
      return;
    }
    if (message.method === 'turn/started') turnId = p.turn?.id;
    if (message.method === 'item/agentMessage/delta') {
      if (!dialogs.size) options.onHumanInteractionProgress?.();
      messages.set(p.itemId, (messages.get(p.itemId) || '') + (p.delta || ''));
      text = [...messages.values()].join('\n\n');
      options.onDelta?.(text);
    }
    if (message.method === 'thread/tokenUsage/updated') {
      const u = p.tokenUsage?.total;
      if (u) {
        usage = {
          prompt_tokens: u.inputTokens,
          completion_tokens: u.outputTokens,
          cache_read_tokens: u.cachedInputTokens || 0,
          total_tokens: u.totalTokens,
        };
        options.onUsage?.(usage);
      }
    }
    if (['item/started', 'item/completed'].includes(message.method)) {
      const item = p.item || {};
      items.set(item.id, item);
      if (item.type === 'agentMessage' && message.method === 'item/completed') {
        messages.set(item.id, item.text || '');
        text = [...messages.values()].join('\n\n');
        options.onDelta?.(text);
        if (item.phase === 'final_answer') finalText = item.text || '';
      }
      if (['commandExecution', 'fileChange'].includes(item.type)) {
        options.onTool?.({
          phase: message.method === 'item/started' ? 'start' : 'end',
          toolCallId: item.id,
          tool: item.type === 'commandExecution' ? 'bash' : 'write',
          args: {
            command: item.command || '',
            changes: item.changes || [],
            path: item.changes?.map(change => change.path).join(', '),
          },
          ...(item.type === 'fileChange' ? { patch: filePatch(item), path: item.changes?.[0]?.path } : {}),
          output: item.aggregatedOutput,
          isError: ['failed', 'declined'].includes(item.status),
          structuredContent: item.exitCode === undefined ? undefined : { exit_code: item.exitCode },
        });
      }
    }
    if (message.method === 'turn/completed') {
      if (dialogs.size || pendingApprovals) return fatal(fail('Codex 在等待用户回答或授权时提前报告结束。', 'INTERACTION_PENDING'));
      if (p.turn?.status !== 'completed') {
        const info = p.turn?.error?.codexErrorInfo;
        const category =
          typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : 'unknown';
        const hint =
          String(p.turn?.error?.message || '')
            .match(
              /sandbox|service.tier|unauthorized|authentication|quota|unsupported|not.supported|model.not.found|401|403|429|502|503|connection|stream|websocket|encrypted|organization|reasoning/gi
            )
            ?.join(', ') || category;
        return fatal(
          fail(`Codex turn ${p.turn?.status || 'failed'} (${hint}). 请在本地客户端检查登录、配额与默认资源。`)
        );
      }
      options.onHumanInteractionProgress?.();
      finished = true;
      resolveTurn();
    }
  };
  reader.on('line', line => {
    if (line.length > 4 * 1024 * 1024) return fatal(fail('Codex protocol message exceeds limit.'));
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return fatal(fail('Invalid Codex protocol output.'));
    }
    Promise.resolve(handle(message)).catch(fatal);
  });
  try {
    await request('initialize', { clientInfo: { name: '52hz_desktop', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized' });
    const current = await request('config/read', { includeLayers: false });
    const config = {
      web_search: 'disabled',
      features: { multi_agent: false, multi_agent_v2: false, apps: false, plugins: false, hooks: false,
        default_mode_request_user_input: true },
      apps: { _default: { enabled: false } },
    };
    config.mcp_servers = Object.fromEntries(
      Object.entries(current?.config?.mcp_servers || {}).map(([name, value]) => [
        name,
        {
          enabled: false,
          ...(typeof value.command === 'string'
            ? { command: value.command }
            : typeof value.url === 'string'
              ? { url: value.url }
              : {}),
        },
      ])
    );
    config.plugins = Object.fromEntries(
      Object.keys(current?.config?.plugins || {}).map(name => [name, { enabled: false }])
    );
    const writable = options.config.mode === 'agent';
    const thread = await request('thread/start', {
      cwd: options.projectDir,
      ephemeral: true,
      ...(options.nativeModel ? { model: options.nativeModel } : {}),
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      sandbox: writable ? 'workspace-write' : 'read-only',
      developerInstructions: options.agentPolicy.instructions || '',
      config,
    });
    threadId = thread.thread.id;
    const expectedSandbox = writable ? 'workspaceWrite' : 'readOnly';
    if (
      thread.sandbox?.type !== expectedSandbox ||
      thread.approvalPolicy !== 'untrusted' ||
      thread.approvalsReviewer !== 'user'
    ) {
      throw fail('Codex did not accept the required permission policy.');
    }
    if (binding && sessionBindings) {
      sessionBindings.recordSessionHandshake(binding.id, {
        runId,
        nativeSessionId: null, // ephemeral thread per task in Codex app-server
        effectiveModel: thread.model || options.nativeModel || null,
      });
    }
    if (terminalError || options.signal?.aborted) throw terminalError || fail('Task cancelled.');
    if (writable) {
      await options.beforeCommand?.();
      checkpointStarted = true;
    }
    const history = (options.history || []).map(m => `${m.role}: ${m.content}`).join('\n\n');
    const turn = await request('turn/start', {
      threadId,
      cwd: options.projectDir,
      input: [{ type: 'text', text: [history, options.prompt].filter(Boolean).join('\n\n') }],
      approvalPolicy: 'untrusted',
      approvalsReviewer: 'user',
      sandboxPolicy: writable
        ? {
            type: 'workspaceWrite',
            writableRoots: [options.projectDir],
            networkAccess: false,
            excludeTmpdirEnvVar: true,
            excludeSlashTmp: true,
          }
        : { type: 'readOnly', networkAccess: false },
    });
    turnId = turn.turn.id;
    await completion;
    if (!text.trim()) throw fail('Codex completed without an assistant response.');
    return {
      content: finalText || text,
      usage,
      model: thread.model,
      sdk: 'codex-app-server',
      usageScope: 'native-turn',
      costKnown: false,
      denied,
      nativeThreadId: threadId,
    };
  } finally {
    options.signal?.removeEventListener('abort', abort);
    reader.close();
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(fail('Codex transport closed.'));
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
  safeFileChanges,
  runCodex,
};
