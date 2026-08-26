'use client';

import * as React from 'react';
import { FileCode, Copy, Check } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { EventLine, EventLineAction } from './event-line';

export interface DiffLine {
  id: string;
  type: 'context' | 'added' | 'removed';
  oldLine?: number;
  newLine?: number;
  content: string;
}

export interface FileDiffProps {
  file: string;
  lines?: DiffLine[];
  rawDiff?: string;
  status?: 'complete' | 'in-progress' | 'pending';
  defaultOpen?: boolean;
  className?: string;
}

function parseUnifiedDiff(raw: string): DiffLine[] {
  const result: DiffLine[] = [];
  const rawLines = raw.split('\n');
  let oldLine = 1;
  let newLine = 1;

  rawLines.forEach((line, idx) => {
    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      return;
    }
    if (line.startsWith('+')) {
      result.push({
        id: `diff-${idx}`,
        type: 'added',
        newLine: newLine++,
        content: line.slice(1),
      });
    } else if (line.startsWith('-')) {
      result.push({
        id: `diff-${idx}`,
        type: 'removed',
        oldLine: oldLine++,
        content: line.slice(1),
      });
    } else {
      result.push({
        id: `diff-${idx}`,
        type: 'context',
        oldLine: oldLine++,
        newLine: newLine++,
        content: line.startsWith(' ') ? line.slice(1) : line,
      });
    }
  });

  return result;
}

/**
 * A file the agent changed.
 *
 * This is the one event whose BODY is allowed two more colours, because added
 * and removed are not decoration here — they are the content, and a diff drawn
 * in one colour cannot be read. What changed is that they now come from
 * `--diff-addition` / `--diff-deletion` instead of hardcoded `emerald-500` and
 * `rose-500`, so they track the theme and are reachable from one place. Rose in
 * particular was a fifth hue that appeared only here and in the old approval
 * card, unrelated to `--destructive`.
 */
export function FileDiff({
  file,
  lines,
  rawDiff,
  status = 'complete',
  defaultOpen = true,
  className,
}: FileDiffProps) {
  const [copied, setCopied] = React.useState(false);

  const parsedLines = React.useMemo<DiffLine[]>(() => {
    if (lines && lines.length > 0) return lines;
    if (rawDiff) return parseUnifiedDiff(rawDiff);
    return [];
  }, [lines, rawDiff]);

  const addedCount = React.useMemo(
    () => parsedLines.filter((l) => l.type === 'added').length,
    [parsedLines]
  );
  const removedCount = React.useMemo(
    () => parsedLines.filter((l) => l.type === 'removed').length,
    [parsedLines]
  );

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = parsedLines
      .map((l) => {
        const prefix = l.type === 'added' ? '+' : l.type === 'removed' ? '-' : ' ';
        return `${prefix}${l.content}`;
      })
      .join('\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    toast.success('Diff copied');
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <EventLine
      className={className}
      icon={<FileCode />}
      label="Edited"
      detail={file}
      state={status === 'in-progress' ? 'running' : 'idle'}
      meta={
        <>
          {addedCount > 0 && <span className="text-diff-addition">+{addedCount}</span>}
          {addedCount > 0 && removedCount > 0 && ' '}
          {removedCount > 0 && <span className="text-diff-deletion">-{removedCount}</span>}
        </>
      }
      actions={
        parsedLines.length > 0 ? (
          <EventLineAction onClick={handleCopy} title="Copy diff">
            {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          </EventLineAction>
        ) : undefined
      }
      defaultOpen={defaultOpen}
    >
      <div className="overflow-x-auto rounded-base border border-border bg-surface-diff-empty">
        <div className="min-w-full font-mono text-2xs leading-relaxed">
          {parsedLines.map((line) => {
            const isAdded = line.type === 'added';
            const isRemoved = line.type === 'removed';

            return (
              <div
                key={line.id}
                className={cn(
                  'flex items-stretch',
                  // `color-mix` against the token rather than a second
                  // hardcoded tint, so the row wash and the glyph colour cannot
                  // drift apart when the token changes.
                  isAdded && 'bg-[color-mix(in_oklab,var(--diff-addition)_12%,transparent)] text-diff-addition',
                  isRemoved && 'bg-[color-mix(in_oklab,var(--diff-deletion)_12%,transparent)] text-diff-deletion',
                  !isAdded && !isRemoved && 'text-foreground-muted'
                )}
              >
                <div className="flex shrink-0 select-none border-r border-border text-3xs text-foreground-extra-muted">
                  <span className="w-9 px-1.5 py-0.5 text-right tabular-nums">
                    {line.oldLine ?? ''}
                  </span>
                  <span className="w-9 border-l border-border px-1.5 py-0.5 text-right tabular-nums">
                    {line.newLine ?? ''}
                  </span>
                </div>

                <div className="w-4 shrink-0 select-none py-0.5 text-center opacity-70">
                  {isAdded ? '+' : isRemoved ? '-' : ' '}
                </div>

                <div className="flex-1 whitespace-pre px-1.5 py-0.5">
                  {line.content || ' '}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </EventLine>
  );
}
