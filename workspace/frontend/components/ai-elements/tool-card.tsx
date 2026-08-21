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
  CircleSlash,
} from 'lucide-react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
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

/**
 * 从工具入参中提炼出一行「命令 / 目标」摘要，用于头部单行展示，
 * 避免把整段 JSON 直接铺在卡片头部造成日志噪音。
 */
const TARGET_KEYS = ['command', 'cmd', 'file_path', 'filePath', 'path', 'pattern', 'query', 'url', 'prompt'];

function getTargetSummary(toolInput?: Record<string, any> | string): string | null {
  if (!toolInput) return null;
  if (typeof toolInput === 'string') return toolInput.replace(/\s+/g, ' ').trim() || null;
  for (const key of TARGET_KEYS) {
    const value = toolInput[key];
    if (typeof value === 'string' && value.trim()) {
      return value.replace(/\s+/g, ' ').trim();
    }
  }
  const keys = Object.keys(toolInput);
  if (keys.length === 0) return null;
  return keys.map((k) => `${k}=${JSON.stringify(toolInput[k])}`).join(' ').replace(/\s+/g, ' ').slice(0, 240);
}

const STATUS_CHIP: Record<ToolStatus, { label: string; className: string; icon: React.ReactNode }> = {
  running: {
    label: 'Running',
    className:
      'bg-amber-500/10 text-amber-600 dark:bg-amber-400/10 dark:text-amber-400 border-amber-500/20 dark:border-amber-400/20',
    icon: <Loader2 className="size-2.5 animate-spin" />,
  },
  success: {
    label: 'Success',
    className:
      'bg-emerald-500/10 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-400 border-emerald-500/20 dark:border-emerald-400/20',
    icon: <CheckCircle2 className="size-2.5" />,
  },
  error: {
    label: 'Failed',
    className:
      'bg-red-500/10 text-red-600 dark:bg-red-400/10 dark:text-red-400 border-red-500/20 dark:border-red-400/20',
    icon: <AlertCircle className="size-2.5" />,
  },
  cancelled: {
    label: 'Cancelled',
    className:
      'bg-surface2 text-foreground-extra-muted dark:bg-surface2 dark:text-foreground-extra-muted border-border/70',
    icon: <CircleSlash className="size-2.5" />,
  },
};

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
  const reduceMotion = useReducedMotion();

  const inputStr = typeof toolInput === 'string'
    ? toolInput
    : toolInput
    ? JSON.stringify(toolInput, null, 2)
    : null;

  const target = getTargetSummary(toolInput);
  const chip = STATUS_CHIP[status] ?? STATUS_CHIP.success;
  const hasBody = Boolean(inputStr || toolOutput || error);

  const handleCopyOutput = (e: React.MouseEvent) => {
    e.stopPropagation();
    const textToCopy = toolOutput || error || inputStr || '';
    if (!textToCopy) return;
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    toast.success('Output copied');
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div
      className={cn(
        'group/tool my-2 rounded-xl border border-border/70 bg-surface1/80 dark:bg-surface1/40',
        'overflow-hidden shadow-2xs transition-all duration-200',
        'hover:border-border-accent/70',
        status === 'running' && 'border-amber-500/25 dark:border-amber-400/25',
        className
      )}
    >
      {/* Header */}
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        aria-expanded={isExpanded}
        className="w-full flex items-center gap-2.5 px-3 py-2 select-none hover:bg-surface2/50 transition-colors duration-200 text-left cursor-pointer"
      >
        {/* Tool identity */}
        <span
          className={cn(
            'size-6 rounded-lg flex items-center justify-center shrink-0 transition-colors duration-200',
            'bg-surface2 border border-border/60 text-foreground-muted',
            'group-hover/tool:text-foreground'
          )}
        >
          {getToolIcon(toolName)}
        </span>

        <span className="text-xs font-semibold text-foreground shrink-0">{toolName}</span>

        {/* Command / target — quiet mono, always one line */}
        {target && (
          <span className="font-mono text-xs text-foreground-extra-muted truncate min-w-0 flex-1">
            {target}
          </span>
        )}
        {!target && <span className="flex-1 min-w-0" />}

        {/* Status + duration */}
        <span className="flex items-center gap-2 shrink-0">
          {durationMs && durationMs > 0 ? (
            <span className="text-3xs font-mono text-foreground-extra-muted tabular-nums hidden sm:inline">
              {(durationMs / 1000).toFixed(1)}s
            </span>
          ) : null}

          <span
            className={cn(
              'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border',
              'text-3xs font-medium leading-none transition-colors duration-200',
              chip.className,
              status === 'running' && !reduceMotion && 'animate-pulse'
            )}
          >
            {chip.icon}
            <span>{chip.label}</span>
          </span>

          {hasBody && (
            <motion.span
              animate={{ rotate: isExpanded ? 180 : 0 }}
              transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="text-foreground-extra-muted"
            >
              <ChevronDown className="size-3.5" />
            </motion.span>
          )}
        </span>
      </button>

      {/* Body */}
      <AnimatePresence initial={false}>
        {isExpanded && hasBody && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden border-t border-border/50 bg-surface2/25"
          >
            <div className="p-3 space-y-2.5">
              {inputStr && (
                <div className="space-y-1">
                  <div className="text-3xs font-medium uppercase tracking-wider text-foreground-extra-muted">
                    Parameters / Command
                  </div>
                  <pre className="p-2.5 rounded-lg bg-surface2/80 border border-border/50 font-mono text-2xs text-foreground-muted overflow-x-auto leading-relaxed">
                    {inputStr}
                  </pre>
                </div>
              )}

              {(toolOutput || error) && (
                <div className="space-y-1 group/output">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-3xs font-medium uppercase tracking-wider text-foreground-extra-muted">
                      Output
                    </span>
                    <button
                      type="button"
                      onClick={handleCopyOutput}
                      className={cn(
                        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md',
                        'text-3xs font-medium text-foreground-extra-muted',
                        'hover:text-foreground hover:bg-surface2 transition-colors duration-200 cursor-pointer'
                      )}
                    >
                      {copied ? (
                        <Check className="size-3 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <Copy className="size-3" />
                      )}
                      <span>{copied ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                  <pre
                    className={cn(
                      'p-2.5 rounded-lg border font-mono text-2xs leading-relaxed',
                      'max-h-60 overflow-y-auto overflow-x-auto',
                      error
                        ? 'bg-red-500/[0.06] dark:bg-red-400/[0.08] text-red-600 dark:text-red-400 border-red-500/20 dark:border-red-400/20'
                        : 'bg-neutral-950 dark:bg-black/60 text-neutral-200 dark:text-neutral-300 border-transparent dark:border-border/50'
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
