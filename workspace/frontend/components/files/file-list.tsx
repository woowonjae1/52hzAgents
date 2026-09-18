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
import { toast } from '@/lib/toast';
import { FileTree, FileTreeFolder, FileTreeFile } from '@/components/motion/file-tree';
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

  const [dragOver, setDragOver] = useState(false);

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const droppedFiles = e.dataTransfer?.files;
    if (!droppedFiles || droppedFiles.length === 0) return;
    setUploading(true);
    let successCount = 0;
    try {
      for (let i = 0; i < droppedFiles.length; i++) {
        const file = droppedFiles[i];
        try {
          if (currentFilePath) {
            const renamedFile = new File([file], `${currentFilePath}/${file.name}`, { type: file.type });
            await uploadFile(renamedFile);
          } else {
            await uploadFile(file);
          }
          successCount++;
        } catch (err) {
          console.error('Failed to upload file:', err);
        }
      }
      if (successCount > 0) {
        toast.success(`Uploaded ${successCount} file${successCount > 1 ? 's' : ''}`);
      }
    } finally {
      setUploading(false);
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

  /*
    THE PANEL IS A TREE NOW, NOT A FLAT LIST.

    `filename` has always carried the full path ("reports/2026/q3.md"); the
    old list threw everything but the basename away, so two files called
    `index.ts` in different folders were two identical rows. `fileTreeNodes`
    splits those paths back into the hierarchy the agent actually wrote, and
    `FileTree` draws it with its own roving-tabindex keyboard navigation —
    which is why `useListKeyboardNav` no longer wraps these rows.

    Folders are derived, not stored: they exist because a file underneath
    them does. So the expanded set is seeded to "everything" on first build
    and only diverges once the reader collapses something.
  */
  const fileTreeNodes = useMemo(() => {
    type Dir = { dirs: Map<string, Dir>; files: WorkspaceFile[] };
    const root: Dir = { dirs: new Map(), files: [] };

    for (const file of recentFiles) {
      const segments = file.filename.split('/').filter(Boolean);
      let dir = root;
      for (const segment of segments.slice(0, -1)) {
        let next = dir.dirs.get(segment);
        if (!next) {
          next = { dirs: new Map(), files: [] };
          dir.dirs.set(segment, next);
        }
        dir = next;
      }
      dir.files.push(file);
    }

    const render = (dir: Dir, prefix: string): React.ReactNode[] => [
      ...Array.from(dir.dirs.entries()).map(([name, child]) => {
        const path = prefix ? `${prefix}/${name}` : name;
        return (
          <FileTreeFolder key={`dir:${path}`} value={`dir:${path}`} name={name}>
            {render(child, path)}
          </FileTreeFolder>
        );
      }),
      ...dir.files.map((file) => (
        <FileTreeFile
          key={file.id}
          value={file.id}
          name={basename(file.filename)}
          icon={getFileIcon(file.contentType, file.filename)}
        />
      )),
    ];

    return render(root, '');
  }, [recentFiles]);

  const allFolderIds = useMemo(() => {
    const ids = new Set<string>();
    for (const file of recentFiles) {
      const segments = file.filename.split('/').filter(Boolean).slice(0, -1);
      let path = '';
      for (const segment of segments) {
        path = path ? `${path}/${segment}` : segment;
        ids.add(`dir:${path}`);
      }
    }
    return Array.from(ids);
  }, [recentFiles]);

  const [collapsedFolderIds, setCollapsedFolderIds] = useState<Set<string>>(new Set());
  const expandedFolderIds = useMemo(
    () => allFolderIds.filter((id) => !collapsedFolderIds.has(id)),
    [allFolderIds, collapsedFolderIds]
  );
  const setExpandedFolderIds = useCallback(
    (next: string[]) => {
      const open = new Set(next);
      setCollapsedFolderIds(new Set(allFolderIds.filter((id) => !open.has(id))));
    },
    [allFolderIds]
  );

  const selectedFile = useMemo(
    () => recentFiles.find((f) => f.id === selectedFileId) ?? null,
    [recentFiles, selectedFileId]
  );

  const openSelectedFile = useCallback(() => {
    const index = recentFiles.findIndex((f) => f.id === selectedFileId);
    if (index >= 0) openFile(index);
  }, [recentFiles, selectedFileId, openFile]);

  /* Folder rows report their own value; only a file id is a selection. */
  const handleTreeSelect = useCallback(
    (value: string) => {
      if (value.startsWith('dir:')) return;
      const index = recentFiles.findIndex((f) => f.id === value);
      if (index >= 0) openFile(index);
    },
    [recentFiles, openFile]
  );

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
    <div
      className={cn('flex flex-col h-full relative', dragOver && 'ring-2 ring-inset ring-primary/40 bg-primary/5')}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-xs border-2 border-dashed border-primary/50 rounded-xl pointer-events-none">
          <div className="flex flex-col items-center gap-2 text-primary">
            <Upload className="size-8 animate-bounce" />
            <span className="text-xs font-medium">Drop files to upload</span>
          </div>
        </div>
      )}
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
          ref={scrollRef}
          className="flex-1 overflow-y-auto px-1 outline-none"
        >
          {/*
            Right-clicking the blank space below the rows. Direct child of the
            scroll container, visually hidden — see RowActions `background`.

            The per-row hover menu went away with the flat rows: a `FileTree`
            row is a single button with no trailing slot. Those four actions
            are not lost, they moved here and act on the SELECTED file, so the
            gesture is select-then-act instead of hover-then-act. Nothing is
            offered when no file is selected rather than offered and inert.
          */}
          <RowActions
            background
            label="File list actions"
            items={[
              ...(selectedFile
                ? [
                    { label: 'Open', icon: FolderOpen, onSelect: () => openSelectedFile() },
                    {
                      label: 'Download',
                      icon: Download,
                      onSelect: () =>
                        downloadUrl(
                          workspaceApi.getFileUrl(selectedFile.id),
                          basename(selectedFile.filename)
                        ),
                    },
                    {
                      label: 'Copy link',
                      icon: LinkIcon,
                      onSelect: () => {
                        navigator.clipboard.writeText(workspaceApi.getFileUrl(selectedFile.id));
                        toast.success('Link copied');
                      },
                    },
                    {
                      label: 'Delete',
                      icon: Trash2,
                      destructive: true,
                      separatorBefore: true,
                      onSelect: () =>
                        deleteFileUndoable(selectedFile.id, basename(selectedFile.filename)),
                    },
                  ]
                : []),
              {
                label: 'Upload file…',
                icon: Upload,
                separatorBefore: Boolean(selectedFile),
                onSelect: () => fileInputRef.current?.click(),
              },
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
          <FileTree
            ariaLabel="Workspace files"
            value={selectedFileId ?? null}
            onValueChange={handleTreeSelect}
            expandedIds={expandedFolderIds}
            onExpandedChange={setExpandedFolderIds}
            classNames={{ item: 'h-8 text-[13px]' }}
          >
            {fileTreeNodes}
          </FileTree>
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