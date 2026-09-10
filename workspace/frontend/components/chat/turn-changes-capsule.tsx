'use client';

import { Hint } from '@/components/ui/hint';
import { useState } from 'react';
import { FileCode2, Undo2, FileDiff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { workspaceApi } from '@/lib/api';
import { EventLine } from '@/components/ai-elements/event-line';
import { MultiDiffInspector } from '@/components/diff/multi-diff-inspector';
import type { TurnChangesMetadata } from '@/lib/types';

interface TurnChangesCapsuleProps {
  channelId: string;
  turnChanges: TurnChangesMetadata;
  className?: string;
}

/**
 * Everything one agent turn changed on disk, and the way to undo it.
 *
 * This was its own card — `rounded-xl` + border + `shadow-xs` + a tinted header
 * bar + its own chevron — sitting directly beneath a transcript whose every
 * other event had by then become a plain line. It now draws through `EventLine`
 * like the rest, so the summary of a turn's edits reads as one more event in the
 * same column rather than as a widget bolted underneath.
 *
 * The rollback flow is untouched. The reference design this borrows its summary
 * shape from has nothing equivalent, and the expanded list is kept as a list
 * rather than reduced to file chips: it carries a change status, a path, a
 * `pre-existing` warning and two counts per row, and chips would drop three of
 * those four.
 */

/**
 * The letter git uses for what happened to a file: A added, D deleted, M
 * modified, ? untracked.
 *
 * Was three filled, bordered badges in success-green / danger-red /
 * warning-amber. Now it is the bare letter in the diff palette — the same two
 * tokens the `+`/`−` counts beside it use, and the same two `FileDiff` paints
 * its rows with. Amber is gone entirely: "modified" is the ordinary case here,
 * not a caution.
 */
function ChangeMark({ status }: { status: string }) {
  const added = status === 'A' || status === '?';
  const deleted = status === 'D';
  return (
    <span
      className={cn(
        'w-3 shrink-0 text-center font-mono text-3xs font-medium',
        added && 'text-diff-addition',
        deleted && 'text-diff-deletion',
        !added && !deleted && 'text-foreground-extra-muted'
      )}
      title={added ? 'added' : deleted ? 'deleted' : 'modified'}
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

  const counts = (
    <>
      {additions > 0 && <span className="text-diff-addition">+{additions}</span>}
      {additions > 0 && deletions > 0 && ' '}
      {/* U+2212 MINUS, not a hyphen: in a mono face the two are different widths,
          so mixing them makes a column of +/− counts fail to line up. */}
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
                  className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-base px-1.5 py-0.5 text-3xs text-foreground-extra-muted transition-colors hover:bg-surface2 hover:text-foreground"
                >
                  <FileDiff className="size-2.5" />
                  <span>Inspect diff</span>
                </button>
              </Hint>

              {showConfirm ? (
                <span className="inline-flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={handleRollback}
                    disabled={rollingBack}
                    className={cn(
                      'cursor-pointer rounded-base bg-destructive px-2 py-0.5 text-3xs font-medium',
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
                    className="cursor-pointer rounded-base px-1.5 py-0.5 text-3xs text-foreground-extra-muted transition-colors hover:bg-surface2 hover:text-foreground"
                  >
                    Cancel
                  </button>
                </span>
              ) : (
                <Hint label="Roll back this agent turn's changes without affecting manual user edits">
                  <button
                    type="button"
                    onClick={() => setShowConfirm(true)}
                    className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-base px-1.5 py-0.5 text-3xs text-foreground-extra-muted transition-colors hover:bg-surface2 hover:text-foreground"
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
          <div className="max-h-48 overflow-y-auto py-0.5">
            {files.map((file) => (
              <button
                key={file.path}
                type="button"
                onClick={() => {
                  setInspectFilePath(file.path);
                  setInspectorOpen(true);
                }}
                className="-mx-1 w-[calc(100%+8px)] flex items-baseline justify-between gap-2 rounded-base px-1 py-0.5 font-mono text-2xs transition-colors hover:bg-surface2 text-left cursor-pointer group"
                title="Click to inspect diff"
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  <ChangeMark status={file.status} />
                  <span className="truncate text-foreground-muted group-hover:text-foreground group-hover:underline decoration-foreground-extra-muted" title={file.path}>
                    {file.path}
                  </span>
                  {file.pre_existing && (
                    <span className="shrink-0 text-3xs text-foreground-extra-muted">
                      pre-existing
                    </span>
                  )}
                </span>
                <span className="shrink-0 tabular-nums text-3xs">
                  {file.additions > 0 && <span className="text-diff-addition">+{file.additions}</span>}
                  {file.additions > 0 && file.deletions > 0 && ' '}
                  {file.deletions > 0 && <span className="text-diff-deletion">−{file.deletions}</span>}
                </span>
              </button>
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
