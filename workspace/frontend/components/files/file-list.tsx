'use client';

import { Hint } from '@/components/ui/hint';
import { useRef, useState, useMemo, useEffect, useCallback } from 'react';
import { Search, Upload, FolderOpen, Trash2, Download, X, CheckSquare } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { workspaceApi } from '@/lib/api';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { formatSize, getFileIcon, timeAgo, basename } from './file-utils';
import { stripAddressPrefix } from '@/lib/types';
import type { WorkspaceFile } from '@/lib/types';

export function FileList() {
  const { files: allFiles, selectedFileId, setSelectedFileId, uploadFile, deleteFile, currentFilePath, currentSessionId } = useWorkspace();
  const { isMobile, openMobileDetail, setActiveRightTab } = useLayout();
  const [search, setSearch] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Multi-selection state
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);

  // Confirmation dialogs
  const [singleDeleteTarget, setSingleDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [batchDeleteConfirmOpen, setBatchDeleteConfirmOpen] = useState(false);
  const [deletingBatch, setDeletingBatch] = useState(false);

  // What this thread produced, not the whole workspace's files.
  const files = useMemo(
    () => (currentSessionId ? allFiles.filter((f) => f.channelName === currentSessionId) : allFiles),
    [allFiles, currentSessionId]
  );

  // Flat list of all files, sorted by most recently modified
  const recentFiles = useMemo(() => {
    // Hide .keep placeholder files
    let list = files.filter((f) => !f.filename.endsWith('/.keep') && f.filename !== '.keep');
    if (search) {
      list = list.filter((f) => f.filename.toLowerCase().includes(search.toLowerCase()));
    }
    list.sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    });
    return list;
  }, [files, search]);

  // Clear multi-selection if Escape is pressed
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedFileIds.size > 0) {
        setSelectedFileIds(new Set());
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedFileIds.size]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = e.target.files;
    if (!selectedFiles || selectedFiles.length === 0) return;
    setUploading(true);
    try {
      for (let i = 0; i < selectedFiles.length; i++) {
        const file = selectedFiles[i];
        if (currentFilePath) {
          const renamedFile = new File([file], `${currentFilePath}/${file.name}`, { type: file.type });
          await uploadFile(renamedFile);
        } else {
          await uploadFile(file);
        }
      }
      toast.success(selectedFiles.length === 1 ? `Uploaded ${selectedFiles[0].name}` : `Uploaded ${selectedFiles.length} files`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleRowClick = (e: React.MouseEvent, file: WorkspaceFile, index: number) => {
    if (e.shiftKey && lastClickedIndex !== null) {
      const start = Math.min(lastClickedIndex, index);
      const end = Math.max(lastClickedIndex, index);
      const next = new Set(selectedFileIds);
      for (let i = start; i <= end; i++) {
        if (recentFiles[i]) next.add(recentFiles[i].id);
      }
      setSelectedFileIds(next);
      return;
    }

    if (e.metaKey || e.ctrlKey) {
      const next = new Set(selectedFileIds);
      if (next.has(file.id)) {
        next.delete(file.id);
      } else {
        next.add(file.id);
      }
      setSelectedFileIds(next);
      setLastClickedIndex(index);
      return;
    }

    // Normal click
    if (selectedFileIds.size > 0) {
      setSelectedFileIds(new Set());
    }
    setSelectedFileId(file.id);
    setLastClickedIndex(index);
    if (isMobile) {
      openMobileDetail();
    } else {
      setActiveRightTab('file');
    }
  };

  const handleCheckboxClick = (e: React.MouseEvent, fileId: string, index: number) => {
    e.stopPropagation();
    const next = new Set(selectedFileIds);
    if (next.has(fileId)) {
      next.delete(fileId);
    } else {
      next.add(fileId);
    }
    setSelectedFileIds(next);
    setLastClickedIndex(index);
  };

  const handleSelectAll = useCallback(() => {
    if (selectedFileIds.size === recentFiles.length) {
      setSelectedFileIds(new Set());
    } else {
      setSelectedFileIds(new Set(recentFiles.map((f) => f.id)));
    }
  }, [recentFiles, selectedFileIds.size]);

  const handleBatchDownload = () => {
    const targets = recentFiles.filter((f) => selectedFileIds.has(f.id));
    if (targets.length === 0) return;
    targets.forEach((f) => {
      const url = workspaceApi.getFileUrl(f.id);
      const link = document.createElement('a');
      link.href = url;
      link.download = basename(f.filename);
      link.target = '_blank';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    });
    toast.success(`Downloading ${targets.length} file${targets.length > 1 ? 's' : ''}`);
  };

  const handleConfirmBatchDelete = async () => {
    const ids = Array.from(selectedFileIds);
    if (ids.length === 0) return;
    setDeletingBatch(true);
    let successCount = 0;
    try {
      for (const id of ids) {
        try {
          await deleteFile(id);
          successCount++;
        } catch {
          // Continue deleting others
        }
      }
      toast.success(`Deleted ${successCount} file${successCount > 1 ? 's' : ''}`);
      if (selectedFileId && selectedFileIds.has(selectedFileId)) {
        setSelectedFileId(null);
      }
      setSelectedFileIds(new Set());
    } finally {
      setDeletingBatch(false);
      setBatchDeleteConfirmOpen(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-1 px-2 py-3 shrink-0 pr-12">
        <div className="flex items-center w-full gap-1">
          <div className="flex-1 flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-muted/50 border border-input text-muted-foreground">
            <Search className="size-3.5" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search files..."
              className="text-xs bg-transparent flex-1 text-foreground placeholder:text-muted-foreground"
            />
          </div>
          <Hint label="Upload File">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="size-8 flex items-center justify-center rounded-lg hover:bg-surface2 text-muted-foreground transition-colors shrink-0 disabled:opacity-50"
            >
              <Upload className="size-3.5" />
            </button>
          </Hint>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleUpload}
          />
        </div>
      </div>

      {/* Batch toolbar when files are multi-selected */}
      {selectedFileIds.size > 0 ? (
        <div className="flex items-center justify-between px-3 py-1.5 mx-2 mb-2 rounded-lg bg-surface2 border border-border shadow-xs text-xs animate-in fade-in duration-100 shrink-0">
          <div className="flex items-center gap-2">
            <Checkbox
              checked={selectedFileIds.size === recentFiles.length && recentFiles.length > 0}
              onCheckedChange={handleSelectAll}
            />
            <span className="font-medium text-foreground">
              {selectedFileIds.size} selected
            </span>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleSelectAll}
              className="px-2 py-1 rounded text-2xs hover:bg-surface3 text-foreground-muted hover:text-foreground transition-colors"
            >
              {selectedFileIds.size === recentFiles.length ? 'Deselect all' : 'Select all'}
            </button>
            <Hint label="Download selected">
              <button
                type="button"
                onClick={handleBatchDownload}
                className="size-7 flex items-center justify-center rounded hover:bg-surface3 text-muted-foreground hover:text-foreground transition-colors"
              >
                <Download className="size-3.5" />
              </button>
            </Hint>
            <Hint label="Delete selected">
              <button
                type="button"
                onClick={() => setBatchDeleteConfirmOpen(true)}
                className="size-7 flex items-center justify-center rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
              >
                <Trash2 className="size-3.5" />
              </button>
            </Hint>
            <Hint label="Clear selection (Esc)">
              <button
                type="button"
                onClick={() => setSelectedFileIds(new Set())}
                className="size-7 flex items-center justify-center rounded hover:bg-surface3 text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="size-3.5" />
              </button>
            </Hint>
          </div>
        </div>
      ) : (
        /* Section label */
        <div className="flex items-center justify-between px-3 pb-1.5 shrink-0">
          <span className="text-2xs font-medium text-muted-foreground">
            Recent Files
          </span>
          {recentFiles.length > 0 && (
            <button
              type="button"
              onClick={() => setSelectedFileIds(new Set(recentFiles.map((f) => f.id)))}
              className="text-3xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Select
            </button>
          )}
        </div>
      )}

      {/* File list — flat, sorted by most recent */}
      {recentFiles.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="text-center space-y-2">
            <FolderOpen className="size-10 mx-auto opacity-30" />
            <p className="text-sm font-medium">
              {files.length === 0 ? 'No files yet' : 'No matches'}
            </p>
            <p className="text-xs">
              {files.length === 0
                ? 'Upload a file or ask an agent to create one'
                : 'Try a different search term'}
            </p>
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-1">
          {recentFiles.map((file, idx) => {
            const isBatchSelected = selectedFileIds.has(file.id);
            const isCurrentActive = selectedFileId === file.id;

            return (
              <div
                key={file.id}
                onClick={(e) => handleRowClick(e, file, idx)}
                className={cn(
                  'w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left transition-colors group cursor-pointer select-none',
                  isBatchSelected
                    ? 'bg-primary/10 ring-1 ring-primary/30'
                    : isCurrentActive
                    ? 'bg-surface2'
                    : 'hover:bg-surface1 dark:hover:bg-primary/50'
                )}
              >
                {/* Selection checkbox — visible when selected or on row hover */}
                <div
                  onClick={(e) => handleCheckboxClick(e, file.id, idx)}
                  className={cn(
                    'shrink-0 transition-opacity',
                    isBatchSelected || selectedFileIds.size > 0
                      ? 'opacity-100'
                      : 'opacity-0 group-hover:opacity-100'
                  )}
                >
                  <Checkbox checked={isBatchSelected} />
                </div>

                {getFileIcon(file.contentType, file.filename)}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{basename(file.filename)}</p>
                  <p className="text-2xs text-muted-foreground">
                    {formatSize(file.size)} · {stripAddressPrefix(file.uploadedBy || 'unknown')}
                    {file.createdAt && ` · ${timeAgo(file.createdAt)}`}
                  </p>
                </div>
                <Hint label="Delete">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setSingleDeleteTarget({ id: file.id, name: basename(file.filename) });
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-surface3 dark:hover:bg-primary text-muted-foreground hover:text-destructive transition-all"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </Hint>
              </div>
            );
          })}
        </div>
      )}

      {/* Single file delete confirmation dialog */}
      <ConfirmDialog
        open={Boolean(singleDeleteTarget)}
        onOpenChange={(open) => !open && setSingleDeleteTarget(null)}
        title="Delete file?"
        targetName={singleDeleteTarget?.name}
        description="will be permanently deleted from this workspace. This action cannot be undone."
        confirmLabel="Delete"
        variant="destructive"
        onConfirm={async () => {
          if (!singleDeleteTarget) return;
          try {
            await deleteFile(singleDeleteTarget.id);
            toast.success(`Deleted ${singleDeleteTarget.name}`);
            if (selectedFileId === singleDeleteTarget.id) {
              setSelectedFileId(null);
            }
            if (selectedFileIds.has(singleDeleteTarget.id)) {
              const next = new Set(selectedFileIds);
              next.delete(singleDeleteTarget.id);
              setSelectedFileIds(next);
            }
          } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Delete failed');
          }
        }}
      />

      {/* Batch delete confirmation dialog */}
      <ConfirmDialog
        open={batchDeleteConfirmOpen}
        onOpenChange={setBatchDeleteConfirmOpen}
        title={`Delete ${selectedFileIds.size} files?`}
        targetName={`${selectedFileIds.size} selected files`}
        description="will be permanently deleted from this workspace. This action cannot be undone."
        confirmLabel={`Delete ${selectedFileIds.size} files`}
        variant="destructive"
        isLoading={deletingBatch}
        onConfirm={handleConfirmBatchDelete}
      />
    </div>
  );
}