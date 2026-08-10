'use client';

import { UploadCloud } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useWorkspace } from '@/lib/workspace-context';
import { toast } from 'sonner';

export function DropzoneOverlay() {
  const [isDragging, setIsDragging] = useState(false);
  const { uploadFile } = useWorkspace();

  useEffect(() => {
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
  }, [uploadFile]);

  if (!isDragging) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-primary/80 backdrop-blur-md border-4 border-dashed border-border-accent animate-[fadeIn_0.15s_ease-out] text-white p-6">
      <div className="size-20 rounded-full bg-surface3 border border-border-accent flex items-center justify-center mb-4 animate-bounce">
        <UploadCloud className="size-10 text-foreground-muted" />
      </div>
      <h3 className="text-xl font-semibold tracking-tight">Drop files to upload</h3>
      <p className="text-sm text-foreground-extra-muted mt-1 max-w-sm text-center">
        Files will be added directly to the Workspace Shared Storage
      </p>
    </div>
  );
}