'use client';

import { memo, useState, useCallback, useMemo } from 'react';
import { Eye, FileIcon, Download, X } from 'lucide-react';
import { Hint } from '@/components/ui/hint';
import { useLayout } from '@/components/layout/layout-context';
import { useWorkspace } from '@/lib/workspace-context';
import { useArtifacts } from '@/lib/artifacts-context';
import { downloadUrl } from '@/lib/download';
import { workspaceApi } from '@/lib/api';

export interface Attachment {
  fileId: string;
  filename: string;
  contentType: string;
  url: string;
}

export function isPreviewable(contentType: string, filename: string): boolean {
  if (contentType?.startsWith('image/')) return true;
  if (contentType === 'text/html' || /\.html?$/i.test(filename)) return true;
  if (contentType === 'text/markdown' || /\.mdx?$/i.test(filename)) return true;
  if (contentType?.startsWith('text/') || /\.(json|js|ts|tsx|jsx|py|rs|go|java|rb|sh|yaml|yml)$/i.test(filename)) return true;
  return false;
}

export const MessageAttachments = memo(function MessageAttachments({ items }: { items: Attachment[] }) {
  const { setActiveRightTab } = useLayout();
  const { setSelectedFileId } = useWorkspace();
  const { openOutput } = useArtifacts();
  const [lightboxImage, setLightboxImage] = useState<{ url: string; filename: string } | null>(null);

  const openPreview = useCallback((fileId: string) => {
    setSelectedFileId(fileId);
    openOutput({ kind: 'file' });
    setActiveRightTab('canvas');
  }, [setSelectedFileId, openOutput, setActiveRightTab]);

  const handleDownload = useCallback((url: string, filename: string) => {
    downloadUrl(url, filename);
  }, []);

  const fixedItems = useMemo(() =>
    (items || []).map((a) => ({ ...a, url: workspaceApi.getFileUrl(a.fileId) })),
    [items]
  );

  const images = useMemo(() => fixedItems.filter((a) => a.contentType?.startsWith('image/')), [fixedItems]);
  const files = useMemo(() => fixedItems.filter((a) => !a.contentType?.startsWith('image/')), [fixedItems]);

  if (!items || items.length === 0) return null;

  return (
    <div className="mt-2 space-y-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((img) => (
            <button
              key={img.fileId}
              type="button"
              onClick={() => setLightboxImage({ url: img.url, filename: img.filename })}
              className="block rounded-xl overflow-hidden border border-border hover:border-primary/40 hover:shadow-md ui-transition max-w-sm text-left cursor-zoom-in"
            >
              <img
                src={img.url}
                alt={img.filename}
                className="max-h-64 min-h-[48px] w-auto object-contain bg-surface2/30"
                loading="lazy"
              />
            </button>
          ))}
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((file) => {
            const previewable = isPreviewable(file.contentType, file.filename);
            return (
              <div
                key={file.fileId}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-border bg-surface2 hover:bg-surface3 transition-colors text-xs font-medium group"
              >
                <Hint label="View in Files">
                  <button
                    type="button"
                    onClick={() => openPreview(file.fileId)}
                    className="inline-flex items-center gap-2 text-foreground hover:text-primary transition-colors"
                  >
                    {previewable ? (
                      <Eye className="size-3.5 text-primary shrink-0" />
                    ) : (
                      <FileIcon className="size-3.5 text-muted-foreground shrink-0" />
                    )}
                    <span className="truncate max-w-[200px]">{file.filename}</span>
                  </button>
                </Hint>
                <Hint label="Download file">
                  <button
                    type="button"
                    onClick={() => handleDownload(file.url, file.filename)}
                    className="size-5 rounded hover:bg-surface1 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors ml-1"
                  >
                    <Download className="size-3" />
                  </button>
                </Hint>
              </div>
            );
          })}
        </div>
      )}

      {/* Inline Image Lightbox Modal */}
      {lightboxImage && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setLightboxImage(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-xs p-4 animate-in fade-in duration-150 select-none"
        >
          <div className="relative max-w-4xl max-h-[90vh] flex flex-col items-center" onClick={(e) => e.stopPropagation()}>
            <div className="absolute top-2 right-2 flex items-center gap-2 z-10">
              <button
                type="button"
                onClick={() => downloadUrl(lightboxImage.url, lightboxImage.filename)}
                className="size-8 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center transition-colors"
                title="Download image"
              >
                <Download className="size-4" />
              </button>
              <button
                type="button"
                onClick={() => setLightboxImage(null)}
                className="size-8 rounded-full bg-black/60 hover:bg-black/80 text-white flex items-center justify-center transition-colors"
                title="Close"
              >
                <X className="size-4" />
              </button>
            </div>
            <img
              src={lightboxImage.url}
              alt={lightboxImage.filename}
              className="max-h-[85vh] max-w-full rounded-lg object-contain shadow-2xl"
            />
            <p className="mt-2 text-xs text-white/80 font-mono truncate">{lightboxImage.filename}</p>
          </div>
        </div>
      )}
    </div>
  );
});
