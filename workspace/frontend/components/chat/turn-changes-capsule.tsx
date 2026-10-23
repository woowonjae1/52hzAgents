'use client';

import { Hint } from '@/components/ui/hint';
import { useState } from 'react';
import { FileCode2, Undo2, FileDiff, PanelRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { workspaceApi } from '@/lib/api';
import { EventLine } from '@/components/ai-elements/event-line';
import { MultiDiffInspector } from '@/components/diff/multi-diff-inspector';
import { ChatAggregatedDiffEntryRow } from '@/components/chat/chat-entry-container';
import { useArtifacts } from '@/lib/artifacts-context';
import type { TurnChangesMetadata } from '@/lib/types';

interface TurnChangesCapsuleProps {
  channelId: string;
  turnChanges: TurnChangesMetadata;
  className?: string;
}

export function TurnChangesCapsule({
  channelId,
  turnChanges,
  className,
}: TurnChangesCapsuleProps) {
  const { openOutput } = useArtifacts();
  const [rollingBack, setRollingBack] = useState(false);
  const [rolledBack, setRolledBack] = useState(turnChanges?.status === 'rolled_back');
  const [showConfirm, setShowConfirm] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectFilePath, setInspectFilePath] = useState<string | undefined>();

  const handleRollback = async () => {
    if (!channelId || !turnChanges?.turn_id || rollingBack || rolledBack) return;
    setRollingBack(true);
    try {
      const res = await workspaceApi.rollbackTurn(channelId, turnChanges.turn_id, false);
      if (res.status === 'ok') {
        setRolledBack(true);
        setShowConfirm(false);
        toast.success(`Rolled back ${res.reverted?.length || 0} file(s) safely`);
      } else if (res.status === 'partially_rolled_back' || res.status === 'partial') {
        setRolledBack(true);
        setShowConfirm(false);
        const failCount = Object.keys(res.failed || {}).length;
        toast.info(`Partially rolled back (${res.reverted?.length || 0} succeeded, ${failCount} failed)`);
      } else {
        const firstErr = res.failed ? Object.values(res.failed)[0] : 'Rollback failed';
        toast.error(`Rollback failed: ${firstErr}`);
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

  const counts = (
    <>
      {additions > 0 && <span className="text-diff-addition">+{additions}</span>}
      {additions > 0 && deletions > 0 && ' '}
      {deletions > 0 && <span className="text-diff-deletion">−{deletions}</span>}
    </>
  );

  return (
    <>
      <EventLine
        className={cn('mt-1', rolledBack && 'opacity-60', className)}
        icon={<FileCode2 />}
        label={rolledBack ? 'Changes rolled back' : `${fileCount} ${fileCount === 1 ? 'file' : 'files'} changed`}
        meta={rolledBack ? undefined : counts}
        actions={
          rolledBack ? undefined : (
            <span className="inline-flex shrink-0 items-center gap-1.5">
              <Hint label="Inspect file diffs side-by-side (J/K to navigate)">
                <button
                  type="button"
                  onClick={() => {
                    setInspectFilePath(files[0]?.path);
                    setInspectorOpen(true);
                  }}
                  className="inline-flex shrink-0 items-center gap-1 rounded-base px-1.5 py-0.5 text-3xs text-foreground-extra-muted transition-colors hover:bg-surface2 hover:text-foreground cursor-pointer"
                >
                  <FileDiff className="size-2.5" />
                  <span>Inspect diff</span>
                </button>
              </Hint>

              <Hint label="Open in right Studio panel">
                <button
                  type="button"
                  onClick={() => {
                    if (files[0]) {
                      openOutput({ kind: 'change', path: files[0].path, turnId: turnChanges?.turn_id || '' });
                    }
                  }}
                  className="inline-flex shrink-0 items-center gap-1 rounded-base px-1.5 py-0.5 text-3xs text-foreground-extra-muted transition-colors hover:bg-surface2 hover:text-foreground cursor-pointer"
                >
                  <PanelRight className="size-2.5" />
                  <span>Studio</span>
                </button>
              </Hint>

              {showConfirm ? (
                <span className="inline-flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={handleRollback}
                    disabled={rollingBack}
                    className={cn(
                      'rounded-base bg-destructive px-2 py-0.5 text-3xs font-medium',
                      'text-destructive-foreground transition-opacity hover:opacity-90',
                      'disabled:cursor-default disabled:opacity-50'
                    )}
                  >
                    {rollingBack ? 'Rolling back…' : 'Confirm'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowConfirm(false)}
                    disabled={rollingBack}
                    className="rounded-base px-1.5 py-0.5 text-3xs text-foreground-extra-muted transition-colors hover:bg-surface2 hover:text-foreground cursor-pointer"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <Hint label="Roll back this agent turn's changes without affecting manual user edits">
                  <button
                    type="button"
                    onClick={() => setShowConfirm(true)}
                    className="inline-flex shrink-0 items-center gap-1 rounded-base px-1.5 py-0.5 text-3xs text-foreground-extra-muted transition-colors hover:bg-surface2 hover:text-foreground cursor-pointer"
                  >
                    <Undo2 className="size-2.5" />
                    <span>Roll back</span>
                  </button>
                </Hint>
              )}
            </span>
          )
        }
      >
        {files.length > 0 && (
          <div className="space-y-1.5 py-1">
            {files.map((file) => (
              <ChatAggregatedDiffEntryRow
                key={file.path}
                channelId={channelId}
                turnId={turnChanges?.turn_id}
                file={file}
                onOpenInChanges={() => {
                  openOutput({ kind: 'change', path: file.path, turnId: turnChanges?.turn_id || '' });
                }}
              />
            ))}
          </div>
        )}
      </EventLine>

      <MultiDiffInspector
        isOpen={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        channelId={channelId}
        files={files}
        turnId={turnChanges?.turn_id}
        initialFilePath={inspectFilePath}
        title={`Turn Changes (${fileCount} ${fileCount === 1 ? 'file' : 'files'})`}
        onRollback={handleRollback}
        isRollingBack={rollingBack}
        isRolledBack={rolledBack}
      />
    </>
  );
}
