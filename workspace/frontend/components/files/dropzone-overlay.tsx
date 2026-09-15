'use client';

import { UploadCloud } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLayout } from '@/components/layout/layout-context';
import { useWorkspace } from '@/lib/workspace-context';
import { toast } from 'sonner';

export function DropzoneOverlay() {
  const [isDragging, setIsDragging] = useState(false);
  const { uploadFile } = useWorkspace();
  const { viewMode } = useLayout();

  // The knowledge view owns drops while it is open — a .md dropped there is an
  // import, not a shared-storage upload. Standing down entirely (rather than
  // racing on the same window events) keeps that unambiguous.
  const suspended = viewMode === 'knowledge';

  useEffect(() => {
    if (suspended) {
      setIsDragging(false);
      return;
    }
    let dragCounter = 0;

    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter++;
      if (e.dataTransfer?.items && e.dataTransfer.items.length > 0) {
        setIsDragging(true);
      }
    };

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter--;
      if (dragCounter === 0) {
        setIsDragging(false);
      }
    };

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };

    const handleDrop = async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      dragCounter = 0;

      const droppedFiles = e.dataTransfer?.files;
      if (!droppedFiles || droppedFiles.length === 0) return;

      try {
        for (let i = 0; i < droppedFiles.length; i++) {
          await uploadFile(droppedFiles[i]);
        }
        toast.success(
          droppedFiles.length === 1
            ? `Uploaded ${droppedFiles[0].name}`
            : `Uploaded ${droppedFiles.length} files`
        );
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Upload failed');
      }
    };

    window.addEventListener('dragenter', handleDragEnter);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('drop', handleDrop);

    return () => {
      window.removeEventListener('dragenter', handleDragEnter);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('drop', handleDrop);
    };
  }, [uploadFile, suspended]);

  if (!isDragging) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-background/80 dark:bg-background/85 backdrop-blur-xl animate-in fade-in-0 duration-200 pointer-events-none select-none">
      <div className="w-full h-full max-w-2xl max-h-[460px] rounded-3xl border-2 border-dashed border-accent-bright/35 dark:border-accent/30 bg-surface-overlay/90 dark:bg-surface1/90 shadow-2xl flex flex-col items-center justify-center p-8 text-center transition-transform animate-in zoom-in-95 duration-200">
        <div className="size-20 rounded-2xl bg-surface2 border border-border-accent shadow-sm flex items-center justify-center mb-4">
          <UploadCloud className="size-10 text-foreground transition-transform animate-pulse" />
        </div>
        <h3 className="text-xl font-semibold tracking-tight text-foreground">
          Drop files to upload
        </h3>
        <p className="text-sm text-foreground-muted mt-1.5 max-w-sm leading-relaxed">
          Files will be added directly to Workspace Shared Storage & available to all agents
        </p>
        <div className="mt-5 inline-flex items-center gap-2 px-3 py-1 rounded-full bg-surface2 border border-border text-2xs font-medium text-foreground-extra-muted">
          <span>Release pointer to upload</span>
        </div>
      </div>
    </div>
  );
}