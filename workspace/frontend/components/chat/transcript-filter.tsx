'use client';

import * as React from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { WorkspaceMessage } from '@/lib/types';

/**
 * Filtering the transcript in place — what the Trace panel was for, without the
 * second copy of the transcript.
 *
 * Trace read the SAME messages as the chat (`useSessionMessages()`), picked out
 * the reasoning, tool calls and subagent steps, and listed them again in the
 * Studio panel. Once tool calls became structured cards and reasoning started
 * flowing inline, the chat already showed every one of those steps, so the
 * panel was the transcript twice. Its one genuinely useful part was the filter:
 * "only pi", "only tool calls", search — the thing you need on a long
 * multi-agent run where everyone's steps interleave. That part lives here now,
 * on the transcript itself.
 *
 * A filtered transcript must never look complete. So the bar is hidden until
 * asked for, and stays visible — with a count — for as long as any filter is
 * on; closing it clears the filter rather than leaving it applied out of sight.
 */

export type TranscriptKind = 'all' | 'tools' | 'thinking';

export interface TranscriptFilterState {
  agent: string; // 'all' or an agent name
  kind: TranscriptKind;
  query: string;
}

export const EMPTY_TRANSCRIPT_FILTER: TranscriptFilterState = { agent: 'all', kind: 'all', query: '' };

export function isTranscriptFilterActive(f: TranscriptFilterState): boolean {
  return f.agent !== 'all' || f.kind !== 'all' || f.query.trim() !== '';
}

function isHuman(m: WorkspaceMessage): boolean {
  return m.senderType === 'human' || m.senderType === 'user';
}

/**
 * A tool call, in either shape: the structured `metadata.tool_name` adapters now
 * send, or the legacy markdown sentence some still do. Both are what the
 * transcript renders as a tool card, so both count.
 */
function isToolStep(m: WorkspaceMessage): boolean {
  const tool = m.metadata?.tool_name ?? m.metadata?.tool ?? m.metadata?.tool_call;
  if (typeof tool === 'string' && tool.trim()) return true;
  return /\*\*(Using tool|Running|Editing):\*\*/.test(m.content || '');
}

function isReasoning(m: WorkspaceMessage): boolean {
  // `reply_preview` thinking is the answer arriving early, not reasoning.
  return m.messageType === 'thinking' && !m.metadata?.reply_preview;
}

export function applyTranscriptFilter(
  messages: WorkspaceMessage[],
  f: TranscriptFilterState,
): WorkspaceMessage[] {
  if (!isTranscriptFilterActive(f)) return messages;
  const q = f.query.trim().toLowerCase();

  return messages.filter((m) => {
    // An agent filter keeps the human side: "only pi" is pi's answers to the
    // questions it was asked, and an answer with its question removed does not
    // read. A KIND filter is a step view, so it keeps only matching steps.
    if (f.agent !== 'all' && !isHuman(m) && m.senderName !== f.agent) return false;
    if (f.kind === 'tools' && !isToolStep(m)) return false;
    if (f.kind === 'thinking' && !isReasoning(m)) return false;
    if (q) {
      const tool = String(m.metadata?.tool_name ?? '');
      const hay = `${m.content || ''} ${m.senderName || ''} ${tool}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

interface BarProps {
  value: TranscriptFilterState;
  onChange: (next: TranscriptFilterState) => void;
  onClose: () => void;
  /** Agents that have actually spoken in this thread. */
  agentNames: string[];
  shown: number;
  total: number;
  className?: string;
}

const KINDS: { id: TranscriptKind; label: string }[] = [
  { id: 'all', label: 'Everything' },
  { id: 'tools', label: 'Tool calls' },
  { id: 'thinking', label: 'Reasoning' },
];

export function TranscriptFilterBar({ value, onChange, onClose, agentNames, shown, total, className }: BarProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const active = isTranscriptFilterActive(value);

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface1 px-2.5 py-1.5',
        className,
      )}
    >
      <div className="flex min-w-[10rem] flex-1 items-center gap-1.5">
        <Search className="size-3.5 shrink-0 text-foreground-extra-muted" />
        <input
          ref={inputRef}
          value={value.query}
          onChange={(e) => onChange({ ...value, query: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
          }}
          placeholder="Search this thread"
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground placeholder:text-foreground-extra-muted outline-none"
        />
      </div>

      <div className="flex items-center rounded-lg bg-surface2 p-0.5" role="radiogroup" aria-label="What to show">
        {KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            role="radio"
            aria-checked={value.kind === k.id}
            onClick={() => onChange({ ...value, kind: k.id })}
            className={cn(
              'rounded-md px-2 py-0.5 text-2xs font-medium transition-colors',
              value.kind === k.id
                ? 'bg-surface0 text-foreground shadow-xs'
                : 'text-foreground-muted hover:text-foreground',
            )}
          >
            {k.label}
          </button>
        ))}
      </div>

      {agentNames.length > 1 && (
        <Select value={value.agent} onValueChange={(agent) => onChange({ ...value, agent })}>
          <SelectTrigger size="sm" className="w-auto max-w-[140px] text-2xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Every agent</SelectItem>
            {agentNames.map((name) => (
              <SelectItem key={name} value={name}>
                @{name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* The count is what keeps a filtered transcript from passing as whole. */}
      {active && (
        <span className="text-2xs tabular-nums text-foreground-muted">
          {shown} of {total}
        </span>
      )}

      <button
        type="button"
        onClick={onClose}
        aria-label={active ? 'Clear filter' : 'Close filter'}
        className="ml-auto grid size-6 place-items-center rounded-md text-foreground-extra-muted transition-colors hover:bg-surface2 hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
