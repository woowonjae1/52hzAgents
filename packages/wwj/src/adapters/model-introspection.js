/**
 * Shared CLI introspection helpers.
 *
 * Every adapter answers "what models can this install reach?" and "what
 * reasoning-effort levels does it accept?" by asking the CLI itself — never
 * from a table in this repo, which would drift the moment a vendor ships a new
 * model. The two shapes that keep recurring live here:
 *
 *   - `captureCli()`       : run a short metadata command and capture stdout
 *   - `parseHelpChoices()` : pull an option's allowed values out of `--help`,
 *     which is where most CLIs state them authoritatively and for free
 *
 * Nothing here invents a value. A failed probe returns empty, and callers must
 * report that as "unknown / not configured" rather than substituting a guess.
 */

'use strict';

const { spawn } = require('child_process');

const IS_WINDOWS = process.platform === 'win32';

/**
 * Run `<binary> <args>` and resolve its stdout. Never rejects: a missing
 * binary, a crash, or a timeout all resolve to whatever was captured (usually
 * ''), because "could not ask" and "asked and got nothing" are the same answer
 * to the caller — unknown.
 *
 * `includeStderr` matters more than it looks: Go-style CLIs (Antigravity's
 * `agy`, among others) print their usage to stderr, so a help probe that reads
 * stdout alone comes back empty and silently reports "no levels".
 *
 * @param {string} binary
 * @param {string[]} args
 * @param {{ env?: object, timeoutMs?: number, includeStderr?: boolean }} [opts]
 * @returns {Promise<string>}
 */
function captureCli(binary, args, opts = {}) {
  const { env, timeoutMs = 30000, includeStderr = false } = opts;
  return new Promise((resolve) => {
    const isBatch = IS_WINDOWS && /\.(cmd|bat)$/i.test(binary);
    const cmd = isBatch ? (process.env.COMSPEC || 'cmd.exe') : binary;
    const argv = isBatch ? ['/c', binary, ...args] : args;
    let proc;
    try {
      proc = spawn(cmd, argv, {
        windowsHide: true,
        env: env || process.env,
        stdio: ['ignore', 'pipe', includeStderr ? 'pipe' : 'ignore'],
      });
    } catch {
      resolve('');
      return;
    }
    let out = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve(out); }, timeoutMs);
    proc.stdout.on('data', (d) => { out += d.toString('utf-8'); });
    if (includeStderr && proc.stderr) {
      proc.stderr.on('data', (d) => { out += d.toString('utf-8'); });
    }
    proc.on('error', () => { clearTimeout(timer); resolve(''); });
    // A non-zero exit still carries usable stdout for metadata commands.
    proc.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

/**
 * Pull an option's allowed values out of a CLI's own `--help`.
 *
 * Handles the two conventions in the wild, both of which may wrap across lines
 * (hence the flatten):
 *
 *   --effort <level>    Effort level ... (low, medium, high, xhigh, max)
 *   --effort            Reasoning effort ... (low|medium|high)
 *   --thinking <level>  Set reasoning effort: none|low|medium|high|xhigh.
 *
 * The scan stops at the next option so a flag that states no values cannot
 * borrow the following one's list.
 *
 * @param {string} helpText  raw `--help` output
 * @param {string} flag      e.g. '--effort'
 * @returns {string[]}       [] when the option is absent or states no values
 */
function parseHelpChoices(helpText, flag) {
  if (!helpText || !flag) return [];
  const flat = helpText.replace(/\s+/g, ' ');
  const at = flat.indexOf(flag + ' ');
  if (at < 0) return [];

  let segment = flat.slice(at + flag.length);
  // Cut at the next option so we only read this flag's own description.
  const nextOpt = segment.search(/\s--[a-zA-Z]/);
  if (nextOpt > 0) segment = segment.slice(0, nextOpt);

  // Preferred form: a parenthesised list.
  const paren = segment.match(/\(([^)]*)\)/);
  const candidates = [];
  if (paren) candidates.push(paren[1]);
  // Fallback form: a bare pipe-separated run, e.g. "none|low|medium|high".
  const piped = segment.match(/([A-Za-z0-9_-]+(?:\|[A-Za-z0-9_-]+)+)/);
  if (piped) candidates.push(piped[1]);

  for (const candidate of candidates) {
    const values = candidate
      .split(/[,|]/)
      .map((v) => v.trim())
      .filter(Boolean);
    // Guard against matching a parenthetical sentence rather than a value list:
    // real level names are single short words.
    if (values.length >= 2 && values.every((v) => /^[A-Za-z0-9_-]{1,24}$/.test(v))) {
      return values;
    }
  }
  return [];
}

/**
 * Parse a `<id><TAB><label>` listing — the shape `agy models` prints. Lines
 * without a tab (banners like "Fetching available models...") are skipped by
 * that alone, so no banner blocklist is needed.
 *
 * @param {string} text
 * @returns {Array<[string, string]>} id/label pairs
 */
function parseTabbedList(text) {
  const pairs = [];
  for (const line of (text || '').split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    pairs.push([line.slice(0, tab), line.slice(tab + 1)]);
  }
  return pairs;
}

/**
 * Return only the indented block under `heading`, up to the next unindented
 * line. Used to keep a listing scoped to its own section — e.g. `amp plugin
 * show-agent-options` prints "Models" and then "Built-in tools", and a parser
 * let loose on the whole output would happily read tools as models the day a
 * tool line grows a parenthetical.
 *
 * @param {string} text
 * @param {string} heading  exact heading line content, e.g. 'Models'
 * @returns {string} '' when the heading is absent
 */
function sliceSection(text, heading) {
  const lines = (text || '').split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start < 0) return '';
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    // An unindented line starts the next section.
    if (!/^\s/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

/**
 * Parse an indented `  <id> (<Label>)` listing — the shape
 * `amp plugin show-agent-options` prints under its "Models" heading.
 *
 * @param {string} text
 * @returns {Array<[string, string]>} id/label pairs
 */
function parseParenLabelledList(text) {
  const pairs = [];
  for (const line of (text || '').split(/\r?\n/)) {
    const m = line.match(/^\s+(\S+)\s+\(([^)]*)\)\s*$/);
    if (!m) continue;
    pairs.push([m[1], m[2]]);
  }
  return pairs;
}

/** Shape an id/label pair list the way the workspace UI consumes it. */
function toOptions(pairs, provider) {
  const seen = new Set();
  const out = [];
  for (const [id, label] of pairs) {
    const trimmed = (id || '').trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push({ id: trimmed, provider, label: (label || '').trim() || trimmed });
  }
  return out;
}

module.exports = {
  captureCli,
  parseHelpChoices,
  parseTabbedList,
  sliceSection,
  parseParenLabelledList,
  toOptions,
};
