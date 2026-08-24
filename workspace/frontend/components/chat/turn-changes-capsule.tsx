'use client';

import { useState } from 'react';
import { FileCode2, Undo2, ChevronDown, Check, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { workspaceApi } from '@/lib/api';
import type { TurnChangesMetadata } from '@/lib/types';

interface TurnChangesCapsuleProps {
  channelId: string;
  turnChanges: TurnChangesMetadata;
  className?: string;
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === 'A' || status === '?'
      ? 'bg-status-success/10 text-status-success border-status-success/20'
      : status === 'D'
        ? 'bg-status-danger/10 text-status-danger border-status-danger/20'
        : 'bg-status-warning/10 text-status-warning border-status-warning/20';

  return (
    <span
      className={cn(
        'inline-flex items-center justify-center size-4 rounded text-3xs font-mono font-bold border shrink-0',
        tone
      )}
    >
      {status === '?' ? 'U' : status}
    </span>
  );
}

export function TurnChangesCapsule({
  channelId,
  turnChanges,
  className,
}: TurnChangesCapsuleProps) {
  const [expanded, setExpanded] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);
  const [rolledBack, setRolledBack] = useState(turnChanges?.status === 'rolled_back');
  const [showConfirm, setShowConfirm] = useState(false);

  const handleRollback = async () => {
    if (!channelId || !turnChanges?.turn_id || rollingBack || rolledBack) return;
    setRollingBack(true);
    try {
      const res = await workspaceApi.rollbackTurn(channelId, turnChanges.turn_id, false);
      if (res.status === 'ok') {
        setRolledBack(true);
        setShowConfirm(false);
        toast.success(`Rolled back ${res.reverted?.length || 0} file(s) safely`);
      } else {
        toast.error('Rollback completed with warnings');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Rollback failed');
    } finally {
      setRollingBack(false);
    }
  };

  const files = turnChanges?.changes || [];
  const fileCount = turnChanges?.file_count || files.length;
  const additions = turnChanges?.additions || 0;
  const deletions = turnChanges?.deletions || 0;

  if (!turnChanges || fileCount === 0) return null;

  return (
    <div
      className={cn(
        'mt-2.5 rounded-xl border border-border/80 bg-surface1/60 overflow-hidden text-xs transition-all shadow-2xs',
        rolledBack && 'opacity-60 border-dashed',
        className
      )}
    >
      {/* Header Row */}
      <div className="flex items-center justify-between px-3 py-2 gap-2 bg-surface2/40">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 text-foreground hover:text-foreground/80 min-w-0 cursor-pointer select-none"
        >
          <FileCode2 className="size-3.5 text-foreground-muted shrink-0" />
          <span className="font-medium truncate">
            {fileCount} {fileCount === 1 ? 'file' : 'files'} modified
          </span>
          <span className="font-mono tabular-nums text-3xs shrink-0">
            {additions > 0 && <span className="text-status-success">+{additions}</span>}
            {additions > 0 && deletions > 0 && ' '}
            {deletions > 0 && <span className="text-status-danger">−{deletions}</span>}
          </span>
          <ChevronDown
            className={cn(
              'size-3 text-foreground-extra-muted transition-transform duration-200',
              expanded && 'rotate-180'
            )}
          />
        </button>

        {/* Action button */}
        <div className="flex items-center gap-1.5 shrink-0">
          {rolledBack ? (
            <span className="inline-flex items-center gap-1 text-3xs text-foreground-extra-muted font-medium px-2 py-0.5 rounded-md bg-surface3 border border-border/50">
              <Check className="size-2.5 text-status-success" />
              Rolled Back
            </span>
          ) : showConfirm ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleRollback}
                disabled={rollingBack}
                className="inline-flex items-center gap-1 px-2 py-1 text-3xs font-semibold rounded-md bg-status-danger text-white hover:bg-status-danger/90 transition-colors cursor-pointer"
              >
                {rollingBack ? <Loader2 className="size-2.5 animate-spin" /> : <Undo2 className="size-2.5" />}
                Confirm Rollback
              </button>
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                disabled={rollingBack}
                className="px-1.5 py-1 text-3xs rounded-md text-foreground-extra-muted hover:text-foreground hover:bg-surface3 transition-colors cursor-pointer"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowConfirm(true)}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-3xs font-medium rounded-md bg-surface2 hover:bg-surface3 text-foreground-muted hover:text-foreground transition-colors cursor-pointer border border-border/60"
              title="Rollback this agent turn's changes without affecting manual user edits"
            >
              <Undo2 className="size-2.5" />
              Rollback Turn
            </button>
          )}
        </div>
      </div>

      {/* Expanded File List */}
      {expanded && files.length > 0 && (
        <div className="border-t border-border/60 divide-y divide-border/40 max-h-48 overflow-y-auto bg-surface0/40 font-mono text-2xs py-0.5">
          {files.map((file) => (
            <div
              key={file.path}
              className="flex items-center justify-between px-3 py-1 gap-2 hover:bg-surface2/50 transition-colors"
            >
              <div className="flex items-center gap-2 min-w-0 truncate">
                <StatusBadge status={file.status} />
                <span className="truncate text-foreground-muted" title={file.path}>
                  {file.path}
                </span>
                {file.pre_existing && (
                  <span className="text-3xs text-status-warning bg-status-warning/10 px-1 py-0.2 rounded border border-status-warning/20 shrink-0">
                    pre-existing
                  </span>
                )}
              </div>
              <span className="shrink-0 tabular-nums text-3xs">
                {file.additions > 0 && <span className="text-status-success">+{file.additions}</span>}
                {file.additions > 0 && file.deletions > 0 && ' '}
                {file.deletions > 0 && <span className="text-status-danger">−{file.deletions}</span>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
