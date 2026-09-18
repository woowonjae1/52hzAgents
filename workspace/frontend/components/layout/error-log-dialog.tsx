'use client';

import * as React from 'react';
import { AlertCircle, Copy, Trash2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { clearErrors, getErrors, subscribeErrors, type LoggedError } from '@/lib/error-log';
import { toast } from '@/lib/toast';

/** Fired by the palette, the shortcut sheet, or an error toast's own action. */
export const ERROR_LOG_EVENT = 'app:error-log';

function timeOf(at: number) {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * The place a three-second toast can be read back from.
 *
 * Deliberately plain: a reverse-chronological list, a timestamp, and one
 * button that puts the whole thing on the clipboard — because the actual next
 * step after "it failed" is usually pasting it to someone else.
 */
export function ErrorLogDialog() {
  const [open, setOpen] = React.useState(false);
  const [items, setItems] = React.useState<LoggedError[]>([]);

  React.useEffect(() => {
    const openIt = () => setOpen(true);
    window.addEventListener(ERROR_LOG_EVENT, openIt);
    return () => window.removeEventListener(ERROR_LOG_EVENT, openIt);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const sync = () => setItems(getErrors());
    sync();
    return subscribeErrors(sync);
  }, [open]);

  const copyAll = () => {
    const text = items
      .map((e) => `[${new Date(e.at).toISOString()}] ${e.message}${e.detail ? `\n    ${e.detail}` : ''}`)
      .join('\n');
    void navigator.clipboard.writeText(text);
    toast.success('Error log copied');
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Recent errors</DialogTitle>
          <DialogDescription>
            Everything the workspace reported in this session, newest first. Cleared when the app restarts.
          </DialogDescription>
        </DialogHeader>

        {items.length === 0 ? (
          <div className="py-12 text-center">
            <AlertCircle className="size-6 mx-auto text-foreground-extra-muted opacity-40" />
            <p className="mt-3 text-xs text-foreground-extra-muted">Nothing has failed yet.</p>
          </div>
        ) : (
          <>
            <div className="max-h-[55vh] overflow-y-auto -mx-1 px-1 space-y-1">
              {items.map((e) => (
                <div
                  key={e.id}
                  className="flex items-start gap-2.5 rounded-lg border border-border/60 bg-surface1 px-3 py-2"
                >
                  <AlertCircle className="size-3.5 text-status-danger shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-foreground leading-snug break-words">{e.message}</p>
                    {e.detail && (
                      <p className="text-3xs text-foreground-extra-muted font-mono mt-1 break-all line-clamp-3">
                        {e.detail}
                      </p>
                    )}
                  </div>
                  <span className="text-3xs text-foreground-extra-muted font-mono shrink-0 tabular-nums">
                    {timeOf(e.at)}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2 pt-4">
              <Button variant="outline" size="sm" onClick={() => { clearErrors(); }}>
                <Trash2 className="size-3.5" />
                Clear
              </Button>
              <Button size="sm" onClick={copyAll}>
                <Copy className="size-3.5" />
                Copy all
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
