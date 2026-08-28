/**
 * Shared utilities for adapter implementations.
 *
 * Direct port of Python: sdk/src/52hzAgents/adapters/utils.py
 */

'use strict';

/**
 * Placeholder channel titles that auto-titling is allowed to overwrite.
 *
 * Deliberately narrow. `general` is NOT listed: it is a standing channel for
 * the whole workspace rather than a session, and renaming it after whatever
 * someone happened to ask first would lose a name people navigate by. A
 * channel the user named themselves is off-limits for the same reason �?the
 * caller additionally checks `titleManuallySet`, and the two guards are
 * independent on purpose so neither one alone has to be airtight.
 */
const SESSION_DEFAULT_RE =
  /^(?:Session \d+|session-[0-9a-f]+|channel-[0-9a-f]+|New [Cc]hat|Untitled|新会话|新对话|未命�?$/;

/**
 * Scripts with no inter-word spacing. Their presence switches the generator
 * from counting words to measuring display width: `split(/\s+/)` sees a whole
 * Chinese sentence as a single word, so the word budget never triggers and the
 * only thing left holding the title back is the character cap �?which is how a
 * "short title" ended up being 50 characters of running prose.
 */
const CJK_CHAR_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

/**
 * Characters that occupy two columns. Used for the length budget so a CJK and
 * a Latin title come out visually the same length in the session list, instead
 * of the CJK one running twice as wide for the same character count.
 */
const WIDE_CHAR_RE =
  /[\u1100-\u115f\u2e80-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/;

/**
 * Leading @mentions and /mentions. The first message in a channel almost always
 * addresses an agent, and "@claude 帮我看下这个报错" should title as the request,
 * not as the agent's name.
 */
const LEADING_MENTION_RE = /^(?:[@/][^\s@/]+[\s,，�?：]*)+/;

/**
 * Openers that carry no information about the task. Applied repeatedly because
 * people stack them �?"请帮我看看�? is three of these in a row.
 *
 * Each pattern swallows its own trailing punctuation so "你好，帮我查天气"
 * doesn't leave a dangling comma behind.
 */
const FILLER_PREFIX_RES = [
  /^(?:hey|hi|hello|yo|ok|okay|thanks|thx|please|pls)\b[\s,:!�?]*/i,
  /^(?:can|could|would|will)\s+you\s+(?:please\s+)?/i,
  /^(?:i\s+(?:need|want|would\s+like)\s+you\s+to|i\s+(?:need|want)\s+to|let'?s|help\s+me)\s+/i,
  /^(?:你好|您好|哈喽|�?[\s,，�?�?！]*/,
  /^(?:请问|请帮我|请帮忙|请你帮我|请你|�?[\s,，�?：]*/,
  /^(?:帮我|帮忙|麻烦你|麻烦)[\s,，�?：]*/,
  /^(?:我想要|我想|我要|我需要|我打算|我希�?[\s,，�?：]*/,
  /^(?:能不能|可不可以|能否|可以帮我|可以帮忙|你能不能|你能|你可以|可以)[\s,，�?：]*/,
  /^(?:给我|来个|来一个|搞一个|搞个)[\s,，�?：]*/,
  /^(?:写一个|写个|做一个|做个|生成一个|生成个|创建一个|创建个|实现一个|实现个|加一个|加个)[\s,，�?：]*/,
  /^(?:看看|看一下|看下|查一下|查查|查下|搜一下|搜搜|搜下|试一下|试试)[\s,，�?：]*/,
];

/** Trailing punctuation that reads as noise once the title is cut short. */
const TRAILING_PUNCT_RE = /[\s。，、；：！�?,;:!?~�?]+$/;

function displayWidth(text) {
  let width = 0;
  for (const ch of text) width += WIDE_CHAR_RE.test(ch) ? 2 : 1;
  return width;
}

function truncateToWidth(text, maxWidth) {
  let width = 0;
  let out = '';
  for (const ch of text) {
    const w = WIDE_CHAR_RE.test(ch) ? 2 : 1;
    if (width + w > maxWidth) return { text: out, truncated: true };
    out += ch;
    width += w;
  }
  return { text, truncated: false };
}

/**
 * Cut at the first sentence terminator.
 *
 * One lazy pattern covers both scripts so the earliest terminator wins in mixed
 * text. The ASCII set requires whitespace or end-of-string after it, which
 * keeps "Bump to 3.5" and "v1.2.0" intact; the CJK set does not, because a
 * Chinese sentence runs straight into the next one with no space.
 */
function firstSentence(text) {
  const m = text.match(/^([\s\S]*?)(?:[。！？；]|[.!?;](?=\s|$))/);
  const head = m && m[1].trim();
  return head ? head : text;
}

/** Apply a prefix strip only if it leaves something behind. */
function stripIfNonEmpty(text, re) {
  const next = text.replace(re, '').trim();
  return next ? next : text;
}

/**
 * Generate a short session title from the first user message.
 *
 * @param {string} message
 * @param {number} [maxWords=6]  word budget, Latin text only
 * @param {number} [maxWidth=32] display-column budget, both scripts (16 CJK chars / 32 Latin)
 */
function generateSessionTitle(message, maxWords = 6, maxWidth = 32) {
  if (typeof message !== 'string' || !message) return '';

  // Code goes before whitespace collapsing. The old order collapsed newlines
  // first, so an unterminated fence �?routine while a message is still
  // streaming �?no longer looked like a fence at all and its contents leaked
  // into the title.
  let text = message
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/```[\s\S]*$/, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';

  text = stripIfNonEmpty(text, LEADING_MENTION_RE);
  text = firstSentence(text);

  // Loop to a fixed point: each pass can expose another opener underneath.
  for (let pass = 0; pass < FILLER_PREFIX_RES.length; pass++) {
    const before = text;
    for (const re of FILLER_PREFIX_RES) text = stripIfNonEmpty(text, re);
    if (text === before) break;
  }

  const hasCjk = CJK_CHAR_RE.test(text);

  // The word budget only means anything where words are delimited.
  if (!hasCjk) {
    const words = text.split(' ');
    if (words.length > maxWords) text = words.slice(0, maxWords).join(' ');
  }

  // One column is reserved for the ellipsis.
  const budget = maxWidth - 1;
  let truncated = false;

  if (displayWidth(text) > maxWidth) {
    truncated = true;
    if (!hasCjk) {
      // Latin drops whole words. The word budget above can still leave a
      // string wider than the column budget when the words are long, and a
      // width cut there lands inside a word ("...the intermitten�?), which
      // reads as corruption rather than as an abbreviation.
      const words = text.split(' ');
      while (words.length > 1 && displayWidth(words.join(' ')) > budget) words.pop();
      text = words.join(' ');
      // A single word longer than the whole budget has no boundary to use.
      if (displayWidth(text) > budget) text = truncateToWidth(text, budget).text;
    } else {
      text = truncateToWidth(text, budget).text;

      // Prefer a clause boundary. "成都未来7天的天气怎么样，然�? is a worse title
      // than "成都未来7天的天气怎么�? despite carrying two more characters �?      // the dangling fragment reads as breakage. Skipped when the boundary
      // sits so early that taking it would gut the title.
      const boundary = Math.max(
        text.lastIndexOf('�?), text.lastIndexOf('�?), text.lastIndexOf('�?),
        text.lastIndexOf(','), text.lastIndexOf(';')
      );
      if (boundary > 0) {
        const head = text.slice(0, boundary);
        if (displayWidth(head) >= budget * 0.45) text = head;
      }
    }
  }

  text = text.replace(TRAILING_PUNCT_RE, '');
  if (!text) return '';

  // Latin-only titles read better sentence-cased. `toUpperCase` on a Han
  // character is a no-op, so this is skipped rather than harmlessly wasted �?  // it would otherwise also uppercase a mixed title's Latin lead-in against
  // the surrounding Chinese.
  if (!hasCjk) text = text[0].toUpperCase() + text.slice(1);

  return truncated ? text + '�? : text;
}

/**
 * Format attachment metadata into text to append to an agent prompt.
 * @param {Array} attachments
 * @param {'mcp'|'skills'} [toolMode='mcp']
 * @param {boolean} [isWindows]
 */
function formatAttachmentsForPrompt(attachments, toolMode = 'mcp', isWindows = process.platform === 'win32') {
  if (!attachments || attachments.length === 0) return null;

  const lines = ['\n[Attached files]'];
  for (const att of attachments) {
    const filename = att.filename || 'unknown';
    const fileId = att.fileId || '';
    const contentType = att.contentType || '';
    if (toolMode === 'skills') {
      const url = att.url || `{WORKSPACE_API}/v1/files/${fileId}`;
      const curl = isWindows ? 'curl.exe' : 'curl';
      const tmpDir = isWindows ? '$env:TEMP' : '/tmp';
      if (contentType.startsWith('image/')) {
        lines.push(
          `- Image: ${filename} (file_id: ${fileId}) �?` +
          `download with curl, then use your Read tool on the local file to view it:\n` +
          `  Step 1: ${curl} -s -H "X-Workspace-Token: $TOKEN" "${url}" -o ${tmpDir}/${filename}\n` +
          `  Step 2: Use the Read tool on ${tmpDir}/${filename} to see the image`
        );
      } else {
        lines.push(
          `- File: ${filename} (file_id: ${fileId}, type: ${contentType}) �?` +
          `download with curl, then use your Read tool on the local file:\n` +
          `  Step 1: ${curl} -s -H "X-Workspace-Token: $TOKEN" "${url}" -o ${tmpDir}/${filename}\n` +
          `  Step 2: Use the Read tool on ${tmpDir}/${filename} to read the file`
        );
      }
    } else {
      if (contentType.startsWith('image/')) {
        lines.push(
          `- Image: ${filename} (file_id: ${fileId}) �?` +
          'use workspace_read_file to view this image'
        );
      } else {
        lines.push(
          `- File: ${filename} (file_id: ${fileId}, type: ${contentType}) �?` +
          'use workspace_read_file to read this file'
        );
      }
    }
  }
  return lines.join('\n');
}

/**
 * Strip a leading "@self" call-prefix from a message before it becomes the
 * agent's prompt. Channels are multi-agent, so users address an agent with
 * "@antigravity do X": the mention is routing metadata the UI needs, not part
 * of the question being asked.
 *
 * This is hygiene, not a fix for a known failure �?models answer correctly with
 * the prefix left in, and the other adapters still pass it through. What it
 * buys: the agent's own name stops accumulating in reused conversation history,
 * and a bare "@agent" with no request no longer turns into a meaningless
 * `-p @agent` run.
 *
 * Only LEADING self-mentions are removed: a mention further in ("ask @claude
 * about X", or the agent's own name used as a noun) is meaningful content and
 * is left alone. Mentions of OTHER agents are never touched.
 *
 * @param {string} content
 * @param {string} agentName
 * @returns {string}
 */
function stripSelfMention(content, agentName) {
  if (!content || !agentName) return content || '';
  const self = String(agentName).toLowerCase();
  // Longest first so "@name-agent" is consumed before "@name".
  const aliases = [self + '-agent', self];
  let out = String(content).trimStart();

  // Peel repeated leading self-mentions or slash commands. Built as a scan rather than a regex
  // assembled from agentName, which would need escaping and is easy to get
  // subtly wrong for names containing regex metacharacters.
  for (;;) {
    if (out[0] !== '@' && out[0] !== '/') break;
    const rest = out.slice(1);
    const lower = rest.toLowerCase();
    const alias = aliases.find((a) => lower.startsWith(a));
    if (!alias) break;
    const after = rest.slice(alias.length);
    // Require a boundary so "@antigravity2" or "/antigravity2" is left untouched.
    if (/^[a-z0-9_-]/i.test(after)) break;
    out = after.replace(/^[,�?：\s]+/, '');
  }

  return out.trim();
}

/**
 * Names in the run of @mentions or /slash-mentions at the START of a message �?the agents actually
 * being addressed. Mentions further in are content, not addressing:
 * "@a 确定日期 然后交给@b 写文�? addresses only `a`, and tells it to delegate.
 *
 * Needed because the composer collects every @name anywhere in the text into
 * `mentions`, so a message like the above used to be picked up by BOTH agents,
 * each doing the whole job independently instead of a handoff.
 *
 * Returns lowercase names, in order. Empty when the message does not open with
 * a mention (callers then fall back to "mentioned anywhere" matching).
 *
 * @param {string} content
 * @returns {string[]}
 */
function leadingMentions(content) {
  const names = [];
  let rest = String(content || '').trimStart();
  for (;;) {
    // If it is a knowledge mention like @knowledge:slug, it is not an agent mention!
    if (/^@knowledge:[a-zA-Z0-9_-]+/i.test(rest)) {
      break;
    }
    const match = rest.match(/^[@/]([a-zA-Z0-9_-]+)/);
    if (!match) break;
    const name = match[1].toLowerCase();
    if (name === 'knowledge') break;
    names.push(name);
    rest = rest.slice(match[0].length).replace(/^[,，�?：\s]+/, '');
  }
  return names;
}

/**
 * Print a stream event exactly as the CLI emitted it, before any field picking.
 *
 * OFF UNLESS `WWJ_RAW_EVENTS` IS SET. These adapters are long-lived daemons
 * handling one event per token in some modes, so unconditional logging would
 * both bury the real log and write whatever the agent happened to be reading �? * file contents, command output �?into it.
 *
 * Exists because several adapters were written against an event shape nobody
 * recorded, so the branches that never fired could not be told apart from the
 * branches that fire on a field that does not exist. Capturing the raw event is
 * the only way to settle which.
 *
 * Usage: `WWJ_RAW_EVENTS=1` in the agent's environment, then run a task that
 * exercises the missing path and read the lines tagged `[raw-agent-event]`.
 */
function logRawEvent(tag, event) {
  if (!process.env.WWJ_RAW_EVENTS) return;
  try {
    // eslint-disable-next-line no-console
    console.log(`[raw-agent-event] ${tag} ${JSON.stringify(event)}`);
  } catch {
    // A circular or un-serialisable event must not take the stream down.
    // eslint-disable-next-line no-console
    console.log(`[raw-agent-event] ${tag} <unserialisable>`);
  }
}

module.exports = {
  SESSION_DEFAULT_RE,
  generateSessionTitle,
  formatAttachmentsForPrompt,
  stripSelfMention,
  leadingMentions,
  logRawEvent,
};
