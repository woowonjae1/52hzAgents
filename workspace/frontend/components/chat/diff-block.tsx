'use client';

import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { Check, Copy, ChevronDown, FileDiff } from 'lucide-react';

interface DiffBlockProps {
  code: string;
}

type DiffKind = 'add' | 'del' | 'context' | 'hunk' | 'meta';

interface DiffRow {
  kind: DiffKind;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}

// Parse a unified diff into rows with reconstructed old/new line numbers.
function parseDiff(code: string): { rows: DiffRow[]; file: string | null; adds: number; dels: number } {
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
      const gm = line.match(/^\+\+\+\s+b\/(.+)$/) || line.match(/^diff --git a\/.+ b\/(.+)$/);
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
  add: { row: 'bg-emerald-500/[0.08]', sign: '+', signColor: 'text-emerald-500', num: 'text-emerald-600/70 dark:text-emerald-500/60' },
  del: { row: 'bg-red-500/[0.08]', sign: '-', signColor: 'text-red-500', num: 'text-red-600/70 dark:text-red-500/60' },
  context: { row: '', sign: ' ', signColor: 'text-transparent', num: 'text-zinc-500/50' },
  hunk: { row: 'bg-cyan-500/[0.06]', sign: ' ', signColor: 'text-transparent', num: 'text-transparent' },
  meta: { row: '', sign: ' ', signColor: 'text-transparent', num: 'text-transparent' },
};

/**
 * DiffBlock — renders a fenced ```diff block as a real unified diff: +/- gutter,
 * red/green line tinting, reconstructed line numbers, a file header with add/del
 * counts, and collapse. Mirrors how Codex / Claude Code surface code edits.
 */
export function DiffBlock({ code }: DiffBlockProps) {
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const { rows, file, adds, dels } = useMemo(() => parseDiff(code), [code]);

  const copy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    toast.success('Diff copied');
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 font-mono text-[12.5px] shadow-sm">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 h-9 border-b border-zinc-800 bg-zinc-900/60 select-none">
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-1.5 min-w-0 text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          <ChevronDown className={cn('size-3.5 shrink-0 transition-transform', collapsed && '-rotate-90')} />
          <FileDiff className="size-3.5 shrink-0 text-zinc-500" />
          <span className="text-[11px] truncate text-zinc-300">{file || 'diff'}</span>
        </button>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          {adds > 0 && <span className="text-[10px] font-semibold text-emerald-500 tabular-nums">+{adds}</span>}
          {dels > 0 && <span className="text-[10px] font-semibold text-red-500 tabular-nums">−{dels}</span>}
          <button onClick={copy} className="text-zinc-500 hover:text-zinc-200 transition-colors" title="Copy diff">
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </button>
        </div>
      </div>

      {/* Rows */}
      {!collapsed && (
        <div className="overflow-x-auto">
          <div className="min-w-max">
            {rows.map((r, i) => {
              const s = ROW_STYLE[r.kind];
              if (r.kind === 'meta') return null; // file/index headers are surfaced in the title bar
              return (
                <div key={i} className={cn('flex items-stretch leading-5', s.row)}>
                  {/* line numbers */}
                  <span className={cn('shrink-0 w-10 px-1.5 text-right tabular-nums text-[11px] select-none', s.num)}>
                    {r.oldNo ?? ''}
                  </span>
                  <span className={cn('shrink-0 w-10 px-1.5 text-right tabular-nums text-[11px] select-none border-r border-zinc-800/80', s.num)}>
                    {r.newNo ?? ''}
                  </span>
                  {/* sign */}
                  <span className={cn('shrink-0 w-5 text-center select-none font-bold', s.signColor)}>{s.sign}</span>
                  {/* content */}
                  <span
                    className={cn(
                      'whitespace-pre pr-4 flex-1',
                      r.kind === 'hunk' ? 'text-cyan-400/80' : r.kind === 'add' ? 'text-emerald-200' : r.kind === 'del' ? 'text-red-200' : 'text-zinc-300',
                    )}
                  >
                    {r.text || ' '}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
