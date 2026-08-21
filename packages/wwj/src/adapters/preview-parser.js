/**
 * Preview-block parser: turns an explicit protocol block in an agent's reply
 * into the `metadata.preview` payload the workspace uses to point its Local
 * Preview panel at a dev server.
 *
 * WHY THE AGENT HAS TO TELL US
 *
 * The obvious design is for the daemon to watch a dev server's stdout for
 * "ready on http://localhost:3000". It cannot: wwj spawns the agent CLI, not
 * the dev server. The server is started by the agent's own shell tool, inside
 * the CLI process, and the only thing wwj sees is the CLI's event stream.
 *
 * The other tempting shortcut is to regex `localhost:(\d+)` out of the reply
 * text. That misfires on every sentence that merely mentions a port — "the old
 * config pointed at localhost:8080" would hijack the panel — and it cannot tell
 * a server that is running now from one described in passing.
 *
 * So, as with `decision-parser.js`, the agent opts in explicitly:
 *
 *     ```preview
 *     { "url": "http://localhost:3000", "label": "Next.js dev" }
 *     ```
 *
 * `{ "port": 3000 }` is accepted as shorthand.
 *
 * Kept as its own file rather than folded into decision-parser: the fence
 * mechanics are similar but the payload, the validation rules and the lifecycle
 * are not, and one module doing both would be shared for the sake of a regex.
 */

'use strict';

/**
 * Fenced blocks tagged `preview` / `oa-preview` / `oa:preview`. The closing
 * fence is required — a half-streamed block parses to nothing useful, and
 * consuming it would delete the agent's words.
 */
const PREVIEW_FENCE_RE = /^[ \t]*```(?:oa[-:])?preview[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*$/gim;

/**
 * Loopback only, matching `LocalPreview`'s address bar and — the copy that
 * actually enforces it — `will-attach-webview` in workspace/desktop/main.js.
 * The panel previews a server on the user's own machine; letting an agent
 * point it at an arbitrary origin would turn a reply into a way to render
 * third-party pages inside the app.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0']);

function isLoopbackUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return LOOPBACK_HOSTS.has(u.hostname) || u.hostname.endsWith('.localhost');
  } catch {
    return false;
  }
}

function asText(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Coerce a raw payload into `{ url, label? }`, or null if it is not usable.
 *
 * Port and url are both accepted because agents reach for whichever is at hand.
 * A port is only ever loopback by construction, so it needs range checking but
 * not host checking.
 */
function normalizePreview(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  let url = asText(raw.url);

  if (!url) {
    // Accept a number or an all-digit string, and nothing else. The type check
    // is not redundant with the range check below: `Number(true)` is 1, which
    // is in range, so a boolean would otherwise yield `http://localhost:1`.
    const rawPort = raw.port;
    const isNumeric =
      typeof rawPort === 'number' ||
      (typeof rawPort === 'string' && /^\d+$/.test(rawPort.trim()));
    if (!isNumeric) return null;

    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    url = `http://localhost:${port}`;
  }

  if (!isLoopbackUrl(url)) return null;

  const preview = { url };
  const label = asText(raw.label) || asText(raw.name) || asText(raw.title);
  if (label) preview.label = label;
  return preview;
}

/**
 * Pull a preview block out of an agent reply.
 *
 * @param {string} content
 * @returns {{ text: string, preview: {url: string, label?: string}|null, invalid: number }}
 *   `text` is the reply with valid blocks removed. A block that fails to parse
 *   or validate is LEFT IN, so a rejected address is visible to the user rather
 *   than silently discarded. `invalid` counts them for logging.
 *
 * When several blocks are present the LAST valid one wins: an agent that
 * restarts a server on a new port in one turn means the newest address is the
 * live one.
 */
function extractPreview(content) {
  if (typeof content !== 'string' || content.indexOf('```') === -1) {
    return { text: typeof content === 'string' ? content : '', preview: null, invalid: 0 };
  }

  let preview = null;
  let invalid = 0;

  const text = content.replace(PREVIEW_FENCE_RE, (match, body) => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      invalid++;
      return match;
    }
    const next = normalizePreview(parsed);
    if (!next) {
      invalid++;
      return match;
    }
    preview = next;
    return '';
  });

  if (!preview) return { text: content, preview: null, invalid };

  return {
    text: text.replace(/\n{3,}/g, '\n\n').trim(),
    preview,
    invalid,
  };
}

module.exports = {
  extractPreview,
  // exported for tests
  normalizePreview,
  isLoopbackUrl,
};
