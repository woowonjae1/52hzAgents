'use client';

import * as React from 'react';
import { RefreshCw, ClipboardCopy } from 'lucide-react';

/**
 * THE WINDOW DOES NOT GO WHITE.
 *
 * The app had exactly one error boundary, around the markdown renderer. Any
 * other render error — a view, the shell, a context — unmounted the tree and
 * left a blank window. In a browser tab that is recoverable: reload. In the
 * desktop shell there is no address bar, no reload button, and (since the View
 * menu's Reload is now development-only) no key for it either. A blank window
 * with a titlebar was a dead end you could only quit out of.
 *
 * Next.js renders this in place of the crashed segment and hands over `reset`,
 * which re-renders it rather than reloading the process — so the SSE
 * connection, the loaded workspace and anything typed elsewhere survive.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [copied, setCopied] = React.useState(false);

  const details = [
    error.message,
    error.digest ? `digest: ${error.digest}` : null,
    error.stack,
  ]
    .filter(Boolean)
    .join('\n\n');

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-background p-8 text-center">
      <div>
        <h1 className="text-base font-semibold text-foreground">This view stopped responding</h1>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">
          The rest of the workspace is still running. Reloading this view keeps your session,
          your threads and anything you have typed elsewhere.
        </p>
      </div>

      {/*
        The message, not a generic apology. Whoever hits this is the person who
        can report it, and asking them to reproduce it with devtools open — in a
        build where devtools are gone — is asking for nothing.
      */}
      <pre className="max-h-40 max-w-xl overflow-auto rounded-lg border border-border bg-surface1 p-3 text-left text-2xs text-muted-foreground">
        {error.message || 'Unknown error'}
      </pre>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={reset}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:opacity-90"
        >
          <RefreshCw className="size-3.5" />
          Reload this view
        </button>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard.writeText(details);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ClipboardCopy className="size-3.5" />
          {copied ? 'Copied' : 'Copy details'}
        </button>
      </div>
    </div>
  );
}
