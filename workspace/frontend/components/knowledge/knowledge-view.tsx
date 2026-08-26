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
  Copy,
  Download,
  Check,
  Bot,
  Columns2,
  LayoutGrid,
  ListFilter,
  Layers,
  Sparkles,
  ShieldCheck,
  Hash,
  Clock,
  Share2,
  AlignLeft,
  ChevronRight,
  ExternalLink,
} from 'lucide-react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MarkdownContent } from '@/components/chat/markdown-content';
import { useLayout } from '@/components/layout/layout-context';
import { workspaceApi } from '@/lib/api';
import type { KnowledgeEntry, WorkspaceAgent } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/lib/workspace-context';
import { ScreenTitle } from '@/components/headers/screen-title';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { KnowledgeEditor } from './knowledge-editor';
import {
  KNOWLEDGE_IMPORT_ACCEPT,
  KnowledgeDropOverlay,
  KnowledgeImportDialog,
  useKnowledgeDropzone,
} from './knowledge-import';

const CARD =
  'rounded-xl border border-border bg-surface1 transition-colors duration-150';

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

function MetaDot() {
  return <span className="size-0.5 rounded-full bg-border-accent shrink-0" aria-hidden />;
}

type KnowledgeCategory = 'all' | 'rules' | 'architecture' | 'api' | 'docs';

interface CategoryItem {
  id: KnowledgeCategory;
  label: string;
  icon: typeof BookOpen;
}

const CATEGORIES: CategoryItem[] = [
  { id: 'all', label: 'All', icon: BookOpen },
  { id: 'rules', label: 'Standards', icon: ShieldCheck },
  { id: 'architecture', label: 'Architecture', icon: Layers },
  { id: 'api', label: 'API', icon: Hash },
  { id: 'docs', label: 'Docs', icon: FileText },
];

const CATEGORY_IDS: KnowledgeCategory[] = ['rules', 'architecture', 'api', 'docs'];

/**
 * The stored category wins; the keyword guess is only for entries nobody has
 * classified.
 *
 * The guess used to be the ONLY answer, and it is wrong often enough to matter:
 * the tests below run in order over `title + slug + description`, so "API design
 * standards" matches /spec|standard/ first and files as `rules`, never reaching
 * the `api` test. Worse, there was no way to correct it — the category was
 * computed, never stored, so a misfiled entry stayed misfiled. It is a field on
 * the entry now, and this runs only when that field is null.
 */
function classifyEntry(entry: KnowledgeEntry): KnowledgeCategory {
  const stored = (entry.category || '').toLowerCase() as KnowledgeCategory;
  if (CATEGORY_IDS.includes(stored)) return stored;

  const text = `${entry.title} ${entry.slug} ${entry.description || ''}`.toLowerCase();
  if (text.match(/rule|standard|guideline|convention|spec|规范|准则|守则/)) return 'rules';
  if (text.match(/arch|design|system|structure|module|架构|设计|模型/)) return 'architecture';
  if (text.match(/api|sdk|endpoint|interface|rest|grpc|接口|路由/)) return 'api';
  return 'docs';
}

interface TocItem {
  id: string;
  text: string;
  level: number;
}

function extractToc(markdown: string): TocItem[] {
  if (!markdown) return [];
  const lines = markdown.split('\n');
  const items: TocItem[] = [];
  lines.forEach((line) => {
    const match = /^(#{1,3})\s+(.+)$/.exec(line.trim());
    if (match) {
      const level = match[1].length;
      const rawText = match[2].trim().replace(/[*_`]/g, '');
      const id = rawText
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
        .replace(/^-|-$/g, '');
      if (rawText) {
        items.push({ id, text: rawText, level });
      }
    }
  });
  return items;
}

export function KnowledgeView({ sidebarOnly = false }: { sidebarOnly?: boolean }) {
  const { knowledge, refreshKnowledge, deleteKnowledge, agents } = useWorkspace();
  const { isMobile, setViewMode } = useLayout();
  const agentNames = useMemo(() => agents.map((a) => a.agentName), [agents]);
  const onlineAgents = useMemo(() => agents.filter((a) => a.status === 'online'), [agents]);
  const reduceMotion = useReducedMotion();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedContent, setSelectedContent] = useState<string>('');
  const [loadingContent, setLoadingContent] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<(KnowledgeEntry & { content: string }) | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [importFiles, setImportFiles] = useState<File[]>([]);
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState<KnowledgeCategory>('all');
  const [viewLayout, setViewLayout] = useState<'split' | 'grid'>('split');
  const [sortBy, setSortBy] = useState<'updated' | 'title' | 'size'>('updated');
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);
  const [copiedContent, setCopiedContent] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<KnowledgeEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const filePickerRef = useRef<HTMLInputElement>(null);
  const contentContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve(refreshKnowledge()).finally(() => {
      if (!cancelled) setInitialLoading(false);
    });
    return () => { cancelled = true; };
  }, [refreshKnowledge]);

  const handleDroppedFiles = useCallback((files: File[]) => { setImportFiles(files); }, []);
  const isDragging = useKnowledgeDropzone(handleDroppedFiles);

  const selectedEntry = useMemo(
    () => knowledge.find((k) => k.id === selectedId) || null,
    [knowledge, selectedId]
  );

  /**
   * Which fetch is allowed to write to the pane.
   *
   * `setSelectedId` lands synchronously but the content arrives later, and the
   * two were not tied together: click entry A then B, have A's (larger) response
   * come back last, and the list highlights B while the pane shows A. Bumping a
   * token per click and comparing before every state write drops the answer to a
   * superseded request instead of painting it.
   */
  const selectionTokenRef = useRef(0);

  const handleSelect = useCallback(async (entry: KnowledgeEntry) => {
    const token = ++selectionTokenRef.current;
    setSelectedId(entry.id);
    setSelectedContent('');
    setLoadingContent(true);
    setMobileDetail(true);
    try {
      const full = await workspaceApi.getKnowledgeEntry(entry.id);
      if (selectionTokenRef.current !== token) return;
      setSelectedContent(full.content);
    } catch {
      if (selectionTokenRef.current !== token) return;
      setSelectedContent('Failed to load content.');
    } finally {
      // Guarded too: an early request clearing the flag would hide the spinner
      // while a later one is still in flight.
      if (selectionTokenRef.current === token) setLoadingContent(false);
    }
  }, []);

  // Declared AFTER `handleSelect` on purpose: it used to sit above it and call
  // it, which works at runtime (effects run post-render) but left `handleSelect`
  // out of the dependency array with nothing to remind anyone. Moved so the
  // dependency can be listed honestly.
  useEffect(() => {
    if (!isMobile && !selectedId && knowledge.length > 0 && viewLayout === 'split') {
      void handleSelect(knowledge[0]);
    }
  }, [isMobile, selectedId, knowledge, viewLayout, handleSelect]);


  const handleEdit = useCallback(async (entry: KnowledgeEntry) => {
    try {
      const full = await workspaceApi.getKnowledgeEntry(entry.id);
      setEditingEntry({ ...full });
      setEditorOpen(true);
    } catch {
      toast.error('Failed to open knowledge entry for editing');
    }
  }, []);

  /*
   * Deleting asks in a `Dialog`, not `window.confirm`.
   *
   * A native confirm is an OS-chrome modal dropped into the middle of a desktop
   * app: it cannot show the entry it is about to remove in the app's own type,
   * it blocks the renderer thread, and it is unstyleable — so the one
   * irreversible action here looked less considered than the reversible ones
   * around it. Every other confirmation in this app (tool approval, decision
   * cards) already goes through `Dialog`.
   */
  const handleDelete = useCallback((entry: KnowledgeEntry) => {
    setPendingDelete(entry);
  }, []);

  const confirmDelete = useCallback(async () => {
    const entry = pendingDelete;
    if (!entry) return;
    setDeleting(true);
    try {
      await deleteKnowledge(entry.id);
      toast.success(`Deleted ${entry.title}`);
      if (selectedId === entry.id) {
        setSelectedId(null);
        setSelectedContent('');
      }
      setPendingDelete(null);
    } catch {
      // The dialog stays open on failure: closing it would leave the user with a
      // toast and no way to retry the thing they just asked for.
      toast.error('Could not delete that entry');
    } finally {
      setDeleting(false);
    }
  }, [deleteKnowledge, pendingDelete, selectedId]);

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
    Promise.resolve(refreshKnowledge()).finally(() => {
      setRefreshing(false);
      toast.success('Knowledge base refreshed');
    });
  }, [refreshKnowledge]);

  const openNewEntry = useCallback(() => {
    setEditingEntry(null);
    setEditorOpen(true);
  }, []);

  const copySlugDirective = useCallback((slug: string) => {
    const directive = `@knowledge:${slug}`;
    navigator.clipboard.writeText(directive);
    setCopiedSlug(slug);
    toast.success(`Copied ${directive} — paste it into a message to cite this entry`);
    setTimeout(() => setCopiedSlug(null), 2000);
  }, []);

  const copyFullContent = useCallback(() => {
    if (!selectedContent) return;
    navigator.clipboard.writeText(selectedContent);
    setCopiedContent(true);
    toast.success('Markdown copied');
    setTimeout(() => setCopiedContent(false), 2000);
  }, [selectedContent]);

  const exportAsMarkdown = useCallback((entry: KnowledgeEntry, content: string) => {
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${entry.slug || 'knowledge'}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success(`Exported ${entry.slug}.md`);
  }, []);

  // Filter and sort entries
  const filtered = useMemo(() => {
    let list = knowledge;

    // Category filter
    if (activeCategory !== 'all') {
      list = list.filter((e) => classifyEntry(e) === activeCategory);
    }

    // Search query filter
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (entry) =>
          entry.title.toLowerCase().includes(q) ||
          entry.slug.toLowerCase().includes(q) ||
          (entry.description || '').toLowerCase().includes(q)
      );
    }

    // Sorting
    return [...list].sort((a, b) => {
      if (sortBy === 'title') return a.title.localeCompare(b.title);
      if (sortBy === 'size') return (b.contentSize || 0) - (a.contentSize || 0);
      const timeA = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const timeB = new Date(b.updatedAt || b.createdAt || 0).getTime();
      return timeB - timeA;
    });
  }, [knowledge, activeCategory, query, sortBy]);

  // Category counts
  const categoryCounts = useMemo(() => {
    const counts: Record<KnowledgeCategory, number> = {
      all: knowledge.length,
      rules: 0,
      architecture: 0,
      api: 0,
      docs: 0,
    };
    knowledge.forEach((e) => {
      const cat = classifyEntry(e);
      counts[cat] = (counts[cat] || 0) + 1;
    });
    return counts;
  }, [knowledge]);

  // TOC extracted from selected document
  const tocItems = useMemo(() => extractToc(selectedContent), [selectedContent]);

  const scrollToSection = (id: string) => {
    const el = document.getElementById(id) || document.querySelector(`[data-heading-id="${id}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const iconButton =
    'inline-flex size-8 items-center justify-center rounded-xl text-foreground-muted hover:text-foreground hover:bg-surface2 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30';

  // --- List Pane (Left Column) ---
  const EntryList = (
    <div className="h-full flex flex-col bg-background select-none">
      {/* Top Header */}
      <div className="shrink-0 px-4 pt-3.5 pb-3 border-b border-border/70 space-y-3 bg-surface1/60 backdrop-blur-md">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              onClick={() => setViewMode('threads')}
              className="flex items-center gap-1 px-2 py-1 -ml-1 rounded-lg text-xs font-medium text-foreground-muted hover:text-foreground hover:bg-surface2 transition-colors cursor-pointer"
              title="Back to conversation"
            >
              <ArrowLeft className="size-3.5" />
              <span>Back</span>
            </button>
            <div className="h-3.5 w-px bg-border/80" />
            <div className="flex items-center gap-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface2 text-foreground-muted">
                <BookOpen className="size-4" />
              </span>
              <ScreenTitle className="text-sm font-semibold tracking-tight text-foreground">
                Knowledge
              </ScreenTitle>
            </div>
            {knowledge.length > 0 && (
              <span className="shrink-0 rounded-full bg-surface3 px-2 py-0.5 text-3xs font-semibold tabular-nums text-foreground">
                {knowledge.length}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" onClick={openNewEntry} className={iconButton}>
                  <Plus className="size-4 text-primary" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">New entry</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => filePickerRef.current?.click()}
                  className={iconButton}
                >
                  <Upload className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Import Markdown files</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" onClick={handleRefresh} className={iconButton}>
                  <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Refresh</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Global Agent Broadcast Strip */}
        <div className="flex items-center justify-between px-2.5 py-1.5 rounded-xl bg-surface2/60 border border-border/50 text-3xs text-foreground-muted">
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="size-1.5 rounded-full bg-status-success shrink-0" aria-hidden />
            <span className="font-medium text-foreground truncate">Shared with every agent</span>
            <span className="text-foreground-extra-muted hidden sm:inline">· applies immediately</span>
          </div>
          <div className="flex -space-x-1 shrink-0 pl-2">
            {onlineAgents.slice(0, 4).map((a) => (
              <div key={a.agentName} className="ring-1 ring-background rounded-full">
                <AgentAvatar name={a.agentName} agentType={a.agentType} size={16} />
              </div>
            ))}
          </div>
        </div>

        {/* Search Bar */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-foreground-extra-muted" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search knowledge…"
            className="h-8.5 w-full rounded-xl border border-border/70 bg-surface1 pl-9 pr-8 text-xs text-foreground placeholder:text-foreground-extra-muted shadow-2xs transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-foreground-extra-muted hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        {/* Category Pills */}
        <div className="flex items-center gap-1 overflow-x-auto no-scrollbar pb-0.5">
          {CATEGORIES.map((cat) => {
            const active = activeCategory === cat.id;
            const count = categoryCounts[cat.id] || 0;
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => setActiveCategory(cat.id)}
                className={cn(
                  'flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-2xs font-medium transition-all duration-150 shrink-0 cursor-pointer',
                  active
                    ? 'bg-primary text-primary-foreground font-semibold shadow-xs'
                    : 'bg-surface2/60 text-foreground-muted hover:text-foreground hover:bg-surface2'
                )}
              >
                <span>{cat.label}</span>
                {count > 0 && (
                  <span
                    className={cn(
                      'px-1 py-0.2 rounded-full text-3xs font-mono font-normal',
                      active ? 'bg-white/20 text-white' : 'bg-surface3 text-foreground-muted'
                    )}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Entry Cards List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-foreground-muted">
            <div className="flex size-12 items-center justify-center rounded-2xl bg-surface2 text-foreground-extra-muted">
              <Search className="size-5" />
            </div>
            <p className="text-xs font-semibold text-foreground">No matching entries</p>
            <p className="max-w-[15rem] text-3xs text-foreground-extra-muted">
              {query ? `Nothing matches “${query}”` : 'This category is empty'}
            </p>
          </div>
        ) : (
          filtered.map((entry, index) => {
            const active = selectedId === entry.id;
            const size = formatSize(entry.contentSize);
            const when = timeAgo(entry.updatedAt || entry.createdAt);
            const cat = classifyEntry(entry);

            return (
              <motion.div
                key={entry.id}
                initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2, delay: Math.min(index, 8) * 0.02 }}
                className={cn(
                  CARD,
                  'group relative p-3 cursor-pointer select-none',
                  active
                    ? 'border-primary/50 bg-surface2/90 shadow-xs ring-1 ring-primary/20'
                    : 'hover:border-border-accent/80 hover:bg-surface2/50'
                )}
                onClick={() => handleSelect(entry)}
              >
                <div className="flex items-start gap-2.5">
                  <span
                    className={cn(
                      'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-xl transition-colors',
                      active ? 'bg-primary text-primary-foreground' : 'bg-surface3 text-foreground-muted'
                    )}
                  >
                    <FileText className="size-3.5" />
                  </span>

                  <div className="min-w-0 flex-1 pr-6">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate text-xs font-semibold text-foreground tracking-tight">
                        {entry.title}
                      </p>
                    </div>

                    {entry.description && (
                      <p className="mt-1 line-clamp-2 text-2xs text-foreground-muted leading-relaxed">
                        {entry.description}
                      </p>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="truncate font-mono text-3xs px-1 py-0.2 rounded bg-surface3 text-foreground-muted font-medium">
                        @{entry.slug}
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

                {/* Hover Quick Actions */}
                <div className="absolute right-2.5 top-2.5 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      copySlugDirective(entry.slug);
                    }}
                    className="p-1 rounded-md text-foreground-extra-muted hover:text-foreground hover:bg-surface3 transition-colors"
                    title="Copy the @knowledge citation"
                  >
                    {copiedSlug === entry.slug ? <Check className="size-3 text-status-success" /> : <Copy className="size-3" />}
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleEdit(entry);
                    }}
                    className="p-1 rounded-md text-foreground-extra-muted hover:text-foreground hover:bg-surface3 transition-colors"
                    title="Edit"
                  >
                    <Pencil className="size-3" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(entry);
                    }}
                    className="p-1 rounded-md text-foreground-extra-muted hover:text-destructive hover:bg-destructive/10 transition-colors"
                    title="Delete"
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              </motion.div>
            );
          })
        )}
      </div>
    </div>
  );

  // --- Detail Reader Pane (Right Column) ---
  const EntryDetail = selectedEntry ? (
    <div className="h-full flex flex-col bg-background">
      {/* Detail Header Bar */}
      <div className="shrink-0 px-6 py-3.5 border-b border-border/70 flex items-center justify-between gap-4 bg-surface1/60 backdrop-blur-md">
        <div className="flex items-center gap-3 min-w-0">
          {isMobile && (
            <button
              type="button"
              onClick={() => setMobileDetail(false)}
              className="p-1.5 rounded-lg text-foreground-muted hover:bg-surface2 transition-colors cursor-pointer"
            >
              <ArrowLeft className="size-4" />
            </button>
          )}

          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-bold tracking-tight text-foreground truncate">
                {selectedEntry.title}
              </h2>
            </div>

            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-foreground-muted">
              <button
                type="button"
                onClick={() => copySlugDirective(selectedEntry.slug)}
                className="inline-flex items-center gap-1 font-mono text-3xs px-1.5 py-0.5 rounded bg-surface2 border border-border/60 text-foreground hover:bg-surface3 transition-colors cursor-pointer"
                title="Copy the @ citation"
              >
                <span>@knowledge:{selectedEntry.slug}</span>
                {copiedSlug === selectedEntry.slug ? <Check className="size-2.5 text-status-success" /> : <Copy className="size-2.5 text-foreground-extra-muted" />}
              </button>
              <MetaDot />
              <span className="text-3xs text-foreground-muted font-medium flex items-center gap-1">
                <Bot className="size-3" />
                <span>Shared with all agents</span>
              </span>
              {timeAgo(selectedEntry.updatedAt || selectedEntry.createdAt) && (
                <>
                  <MetaDot />
                  <span className={MICRO}>Updated {timeAgo(selectedEntry.updatedAt || selectedEntry.createdAt)}</span>
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

        {/* Action Button Group */}
        <div className="flex items-center gap-1.5 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={copyFullContent}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl border border-border/70 bg-surface1 text-xs font-medium text-foreground hover:bg-surface2 transition-all cursor-pointer shadow-2xs"
              >
                {copiedContent ? <Check className="size-3.5 text-status-success" /> : <Copy className="size-3.5 text-foreground-muted" />}
                <span className="hidden sm:inline">Copy</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Copy the Markdown body</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => exportAsMarkdown(selectedEntry, selectedContent)}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl border border-border/70 bg-surface1 text-xs font-medium text-foreground hover:bg-surface2 transition-all cursor-pointer shadow-2xs"
              >
                <Download className="size-3.5 text-foreground-muted" />
                <span className="hidden sm:inline">Export</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Save as a local .md file</TooltipContent>
          </Tooltip>

          <button
            type="button"
            onClick={() => handleEdit(selectedEntry)}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90 transition-all cursor-pointer shadow-xs"
          >
            <Pencil className="size-3.5" />
            <span>Edit</span>
          </button>
        </div>
      </div>

      {/* Reading Canvas with Optional Table of Contents */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Main Markdown Body */}
        <div ref={contentContainerRef} className="flex-1 overflow-y-auto px-8 py-8">
          {loadingContent ? (
            <div className="mx-auto w-full max-w-3xl space-y-4">
              <div className="h-6 w-1/3 rounded-lg bg-surface3 animate-pulse" />
              <div className="h-4 w-full rounded bg-surface2 animate-pulse" />
              <div className="h-4 w-11/12 rounded bg-surface2 animate-pulse" />
              <div className="h-4 w-4/5 rounded bg-surface2 animate-pulse" />
            </div>
          ) : (
            <div className="mx-auto w-full max-w-3xl">
              {selectedEntry.description && (
                <div className="mb-6 p-4 rounded-xl bg-surface2/60 border border-border/60 text-xs text-foreground-muted leading-relaxed">
                  <p className="font-semibold text-foreground mb-1">Summary</p>
                  {selectedEntry.description}
                </div>
              )}
              <div className="prose prose-sm dark:prose-invert max-w-none leading-relaxed">
                <MarkdownContent content={selectedContent} agentNames={agentNames} />
              </div>
            </div>
          )}
        </div>

        {/* Floating Table of Contents (TOC) */}
        {tocItems.length > 1 && (
          <div className="hidden lg:block w-56 shrink-0 border-l border-border/60 p-4 overflow-y-auto bg-surface1/30 select-none">
            <div className="flex items-center gap-1.5 text-3xs font-semibold uppercase tracking-wider text-foreground-extra-muted mb-3">
              <AlignLeft className="size-3" />
              <span>Contents</span>
            </div>
            <div className="space-y-1">
              {tocItems.map((item, idx) => (
                <button
                  key={`${item.id}-${idx}`}
                  type="button"
                  onClick={() => scrollToSection(item.id)}
                  style={{ paddingLeft: `${(item.level - 1) * 12 + 6}px` }}
                  className="w-full text-left py-1 text-2xs text-foreground-muted hover:text-primary transition-colors truncate block rounded hover:bg-surface2 cursor-pointer"
                >
                  {item.text}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  ) : (
    <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center bg-background text-foreground-muted select-none">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-surface2 text-foreground-muted">
        <BookOpen className="size-7" />
      </div>
      <p className="text-sm font-semibold text-foreground">No entry selected</p>
      <p className="max-w-xs text-xs text-foreground-extra-muted">
        Pick an entry on the left to read it, or create one to give every agent the same reference.
      </p>
      <button
        type="button"
        onClick={openNewEntry}
        className="mt-2 inline-flex items-center gap-1.5 rounded-xl bg-primary px-3.5 py-2 text-xs font-semibold text-primary-foreground shadow-xs hover:bg-primary/90 transition-all cursor-pointer"
      >
        <Plus className="size-3.5" />
        <span>Create the first entry</span>
      </button>
    </div>
  );

  // Layout Renderer
  const body = sidebarOnly ? (
    EntryList
  ) : isMobile ? (
    mobileDetail && selectedEntry ? EntryDetail : EntryList
  ) : (
    <div className="h-full flex w-full overflow-hidden">
      <div className="w-[320px] xl:w-[380px] shrink-0 border-r border-border/70 overflow-hidden">
        {EntryList}
      </div>
      <div className="flex-1 min-w-0 overflow-hidden">
        {EntryDetail}
      </div>
    </div>
  );

  return (
    <div className="relative h-full overflow-hidden">
      {body}

      <KnowledgeEditor
        open={editorOpen}
        entry={editingEntry}
        onClose={handleEditorClose}
        onSaved={handleEditorSaved}
      />

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
          e.target.value = '';
        }}
      />

      <KnowledgeImportDialog
        files={importFiles}
        onClose={() => setImportFiles([])}
        onImported={refreshKnowledge}
      />

      <Dialog open={!!pendingDelete} onOpenChange={(open) => { if (!open && !deleting) setPendingDelete(null); }}>
        <DialogContent className="max-w-md">
          <DialogTitle>Delete this entry?</DialogTitle>
          <DialogDescription>
            {/* The title is quoted back rather than described, because "are you
                sure" without the name is how the wrong thing gets deleted. */}
            <span className="font-medium text-foreground">{pendingDelete?.title}</span>
            {' '}will be removed for everyone. No agent will be able to read it again,
            and this cannot be undone.
          </DialogDescription>
          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setPendingDelete(null)}
              disabled={deleting}
              className="cursor-pointer rounded-base border border-border px-2.5 py-1 text-xs text-foreground-muted transition-colors hover:bg-surface2 hover:text-foreground disabled:cursor-default disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void confirmDelete()}
              disabled={deleting}
              className="cursor-pointer rounded-base bg-destructive px-2.5 py-1 text-xs font-medium text-destructive-foreground transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
