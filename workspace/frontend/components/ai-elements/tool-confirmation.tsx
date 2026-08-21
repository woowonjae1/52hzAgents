'use client';

import * as React from 'react';
import { Terminal, FileCode, Check, X, ShieldAlert, Clock, Loader2, Copy } from 'lucide-react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

export interface ToolConfirmationProps {
  toolName?: string;
  args?: Record<string, any> | string;
  approvalId?: string;
  status?: 'pending' | 'approved' | 'denied';
  onApprove: () => Promise<void> | void;
  onDeny: () => Promise<void> | void;
  className?: string;
}

export function ToolConfirmation({
  toolName,
  args,
  approvalId,
  status = 'pending',
  onApprove,
  onDeny,
  className,
}: ToolConfirmationProps) {
  const [loadingAction, setLoadingAction] = React.useState<'approve' | 'deny' | null>(null);
  const [copied, setCopied] = React.useState(false);

  const formattedArgs = React.useMemo(() => {
    if (!args) return '';
    if (typeof args === 'string') return args;
    try {
      return JSON.stringify(args, null, 2);
    } catch {
      return String(args);
    }
  }, [args]);

  const handleApproveClick = async () => {
    setLoadingAction('approve');
    try {
      await onApprove();
    } finally {
      setLoadingAction(null);
    }
  };

  const handleDenyClick = async () => {
    setLoadingAction('deny');
    try {
      await onDeny();
    } finally {
      setLoadingAction(null);
    }
  };

  const handleCopyArgs = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!formattedArgs) return;
    navigator.clipboard.writeText(formattedArgs);
    setCopied(true);
    toast.success('Arguments copied');
    setTimeout(() => setCopied(false), 2000);
  };

  const isPending = status === 'pending';
  const isApproved = status === 'approved';
  const isDenied = status === 'denied';

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        'my-3 overflow-hidden rounded-2xl border transition-all shadow-xs',
        isPending && 'border-amber-500/40 bg-amber-500/[0.03] dark:bg-amber-500/[0.05]',
        isApproved && 'border-emerald-500/30 bg-emerald-500/[0.02]',
        isDenied && 'border-rose-500/30 bg-rose-500/[0.02]',
        className
      )}
    >
      {/* Header Bar */}
      <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 bg-surface2/40 border-b border-border/30">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={cn(
              'size-6 rounded-lg flex items-center justify-center shrink-0',
              isPending && 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
              isApproved && 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
              isDenied && 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
            )}
          >
            {isPending ? (
              <ShieldAlert className="size-3.5 animate-pulse" />
            ) : isApproved ? (
              <Check className="size-3.5" />
            ) : (
              <X className="size-3.5" />
            )}
          </span>

          <div className="flex items-center gap-1.5 min-w-0">
            <span className="text-xs font-semibold text-foreground truncate">
              {isPending ? 'Needs your approval' : isApproved ? 'Approved' : 'Denied'}
            </span>
            <span className="text-2xs font-mono px-1.5 py-0.2 rounded bg-surface2 text-primary font-medium truncate">
              {toolName}
            </span>
          </div>
        </div>

        {/* Status Pill */}
        {approvalId && (
          <span className="text-3xs font-mono text-muted-foreground/70 hidden sm:inline">
            ID: {approvalId.slice(-6)}
          </span>
        )}
      </div>

      {/* Body: Command / Arguments Preview */}
      {formattedArgs && (
        <div className="p-3 space-y-1.5">
          <div className="flex items-center justify-between text-3xs text-muted-foreground font-mono">
            <span>Arguments</span>
            <button
              type="button"
              onClick={handleCopyArgs}
              className="flex items-center gap-1 text-3xs hover:text-foreground transition-colors cursor-pointer"
            >
              {copied ? <Check className="size-2.5 text-emerald-500" /> : <Copy className="size-2.5" />}
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>

          <pre className="p-2.5 rounded-xl bg-neutral-950 text-neutral-200 font-mono text-2xs overflow-x-auto leading-relaxed max-h-48 border border-neutral-800/80 shadow-inner">
            {formattedArgs}
          </pre>
        </div>
      )}

      {/* Action Footer */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-surface2/30">
        {isPending ? (
          <>
            <span className="text-2xs text-muted-foreground">
              Allow the agent to run this?
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleDenyClick}
                disabled={Boolean(loadingAction)}
                className="inline-flex items-center gap-1 px-3 py-1 rounded-xl text-xs font-medium text-rose-600 hover:bg-rose-500/10 border border-rose-500/20 transition-all cursor-pointer"
              >
                {loadingAction === 'deny' ? <Loader2 className="size-3 animate-spin" /> : <X className="size-3" />}
                <span>Deny</span>
              </button>
              <button
                type="button"
                onClick={handleApproveClick}
                disabled={Boolean(loadingAction)}
                className="inline-flex items-center gap-1 px-3.5 py-1 rounded-xl text-xs font-semibold bg-primary text-primary-foreground hover:opacity-90 transition-all cursor-pointer shadow-xs"
              >
                {loadingAction === 'approve' ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                <span>Approve</span>
              </button>
            </div>
          </>
        ) : isApproved ? (
          <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
            <Check className="size-3.5" />
            <span>Approved — running…</span>
          </span>
        ) : (
          <span className="text-xs font-medium text-rose-600 dark:text-rose-400 flex items-center gap-1.5">
            <X className="size-3.5" />
            <span>This tool call was denied</span>
          </span>
        )}
      </div>
    </motion.div>
  );
}
