/**
 * Conversation → Markdown export.
 *
 * Multi-agent threads are where the actual technical decisions get made, but
 * they only live in the local SQLite store. This turns one thread into a single
 * self-contained .md file that can be dropped into Obsidian / Notion, or
 * committed next to the code it describes.
 *
 * Pure string work plus one download helper — no React, so it is testable and
 * reusable from anywhere in the app.
 */

import type { WorkspaceMessage } from './types';

/**
 * Message types that are UI scaffolding rather than conversation: the
 * "thinking..." / "idle" pulses and intermediate tool-call chatter. They are
 * noise in an archive and would swamp the actual discussion.
 */
const NOISE_MESSAGE_TYPES = new Set(['status', 'thinking', 'loading']);

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Local `YYYY-MM-DD HH:mm`. Deliberately not `toLocaleString()`: an archive
 * wants one fixed shape that sorts and diffs predictably, not something that
 * changes with the reader's locale.
 */
function formatTimestamp(value: string | Date | null): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface ConversationExportMeta {
  /** Thread title; falls back to the channel name when empty. */
  title: string;
  channelName: string;
  workspaceName?: string | null;
  participants?: string[];
  exportedAt?: Date;
}

/**
 * Render a thread as Markdown.
 *
 * Each turn becomes an `##` heading so the document gets a usable outline in
 * Obsidian's sidebar. Message bodies are emitted verbatim — they are already
 * Markdown, and rewriting them (escaping, re-indenting) would corrupt the code
 * blocks and diffs that are usually the whole point of keeping the thread.
 */
export function messagesToMarkdown(
  messages: WorkspaceMessage[],
  meta: ConversationExportMeta,
): string {
  const out: string[] = [];

  out.push(`# ${meta.title?.trim() || meta.channelName}`);
  out.push('');

  const front: string[] = [];
  if (meta.workspaceName) front.push(`**Workspace**: ${meta.workspaceName}`);
  front.push(`**Channel**: ${meta.channelName}`);
  if (meta.participants && meta.participants.length > 0) {
    front.push(`**Participants**: ${meta.participants.join(', ')}`);
  }
  front.push(`**Exported**: ${formatTimestamp(meta.exportedAt || new Date())} · 52hzAgents`);
  out.push(front.map((line) => `> ${line}`).join('\n'));
  out.push('');
  out.push('---');
  out.push('');

  let written = 0;
  for (const m of messages) {
    if (NOISE_MESSAGE_TYPES.has(m.messageType)) continue;
    const content = (m.content || '').trim();
    if (!content) continue;

    const who = m.senderName || (m.senderType === 'human' ? 'user' : 'agent');
    const when = formatTimestamp(m.createdAt);
    out.push(when ? `## ${who} · ${when}` : `## ${who}`);
    out.push('');
    out.push(content);
    out.push('');
    written++;
  }

  if (written === 0) {
    out.push('_No messages in this conversation._');
    out.push('');
  }

  return out.join('\n');
}

/**
 * `<thread-title>-YYYYMMDD.md`, stripped of characters Windows rejects in a
 * filename. Windows is the primary desktop target, and its rules are the
 * stricter set, so a name that survives here survives everywhere.
 */
export function conversationFilename(title: string, when: Date = new Date()): string {
  const safe = (title || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .trim();
  const stamp = `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}`;
  return `${safe || 'conversation'}-${stamp}.md`;
}

/**
 * Hand a generated file to the browser's download flow.
 *
 * No BOM: Obsidian and Notion both read plain UTF-8, and a BOM surfaces as a
 * stray glyph in grep / diff / anything reading the file as text.
 */
export function downloadTextFile(
  filename: string,
  text: string,
  mime = 'text/markdown;charset=utf-8',
): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking synchronously can cancel the download in some Chromium builds
  // before it has finished reading the blob.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
