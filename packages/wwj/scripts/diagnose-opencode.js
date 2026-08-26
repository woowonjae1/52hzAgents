#!/usr/bin/env node
/**
 * Phase-0 diagnostic for the OpenCode / Kilo headless `run` stall.
 *
 * The OpenCodeAdapter drives `<cli> run --format json`. On opencode 1.18.23 and
 * kilocode 7.4.23 that call produces ZERO bytes and stalls at the CLI's `init`
 * step — before it ever reaches `stream` — while the same model and credentials
 * work fine in the TUI. This script decides *why*, by producing the evidence the
 * judgment matrix needs instead of just "did JSON come out".
 *
 * Every probe records: exit code, signal, stdout/stderr byte counts, elapsed ms,
 * the ports the process tree was listening on, and the process tree itself.
 * stderr is always kept, never discarded.
 *
 * Probes per flavor:
 *   T0  version      — `<cli> --version`
 *   T1  headless     — `<cli> run --format json --model M <prompt>`   (the adapter's path)
 *   T2  serve        — `<cli> serve --port <p>` → can it bind? does it answer HTTP?
 *   T3  attach       — `<cli> run --attach <url> --format json --model M <prompt>`
 *
 * Judgment matrix (printed at the end):
 *   T2 binds + T3 streams          → CLI moved to server mode  → adapter needs serve+attach
 *   T1 works on 1.17.11, not 1.18  → version regression        → pin back, hard-fail above max
 *   T1/T2 both fail                → local environment         → root-cause + preflight
 *   T2 binds but T3 fails          → deeper than server init   → auth/cwd/stdio/config/MCP
 *
 * Usage:
 *   node scripts/diagnose-opencode.js
 *   node scripts/diagnose-opencode.js --flavor kilocode --model mimo/mimo-v2.5-pro
 *   node scripts/diagnose-opencode.js --timeout 90000 --out ./diag
 *
 * Exits 0 when it produced a complete record (even if every probe failed) —
 * a non-zero exit means the diagnostic itself broke.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const IS_WINDOWS = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Flavors. Deliberately duplicated here rather than imported from the adapter:
// this script must be able to observe a flavor the adapter cannot yet resolve.
// ---------------------------------------------------------------------------

const FLAVORS = {
  opencode: {
    id: 'opencode',
    displayName: 'OpenCode',
    binaryCandidates: ['opencode'],
    packageName: 'opencode-ai',
    configDir: path.join(os.homedir(), '.config', 'opencode'),
    stateDir: path.join(os.homedir(), '.local', 'share', 'opencode'),
    // A model known to have worked in this install's TUI.
    defaultModel: 'opencode/mimo-v2.5-free',
  },
  kilocode: {
    id: 'kilocode',
    displayName: 'Kilo Code',
    binaryCandidates: ['kilocode', 'kilo'],
    packageName: '@kilocode/cli',
    configDir: path.join(os.homedir(), '.config', 'kilo'),
    stateDir: path.join(os.homedir(), '.local', 'share', 'kilo'),
    defaultModel: 'mimo/mimo-v2.5-pro',
  },
};

const PROMPT = 'Reply with exactly: PONG';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { flavor: 'both', timeout: 60000, serveTimeout: 20000, out: null, model: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--flavor') out.flavor = next();
    else if (a === '--timeout') out.timeout = Number(next());
    else if (a === '--serve-timeout') out.serveTimeout = Number(next());
    else if (a === '--out') out.out = next();
    else if (a === '--model') {
      // --model X applies to every flavor; --model kilocode=X targets one.
      const v = next();
      const eq = v.indexOf('=');
      if (eq > 0) out.model[v.slice(0, eq)] = v.slice(eq + 1);
      else out.model['*'] = v;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Binary discovery
// ---------------------------------------------------------------------------

function whichBinary(name) {
  try {
    const cmd = IS_WINDOWS ? 'where' : 'which';
    const out = execFileSync(cmd, [name], { encoding: 'utf-8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] });
    const hits = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!IS_WINDOWS) return hits[0] || null;
    // `where` lists the extensionless npm shim (a shell script usable only from
    // bash) alongside the real `.cmd`. CreateProcess cannot run the former, so
    // taking hits[0] blindly yields ENOENT. Prefer something Windows can spawn.
    const runnable = hits.find((h) => /\.(exe|cmd|bat)$/i.test(h));
    return runnable || hits[0] || null;
  } catch {
    return null;
  }
}

function resolveBinary(flavor) {
  const home = os.homedir();
  const ext = IS_WINDOWS ? '.cmd' : '';
  for (const name of flavor.binaryCandidates) {
    const candidates = [
      path.join(home, '.wwj', 'runtimes', name, 'node_modules', `${name}-ai`, 'bin', `${name}.exe`),
      path.join(home, '.wwj', 'runtimes', name, 'node_modules', '.bin', `${name}${ext}`),
      path.join(home, '.wwj', 'nodejs', 'node_modules', '.bin', `${name}${ext}`),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return { path: c, name, via: 'wwj-runtime' };

    const viaWhich = whichBinary(name);
    if (viaWhich) return { path: viaWhich, name, via: IS_WINDOWS ? 'where' : 'which' };

    const more = IS_WINDOWS
      ? [path.join(process.env.APPDATA || '', 'npm', `${name}.cmd`)]
      : [`/usr/local/bin/${name}`, path.join(home, '.local', 'bin', name)];
    for (const c of more) if (fs.existsSync(c)) return { path: c, name, via: 'well-known-path' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Environment observation: listening ports + process tree
// ---------------------------------------------------------------------------

/** Every LISTENING socket with its owning pid. */
function listeningSockets() {
  try {
    if (IS_WINDOWS) {
      const out = execFileSync('netstat', ['-ano'], { encoding: 'utf-8', timeout: 10000 });
      return out
        .split(/\r?\n/)
        .filter((l) => /LISTENING/.test(l))
        .map((l) => l.trim().split(/\s+/))
        .filter((p) => p.length >= 5)
        .map((p) => ({ local: p[1], pid: Number(p[4]) }));
    }
    const out = execFileSync('sh', ['-c', 'ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null'], {
      encoding: 'utf-8',
      timeout: 10000,
    });
    return out
      .split(/\r?\n/)
      .slice(1)
      .map((l) => {
        const local = (l.match(/\s(\S+:\d+)\s/) || [])[1];
        const pid = Number((l.match(/pid=(\d+)/) || [])[1] || 0);
        return local ? { local, pid } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** All processes, as {pid, ppid, name, cmd} — used to walk a child's subtree. */
function processTable() {
  try {
    if (IS_WINDOWS) {
      const ps =
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress -Depth 3';
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        encoding: 'utf-8',
        timeout: 25000,
        maxBuffer: 32 * 1024 * 1024,
      });
      const rows = JSON.parse(out);
      return (Array.isArray(rows) ? rows : [rows]).map((r) => ({
        pid: r.ProcessId,
        ppid: r.ParentProcessId,
        name: r.Name,
        cmd: r.CommandLine || '',
      }));
    }
    const out = execFileSync('ps', ['-eo', 'pid,ppid,comm,args'], { encoding: 'utf-8', timeout: 15000 });
    return out
      .split(/\r?\n/)
      .slice(1)
      .map((l) => {
        const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
        return m ? { pid: Number(m[1]), ppid: Number(m[2]), name: m[3], cmd: m[4] } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** The subtree rooted at `rootPid`, plus whatever each member is listening on. */
function subtreeSnapshot(rootPid) {
  const table = processTable();
  const sockets = listeningSockets();
  const byParent = new Map();
  for (const p of table) {
    if (!byParent.has(p.ppid)) byParent.set(p.ppid, []);
    byParent.get(p.ppid).push(p);
  }
  const members = [];
  const walk = (pid, depth) => {
    if (depth > 6) return;
    const self = table.find((p) => p.pid === pid);
    if (self) {
      members.push({
        depth,
        pid: self.pid,
        name: self.name,
        cmd: String(self.cmd).slice(0, 300),
        listening: sockets.filter((s) => s.pid === self.pid).map((s) => s.local),
      });
    }
    for (const child of byParent.get(pid) || []) walk(child.pid, depth + 1);
  };
  walk(rootPid, 0);
  return { members, listeningInTree: members.flatMap((m) => m.listening) };
}

// ---------------------------------------------------------------------------
// Probe runner
// ---------------------------------------------------------------------------

/**
 * Spawn a command with a hard timeout, capturing everything. Never rejects.
 *
 * `snapshotAtMs` takes a process-tree snapshot partway through, which is the
 * only way to see what a *stalled* process is doing — by the time it exits the
 * evidence is gone.
 */
function runProbe(label, binPath, args, { timeout, cwd, snapshotAtMs = null, onStdout = null }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const isBatch = IS_WINDOWS && /\.(cmd|bat)$/i.test(binPath);
    const spawnCmd = isBatch ? process.env.COMSPEC || 'cmd.exe' : binPath;
    const spawnArgs = isBatch ? ['/c', binPath, ...args] : args;

    let proc;
    try {
      proc = spawn(spawnCmd, spawnArgs, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: process.env,
      });
    } catch (e) {
      resolve({
        label,
        command: `${binPath} ${args.join(' ')}`,
        spawnError: e.message,
        elapsedMs: Date.now() - started,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let firstByteMs = null;
    let snapshot = null;
    let timedOut = false;

    const noteFirstByte = () => {
      if (firstByteMs === null) firstByteMs = Date.now() - started;
    };

    proc.stdout.on('data', (d) => {
      noteFirstByte();
      stdout += d.toString('utf-8');
      if (onStdout) onStdout(stdout);
    });
    proc.stderr.on('data', (d) => {
      noteFirstByte();
      stderr += d.toString('utf-8');
    });

    const snapTimer = snapshotAtMs
      ? setTimeout(() => {
          try {
            snapshot = subtreeSnapshot(proc.pid);
          } catch {}
        }, snapshotAtMs)
      : null;

    const killTimer = setTimeout(() => {
      timedOut = true;
      // Take the snapshot before killing if we haven't yet — a stalled tree is
      // the whole point of this probe.
      if (!snapshot) {
        try {
          snapshot = subtreeSnapshot(proc.pid);
        } catch {}
      }
      killTree(proc.pid);
    }, timeout);

    proc.on('error', (e) => {
      stderr += `\n[spawn error] ${e.message}`;
    });

    proc.on('close', (code, signal) => {
      clearTimeout(killTimer);
      if (snapTimer) clearTimeout(snapTimer);
      resolve({
        label,
        command: `${binPath} ${args.join(' ')}`,
        cwd: cwd || process.cwd(),
        exitCode: code,
        signal: signal || null,
        timedOut,
        elapsedMs: Date.now() - started,
        firstByteMs,
        stdoutBytes: Buffer.byteLength(stdout, 'utf-8'),
        stderrBytes: Buffer.byteLength(stderr, 'utf-8'),
        stdout,
        stderr,
        snapshot,
      });
    });
  });
}

function killTree(pid) {
  try {
    if (IS_WINDOWS) {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { timeout: 10000, stdio: 'ignore' });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * A stall that produced no bytes at all is NOT an ordinary agent timeout — the
 * CLI never got as far as talking to a model. The adapter must be able to tell
 * these apart, so name it explicitly here.
 */
function classify(probe) {
  if (!probe) return 'not_run';
  if (probe.spawnError) return 'spawn_failed';
  if (probe.timedOut && probe.stdoutBytes === 0 && probe.stderrBytes === 0) return 'headless_init_timeout';
  if (probe.timedOut && probe.stdoutBytes === 0) return 'headless_init_timeout';
  if (probe.timedOut) return 'timeout_after_partial_output';
  if (probe.exitCode !== 0 && probe.stdoutBytes === 0) return 'failed_no_output';
  if (probe.stdoutBytes === 0) return 'empty_response';
  return 'produced_output';
}

/** Did stdout carry parseable stream-json events? */
function inspectJsonStream(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const events = [];
  let unparseable = 0;
  for (const l of lines) {
    try {
      events.push(JSON.parse(l));
    } catch {
      unparseable++;
    }
  }
  const types = [...new Set(events.map((e) => e.type || e.event || Object.keys(e)[0]).filter(Boolean))];
  return { lineCount: lines.length, eventCount: events.length, unparseable, eventTypes: types.slice(0, 25) };
}

function extractServerUrl(text) {
  const m = String(text || '').match(/https?:\/\/[\w.-]+:\d+/);
  return m ? m[0] : null;
}

async function httpProbe(url, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return { ok: true, status: res.status };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Per-flavor diagnosis
// ---------------------------------------------------------------------------

async function diagnoseFlavor(flavor, opts, workDir) {
  const record = {
    flavor: flavor.id,
    displayName: flavor.displayName,
    configDir: flavor.configDir,
    configDirExists: fs.existsSync(flavor.configDir),
    stateDirExists: fs.existsSync(flavor.stateDir),
    authFile: path.join(flavor.stateDir, 'auth.json'),
    authFileExists: fs.existsSync(path.join(flavor.stateDir, 'auth.json')),
    binary: null,
    probes: {},
    verdicts: {},
  };

  const bin = resolveBinary(flavor);
  if (!bin) {
    record.binary = null;
    record.verdicts.overall = 'cli_not_found';
    return record;
  }
  record.binary = bin;

  const model = opts.model[flavor.id] || opts.model['*'] || flavor.defaultModel;
  record.model = model;

  // ---- T0: version -------------------------------------------------------
  log(`  T0 version  …`);
  const t0 = await runProbe('version', bin.path, ['--version'], { timeout: 30000, cwd: workDir });
  record.probes.version = t0;
  record.cliVersion = (t0.stdout.match(/\d+\.\d+\.\d+[\w.-]*/) || [])[0] || null;
  record.verdicts.version = record.cliVersion || 'unparseable';
  log(`     → ${record.cliVersion || 'unparseable'} (exit=${t0.exitCode}, ${t0.elapsedMs}ms)`);

  // ---- T1: the adapter's actual path -------------------------------------
  log(`  T1 headless run --format json  … (up to ${opts.timeout}ms)`);
  const t1 = await runProbe(
    'headless_run',
    bin.path,
    ['run', '--format', 'json', '--model', model, PROMPT],
    { timeout: opts.timeout, cwd: workDir, snapshotAtMs: Math.min(15000, Math.floor(opts.timeout / 2)) }
  );
  record.probes.headless_run = t1;
  record.verdicts.headless_run = classify(t1);
  record.jsonStream = inspectJsonStream(t1.stdout);
  log(
    `     → ${record.verdicts.headless_run} (exit=${t1.exitCode}, signal=${t1.signal}, ` +
      `stdout=${t1.stdoutBytes}B, stderr=${t1.stderrBytes}B, firstByte=${t1.firstByteMs}ms, ${t1.elapsedMs}ms)`
  );
  if (t1.snapshot) {
    log(`     tree: ${t1.snapshot.members.length} proc(s), listening: ${JSON.stringify(t1.snapshot.listeningInTree)}`);
  }

  // ---- T2: can it bind a server? -----------------------------------------
  const port = 34100 + Math.floor((flavor.id === 'kilocode' ? 1 : 0) * 7);
  log(`  T2 serve --port ${port}  … (up to ${opts.serveTimeout}ms)`);
  let serveUrl = null;
  const serveProbe = await new Promise((resolve) => {
    const started = Date.now();
    const isBatch = IS_WINDOWS && /\.(cmd|bat)$/i.test(bin.path);
    const spawnCmd = isBatch ? process.env.COMSPEC || 'cmd.exe' : bin.path;
    const baseArgs = ['serve', '--port', String(port), '--hostname', '127.0.0.1'];
    const spawnArgs = isBatch ? ['/c', bin.path, ...baseArgs] : baseArgs;
    const proc = spawn(spawnCmd, spawnArgs, {
      cwd: workDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let spawnError = null;
    // Without this, an ENOENT here becomes an unhandled 'error' event and takes
    // the whole diagnostic down instead of being recorded as a finding.
    proc.on('error', (e) => {
      spawnError = e.message;
      stderr += `\n[spawn error] ${e.message}`;
    });
    proc.stdout.on('data', (d) => {
      stdout += d.toString('utf-8');
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString('utf-8');
    });

    const finish = async () => {
      const snapshot = (() => {
        try {
          return subtreeSnapshot(proc.pid);
        } catch {
          return null;
        }
      })();
      serveUrl = extractServerUrl(stdout) || extractServerUrl(stderr) || `http://127.0.0.1:${port}`;
      const health = await httpProbe(serveUrl);
      const boundInTree = (snapshot?.listeningInTree || []).some((l) => l.endsWith(`:${port}`));
      const boundAnywhere = listeningSockets().some((s) => s.local.endsWith(`:${port}`));
      resolve({
        pid: proc.pid,
        command: `${bin.path} ${baseArgs.join(' ')}`,
        spawnError,
        elapsedMs: Date.now() - started,
        stdout,
        stderr,
        stdoutBytes: Buffer.byteLength(stdout, 'utf-8'),
        stderrBytes: Buffer.byteLength(stderr, 'utf-8'),
        url: serveUrl,
        boundInTree,
        boundAnywhere,
        health,
        snapshot,
        _proc: proc,
      });
    };

    setTimeout(finish, opts.serveTimeout);
  });

  const serveKeep = serveProbe._proc;
  delete serveProbe._proc;
  record.probes.serve = serveProbe;
  record.verdicts.serve =
    serveProbe.health.ok ? 'bound_and_answering'
    : serveProbe.boundAnywhere ? 'bound_not_answering'
    : 'did_not_bind';
  log(
    `     → ${record.verdicts.serve} (port ${port} bound=${serveProbe.boundAnywhere}, ` +
      `http=${JSON.stringify(serveProbe.health)}, stdout=${serveProbe.stdoutBytes}B)`
  );

  // ---- T3: attach to that server -----------------------------------------
  if (record.verdicts.serve !== 'did_not_bind') {
    log(`  T3 run --attach ${serveProbe.url}  … (up to ${opts.timeout}ms)`);
    const t3 = await runProbe(
      'attach_run',
      bin.path,
      ['run', '--attach', serveProbe.url, '--format', 'json', '--model', model, PROMPT],
      { timeout: opts.timeout, cwd: workDir, snapshotAtMs: Math.min(15000, Math.floor(opts.timeout / 2)) }
    );
    record.probes.attach_run = t3;
    record.verdicts.attach_run = classify(t3);
    record.attachJsonStream = inspectJsonStream(t3.stdout);
    log(
      `     → ${record.verdicts.attach_run} (exit=${t3.exitCode}, stdout=${t3.stdoutBytes}B, ` +
        `events=${record.attachJsonStream.eventCount}, ${t3.elapsedMs}ms)`
    );
  } else {
    record.verdicts.attach_run = 'not_run';
    log(`  T3 skipped — server never bound`);
  }

  try {
    killTree(serveKeep.pid);
  } catch {}

  // ---- Matrix row --------------------------------------------------------
  record.verdicts.overall = decide(record);
  return record;
}

/** Map this flavor's probe results onto the judgment matrix. */
function decide(r) {
  const t1 = r.verdicts.headless_run;
  const serve = r.verdicts.serve;
  const t3 = r.verdicts.attach_run;

  if (t1 === 'produced_output') return 'headless_works';
  if (serve === 'bound_and_answering' && t3 === 'produced_output') return 'server_mode_required';
  if (serve === 'bound_and_answering' && t3 !== 'produced_output') return 'deeper_than_server_init';
  if (serve === 'did_not_bind' && t1 !== 'produced_output') return 'local_environment_fault';
  if (serve === 'bound_not_answering') return 'server_binds_but_unresponsive';
  return 'inconclusive';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const LOG_LINES = [];
function log(msg) {
  LOG_LINES.push(msg);
  process.stdout.write(msg + '\n');
}

const NEXT_STEP = {
  headless_works:
    'Headless run works here — the stall is NOT reproducible with these args. Diff this command against what the adapter builds.',
  server_mode_required:
    'The CLI now needs a server: adapter must move to a long-lived `serve` + `run --attach` model (ServerManager).',
  deeper_than_server_init:
    'Server binds and answers but attach still yields nothing — investigate auth loading, working directory, stdio/TTY, config and MCP init.',
  local_environment_fault:
    'Neither headless nor serve works — treat as a local environment fault (permissions, port binding, network). Root-cause, then add a preflight check.',
  server_binds_but_unresponsive:
    'Port is bound but HTTP does not answer — likely a bind-address or firewall issue rather than a CLI regression.',
  cli_not_found: 'CLI binary not found — install it before diagnosing.',
  inconclusive: 'Inconclusive — widen the timeout or capture CLI-internal logs (--print-logs --log-level DEBUG).',
};

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(fs.readFileSync(__filename, 'utf-8').split('*/')[0] + '\n');
    return;
  }

  const wanted =
    opts.flavor === 'both' ? Object.keys(FLAVORS) : opts.flavor.split(',').map((s) => s.trim()).filter(Boolean);
  for (const f of wanted) {
    if (!FLAVORS[f]) {
      process.stderr.write(`Unknown flavor '${f}'. Known: ${Object.keys(FLAVORS).join(', ')}\n`);
      process.exitCode = 2;
      return;
    }
  }

  const outDir = opts.out
    ? path.resolve(opts.out)
    : path.join(os.tmpdir(), `wwj-opencode-diag-${process.pid}`);
  fs.mkdirSync(outDir, { recursive: true });
  const workDir = path.join(outDir, 'workdir');
  fs.mkdirSync(workDir, { recursive: true });

  log('='.repeat(78));
  log('OpenCode / Kilo headless-run diagnostic (phase 0)');
  log('='.repeat(78));
  log(`platform   : ${process.platform} ${os.release()}`);
  log(`node       : ${process.version}`);
  log(`workdir    : ${workDir}`);
  log(`out        : ${outDir}`);
  log(`timeout    : ${opts.timeout}ms per run probe, ${opts.serveTimeout}ms for serve`);
  log('');

  const report = {
    schema: 'wwj.opencode-diagnostic/1',
    startedAt: new Date().toISOString(),
    platform: { os: process.platform, release: os.release(), node: process.version },
    options: { timeout: opts.timeout, serveTimeout: opts.serveTimeout, model: opts.model },
    workDir,
    flavors: [],
  };

  for (const id of wanted) {
    log(`── ${FLAVORS[id].displayName} (${id}) ${'─'.repeat(Math.max(0, 50 - id.length))}`);
    const rec = await diagnoseFlavor(FLAVORS[id], opts, workDir);
    report.flavors.push(rec);
    log(`  VERDICT: ${rec.verdicts.overall}`);
    log('');
  }

  report.finishedAt = new Date().toISOString();

  log('='.repeat(78));
  log('JUDGMENT MATRIX');
  log('='.repeat(78));
  for (const r of report.flavors) {
    log(`${r.displayName} (${r.cliVersion || 'version?'})`);
    log(`  binary        : ${r.binary ? `${r.binary.path} [${r.binary.via}]` : '(not found)'}`);
    log(`  auth.json     : ${r.authFileExists ? 'present' : 'absent'}  |  config: ${r.configDirExists ? 'present' : 'absent'}`);
    log(`  T1 headless   : ${r.verdicts.headless_run || 'not_run'}`);
    log(`  T2 serve      : ${r.verdicts.serve || 'not_run'}`);
    log(`  T3 attach     : ${r.verdicts.attach_run || 'not_run'}`);
    log(`  → ${r.verdicts.overall}`);
    log(`    ${NEXT_STEP[r.verdicts.overall] || ''}`);
    log('');
  }

  const jsonPath = path.join(outDir, 'diagnostic.json');
  const logPath = path.join(outDir, 'diagnostic.log');
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf-8');
  fs.writeFileSync(logPath, LOG_LINES.join('\n') + '\n', 'utf-8');
  log(`Full record : ${jsonPath}`);
  log(`This log    : ${logPath}`);
}

main().catch((e) => {
  process.stderr.write(`diagnostic itself failed: ${e && e.stack ? e.stack : e}\n`);
  process.exitCode = 1;
});
