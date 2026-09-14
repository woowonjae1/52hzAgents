/**
 * ONE WAY TO GET A FILE OUT OF THIS APP.
 *
 * There were two, and one of them did not work.
 *
 * Seven places built an `<a download>`, appended it, clicked it and removed it
 * — correct, and duplicated seven times. The file preview instead called
 * `window.open(url, '_blank')`, which in a browser tab opens the file and in
 * the desktop shell hit `setWindowOpenHandler`, matched the "this is our own
 * server" branch, and was denied with nothing in its place. The button did
 * nothing, silently, in the only build most users run.
 *
 * In the shell the anchor now reaches Electron's `will-download`, which gives
 * it a native Save As dialog and reports back when the bytes have landed —
 * that is what turns "the click did something invisible" into "Saved · Show in
 * folder" (see components/layout/desktop-integration.tsx).
 */

/**
 * Trigger a download of `url`, named `filename`.
 *
 * `target` is deliberately NOT set: `target="_blank"` on a download anchor
 * makes Chromium consider opening a window first, which is what routed the old
 * call into the shell's window handler. A plain `download` attribute does not.
 */
export function downloadUrl(url: string, filename?: string): void {
  if (typeof document === 'undefined') return;
  const link = document.createElement('a');
  link.href = url;
  // Empty string still means "download rather than navigate"; the server's
  // Content-Disposition then picks the name.
  link.download = filename ?? '';
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/** Download an in-memory string as a file. Revokes its own object URL. */
export function downloadBlob(content: BlobPart, filename: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  downloadUrl(url, filename);
  // The click is synchronous but the fetch of the blob URL is not; revoking in
  // the same tick cancels the download on some builds.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
