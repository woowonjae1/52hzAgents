import type { WorkspaceMessage, TurnFileChange } from '@/lib/types';
import { extractThinking } from '@/lib/message-text';

/*
  OUTPUTS: WHAT THE AGENTS IN A THREAD ACTUALLY PRODUCED.

  Everything here is derived from the thread's own messages, so there is no
  second store to keep in sync and nothing is lost on reload:

  - Documents: a reply that IS a deliverable -- an explicit <artifact> block,
    metadata from a tool, a standalone HTML/SVG page, or a code block tagged
    with a file name. Replies that only contain an example snippet are not
    deliverables; the old ">= 30 lines of code" rule made one of every long
    answer and is gone.
  - Versions: documents sharing an identity (the <artifact identifier>, or the
    file name of a named code block) are one document with several versions,
    oldest first. The revise loop in the Outputs panel asks the agent to answer
    with the same identifier, which is what makes its reply the next version.
  - Handoffs: a pipeline step's structured deliverable, which the backend
    attaches to the relay message that wakes the next agent.
  - Changed files: the turn-change summaries the backend attaches to the
    message that ended each turn; latest state per path.
*/

export type ArtifactKind = 'markdown' | 'code' | 'html' | 'svg' | 'deliverable';

export interface ArtifactItem {
  /** This version's id (unique per message). */
  id: string;
  /** Identity shared by every version of the same document. */
  key: string;
  title: string;
  type: ArtifactKind;
  language?: string;
  content: string;
  authorAgent?: string;
  filePath?: string;
  updatedAt: number;
  sourceMessageId?: string;
}

export interface ArtifactGroup {
  key: string;
  /** Oldest first; the last one is current. */
  versions: ArtifactItem[];
}

export interface ChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  turnId: string;
  agent: string;
  messageId: string;
  at: number;
}

export interface ThreadOutputs {
  documents: ArtifactGroup[];
  changedFiles: ChangedFile[];
}

function timeOf(message: WorkspaceMessage): number {
  const t = message.createdAt ? new Date(message.createdAt).getTime() : NaN;
  return Number.isFinite(t) ? t : 0;
}

function slug(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '-');
}

/** The deliverable a single agent reply carries, or null if it is just an answer. */
export function inferArtifact(message: WorkspaceMessage, answer?: string): ArtifactItem | null {
  if (message.senderType !== 'agent') return null;
  const text = answer ?? extractThinking(message.content).answer;
  if (!text) return null;
  const base = {
    authorAgent: message.senderName,
    sourceMessageId: message.messageId,
    updatedAt: timeOf(message) || Date.now(),
  };

  // 1. Explicit metadata from a tool or the backend.
  const meta = message.metadata?.artifact as Partial<ArtifactItem> & { id?: string } | undefined;
  if (meta && typeof meta === 'object' && meta.title && meta.content) {
    const type = (meta.type as ArtifactKind) || 'markdown';
    return {
      ...base,
      id: `art-${message.messageId}`,
      key: meta.key || meta.id || `title:${slug(meta.title)}`,
      title: meta.title,
      type,
      language: meta.language,
      content: meta.content,
      filePath: meta.filePath,
      authorAgent: meta.authorAgent || base.authorAgent,
    };
  }

  // 2. <artifact identifier="..." title="..." type="..."> ... </artifact>
  const tag = text.match(/<(?:artifact|antArtifact)\s+([^>]*?)>([\s\S]*?)<\/(?:artifact|antArtifact)>/i);
  if (tag) {
    const attrs = tag[1];
    const body = tag[2].trim();
    const attr = (name: string) => attrs.match(new RegExp(`${name}="([^"]+)"`, 'i'))?.[1];
    const title = attr('title') || `${message.senderName} deliverable`;
    const declared = (attr('type') || '').toLowerCase();
    const language = attr('language');
    const type: ArtifactKind =
      declared === 'html' || /^<!doctype html|^<html/i.test(body)
        ? 'html'
        : declared === 'svg' || /^<svg[\s>]/i.test(body)
        ? 'svg'
        : declared === 'code'
        ? 'code'
        : 'markdown';
    return {
      ...base,
      id: `art-${message.messageId}`,
      key: attr('identifier') || `title:${slug(title)}`,
      title,
      type,
      language,
      content: body,
    };
  }

  // 3. A standalone HTML page or SVG.
  const isHtml = /<!DOCTYPE html>/i.test(text) || (/<html[\s>]/i.test(text) && /<\/html>/i.test(text));
  const isSvg = /<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/i.test(text) && /<\/svg>/i.test(text);
  if (isHtml || isSvg) {
    const fenced = text.match(/```(?:html|svg|xml)?\n([\s\S]*?)```/i);
    const content = (fenced ? fenced[1] : text).trim();
    return {
      ...base,
      id: `art-${message.messageId}`,
      key: `art-${message.messageId}`,
      title: isSvg && !isHtml ? `${message.senderName} graphic` : `${message.senderName} page`,
      type: isSvg && !isHtml ? 'svg' : 'html',
      language: isSvg && !isHtml ? 'svg' : 'html',
      content,
    };
  }

  // 4. One code block tagged with a file name (```tsx:App.tsx / ```App.tsx) or
  //    opening with a "// file: path" header.
  const blocks = Array.from(text.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g));
  if (blocks.length === 1) {
    const fence = (blocks[0][1] || '').trim();
    const body = blocks[0][2].replace(/\n$/, '');
    const fenceFile = fence.includes(':') ? fence.split(':').slice(1).join(':') : fence;
    const isNamedFile = /[\w-]\.[a-zA-Z0-9]{1,6}$/.test(fenceFile);
    const header = body.match(/^(?:\/\/|#|--|\/\*)\s*(?:file(?:name)?|path):\s*([\w\-./\\]+)/im);
    if (isNamedFile || header) {
      const filePath = isNamedFile ? fenceFile : header![1].trim();
      const language = fence.includes(':')
        ? fence.split(':')[0]
        : filePath.split('.').pop() || 'text';
      return {
        ...base,
        id: `art-${message.messageId}`,
        key: `file:${filePath}`,
        title: filePath.split(/[\\/]/).pop() || filePath,
        type: 'code',
        language,
        content: body,
        filePath,
      };
    }
  }

  return null;
}

interface PipelineDeliverable {
  summary?: string;
  key_findings?: string[];
  artifacts?: string[];
  open_questions?: string[];
  raw_excerpt?: string;
}

/** A pipeline handoff's structured deliverable, rendered as a document. */
export function deliverableArtifact(message: WorkspaceMessage): ArtifactItem | null {
  const d = message.metadata?.deliverable as PipelineDeliverable | undefined;
  if (!d || typeof d !== 'object' || !d.summary) return null;
  const from =
    (message.content.match(/@([\w-]+)/g) || [])
      .map((m) => m.slice(1))
      .find((n) => !(message.targetAgents || []).includes(n)) || 'previous step';
  const section = (title: string, items?: string[]) =>
    items && items.length ? `\n\n### ${title}\n${items.map((i) => `- ${i}`).join('\n')}` : '';
  const content =
    `${d.summary.trim()}` +
    section('Key findings', d.key_findings) +
    section('Produced', d.artifacts) +
    section('Open questions', d.open_questions);
  return {
    id: `handoff-${message.messageId}`,
    key: `handoff-${message.messageId}`,
    title: `Handoff from @${from}`,
    type: 'deliverable',
    content,
    authorAgent: from === 'previous step' ? undefined : from,
    sourceMessageId: message.messageId,
    updatedAt: timeOf(message) || Date.now(),
  };
}

/** Every output in a thread, newest document first. */
export function collectOutputs(messages: WorkspaceMessage[]): ThreadOutputs {
  const groups = new Map<string, ArtifactItem[]>();
  const files = new Map<string, ChangedFile>();

  for (const m of messages) {
    if (m.messageType !== 'chat' && m.messageType !== undefined) {
      // Steps (thinking/status/todos) never carry deliverables.
      if (m.messageType === 'thinking' || m.messageType === 'status' || m.messageType === 'todos') continue;
    }
    const art = inferArtifact(m) ?? deliverableArtifact(m);
    if (art) {
      const list = groups.get(art.key) ?? [];
      // The same reply can be seen twice (optimistic + confirmed); one version each.
      if (!list.some((v) => v.sourceMessageId === art.sourceMessageId)) list.push(art);
      groups.set(art.key, list);
    }
    const tc = m.metadata?.turn_changes;
    if (tc && Array.isArray(tc.changes)) {
      for (const c of tc.changes as TurnFileChange[]) {
        files.set(c.path, {
          path: c.path,
          status: c.status,
          additions: c.additions,
          deletions: c.deletions,
          turnId: tc.turn_id,
          agent: m.senderName,
          messageId: m.messageId,
          at: timeOf(m),
        });
      }
    }
  }

  const documents = Array.from(groups.entries())
    .map(([key, versions]) => ({ key, versions: versions.sort((a, b) => a.updatedAt - b.updatedAt) }))
    .sort((a, b) => b.versions[b.versions.length - 1].updatedAt - a.versions[a.versions.length - 1].updatedAt);
  const changedFiles = Array.from(files.values()).sort((a, b) => b.at - a.at);
  return { documents, changedFiles };
}

const EXTENSIONS: Record<string, string> = {
  typescript: 'ts', ts: 'ts', tsx: 'tsx', javascript: 'js', js: 'js', jsx: 'jsx', python: 'py', py: 'py',
  go: 'go', rust: 'rs', rs: 'rs', java: 'java', ruby: 'rb', shell: 'sh', bash: 'sh', sh: 'sh',
  json: 'json', yaml: 'yml', yml: 'yml', css: 'css', html: 'html', svg: 'svg', sql: 'sql', md: 'md',
};

/** File name to save an artifact under. */
export function downloadName(a: ArtifactItem): string {
  if (a.filePath) return a.filePath.split(/[\\/]/).pop() || a.filePath;
  const ext =
    a.type === 'html' ? 'html' : a.type === 'svg' ? 'svg' : a.type === 'code' ? EXTENSIONS[(a.language || '').toLowerCase()] || 'txt' : 'md';
  return `${slug(a.title || 'artifact').replace(/[^\w.-]/g, '') || 'artifact'}.${ext}`;
}

export function mimeType(a: ArtifactItem): string {
  if (a.type === 'html') return 'text/html;charset=utf-8';
  if (a.type === 'svg') return 'image/svg+xml;charset=utf-8';
  if (a.type === 'code') return 'text/plain;charset=utf-8';
  return 'text/markdown;charset=utf-8';
}

/**
 * Unified diff of two versions, for DiffBlock. Plain LCS over lines; past
 * MAX_DIFF_CELLS the table would be too large to build on the main thread,
 * so the caller is told instead of the tab freezing.
 */
const MAX_DIFF_CELLS = 4_000_000;

export function lineDiff(before: string, after: string, labels: [string, string]): string | null {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) return null;
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[i] === b[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  const out: string[] = [`--- ${labels[0]}`, `+++ ${labels[1]}`, `@@ -1,${n} +1,${m} @@`];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(` ${a[i]}`);
      i++;
      j++;
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
      out.push(`-${a[i++]}`);
    } else {
      out.push(`+${b[j++]}`);
    }
  }
  while (i < n) out.push(`-${a[i++]}`);
  while (j < m) out.push(`+${b[j++]}`);
  return out.join('\n');
}

/**
 * The message that asks an agent for a new version. The answer format is the
 * whole protocol: replying with the same `identifier` is what files the reply
 * as the next version of this document (see collectOutputs).
 */
export function revisionRequest(a: ArtifactItem, agent: string, instruction: string, selection?: string): string {
  const quoted = selection
    ? `\n\nThe part to change:\n${selection.slice(0, 1500).split('\n').map((l) => `> ${l}`).join('\n')}${selection.length > 1500 ? '\n> ...' : ''}`
    : '';
  const type = a.type === 'deliverable' ? 'markdown' : a.type;
  return (
    `@${agent} Please revise "${a.title}".${quoted}\n\nRequested change: ${instruction.trim()}\n\n` +
    `Reply with the complete updated document (not only the changed part), wrapped exactly like this:\n` +
    `<artifact identifier="${a.key}" title="${a.title.replace(/"/g, "'")}" type="${type}"${a.language ? ` language="${a.language}"` : ''}>\n` +
    `...full updated content...\n</artifact>`
  );
}
