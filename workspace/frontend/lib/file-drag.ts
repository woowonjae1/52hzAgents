/**
 * DRAGGING A FILE OUT OF THE WINDOW.
 *
 * In a desktop application a file in a list is a file: you drag it to the
 * desktop, to a Finder/Explorer window, onto another app's drop target. Here
 * the only way out was the download button, because nothing in the app was
 * `draggable` at all — a row was a div you could click and nothing else.
 *
 * `DownloadURL` is the Chromium data-transfer type that means "this drag
 * carries a file the receiver should fetch". Its format is exactly
 * `mime:filename:absolute-url`, colon-separated, and the URL must be absolute —
 * a relative one silently produces a drag that drops nothing. Electron honours
 * it the same way Chrome does, so the same code works in the shell and in a
 * browser tab.
 *
 * `text/uri-list` and `text/plain` ride along for targets that do not speak
 * DownloadURL — a text editor, a chat box, the address bar — which get a link
 * instead of a file rather than getting nothing.
 */

export interface DraggableFile {
  filename: string;
  contentType?: string | null;
  /** Absolute http(s) URL the receiver can fetch the bytes from. */
  url: string;
}

/** Strip any directory prefix — the receiver wants a name, not a path. */
function leafName(filename: string): string {
  const leaf = filename.split(/[\/]/).pop() || filename;
  // Colons are the DownloadURL field separator, so a name containing one
  // truncates the URL and the drop fails with no error anywhere.
  return leaf.replace(/:/g, '-');
}

export function setFileDragData(dataTransfer: DataTransfer, file: DraggableFile): void {
  const name = leafName(file.filename);
  const mime = file.contentType || 'application/octet-stream';

  dataTransfer.effectAllowed = 'copy';
  try {
    dataTransfer.setData('DownloadURL', `${mime}:${name}:${file.url}`);
  } catch {
    // Firefox rejects the type outright; the fallbacks below still apply.
  }
  dataTransfer.setData('text/uri-list', file.url);
  dataTransfer.setData('text/plain', file.url);
}

/** Props to spread onto a row so it can be dragged out of the window. */
export function fileDragProps(file: DraggableFile) {
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      setFileDragData(e.dataTransfer, file);
    },
  };
}
