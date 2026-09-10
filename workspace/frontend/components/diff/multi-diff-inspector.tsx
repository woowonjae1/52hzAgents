'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  FileCode2,
  X,
  Copy,
  Check,
  Loader2,
  Undo2,
  ChevronDown,
  ChevronUp,
  FileDiff,
  Search,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Hint } from '@/components/ui/hint';
import { DiffBlock } from '@/components/chat/diff-block';
import { workspaceApi } from '@/lib/api';
import { toast } from 'sonner';

export interface DiffFileItem {
  path: string;
  status: string; // 'A' | 'M' | 'D' | '?' | 'R'
  additions: number;
  deletions: number;
  pre_existing?: boolean;
}

export interface MultiDiffInspectorProps {
  isOpen: boolean;
  onClose: () => void;
  channelId: string | null;
  files: DiffFileItem[];
  turnId?: string;
  initialFilePath?: string;
  title?: string;
  subtitle?: string;
  onRollback?: () => Promise<void>;
  isRollingBack?: boolean;
  isRolledBack?: boolean;
}

function StatusBadge({ status }: { status: string }) {
  const isAdded = status === 'A' || status === '?';
  const isDeleted = status === 'D';
  const label = isAdded ? 'Added' : isDeleted ? 'Deleted' : 'Modified';

  return (
    <span
      className={cn(
        'w-3.5 h-3.5 shrink-0 rounded text-center font-mono text-3xs font-semibold flex items-center justify-center',
        isAdded && 'text-diff-addition bg-diff-addition/10',
        isDeleted && 'text-diff-deletion bg-diff-deletion/10',
        !isAdded && !isDeleted && 'text-foreground-extra-muted bg-surface3'
      )}
      title={label}
    >
      {status === '?' ? 'U' : status}
    </span>
  );
}

export function MultiDiffInspector({
  isOpen,
  onClose,
  channelId,
  files,
  turnId,
  initialFilePath,
  title = 'Turn Changes Inspector',
  subtitle,
  onRollback,
  isRollingBack = false,
  isRolledBack = false,
}: MultiDiffInspectorProps) {
  const [selectedFile, setSelectedFile] = useState<string>(() => {
    return initialFilePath || (files.length > 0 ? files[0].path : '');
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [diffCache, setDiffCache] = useState<Record<string, string>>({});
  const [loadingFile, setLoadingFile] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showRollbackConfirm, setShowRollbackConfirm] = useState(false);

  // Sync selected file when initialFilePath changes or dialog opens
  useEffect(() => {
    if (isOpen) {
      if (initialFilePath && files.some((f) => f.path === initialFilePath)) {
        setSelectedFile(initialFilePath);
      } else if (files.length > 0 && !files.some((f) => f.path === selectedFile)) {
        setSelectedFile(files[0].path);
      }
    }
  }, [isOpen, initialFilePath, files, selectedFile]);

  // Fetch diff for currently selected file
  const fetchDiffForFile = useCallback(
    async (filePath: string) => {
      if (!channelId || !filePath) return;
      if (diffCache[filePath] !== undefined) return;

      setLoadingFile(filePath);
      try {
        const res = await workspaceApi.getGitDiff(channelId, filePath, turnId);
        setDiffCache((prev) => ({
          ...prev,
          [filePath]: res.diff || 'No textual changes detected against baseline.',
        }));
      } catch (err) {
        setDiffCache((prev) => ({
          ...prev,
          [filePath]: `Error loading diff: ${err instanceof Error ? err.message : String(err)}`,
        }));
      } finally {
        setLoadingFile(null);
      }
    },
    [channelId, turnId, diffCache]
  );

  useEffect(() => {
    if (isOpen && selectedFile) {
      void fetchDiffForFile(selectedFile);
    }
  }, [isOpen, selectedFile, fetchDiffForFile]);

  // Filtered files list
  const filteredFiles = useMemo(() => {
    if (!searchQuery.trim()) return files;
    const q = searchQuery.toLowerCase();
    return files.filter((f) => f.path.toLowerCase().includes(q));
  }, [files, searchQuery]);

  // Keyboard navigation: Escape to close, Up/Down or J/K to switch file
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }

      // Ignore arrow navigation if user is typing in the search box
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      if (e.key === 'ArrowDown' || e.key === 'j' || e.key === 'J') {
        e.preventDefault();
        const currentIndex = filteredFiles.findIndex((f) => f.path === selectedFile);
        if (currentIndex < filteredFiles.length - 1) {
          setSelectedFile(filteredFiles[currentIndex + 1].path);
        }
      } else if (e.key === 'ArrowUp' || e.key === 'k' || e.key === 'K') {
        e.preventDefault();
        const currentIndex = filteredFiles.findIndex((f) => f.path === selectedFile);
        if (currentIndex > 0) {
          setSelectedFile(filteredFiles[currentIndex - 1].path);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose, filteredFiles, selectedFile]);

  const activeItem = useMemo(() => {
    return files.find((f) => f.path === selectedFile);
  }, [files, selectedFile]);

  const totalAdds = useMemo(() => files.reduce((acc, f) => acc + (f.additions || 0), 0), [files]);
  const totalDels = useMemo(() => files.reduce((acc, f) => acc + (f.deletions || 0), 0), [files]);

  const handleCopyPath = () => {
    if (!selectedFile) return;
    navigator.clipboard.writeText(selectedFile).then(() => {
      setCopied(true);
      toast.success('File path copied');
      setTimeout(() => setCopied(false), 2000);
    });
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-3 sm:p-6 animate-in fade-in duration-150">
      <div
        className="w-full max-w-6xl h-[88vh] flex flex-col rounded-2xl bg-surface1 border border-border shadow-xl overflow-hidden animate-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-surface2/70 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="size-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <FileDiff className="size-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-foreground truncate">{title}</h2>
                <span className="text-3xs px-2 py-0.5 rounded-full bg-surface3 border border-border text-foreground-extra-muted font-mono">
                  {files.length} {files.length === 1 ? 'file' : 'files'}
                </span>
                <span className="text-3xs font-mono tabular-nums">
                  {totalAdds > 0 && <span className="text-diff-addition">+{totalAdds}</span>}
                  {totalAdds > 0 && totalDels > 0 && ' '}
                  {totalDels > 0 && <span className="text-diff-deletion">−{totalDels}</span>}
                </span>
              </div>
              {subtitle && <p className="text-3xs text-foreground-extra-muted mt-0.5 truncate">{subtitle}</p>}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Rollback confirmation flow if provided */}
            {onRollback && !isRolledBack && (
              showRollbackConfirm ? (
                <div className="flex items-center gap-1.5 bg-surface3 border border-border px-2 py-1 rounded-lg animate-in fade-in">
                  <span className="text-3xs text-foreground-muted">Revert this turn?</span>
                  <button
                    onClick={async () => {
                      await onRollback();
                      setShowRollbackConfirm(false);
                    }}
                    disabled={isRollingBack}
                    className="px-2 py-0.5 rounded bg-destructive text-destructive-foreground text-3xs font-medium hover:opacity-90 disabled:opacity-50 cursor-pointer"
                  >
                    {isRollingBack ? 'Reverting…' : 'Confirm'}
                  </button>
                  <button
                    onClick={() => setShowRollbackConfirm(false)}
                    disabled={isRollingBack}
                    className="px-1.5 py-0.5 rounded text-3xs text-foreground-extra-muted hover:text-foreground cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <Hint label="Undo all file edits made during this agent turn">
                  <button
                    onClick={() => setShowRollbackConfirm(true)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-foreground-muted hover:text-foreground bg-surface3 border border-border hover:bg-surface4 transition-colors cursor-pointer"
                  >
                    <Undo2 className="size-3" />
                    <span>Roll back turn</span>
                  </button>
                </Hint>
              )
            )}

            {isRolledBack && (
              <span className="text-3xs font-medium px-2 py-1 rounded-lg bg-surface3 text-foreground-extra-muted">
                Changes rolled back
              </span>
            )}

            <Hint label="Close (Esc)">
              <button
                onClick={onClose}
                className="size-8 rounded-lg flex items-center justify-center text-foreground-muted hover:text-foreground hover:bg-surface3 transition-colors cursor-pointer"
              >
                <X className="size-4" />
              </button>
            </Hint>
          </div>
        </div>

        {/* ── Main Split View ── */}
        <div className="flex-1 flex min-h-0 divide-x divide-border">
          {/* Left Column: File List */}
          <div className="w-80 shrink-0 flex flex-col bg-surface1/60">
            {/* Search filter if > 4 files */}
            {files.length > 4 && (
              <div className="p-2.5 border-b border-border">
                <div className="relative flex items-center">
                  <Search className="size-3.5 text-foreground-extra-muted absolute left-2.5 pointer-events-none" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Filter files (J/K to navigate)…"
                    className="w-full bg-surface2 border border-border rounded-lg pl-8 pr-2.5 py-1 text-xs text-foreground placeholder:text-foreground-extra-muted outline-none focus:border-accent transition-colors"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery('')}
                      className="absolute right-2 text-foreground-extra-muted hover:text-foreground text-3xs cursor-pointer"
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* List */}
            <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
              {filteredFiles.map((file) => {
                const isSelected = file.path === selectedFile;
                const pathParts = file.path.split('/');
                const fileName = pathParts.pop();
                const dirPath = pathParts.join('/');

                return (
                  <button
                    key={file.path}
                    onClick={() => setSelectedFile(file.path)}
                    className={cn(
                      'w-full flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg text-left transition-all cursor-pointer font-mono',
                      isSelected
                        ? 'bg-primary/10 text-primary border border-primary/20 shadow-xs font-medium'
                        : 'hover:bg-surface2 text-foreground-muted hover:text-foreground'
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <StatusBadge status={file.status} />
                      <div className="min-w-0 flex flex-col">
                        <span className="text-xs truncate font-mono text-foreground leading-tight">
                          {fileName}
                        </span>
                        {dirPath && (
                          <span className="text-3xs text-foreground-extra-muted truncate leading-tight mt-0.5">
                            {dirPath}/
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="shrink-0 flex items-center gap-1.5 text-3xs tabular-nums font-mono">
                      {file.pre_existing && (
                        <span className="text-4xs uppercase px-1 py-0.2 rounded bg-surface3 text-foreground-extra-muted">
                          pre
                        </span>
                      )}
                      {file.additions > 0 && <span className="text-diff-addition">+{file.additions}</span>}
                      {file.deletions > 0 && <span className="text-diff-deletion">−{file.deletions}</span>}
                    </div>
                  </button>
                );
              })}

              {filteredFiles.length === 0 && (
                <div className="py-8 text-center text-xs text-foreground-extra-muted">
                  No matching files
                </div>
              )}
            </div>

            {/* Keyboard shortcut footer */}
            <div className="px-3 py-2 border-t border-border bg-surface2/40 text-4xs text-foreground-extra-muted flex items-center justify-between">
              <span>Use <kbd className="px-1 py-0.5 rounded bg-surface3 border border-border">J</kbd> / <kbd className="px-1 py-0.5 rounded bg-surface3 border border-border">K</kbd> to navigate files</span>
              <span><kbd className="px-1 py-0.5 rounded bg-surface3 border border-border">Esc</kbd> to close</span>
            </div>
          </div>

          {/* Right Column: Diff Viewer */}
          <div className="flex-1 flex flex-col min-w-0 bg-surface0">
            {/* Active file sub-header */}
            <div className="px-4 py-2.5 border-b border-border bg-surface1/60 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                {activeItem && <StatusBadge status={activeItem.status} />}
                <span className="text-xs font-mono font-medium text-foreground truncate select-all">
                  {selectedFile || 'No file selected'}
                </span>
                <Hint label={copied ? 'Copied' : 'Copy file path'}>
                  <button
                    onClick={handleCopyPath}
                    className="p-1 rounded hover:bg-surface2 text-foreground-extra-muted hover:text-foreground transition-colors cursor-pointer"
                  >
                    {copied ? <Check className="size-3 text-status-success" /> : <Copy className="size-3" />}
                  </button>
                </Hint>
              </div>

              {activeItem && (
                <div className="flex items-center gap-2 text-xs font-mono tabular-nums">
                  {activeItem.additions > 0 && (
                    <span className="text-diff-addition font-semibold">+{activeItem.additions}</span>
                  )}
                  {activeItem.deletions > 0 && (
                    <span className="text-diff-deletion font-semibold">−{activeItem.deletions}</span>
                  )}
                </div>
              )}
            </div>

            {/* Diff content scroll area */}
            <div className="flex-1 overflow-y-auto p-4">
              {loadingFile === selectedFile ? (
                <div className="h-64 flex flex-col items-center justify-center gap-2 text-foreground-muted text-xs">
                  <Loader2 className="size-5 animate-spin text-primary" />
                  <span>Loading diff…</span>
                </div>
              ) : diffCache[selectedFile] ? (
                <div className="max-w-none">
                  <DiffBlock code={diffCache[selectedFile]} />
                </div>
              ) : (
                <div className="h-64 flex flex-col items-center justify-center text-xs text-foreground-extra-muted">
                  Select a file from the list to inspect changes
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
