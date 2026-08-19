'use client';

import {
  Terminal,
  FileCode,
  Search,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ChevronDown,
  Copy,
  Check,
  Globe,
  Settings,
  FolderOpen,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useState } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

export type ToolStatus = 'running' | 'success' | 'error' | 'cancelled';

export interface ToolCardProps {
  toolName: string;
  toolInput?: Record<string, any> | string;
  toolOutput?: string;
  status?: ToolStatus;
  durationMs?: number;
  error?: string;
  defaultExpanded?: boolean;
  className?: string;
}

function getToolIcon(name: string) {
  const lower = name.toLowerCase();
  if (lower.includes('bash') || lower.includes('cmd') || lower.includes('terminal') || lower.includes('exec')) {
    return <Terminal className="size-3.5" />;
  }
  if (lower.includes('read') || lower.includes('write') || lower.includes('file') || lower.includes('edit')) {
    return <FileCode className="size-3.5" />;
  }
  if (lower.includes('search') || lower.includes('grep') || lower.includes('find')) {
    return <Search className="size-3.5" />;
  }
  if (lower.includes('web') || lower.includes('fetch') || lower.includes('url') || lower.includes('http')) {
    return <Globe className="size-3.5" />;
  }
  if (lower.includes('dir') || lower.includes('list')) {
    return <FolderOpen className="size-3.5" />;
  }
  return <Settings className="size-3.5" />;
}

export function ToolCard({
  toolName,
  toolInput,
  toolOutput,
  status = 'success',
  durationMs,
  error,
  defaultExpanded = false,
  className,
}: ToolCardProps) {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);

  const inputStr = typeof toolInput === 'string'
    ? toolInput
    : toolInput
    ? JSON.stringify(toolInput, null, 2)
    : null;

  const handleCopyOutput = (e: React.MouseEvent) => {
    e.stopPropagation();
    const textToCopy = toolOutput || error || inputStr || '';
    if (!textToCopy) return;
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    toast.success('输出内容已复制');
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={cn(
        'group/tool my-2 rounded-xl border border-border/80 bg-surface1/80 dark:bg-surface1/40 overflow-hidden shadow-2xs transition-all duration-150',
        className
      )}
    >
      {/* Header */}
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        className="w-full flex items-center justify-between px-3.5 py-2 select-none hover:bg-surface2/60 transition-colors text-left cursor-pointer"
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="size-6 rounded-lg bg-surface2 border border-border/60 flex items-center justify-center text-foreground-muted shrink-0">
            {getToolIcon(toolName)}
          </div>

          <div className="flex items-center gap-2 min-w-0">
            <span className="font-mono text-xs font-semibold text-foreground truncate">{toolName}</span>
            {durationMs && durationMs > 0 && (
              <span className="text-[10px] text-muted-foreground font-mono">
                {(durationMs / 1000).toFixed(1)}s
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Status Badge */}
          {status === 'running' && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 text-[10px] font-medium animate-pulse">
              <Loader2 className="size-2.5 animate-spin" />
              <span>Running</span>
            </span>
          )}
          {status === 'success' && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-[10px] font-medium">
              <CheckCircle2 className="size-2.5" />
              <span>Done</span>
            </span>
          )}
          {status === 'error' && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-rose-500/10 text-rose-600 dark:text-rose-400 text-[10px] font-medium">
              <AlertCircle className="size-2.5" />
              <span>Error</span>
            </span>
          )}

          <motion.div
            animate={{ rotate: isExpanded ? 180 : 0 }}
            transition={{ duration: 0.2 }}
            className="text-muted-foreground"
          >
            <ChevronDown className="size-3.5" />
          </motion.div>
        </div>
      </button>

      {/* Body */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="border-t border-border/60 bg-surface2/30"
          >
            <div className="p-3 space-y-2 text-xs">
              {inputStr && (
                <div>
                  <div className="text-[10px] uppercase font-semibold text-muted-foreground mb-1 tracking-wider">
                    Parameters / Command
                  </div>
                  <pre className="p-2.5 rounded-lg bg-surface2 font-mono text-[11px] text-foreground-muted overflow-x-auto whitespace-pre-wrap leading-relaxed">
                    {inputStr}
                  </pre>
                </div>
              )}

              {(toolOutput || error) && (
                <div className="relative group/output">
                  <div className="flex items-center justify-between text-[10px] uppercase font-semibold text-muted-foreground mb-1 tracking-wider">
                    <span>Output</span>
                    <button
                      type="button"
                      onClick={handleCopyOutput}
                      className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                    >
                      {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
                      <span>{copied ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                  <pre
                    className={cn(
                      'p-2.5 rounded-lg font-mono text-[11px] max-h-60 overflow-y-auto whitespace-pre-wrap leading-relaxed',
                      error
                        ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20'
                        : 'bg-neutral-900 dark:bg-neutral-950 text-neutral-200'
                    )}
                  >
                    {error || toolOutput}
                  </pre>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
