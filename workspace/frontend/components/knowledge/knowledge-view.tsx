'use client';

import { formatDistanceToNow } from 'date-fns';
import {
  ArrowLeft,
  BookOpen,
  FileText,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MarkdownContent } from '@/components/chat/markdown-content';
import { useLayout } from '@/components/layout/layout-context';
import { workspaceApi } from '@/lib/api';
import type { KnowledgeEntry } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/lib/workspace-context';
import { ScreenTitle } from '@/components/headers/screen-title';
import { KnowledgeEditor } from './knowledge-editor';
import {
  KNOWLEDGE_IMPORT_ACCEPT,
  KnowledgeDropOverlay,
  KnowledgeImportDialog,
  useKnowledgeDropzone,
} from './knowledge-import';

/** Shared card chrome — every knowledge surface reuses this exact shell. */
const CARD =
  'rounded-xl border border-border/70 bg-surface1 shadow-sm transition-all duration-200';

/** Micro-label: the one quiet metadata typography used across the app. */
const MICRO =
  'text-3xs font-medium uppercase tracking-wider text-foreground-extra-muted';

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return '';
  return formatDistanceToNow(date, { addSuffix: true });
}

function formatSize(bytes: number | null): string {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Dot separator between metadata fragments. */
function MetaDot() {
  return <span className="size-0.5 rounded-full bg-border-accent" aria-hidden />;
}

/** Skeleton mirroring the real entry card so first paint doesn't reflow. */
function EntrySkeleton() {
  return (
    <div className={cn(CARD, 'p-4')}>
      <div className="flex items-start gap-3">
        <div className="size-8 shrink-0 rounded-lg bg-surface3 animate-pulse" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="h-3.5 w-2/5 rounded bg-surface3 animate-pulse" />
          <div className="h-3 w-full rounded bg-surface2 animate-pulse" />
          <div className="h-2.5 w-1/3 rounded bg-surface2 animate-pulse" />
        </div>
      </div>
    </div>
  );
}

export function KnowledgeView({ sidebarOnly = false }: { sidebarOnly?: boolean }) {
  const { knowledge, refreshKnowledge, deleteKnowledge, agents } = useWorkspace();
  const { isMobile, setViewMode } = useLayout();
  const agentNames = agents.map((a) => a.agentName);
  const reduceMotion = useReducedMotion();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedContent, setSelectedContent] = useState<string>('');
  const [loadingContent, setLoadingContent] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<(KnowledgeEntry & { content: string }) | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [importFiles, setImportFiles] = useState<File[]>([]);
  const [query, setQuery] = useState('');
  // Presentation-only: skeletons on first load, spin on manual refresh.
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const filePickerRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve(refreshKnowledge()).finally(() => {
      if (!cancelled) setInitialLoading(false);
    });
    return () => { cancelled = true; };
  }, [refreshKnowledge]);

  const handleDroppedFiles = useCallback((files: File[]) => { setImportFiles(files); }, []);
  const isDragging = useKnowledgeDropzone(handleDroppedFiles);

  const selectedEntry = knowledge.find((k) => k.id === selectedId) || null;

  const handleSelect = useCallback(async (entry: KnowledgeEntry) => {
    setSelectedId(entry.id);
    setLoadingContent(true);
    setMobileDetail(true);
    try {
      const full = await workspaceApi.getKnowledgeEntry(entry.id);
      setSelectedContent(full.content);
    } catch {
      setSelectedContent('Failed to load content.');
    } finally {
      setLoadingContent(false);
    }
  }, []);

  const handleEdit = useCallback(async (entry: KnowledgeEntry) => {
    try {
      const full = await workspaceApi.getKnowledgeEntry(entry.id);
      setEditingEntry({ ...full });
      setEditorOpen(true);
    } catch {
      // ignore
    }
  }, []);

  const handleDelete = useCallback(async (entry: KnowledgeEntry) => {
    await deleteKnowledge(entry.id);
    if (selectedId === entry.id) {
      setSelectedId(null);
      setSelectedContent('');
    }
  }, [deleteKnowledge, selectedId]);

  const handleEditorClose = useCallback(() => {
    setEditorOpen(false);
    setEditingEntry(null);
  }, []);

  const handleEditorSaved = useCallback(async () => {
    setEditorOpen(false);
    setEditingEntry(null);
    await refreshKnowledge();
    if (selectedId) {
      try {
        const full = await workspaceApi.getKnowledgeEntry(selectedId);
        setSelectedContent(full.content);
      } catch { /* ignore */ }
    }
  }, [refreshKnowledge, selectedId]);

  const handleRefresh = useCallback(() => {
    setRefreshing(true);
    Promise.resolve(refreshKnowledge()).finally(() => setRefreshing(false));
  }, [refreshKnowledge]);

  const openNewEntry = useCallback(() => { setEditingEntry(null); setEditorOpen(true); }, []);

  // Client-side filter only — the underlying list and its order are untouched.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return knowledge;
    return knowledge.filter((entry) =>
      entry.title.toLowerCase().includes(q)
      || entry.slug.toLowerCase().includes(q)
      || (entry.description || '').toLowerCase().includes(q),
    );
  }, [knowledge, query]);

  const iconButton =
    'inline-flex size-8 items-center justify-center rounded-lg text-foreground-muted hover:text-foreground hover:bg-surface2 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30';

  // List component
  const EntryList = (
    <div className="h-full flex flex-col bg-background">
      <div className="shrink-0 px-4 pt-3 pb-3 border-b border-border/70 space-y-3 bg-surface1/70 backdrop-blur-sm">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={() => setViewMode('threads')}
              className="flex items-center gap-1 px-2 py-1 -ml-1 rounded-lg text-xs font-medium text-foreground-muted hover:text-foreground hover:bg-surface2 transition-colors cursor-pointer"
              title="Back to chats"
            >
              <ArrowLeft className="size-3.5" />
              <span>Back</span>
            </button>
            <div className="h-3.5 w-px bg-border" />
            <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:bg-amber-400/10 dark:text-amber-400">
              <BookOpen className="size-3.5" />
            </span>
            <ScreenTitle className="text-sm font-semibold tracking-tight text-foreground">
              Knowledge
            </ScreenTitle>
            {knowledge.length > 0 && (
              <span className="shrink-0 rounded-full bg-surface2 px-1.5 py-0.5 text-3xs font-medium tabular-nums text-foreground-muted">
                {knowledge.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            <button type="button" onClick={openNewEntry} className={iconButton} title="New entry">
              <Plus className="size-4" />
            </button>
            {/* Same import path as drag-and-drop — a dropzone alone is
                undiscoverable and unreachable by keyboard. */}
            <button
              type="button"
              onClick={() => filePickerRef.current?.click()}
              className={iconButton}
              title="Import .md / .txt files"
            >
              <Upload className="size-4" />
            </button>
            <button type="button" onClick={handleRefresh} className={iconButton} title="Refresh">
              <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
            </button>
          </div>
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-foreground-extra-muted" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search knowledge..."
            aria-label="Search knowledge"
            className="h-9 w-full rounded-lg border border-border/70 bg-surface1 pl-9 pr-8 text-sm text-foreground placeholder:text-foreground-extra-muted shadow-sm transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:border-primary/40"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-foreground-extra-muted hover:text-foreground hover:bg-surface2 transition-colors cursor-pointer"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3">
        {initialLoading && knowledge.length === 0 ? (
          <div className="grid grid-cols-1 gap-3">
            {[0, 1, 2, 3].map((i) => <EntrySkeleton key={i} />)}
          </div>
        ) : knowledge.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:bg-amber-400/10 dark:text-amber-400">
              <BookOpen className="size-6" />
            </div>
            <p className="text-sm font-semibold tracking-tight text-foreground">
              No knowledge entries yet
            </p>
            <p className="max-w-[15rem] text-sm text-foreground-muted">
              Create shared knowledge for your agents, or drop <span className="font-mono text-xs">.md</span> / <span className="font-mono text-xs">.txt</span> files anywhere here to import.
            </p>
            <button
              type="button"
              onClick={openNewEntry}
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground shadow-sm hover:bg-primary/90 transition-all duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
            >
              <Plus className="size-3.5" />
              Create First Entry
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-surface2 text-foreground-extra-muted">
              <Search className="size-6" />
            </div>
            <p className="text-sm font-semibold tracking-tight text-foreground">No matches</p>
            <p className="max-w-[15rem] text-sm text-foreground-muted">
              Nothing here matches “{query}”. Try a shorter term.
            </p>
            <button
              type="button"
              onClick={() => setQuery('')}
              className="mt-1 inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-surface1 px-3 py-2 text-xs font-medium text-foreground shadow-sm hover:shadow-md transition-all duration-200 cursor-pointer"
            >
              Clear search
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3">
            {filtered.map((entry, index) => {
              const active = selectedId === entry.id;
              const size = formatSize(entry.contentSize);
              const when = timeAgo(entry.updatedAt || entry.createdAt);
              return (
                <motion.div
                  key={entry.id}
                  initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25, delay: reduceMotion ? 0 : Math.min(index, 12) * 0.03 }}
                  className={cn(
                    CARD,
                    'group relative hover:shadow-md',
                    active
                      ? 'border-primary/40 dark:border-primary/40 ring-1 ring-primary/25 shadow-md'
                      : 'hover:border-border-accent/80',
                  )}
                >
                  <button
                    type="button"
                    aria-current={active ? 'true' : undefined}
                    onClick={() => handleSelect(entry)}
                    className="block w-full min-w-0 rounded-xl p-4 text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                  >
                    <div className="flex items-start gap-3">
                      <span
                        className={cn(
                          'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors',
                          active
                            ? 'bg-primary/10 text-primary'
                            : 'bg-surface2 text-foreground-muted',
                        )}
                      >
                        <FileText className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1 pr-12">
                        <p className="truncate text-sm font-semibold tracking-tight text-foreground">
                          {entry.title}
                        </p>
                        {entry.description && (
                          <p className="mt-1 line-clamp-2 text-sm text-foreground-muted">
                            {entry.description}
                          </p>
                        )}
                        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="truncate font-mono text-3xs tracking-tight text-foreground-muted">
                            @knowledge:{entry.slug}
                          </span>
                          {when && (
                            <>
                              <MetaDot />
                              <span className={MICRO}>{when}</span>
                            </>
                          )}
                          {size && (
                            <>
                              <MetaDot />
                              <span className={cn(MICRO, 'tabular-nums')}>{size}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  </button>

                  <div className="absolute right-3 top-3 flex items-center gap-0.5 opacity-0 transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleEdit(entry); }}
                      className="rounded-md p-1.5 text-foreground-extra-muted hover:text-foreground hover:bg-surface2 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                      title="Edit"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleDelete(entry); }}
                      className="rounded-md p-1.5 text-foreground-extra-muted hover:text-red-600 dark:hover:text-red-400 hover:bg-red-500/10 dark:hover:bg-red-400/10 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/30 dark:focus-visible:ring-red-400/30"
                      title="Delete"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </motion.div>
              );
            })}
          </div>
        )}
      </div>

      <KnowledgeEditor
        open={editorOpen}
        entry={editingEntry}
        onClose={handleEditorClose}
        onSaved={handleEditorSaved}
      />
    </div>
  );

  // Detail component
  const EntryDetail = selectedEntry ? (
    <div className="h-full flex flex-col bg-background">
      <div className="shrink-0 px-5 py-3 border-b border-border/70 flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0">
          {isMobile && (
            <button
              type="button"
              onClick={() => setMobileDetail(false)}
              className="mt-0.5 rounded-lg p-1 -ml-1 text-foreground-muted hover:bg-surface2 transition-colors cursor-pointer"
            >
              <ArrowLeft className="size-4" />
            </button>
          )}
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface2 text-foreground-muted">
            <FileText className="size-4" />
          </span>
          <div className="min-w-0">
            <ScreenTitle className="text-sm font-semibold tracking-tight text-foreground">
              {selectedEntry.title}
            </ScreenTitle>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="rounded-md bg-surface2 px-1.5 py-0.5 font-mono text-3xs text-foreground-muted">
                @knowledge:{selectedEntry.slug}
              </span>
              {timeAgo(selectedEntry.updatedAt || selectedEntry.createdAt) && (
                <>
                  <MetaDot />
                  <span className={MICRO}>
                    Updated {timeAgo(selectedEntry.updatedAt || selectedEntry.createdAt)}
                  </span>
                </>
              )}
              {formatSize(selectedEntry.contentSize) && (
                <>
                  <MetaDot />
                  <span className={cn(MICRO, 'tabular-nums')}>{formatSize(selectedEntry.contentSize)}</span>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => handleEdit(selectedEntry)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-surface1 px-2.5 py-1.5 text-xs font-medium text-foreground shadow-sm hover:shadow-md transition-all duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
            title="Edit"
          >
            <Pencil className="size-3.5" />
            <span className="hidden sm:inline">Edit</span>
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-6">
        {loadingContent ? (
          <div className="mx-auto w-full max-w-3xl space-y-3">
            {[
              'w-1/3 h-4', 'w-full h-3', 'w-11/12 h-3', 'w-4/5 h-3',
              'w-1/4 h-4', 'w-full h-3', 'w-10/12 h-3',
            ].map((shape, i) => (
              <div
                key={i}
                className={cn('rounded bg-surface3 animate-pulse', shape)}
              />
            ))}
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl">
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <MarkdownContent content={selectedContent} agentNames={agentNames} />
            </div>
          </div>
        )}
      </div>

      <KnowledgeEditor
        open={editorOpen}
        entry={editingEntry}
        onClose={handleEditorClose}
        onSaved={handleEditorSaved}
      />
    </div>
  ) : (
    <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center bg-background">
      <div className="flex size-14 items-center justify-center rounded-full bg-surface2 text-foreground-extra-muted">
        <BookOpen className="size-6" />
      </div>
      <p className="text-sm font-semibold tracking-tight text-foreground">
        Nothing selected
      </p>
      <p className="max-w-xs text-sm text-foreground-muted">
        Pick an entry on the left to read it, or create a new one your agents can reference.
      </p>
      <button
        type="button"
        onClick={openNewEntry}
        className="mt-1 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground shadow-sm hover:bg-primary/90 transition-all duration-200 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
      >
        <Plus className="size-3.5" />
        New Entry
      </button>
    </div>
  );

  const body = sidebarOnly
    ? EntryList
    // Mobile: single pane switching. Desktop: split view.
    : isMobile
      ? (mobileDetail && selectedEntry ? EntryDetail : EntryList)
      : (
        <div className="h-full flex w-full">
          <div className="w-[300px] xl:w-[380px] shrink-0 border-r border-border/70 overflow-hidden">
            {EntryList}
          </div>
          <div className="flex-1 min-w-0 overflow-hidden">
            {EntryDetail}
          </div>
        </div>
      );

  // Import surface wraps every layout so a drop lands the same way in the
  // sidebar, on mobile detail, and in the desktop split.
  return (
    <div className="relative h-full">
      {body}
      <KnowledgeDropOverlay visible={isDragging} />
      <input
        ref={filePickerRef}
        type="file"
        multiple
        accept={KNOWLEDGE_IMPORT_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const picked = e.target.files;
          if (picked && picked.length > 0) setImportFiles(Array.from(picked));
          // Reset so picking the same file twice still fires onChange.
          e.target.value = '';
        }}
      />
      <KnowledgeImportDialog
        files={importFiles}
        onClose={() => setImportFiles([])}
        onImported={refreshKnowledge}
      />
    </div>
  );
}
