'use client';

import * as React from 'react';
import { ShieldAlert, Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { EventLine, EventLineAction, EventLinePre } from './event-line';

export interface ToolConfirmationProps {
  toolName?: string;
  args?: Record<string, any> | string;
  approvalId?: string;
  status?: 'pending' | 'approved' | 'denied';
  onApprove: () => Promise<void> | void;
  onDeny: () => Promise<void> | void;
  className?: string;
}

/**
 * A tool call the agent is not allowed to make without an answer.
 *
 * `alwaysOpen`, because a question nobody can see is not a question — this is the
 * other case the flag exists for. Everything else about the frame is the shared
 * one: no tinted card, no amber/emerald/rose triad, no pulsing shield.
 *
 * Which is not to say this row is quiet. It is the only event kind in the
 * transcript that BLOCKS, and what carries that is the wording ("Needs your
 * approval") plus two real buttons — not a colour. The two resolved states say
 * plainly what happened and then stop asking for attention, because there is
 * nothing left to do about them.
 */
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

  return (
    <EventLine
      className={className}
      icon={<ShieldAlert />}
      label={isPending ? 'Needs your approval' : status === 'approved' ? 'Approved' : 'Denied'}
      detail={toolName}
      // `blocked` is exactly what a denial is: a policy said no and nothing the
      // agent does differently will help.
      state={status === 'denied' ? 'blocked' : 'idle'}
      meta={approvalId ? approvalId.slice(-6) : undefined}
      alwaysOpen={isPending}
      defaultOpen={false}
    >
      <div className="space-y-1.5 py-0.5">
        {formattedArgs && (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-3xs uppercase tracking-wider text-foreground-extra-muted">
                Arguments
              </span>
              <EventLineAction onClick={handleCopyArgs} title="Copy arguments">
                {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </EventLineAction>
            </div>
            <EventLinePre>{formattedArgs}</EventLinePre>
          </>
        )}

        {isPending && (
          <div className="flex items-center gap-2 pt-0.5">
            {/*
             * Deny leads. The destructive action being second is a habit from
             * dialogs where the safe choice is the default; here the safe choice
             * is to NOT let it run, so approve is the one that should take the
             * deliberate reach.
             */}
            <button
              type="button"
              onClick={handleDenyClick}
              disabled={Boolean(loadingAction)}
              className={cn(
                'cursor-pointer rounded-base border border-border px-2.5 py-1 text-xs',
                'text-destructive transition-colors hover:bg-destructive/10',
                'disabled:cursor-default disabled:opacity-50'
              )}
            >
              {loadingAction === 'deny' ? 'Denying…' : 'Deny'}
            </button>
            <button
              type="button"
              onClick={handleApproveClick}
              disabled={Boolean(loadingAction)}
              className={cn(
                'cursor-pointer rounded-base bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground',
                'transition-opacity hover:opacity-90',
                'disabled:cursor-default disabled:opacity-50'
              )}
            >
              {loadingAction === 'approve' ? 'Approving…' : 'Approve'}
            </button>
          </div>
        )}
      </div>
    </EventLine>
  );
}
