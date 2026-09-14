'use client';

/**
 * The last resort: an error thrown in the root layout itself, where `app/
 * error.tsx` cannot render because the layout that would contain it is the
 * thing that failed. Next.js replaces the entire document with this, which is
 * why it has to ship its own <html> and <body> and cannot use any of the app's
 * providers, fonts or theme tokens — none of them are mounted.
 *
 * Deliberately styled inline and in plain colours for that reason. It should
 * be reachable approximately never; it exists so that the failure mode is a
 * message and a button rather than a white rectangle with a titlebar.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          fontFamily: 'system-ui, -apple-system, sans-serif',
          background: '#09090b',
          color: '#f4f4f5',
        }}
      >
        <h1 style={{ fontSize: 16, margin: 0 }}>52hzAgent Studio could not start</h1>
        <p style={{ fontSize: 13, color: '#a1a1aa', margin: 0, maxWidth: 420, textAlign: 'center' }}>
          {error.message || 'An unexpected error occurred while loading the workspace.'}
        </p>
        <button
          type="button"
          onClick={reset}
          style={{
            marginTop: 8,
            background: '#27272a',
            color: '#fff',
            border: '1px solid #3f3f46',
            padding: '8px 16px',
            borderRadius: 6,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
