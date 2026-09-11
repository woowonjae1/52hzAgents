'use client';

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface PromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  placeholder?: string;
  initialValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Rejecting (or throwing) leaves the dialog open so the value is not lost. */
  onSubmit: (value: string) => void | Promise<void>;
}

/**
 * The sibling of ConfirmDialog, for the case that needs a value back.
 *
 * `window.prompt` was doing this job in the browser panel. It blocks the JS
 * thread — the SSE stream, every heartbeat and every in-flight render stop
 * until the user answers — it cannot be styled, it cannot validate, and in
 * the Electron shell it renders as a detached OS box with the app's name
 * missing from it. It also silently returns `null` on cancel, which reads the
 * same as an empty string at most call sites.
 */
export function PromptDialog({
  open,
  onOpenChange,
  title,
  description,
  placeholder,
  initialValue = '',
  confirmLabel = 'Save',
  cancelLabel = 'Cancel',
  onSubmit,
}: PromptDialogProps) {
  const [value, setValue] = React.useState(initialValue);
  const [busy, setBusy] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Reopening with a different subject must not show the previous answer.
  React.useEffect(() => {
    if (open) {
      setValue(initialValue);
      // Radix moves focus to the content on open; wait a frame so this wins.
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [open, initialValue]);

  const submit = async () => {
    const trimmed = value.trim();
    if (!trimmed || busy) return;
    try {
      setBusy(true);
      await onSubmit(trimmed);
      onOpenChange(false);
    } catch {
      // The caller reports the failure; keep the typed value on screen.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!busy) onOpenChange(v); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && (
            <DialogDescription className="mt-2 text-xs leading-relaxed">
              {description}
            </DialogDescription>
          )}
        </DialogHeader>
        <Input
          ref={inputRef}
          autoFocus
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
          className="h-9 text-sm"
        />
        <DialogFooter className="mt-4 gap-2 sm:gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy || value.trim().length === 0}
            onClick={submit}
          >
            {busy ? `${confirmLabel}…` : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
