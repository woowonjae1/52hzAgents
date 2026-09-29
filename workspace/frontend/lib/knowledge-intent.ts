import { useEffect } from 'react';

/*
  A REQUEST TO THE KNOWLEDGE VIEW FROM SOMEWHERE ELSE.

  Knowledge lives in Settings, and the view is only mounted while it is open, so
  a caller (a chat message, the command palette) cannot hand it anything
  directly: `setViewMode('knowledge')` mounts it a render later. The request is
  parked here instead and the view takes it when it mounts, or at once if it is
  already mounted. One request at a time; a newer one replaces an unclaimed one.
*/

export interface KnowledgeDraft {
  title: string;
  content: string;
  description?: string;
}

export type KnowledgeIntent =
  | { kind: 'open'; id: string }
  | { kind: 'draft'; draft: KnowledgeDraft };

let pending: KnowledgeIntent | null = null;
const listeners = new Set<() => void>();

export function requestKnowledgeIntent(intent: KnowledgeIntent) {
  pending = intent;
  listeners.forEach((l) => l());
}

/** Claims any parked request now and every later one while mounted. `handler` should be stable. */
export function usePendingKnowledgeIntent(handler: (intent: KnowledgeIntent) => void) {
  useEffect(() => {
    const claim = () => {
      if (!pending) return;
      const intent = pending;
      pending = null;
      handler(intent);
    };
    claim();
    listeners.add(claim);
    return () => {
      listeners.delete(claim);
    };
  }, [handler]);
}

const TITLE_MAX = 80;

/**
 * A knowledge draft from a chat message: the first heading (or first line) as
 * the title, the markdown as the body. The person edits both before it is
 * saved; nothing here writes anything.
 */
export function draftFromMessage(markdown: string, sender: string): KnowledgeDraft {
  const content = markdown.trim();
  const lines = content.split('\n').map((l) => l.trim()).filter(Boolean);
  const heading = lines.find((l) => /^#{1,3}\s+\S/.test(l));
  const raw = (heading ?? lines[0] ?? '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*>]\s+/, '')
    .replace(/[*_`~]/g, '')
    .trim();
  const title = raw.length > TITLE_MAX ? `${raw.slice(0, TITLE_MAX - 1).trimEnd()}…` : raw;
  return { title, content, description: `Saved from @${sender}` };
}
