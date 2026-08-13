/**
 * Custom adapter — the generic escape hatch for agents wwj has no built-in
 * adapter for (kilo, an in-house CLI, a shell script, anything).
 *
 * The user supplies a command; this runs it once per incoming workspace message
 * and posts stdout back to the channel. Two calling conventions, picked by
 * whether the argument template mentions the prompt:
 *
 *   args contains {prompt}  → substituted, command invoked with it as an arg
 *   args does not           → prompt is written to the process's stdin
 *
 * Placeholders available in every arg: {prompt} {agent} {channel} {cwd}
 *
 * Before this existed, `custom` was wired to OpenClawAdapter — so "connect a
 * custom agent" silently launched OpenClaw regardless of what the user meant.
 * A custom agent with no command configured now fails preflight with a clear
 * reason instead of running something the user never asked for.
 */

'use strict';

const { execSync, spawn } = require('child_process');

const BaseAdapter = require('./base');
const { whichBinary, whereBinary } = require('../paths');

const IS_WINDOWS = process.platform === 'win32';

/** Cap on captured output — a runaway CLI must not blow up the daemon's heap. */
const MAX_OUTPUT_BYTES = 512 * 1024;

class CustomAdapter extends BaseAdapter {
  /**
   * @param {object} opts - BaseAdapter opts plus:
   * @param {string}   [opts.customCommand] - executable to run per message
   * @param {string[]} [opts.customArgs]    - argument template (see placeholders)
   * @param {number}   [opts.customTimeoutMs]
   */
  constructor(opts) {
    super(opts);
    this.customCommand = (opts.customCommand || '').trim();
    this.customArgs = Array.isArray(opts.customArgs) ? opts.customArgs : [];
    this.customTimeoutMs = Number.isInteger(opts.customTimeoutMs) ? opts.customTimeoutMs : 10 * 60 * 1000;
    this._channelProcesses = {};
    this._resolvedBinary = this.customCommand ? this._resolveBinary(this.customCommand) : null;

    if (this.customCommand) {
      this._log(`Custom runtime: ${this._resolvedBinary || this.customCommand} ${this.customArgs.join(' ')}`.trim());
    } else {
      this._log('Warning: no command configured for this custom agent — it cannot run.');
    }
  }

  /**
   * Resolve the command to an absolute path so we can spawn WITHOUT a shell.
   * Going through cmd.exe would re-parse every argument, and a user message
   * substituted into {prompt} routinely contains spaces and quotes — the shell
   * would split it into garbage. An absolute path also picks up .cmd/.bat shims
   * that a running daemon's stale PATH would otherwise miss.
   * Returns null when the command can't be found; spawn then reports ENOENT
   * against the raw name, which is the clearest possible error.
   */
  _resolveBinary(command) {
    // An explicit path (contains a separator) is used as given.
    if (/[\\/]/.test(command)) return command;
    try {
      return whereBinary(command) || whichBinary(command) || null;
    } catch {
      return null;
    }
  }

  /**
   * Refuse to join the workspace when nothing is configured to run. Joining
   * anyway would put an agent online that answers every message with an error.
   */
  preflight() {
    if (!this.customCommand) {
      return {
        ok: false,
        reason: 'runtime_missing',
        message:
          'No command configured for this custom agent. Set one with ' +
          '`wwj create <name> --type custom --command "<executable>"`, or from the workspace UI.',
      };
    }
    return { ok: true };
  }

  /** Does the arg template ask for the prompt, or should it go over stdin? */
  _promptIsArgument() {
    return this.customArgs.some((a) => String(a).includes('{prompt}'));
  }

  _buildArgs(prompt, channelName, cwd) {
    return this.customArgs.map((arg) =>
      String(arg)
        .replace(/\{prompt\}/g, prompt)
        .replace(/\{agent\}/g, this.agentName)
        .replace(/\{channel\}/g, channelName)
        .replace(/\{cwd\}/g, cwd || ''),
    );
  }

  async _runCommand(prompt, channelName, cwd) {
    const viaArg = this._promptIsArgument();
    const args = this._buildArgs(prompt, channelName, cwd);
    this._log(`Running custom command (channel=${channelName}, prompt via ${viaArg ? 'argv' : 'stdin'})`);

    // No shell: args reach the process verbatim, so a prompt containing spaces,
    // quotes or newlines survives intact.
    const proc = spawn(this._resolvedBinary || this.customCommand, args, {
      cwd: cwd || undefined,
      env: { ...(this.agentEnv || process.env) },
      stdio: [viaArg ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this._channelProcesses[channelName] = proc;

    if (!viaArg && proc.stdin) {
      proc.stdin.end(prompt, 'utf-8');
    }

    let stdout = '';
    let stderr = '';
    let truncated = false;
    const collect = (chunk, target) => {
      const text = chunk.toString('utf-8');
      if (target === 'out') {
        if (stdout.length < MAX_OUTPUT_BYTES) stdout += text;
        else truncated = true;
      } else if (stderr.length < MAX_OUTPUT_BYTES) {
        stderr += text;
      }
    };
    proc.stdout.on('data', (d) => collect(d, 'out'));
    proc.stderr.on('data', (d) => collect(d, 'err'));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this._stopProcess(proc);
    }, this.customTimeoutMs);

    const exitCode = await new Promise((resolve) => {
      proc.on('exit', resolve);
      proc.on('error', (e) => {
        stderr += `\n${e.message}`;
        resolve(-1);
      });
    });
    clearTimeout(timer);
    delete this._channelProcesses[channelName];

    if (timedOut) {
      throw new Error(`command timed out after ${Math.round(this.customTimeoutMs / 1000)}s`);
    }
    if (exitCode !== 0) {
      const detail = (stderr || stdout).trim().slice(0, 600);
      throw new Error(`'${this.customCommand}' exited with code ${exitCode}${detail ? `: ${detail}` : ''}`);
    }

    const text = stdout.trim();
    return truncated ? `${text}\n\n[output truncated]` : text;
  }

  async _stopProcess(proc) {
    if (!proc || proc.exitCode !== null) return;
    try {
      if (IS_WINDOWS) {
        try { execSync(`taskkill /F /T /PID ${proc.pid}`, { timeout: 5000, windowsHide: true }); } catch {}
      } else {
        proc.kill('SIGTERM');
        await new Promise((resolve) => {
          const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} resolve(); }, 5000);
          proc.on('exit', () => { clearTimeout(t); resolve(); });
        });
      }
    } catch {}
  }

  async _onControlAction(action, _payload) {
    if (action === 'stop') {
      for (const [channel, proc] of Object.entries(this._channelProcesses)) {
        await this._stopProcess(proc);
        delete this._channelProcesses[channel];
        try { await this.sendStatus(channel, 'Execution stopped by user'); } catch {}
      }
    }
  }

  async _handleMessage(msg) {
    const content = (msg.content || '').trim();
    if (!content) return;

    const msgChannel = msg.sessionId || this.channelName;
    const sender = msg.senderName || msg.senderType || 'user';
    this._log(`Processing workspace message from ${sender} in ${msgChannel}`);

    await this._autoTitleChannel(msgChannel, content);
    await this.sendStatus(msgChannel, 'thinking...');

    try {
      let cwd = this.workingDir;
      if (typeof this._resolveWorkingDir === 'function') {
        try { cwd = (await this._resolveWorkingDir(msgChannel)) || cwd; } catch {}
      }
      const responseText = await this._runCommand(content, msgChannel, cwd);
      if (responseText) {
        await this.sendResponse(msgChannel, responseText);
      } else {
        await this.sendResponse(msgChannel, 'The command produced no output.');
      }
    } catch (e) {
      this._log(`Custom adapter error: ${e.message}`);
      await this.sendError(msgChannel, `Error processing message: ${e.message}`);
    }
  }
}

module.exports = CustomAdapter;
