/**
 * Shared utilities for adapter implementations.
 *
 * Direct port of Python: sdk/src/openagents/adapters/utils.py
 */

'use strict';

const SESSION_DEFAULT_RE = /^(Session \d+|session-[0-9a-f]+|channel-[0-9a-f]+)$/;

/**
 * Generate a short session title from the first user message.
 */
function generateSessionTitle(message, maxWords = 6) {
  // Collapse whitespace, strip code blocks
  let text = message.replace(/\s+/g, ' ').trim();
  text = text.replace(/```[\s\S]*?```/g, '').trim();
  text = text.replace(/`[^`]+`/g, '').trim();

  if (!text) return '';

  // Try to get first sentence
  const sentenceMatch = text.match(/^(.+?[.!?])\s/);
  if (sentenceMatch) {
    text = sentenceMatch[1].replace(/[.!?]+$/, '').trim();
  }

  // Take first maxWords words
  const words = text.split(/\s+/);
  if (words.length > maxWords) {
    text = words.slice(0, maxWords).join(' ');
  }

  // Strip common filler prefixes
  text = text.replace(
    /^(hey|hi|hello|please|can you|could you|i need you to|i want you to)\s+/i,
    ''
  ).trim();

  // Capitalize first letter
  if (text) {
    text = text[0].toUpperCase() + text.slice(1);
  }

  // Hard cap at 50 characters
  if (text.length > 50) {
    text = text.slice(0, 47) + '...';
  }

  return text;
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
          `- Image: ${filename} (file_id: ${fileId}) — ` +
          `download with curl, then use your Read tool on the local file to view it:\n` +
          `  Step 1: ${curl} -s -H "X-Workspace-Token: $TOKEN" "${url}" -o ${tmpDir}/${filename}\n` +
          `  Step 2: Use the Read tool on ${tmpDir}/${filename} to see the image`
        );
      } else {
        lines.push(
          `- File: ${filename} (file_id: ${fileId}, type: ${contentType}) — ` +
          `download with curl, then use your Read tool on the local file:\n` +
          `  Step 1: ${curl} -s -H "X-Workspace-Token: $TOKEN" "${url}" -o ${tmpDir}/${filename}\n` +
          `  Step 2: Use the Read tool on ${tmpDir}/${filename} to read the file`
        );
      }
    } else {
      if (contentType.startsWith('image/')) {
        lines.push(
          `- Image: ${filename} (file_id: ${fileId}) — ` +
          'use workspace_read_file to view this image'
        );
      } else {
        lines.push(
          `- File: ${filename} (file_id: ${fileId}, type: ${contentType}) — ` +
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
 * This is hygiene, not a fix for a known failure — models answer correctly with
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
    out = after.replace(/^[,，:：\s]+/, '');
  }

  return out.trim();
}

/**
 * Names in the run of @mentions or /slash-mentions at the START of a message — the agents actually
 * being addressed. Mentions further in are content, not addressing:
 * "@a 确定日期 然后交给@b 写文档" addresses only `a`, and tells it to delegate.
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
    const match = rest.match(/^[@/]([a-zA-Z0-9_-]+)/);
    if (!match) break;
    names.push(match[1].toLowerCase());
    rest = rest.slice(match[0].length).replace(/^[,，、:：\s]+/, '');
  }
  return names;
}

module.exports = {
  SESSION_DEFAULT_RE,
  generateSessionTitle,
  formatAttachmentsForPrompt,
  stripSelfMention,
  leadingMentions,
};
