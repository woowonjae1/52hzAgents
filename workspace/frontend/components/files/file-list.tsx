'use client';

import { Hint } from '@/components/ui/hint';
import { SkeletonRows } from '@/components/ui/skeleton';
import { useListKeyboardNav } from '@/hooks/use-list-keyboard-nav';
import { useRef, useState, useMemo, useEffect, useCallback } from 'react';
import { Search, Upload, FolderOpen, Trash2, Download, X, CheckSquare, Link as LinkIcon, ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import { workspaceApi } from '@/lib/api';
import { fileDragProps } from '@/lib/file-drag';
import { RowActions } from '@/components/ui/row-actions';
import { useFileSort, sortFiles, SORT_LABELS, type FileSortKey } from '@/lib/file-sort';
import { useScrollRestore } from '@/hooks/use-scroll-restore';
import { downloadUrl } from '@/lib/download';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { cn, mergeRefs } from '@/lib/utils';
import { toast } from 'sonner';
import { formatSize, getFileIcon, timeAgo, basename } from './file-utils';
import { stripAddressPrefix } from '@/lib/types';
import type { WorkspaceFile } from '@/lib/types';

export function FileList() {
  const { loading, files: allFiles, selectedFileId, setSelectedFileId, uploadFile, deleteFile, deleteFileUndoable, currentFilePath, currentSessionId } = useWorkspace();
  const { isMobile, openMobileDetail, setActiveRightTab } = useLayout();
  const [search, setSearch] = useState('');
  const { sort, toggle: toggleSort } = useFileSort('files_list_sort');
  const scrollRef = useScrollRestore<HTMLDivElement>('files-list', !loading);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Multi-selection state
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);

  // Confirmation dialogs
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
    return sortFiles(list, sort);
  }, [files, search, sort]);

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

  /*
   * ↑/↓, Home/End, Page keys, Enter to open, Space to tick, Delete to delete,
   * Shift+↑/↓ to extend the selection. A file list that answers none of those
   * is a web page with rows on it; this is the same keyboard every file
   * manager on every platform has.
   */
  const openFile = useCallback((index: number) => {
    const file = recentFiles[index];
    if (!file) return;
    setSelectedFileId(file.id);
    if (isMobile) openMobileDetail();
    else setActiveRightTab('file');
  }, [recentFiles, setSelectedFileId, isMobile, openMobileDetail, setActiveRightTab]);

  const { cursor, setCursor, listNavProps, rowProps } = useListKeyboardNav({
    count: recentFiles.length,
    onActivate: openFile,
    onExtend: (index) => {
      const anchor = lastClickedIndex ?? index;
      const next = new Set<string>();
      for (let i = Math.min(anchor, index); i <= Math.max(anchor, index); i++) {
        if (recentFiles[i]) next.add(recentFiles[i].id);
      }
      setSelectedFileIds(next);
    },
    onToggle: (index) => {
      const file = recentFiles[index];
      if (!file) return;
      const next = new Set(selectedFileIds);
      if (next.has(file.id)) next.delete(file.id);
      else next.add(file.id);
      setSelectedFileIds(next);
      setLastClickedIndex(index);
    },
    onDelete: (index) => {
      const file = recentFiles[index];
      if (file) deleteFileUndoable(file.id, basename(file.filename));
    },
    pageSize: 12,
  });

  const handleRowClick = (e: React.MouseEvent, file: WorkspaceFile, index: number) => {
    if (e.shiftKey && lastClickedIndex !== null) {
      /*
        A range REPLACES the selection; it does not add to it.

        This used to start from the current set and only ever `add`, so
        shift-clicking a shorter range left everything from the longer one
        still selected and there was no way to narrow a selection without
        clearing it first. Explorer, Finder and every list view built on them
        replace — ctrl+shift is the gesture that unions.
      */
      const start = Math.min(lastClickedIndex, index);
      const end = Math.max(lastClickedIndex, index);
      const union = e.metaKey || e.ctrlKey;
      const next = union ? new Set(selectedFileIds) : new Set<string>();
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
    setCursor(index);
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
    // `target="_blank"` used to be set here, which makes Chromium consider
    // opening a window before downloading — in the desktop shell that landed
    // in setWindowOpenHandler instead of in a download.
    targets.forEach((f) => {
      downloadUrl(workspaceApi.getFileUrl(f.id), basename(f.filename));
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
            data-view-search
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
          {/* The list was hardcoded newest-first with no way to change it. */}
          <div className="flex items-center gap-0.5 ml-auto mr-2">
            {(['name', 'size', 'date'] as FileSortKey[]).map((key) => (
              <Hint key={key} label={`Sort by ${SORT_LABELS[key].toLowerCase()}`}>
                <button
                  type="button"
                  onClick={() => toggleSort(key)}
                  aria-pressed={sort.key === key}
                  className={cn(
                    'px-1.5 py-0.5 rounded text-3xs font-medium transition-colors flex items-center gap-0.5',
                    sort.key === key
                      ? 'bg-surface2 text-foreground'
                      : 'text-muted-foreground hover:text-foreground hover:bg-surface2/60',
                  )}
                >
                  {SORT_LABELS[key]}
                  {sort.key === key &&
                    (sort.direction === 'asc'
                      ? <ArrowUp className="size-2.5" />
                      : <ArrowDown className="size-2.5" />)}
                </button>
              </Hint>
            ))}
          </div>
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
      {/* A list that has not loaded yet is not an empty list. This pane used
          to render "No files yet" during the first fetch, so a cold start
          told the user their workspace was empty and then contradicted
          itself. Rows shaped like the ones that are coming say "wait"
          without saying anything. */}
      {loading && files.length === 0 ? (
        <div className="flex-1 px-1 pt-1">
          <SkeletonRows rows={8} />
        </div>
      ) : recentFiles.length === 0 ? (
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
        <div
          {...listNavProps}
          ref={mergeRefs(listNavProps.ref, scrollRef)}
          className="flex-1 overflow-y-auto px-1 outline-none"
        >
          {/*
            Right-clicking the blank space below the rows. Direct child of the
            scroll container, visually hidden — see RowActions `background`.
          */}
          <RowActions
            background
            label="File list actions"
            items={[
              { label: 'Upload file…', icon: Upload, onSelect: () => fileInputRef.current?.click() },
              { label: 'Select all', icon: CheckSquare, onSelect: handleSelectAll },
              ...(['name', 'size', 'date'] as FileSortKey[]).map((key) => ({
                // The arrow marks the active column and its direction, so the
                // menu says what the list is doing rather than only what it
                // could do.
                label:
                  sort.key === key
                    ? `Sort by ${SORT_LABELS[key]} ${sort.direction === 'asc' ? '↑' : '↓'}`
                    : `Sort by ${SORT_LABELS[key]}`,
                icon: ArrowUpDown,
                separatorBefore: key === 'name',
                onSelect: () => toggleSort(key),
              })),
            ]}
          />
          {recentFiles.map((file, idx) => {
            const isBatchSelected = selectedFileIds.has(file.id);
            const isCurrentActive = selectedFileId === file.id;

            return (
              <div
                key={file.id}
                {...rowProps(idx, isBatchSelected || isCurrentActive)}
                onClick={(e) => handleRowClick(e, file, idx)}
                /* Double-click opens. Single-click selects. That split is what
                   every file manager does and what nothing in this app did. */
                onDoubleClick={(e) => { e.stopPropagation(); openFile(idx); }}
                {...fileDragProps({
                  filename: file.filename,
                  contentType: file.contentType,
                  url: workspaceApi.getFileUrl(file.id),
                })}
                className={cn(
                  'skip-offscreen-row w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left transition-colors group select-none',
                  cursor === idx && 'ring-1 ring-border-accent',
                  isBatchSelected
                    ? 'bg-primary/10 ring-1 ring-primary/30'
                    : isCurrentActive
                    ? 'bg-surface2'
                    : 'hover:bg-surface2'
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
                {/*
                  A hover-only trash can was this row's entire action set, and
                  it is why right-click here fell through to the shell's bare
                  "Select All" — RowContextMenu looks for a dropdown trigger
                  that is a DIRECT CHILD of the row, and there was none.
                */}
                <RowActions
                  label={`Actions for ${basename(file.filename)}`}
                  items={[
                    { label: 'Open', icon: FolderOpen, onSelect: () => openFile(idx) },
                    {
                      label: 'Download',
                      icon: Download,
                      onSelect: () => downloadUrl(workspaceApi.getFileUrl(file.id), basename(file.filename)),
                    },
                    {
                      label: 'Copy link',
                      icon: LinkIcon,
                      onSelect: () => {
                        navigator.clipboard.writeText(workspaceApi.getFileUrl(file.id));
                        toast.success('Link copied');
                      },
                    },
                    {
                      label: 'Delete',
                      icon: Trash2,
                      destructive: true,
                      onSelect: () => deleteFileUndoable(file.id, basename(file.filename)),
                    },
                  ]}
                />
              </div>
            );
          })}
        </div>
      )}


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