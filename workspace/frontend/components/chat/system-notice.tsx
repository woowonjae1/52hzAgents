'use client';

import { memo, useState } from 'react';
import { PlayCircle, Clock, AlertTriangle, Info, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { MarkdownContent } from './markdown-content';
import type { WorkspaceMessage } from '@/lib/types';

const LEADING_EMOJI = /^\s*(\p{Extended_Pictographic})\uFE0F?\s*/u;
const LONG_NOTICE_CHARS = 280;

export const SystemNotice = memo(function SystemNotice({
  message,
  agentNames,
  workingDir,
}: {
  message: WorkspaceMessage;
  agentNames: string[];
  workingDir?: string;
}) {
  const [open, setOpen] = useState(false);
  const raw = (message.content || '').trim();
  const emoji = raw.match(LEADING_EMOJI)?.[1];
  const content = raw.replace(LEADING_EMOJI, '');
  const meta = (message.metadata || {}) as Record<string, unknown>;

  const kind: 'started' | 'queued' | 'warning' | 'info' = meta.queued_wake
    ? 'started'
    : emoji === '⏳' || /排队中|queued/i.test(content)
      ? 'queued'
      : emoji === '⚠' || emoji === '❌' || emoji === '🛑'
        ? 'warning'
        : 'info';
  const Icon = { started: PlayCircle, queued: Clock, warning: AlertTriangle, info: Info }[kind];

  // First paragraph is the notice; the rest (a forwarded task) is detail.
  const split = content.search(/\n\s*\n/);
  const summary = split >= 0 ? content.slice(0, split).trim() : content;
  const detail = split >= 0 ? content.slice(split).trim() : '';
  const longSummary = !detail && summary.length > LONG_NOTICE_CHARS;
  const canExpand = !!detail || longSummary;

  const timestamp = message.createdAt
    ? new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '';

  return (
    <div className="py-1.5">
      <div
        className={cn(
          'rounded-lg border bg-surface1/60 px-3 py-2 text-xs text-muted-foreground',
          kind === 'warning' ? 'border-status-warning/30' : 'border-border/60'
        )}
      >
        <div className="flex items-center gap-1.5 text-2xs leading-none select-none">
          <Icon className={cn('size-3.5 shrink-0', kind === 'warning' ? 'text-status-warning' : 'text-foreground-extra-muted')} />
          <span className="font-medium text-foreground-muted">{message.senderName}</span>
          {timestamp && <span className="ml-auto tabular-nums text-foreground-extra-muted">{timestamp}</span>}
        </div>
        <div
          className={cn(
            'mt-1.5 pl-5 [&_.markdown-content]:text-xs [&_p]:my-0',
            longSummary && !open && 'line-clamp-3'
          )}
        >
          <MarkdownContent content={summary} agentNames={agentNames} sessionId={message.sessionId} workingDir={workingDir} />
        </div>
        {open && detail && (
          <div className="mt-2 ml-5 max-h-96 overflow-y-auto rounded-md border border-border/50 bg-surface0/60 px-3 py-2 [&_.markdown-content]:text-xs">
            <MarkdownContent content={detail} agentNames={agentNames} sessionId={message.sessionId} workingDir={workingDir} />
          </div>
        )}
        {canExpand && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="mt-1.5 ml-5 inline-flex items-center gap-1 text-2xs text-foreground-muted hover:text-foreground cursor-pointer"
          >
            <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} />
            {open ? 'Hide' : detail ? 'Show forwarded task' : 'Show more'}
          </button>
        )}
      </div>
    </div>
  );
});
