'use client';

import { Hint } from '@/components/ui/hint';
import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { Check, Copy, ChevronDown, FileDiff } from 'lucide-react';

interface DiffBlockProps {
  code: string;
  embedded?: boolean;
}

type DiffKind = 'add' | 'del' | 'context' | 'hunk' | 'meta';

interface DiffRow {
  kind: DiffKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

function parseDiff(code: string): { rows: DiffRow[]; file: string | null; adds: number; dels: number } {
  if (!code || typeof code !== 'string') {
    return { rows: [], file: null, adds: 0, dels: 0 };
  }
  const lines = code.replace(/\n$/, '').split('\n');
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let file: string | null = null;
  let adds = 0;
  let dels = 0;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      const m = line.match(/@@\s*-(\d+)(?:,\d+)?\s*\+(\d+)(?:,\d+)?\s*@@/);
      if (m) {
        oldNo = parseInt(m[1], 10);
        newNo = parseInt(m[2], 10);
      }
      rows.push({ kind: 'hunk', oldNo: null, newNo: null, text: line });
      continue;
    }
    if (line.startsWith('diff --git') || line.startsWith('index ') || /^(---|\+\+\+)\s/.test(line)) {
      const gm = line.match(/^\+\+\+\s+b\/(.+)$/) || line.match(/^diff --git\/.+ b\/(.+)$/);
      if (gm && gm[1] && gm[1] !== '/dev/null') file = gm[1];
      rows.push({ kind: 'meta', oldNo: null, newNo: null, text: line });
      continue;
    }
    if (line.startsWith('+')) {
      adds++;
      rows.push({ kind: 'add', oldNo: null, newNo: newNo++, text: line.slice(1) });
      continue;
    }
    if (line.startsWith('-')) {
      dels++;
      rows.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: line.slice(1) });
      continue;
    }
    // Context (leading space or empty)
    rows.push({ kind: 'context', oldNo: oldNo++, newNo: newNo++, text: line.startsWith(' ') ? line.slice(1) : line });
  }

  return { rows, file, adds, dels };
}

const ROW_STYLE: Record<DiffKind, { row: string; sign: string; signColor: string; num: string }> = {
  add: {
    row: 'bg-status-success/[0.10] dark:bg-status-success/[0.14]',
    sign: '+',
    signColor: 'text-status-success font-semibold',
    num: 'text-status-success/80 dark:text-status-success/70',
  },
  del: {
    row: 'bg-status-danger/[0.10] dark:bg-status-danger/[0.14]',
    sign: '-',
    signColor: 'text-status-danger font-semibold',
    num: 'text-status-danger/80 dark:text-status-danger/70',
  },
  context: {
    row: 'hover:bg-surface2/30 transition-colors',
    sign: ' ',
    signColor: 'text-transparent',
    num: 'text-foreground-extra-muted/60',
  },
  hunk: {
    row: 'bg-surface2/80 text-foreground-muted border-y border-border/60 py-0.5 select-none font-medium text-2xs',
    sign: ' ',
    signColor: 'text-transparent',
    num: 'text-transparent',
  },
  meta: {
    row: '',
    sign: ' ',
    signColor: 'text-transparent',
    num: 'text-transparent',
  },
};

/**
 * DiffBlock — renders a fenced ```diff block as a real unified diff: +/- gutter,
 * red/green line tinting, reconstructed line numbers, a file header with add/del
 * counts, and collapse. Mirrors how Codex / Claude Code surface code edits.
 */
export function DiffBlock({ code, embedded = false }: DiffBlockProps) {
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const { rows, file, adds, dels } = useMemo(() => parseDiff(code), [code]);

  const copy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    toast.success('Diff copied');
    setTimeout(() => setCopied(false), 1500);
  };

  const content = (
    <div className="overflow-x-auto">
      <div className="min-w-max font-mono text-xs">
        {rows.map((r, i) => {
          const s = ROW_STYLE[r.kind];
          if (r.kind === 'meta') return null; // file/index headers are surfaced in the title bar
          return (
            <div key={i} className={cn('flex items-stretch leading-5', s.row)}>
              {/* line numbers */}
              <span className={cn('shrink-0 w-10 px-1.5 text-right tabular-nums text-2xs select-none', s.num)}>
                {r.oldNo ?? ''}
              </span>
              <span className={cn('shrink-0 w-10 px-1.5 text-right tabular-nums text-2xs select-none border-r border-border/60', s.num)}>
                {r.newNo ?? ''}
              </span>
              {/* sign */}
              <span className={cn('shrink-0 w-5 text-center select-none', s.signColor)}>{s.sign}</span>
              {/* content */}
              <span
                className={cn(
                  'whitespace-pre pr-4 flex-1',
                  r.kind === 'hunk'
                    ? 'text-foreground-muted font-medium'
                    : r.kind === 'add'
                      ? 'text-foreground'
                      : r.kind === 'del'
                        ? 'text-foreground'
                        : 'text-foreground/85',
                )}
              >
                {r.text || ' '}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );

  if (embedded) {
    return content;
  }

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-border bg-surface0 font-mono text-xs shadow-xs">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 h-9 bg-surface1/60 border-b border-border select-none">
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-1.5 min-w-0 text-foreground-muted hover:text-foreground transition-colors"
        >
          <ChevronDown className={cn('size-3.5 shrink-0 transition-transform', collapsed && '-rotate-90')} />
          <FileDiff className="size-3.5 shrink-0 text-foreground-muted" />
          <span className="text-2xs font-mono truncate text-foreground">{file || 'diff'}</span>
        </button>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {adds > 0 && <span className="text-3xs font-medium text-status-success tabular-nums">+{adds}</span>}
          {dels > 0 && <span className="text-3xs font-medium text-status-danger tabular-nums">−{dels}</span>}
          <Hint label="Copy diff">
            <button onClick={copy} className="text-foreground-muted hover:text-foreground transition-colors">
              {copied ? <Check className="size-3.5 text-status-success" /> : <Copy className="size-3.5" />}
            </button>
          </Hint>
        </div>
      </div>

      {/* Rows */}
      {!collapsed && content}
    </div>
  );
}