'use client';

import * as React from 'react';
import { FileCode, ChevronDown, Copy, Check, Plus, Minus } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

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

export function FileDiff({
  file,
  lines,
  rawDiff,
  status = 'complete',
  defaultOpen = true,
  className,
}: FileDiffProps) {
  const [isOpen, setIsOpen] = React.useState(defaultOpen);
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
    toast.success('已复制差异代码');
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={cn(
        'w-full rounded-xl border border-border/70 overflow-hidden bg-surface1/95 backdrop-blur-md shadow-2xs font-mono text-xs',
        className
      )}
    >
      {/* File Header Bar */}
      <div
        onClick={() => setIsOpen((prev) => !prev)}
        className="flex items-center justify-between gap-2 px-3 py-2 bg-surface2/70 hover:bg-surface2 transition-colors cursor-pointer select-none border-b border-border/50"
      >
        <div className="flex items-center gap-2 min-w-0">
          <ChevronDown
            className={cn(
              'size-3.5 text-muted-foreground transition-transform duration-200 shrink-0',
              !isOpen && '-rotate-90'
            )}
          />
          <FileCode className="size-3.5 text-primary shrink-0" />
          <span className="font-semibold text-foreground truncate">{file}</span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Stats Badge */}
          <div className="flex items-center gap-1 text-[11px] font-medium">
            {addedCount > 0 && (
              <span className="text-emerald-600 dark:text-emerald-400 flex items-center">
                +{addedCount}
              </span>
            )}
            {removedCount > 0 && (
              <span className="text-rose-600 dark:text-rose-400 flex items-center">
                -{removedCount}
              </span>
            )}
          </div>

          {/* Copy Action */}
          <button
            type="button"
            onClick={handleCopy}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-surface3 transition-colors cursor-pointer"
            title="复制 Diff 内容"
          >
            {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
          </button>
        </div>
      </div>

      {/* Diff Table Lines */}
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-x-auto overflow-y-hidden"
          >
            <div className="min-w-full divide-y divide-border/20 text-[11.5px] leading-relaxed">
              {parsedLines.map((line) => {
                const isAdded = line.type === 'added';
                const isRemoved = line.type === 'removed';

                return (
                  <div
                    key={line.id}
                    className={cn(
                      'flex items-stretch font-mono hover:bg-surface2/50 transition-colors',
                      isAdded && 'bg-emerald-500/10 dark:bg-emerald-500/[0.12] text-emerald-800 dark:text-emerald-200',
                      isRemoved && 'bg-rose-500/10 dark:bg-rose-500/[0.12] text-rose-800 dark:text-rose-200'
                    )}
                  >
                    {/* Line Numbers Gutter */}
                    <div className="flex select-none shrink-0 text-[10px] text-muted-foreground/60 border-r border-border/40 bg-surface1/60">
                      <span className="w-9 px-1.5 py-0.5 text-right tabular-nums">
                        {line.oldLine ?? ''}
                      </span>
                      <span className="w-9 px-1.5 py-0.5 text-right tabular-nums border-l border-border/30">
                        {line.newLine ?? ''}
                      </span>
                    </div>

                    {/* Diff Marker (+ / -) */}
                    <div className="w-5 py-0.5 text-center font-bold shrink-0 select-none opacity-75">
                      {isAdded ? '+' : isRemoved ? '-' : ' '}
                    </div>

                    {/* Code Content */}
                    <div className="flex-1 px-1.5 py-0.5 whitespace-pre overflow-x-auto">
                      {line.content || ' '}
                    </div>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
