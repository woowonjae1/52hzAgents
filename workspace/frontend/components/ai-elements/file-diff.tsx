'use client';

import * as React from 'react';
import {
  FileDiff as BeuiFileDiff,
  type FileDiffLine,
} from '@/components/agents/file-diff';

/*
  THE ADAPTER, NOT A SECOND IMPLEMENTATION.

  The diff view itself is beUI's now. What stays here is the part beUI has no
  concept of: this app's callers may hand over a raw unified diff instead of
  parsed lines, because that is what the agent's tool output contains.
*/

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
      result.push({ id: `diff-${idx}`, type: 'added', newLine: newLine++, content: line.slice(1) });
    } else if (line.startsWith('-')) {
      result.push({ id: `diff-${idx}`, type: 'removed', oldLine: oldLine++, content: line.slice(1) });
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

export function FileDiff({ file, lines, rawDiff, status, defaultOpen, className }: FileDiffProps) {
  const resolved = React.useMemo<FileDiffLine[]>(() => {
    if (lines && lines.length > 0) return lines;
    if (rawDiff) return parseUnifiedDiff(rawDiff);
    return [];
  }, [lines, rawDiff]);

  return (
    <BeuiFileDiff
      file={file}
      lines={resolved}
      /* beUI has two states, not three: anything not finished is streaming. */
      status={status === 'complete' ? 'complete' : 'streaming'}
      defaultOpen={defaultOpen}
      copyText={rawDiff}
      className={className}
    />
  );
}
