'use client';

/**
 * Bulk import of local `.md` / `.txt` documents into the knowledge base.
 *
 * The slug is generated server-side (`knowledgeSlugify` +
 * `knowledgeUniqueSlug`), including collision suffixes, so the client only has
 * to decide the *title* and whether a drop means "add" or "replace".
 *
 * That decision is the whole reason there is a confirm step instead of a
 * straight drag-and-done: re-dropping a file you already imported is the normal
 * case (you edited it locally), and silently creating `readme`, `readme-2`,
 * `readme-3` would quietly rot the knowledge base. Conflicts default to
 * overwrite, but every one of them is listed before anything is written.
 */

import { AlertCircle, BookOpen, Check, FileText, RefreshCw, UploadCloud } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { KnowledgeEntry } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/lib/workspace-context';

/** Accept string shared by the drop handler and the file picker. */
export const KNOWLEDGE_IMPORT_ACCEPT = '.md,.markdown,.txt,.mdx';

const ACCEPTED_EXTENSIONS = ['.md', '.markdown', '.mdx', '.txt'];

/**
 * Refuse anything above this. These are documents, not blobs: a 5 MB "markdown"
 * file is a mistake (a minified dump, a wrong drag), and importing it would
 * bloat every agent prompt that references the entry.
 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** Micro-label typography shared with the rest of the knowledge surface. */
const MICRO =
  'text-[10px] font-medium uppercase tracking-wider text-foreground-extra-muted';

type ImportAction = 'create' | 'overwrite' | 'skip';

interface ParsedDoc {
  key: string;
  fileName: string;
  title: string;
  content: string;
  bytes: number;
  /** Existing active entry with the same title, if any. */
  conflict: KnowledgeEntry | null;
  action: ImportAction;
  /** Set when the file could not be used at all; such rows are never imported. */
  error: string | null;
}

function hasAcceptedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Title = the document's first `# heading`, falling back to the filename.
 *
 * Only a leading H1 counts, and only within the first few lines: a `#` further
 * down is a section of the document, not its name. Front-matter is skipped so a
 * Obsidian/Hugo export doesn't get titled `---`.
 */
export function deriveTitle(fileName: string, content: string): string {
  const lines = content.split(/\r?\n/);
  let i = 0;

  // Skip YAML front matter, and prefer its `title:` when present.
  if (lines[0]?.trim() === '---') {
    for (let j = 1; j < lines.length && j < 50; j++) {
      const line = lines[j].trim();
      if (line === '---') { i = j + 1; break; }
      const m = /^title:\s*(.+)$/i.exec(line);
      if (m) {
        const value = m[1].trim().replace(/^["']|["']$/g, '').trim();
        if (value) return value.slice(0, 200);
      }
    }
  }

  for (let scanned = 0; i < lines.length && scanned < 10; i++, scanned++) {
    const line = lines[i].trim();
    if (!line) { scanned--; continue; }
    const m = /^#\s+(.+)$/.exec(line);
    if (m) return m[1].trim().slice(0, 200);
    break; // First non-empty line isn't an H1 — the file has no title of its own.
  }

  return stripExtension(fileName).trim().slice(0, 200) || fileName;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Window-level drag/drop listener for knowledge import.
 *
 * Mounted only inside the knowledge view, and `DropzoneOverlay` (the app-wide
 * "upload to shared storage" handler) stands down while that view is open, so
 * the two never both claim a drop.
 */
export function useKnowledgeDropzone(onFiles: (files: File[]) => void): boolean {
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    let dragCounter = 0;

    const onDragEnter = (e: DragEvent) => {
      e.preventDefault();
      dragCounter++;
      if (e.dataTransfer?.items && e.dataTransfer.items.length > 0) setIsDragging(true);
    };
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) { dragCounter = 0; setIsDragging(false); }
    };
    const onDragOver = (e: DragEvent) => { e.preventDefault(); };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounter = 0;
      setIsDragging(false);
      const dropped = e.dataTransfer?.files;
      if (dropped && dropped.length > 0) onFiles(Array.from(dropped));
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [onFiles]);

  return isDragging;
}

export function KnowledgeDropOverlay({ visible }: { visible: boolean }) {
  const reduceMotion = useReducedMotion();
  if (!visible) return null;
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center p-4 bg-background/80 backdrop-blur-md">
      <motion.div
        initial={reduceMotion ? false : { opacity: 0, scale: 0.98, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="flex w-full max-w-md flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary/50 bg-surface1/70 p-8 text-center shadow-sm"
      >
        <div className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
          <UploadCloud className="size-6" />
        </div>
        <p className="text-sm font-semibold tracking-tight text-foreground">
          Drop documents to import
        </p>
        <p className="max-w-xs text-sm text-foreground-muted">
          Markdown or plain text — each file becomes a knowledge entry your agents can reference
        </p>
        <div className="mt-1 flex flex-wrap items-center justify-center gap-1.5">
          {ACCEPTED_EXTENSIONS.map((ext) => (
            <span
              key={ext}
              className="rounded-md bg-surface2 px-1.5 py-0.5 font-mono text-[10px] text-foreground-muted"
            >
              {ext}
            </span>
          ))}
        </div>
      </motion.div>
    </div>
  );
}

/** Status chip describing what will happen to one row on import. */
function StatusChip({ doc }: { doc: ParsedDoc }) {
  const base = 'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium';
  if (doc.error) {
    return (
      <span className={cn(base, 'bg-red-500/10 text-red-600 dark:bg-red-400/10 dark:text-red-400')}>
        <AlertCircle className="size-3" /> Unusable
      </span>
    );
  }
  if (doc.action === 'skip') {
    return <span className={cn(base, 'bg-surface2 text-foreground-muted')}>Skipped</span>;
  }
  if (doc.action === 'overwrite') {
    return (
      <span className={cn(base, 'bg-amber-500/10 text-amber-600 dark:bg-amber-400/10 dark:text-amber-400')}>
        <RefreshCw className="size-3" /> Replaces
      </span>
    );
  }
  return (
    <span className={cn(base, 'bg-emerald-500/10 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-400')}>
      <Check className="size-3" /> New
    </span>
  );
}

/** Skeleton row matching the parsed-document card while files are read. */
function DocSkeleton() {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-border/70 bg-surface1 p-4 shadow-sm">
      <div className="size-8 shrink-0 rounded-lg bg-surface3 animate-pulse" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="h-3.5 w-1/3 rounded bg-surface3 animate-pulse" />
        <div className="h-2.5 w-1/2 rounded bg-surface2 animate-pulse" />
      </div>
      <div className="h-6 w-20 shrink-0 rounded-md bg-surface2 animate-pulse" />
    </div>
  );
}

interface KnowledgeImportDialogProps {
  /** Raw dropped/picked files. Non-empty opens the dialog. */
  files: File[];
  onClose: () => void;
  onImported: () => void;
}

export function KnowledgeImportDialog({ files, onClose, onImported }: KnowledgeImportDialogProps) {
  const { knowledge, createKnowledge, updateKnowledge } = useWorkspace();
  const [docs, setDocs] = useState<ParsedDoc[]>([]);
  const [parsing, setParsing] = useState(false);
  const [importing, setImporting] = useState(false);
  const reduceMotion = useReducedMotion();

  const open = files.length > 0;

  // Index by lowercased title so "README" and "readme" are the same document.
  const byTitle = useMemo(() => {
    const map = new Map<string, KnowledgeEntry>();
    for (const entry of knowledge) {
      if (entry.status && entry.status !== 'active') continue;
      map.set(entry.title.trim().toLowerCase(), entry);
    }
    return map;
  }, [knowledge]);

  useEffect(() => {
    if (!open) { setDocs([]); return; }
    let cancelled = false;
    setParsing(true);

    (async () => {
      const parsed: ParsedDoc[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const key = `${file.name}:${i}`;
        const base = { key, fileName: file.name, bytes: file.size };

        if (!hasAcceptedExtension(file.name)) {
          parsed.push({ ...base, title: stripExtension(file.name), content: '', conflict: null, action: 'skip', error: 'Unsupported file type' });
          continue;
        }
        if (file.size > MAX_FILE_BYTES) {
          parsed.push({ ...base, title: stripExtension(file.name), content: '', conflict: null, action: 'skip', error: `Too large (max ${formatBytes(MAX_FILE_BYTES)})` });
          continue;
        }

        let text: string;
        try {
          text = await file.text();
        } catch {
          parsed.push({ ...base, title: stripExtension(file.name), content: '', conflict: null, action: 'skip', error: 'Could not read file' });
          continue;
        }
        if (!text.trim()) {
          parsed.push({ ...base, title: stripExtension(file.name), content: '', conflict: null, action: 'skip', error: 'File is empty' });
          continue;
        }

        const title = deriveTitle(file.name, text);
        const conflict = byTitle.get(title.trim().toLowerCase()) || null;
        parsed.push({
          ...base,
          title,
          content: text,
          conflict,
          // Re-importing an edited local file is the common case, so replacing
          // is the sane default — but it is shown, never silent.
          action: conflict ? 'overwrite' : 'create',
          error: null,
        });
      }
      if (!cancelled) { setDocs(parsed); setParsing(false); }
    })();

    return () => { cancelled = true; };
  }, [open, files, byTitle]);

  const setAction = useCallback((key: string, action: ImportAction) => {
    setDocs((prev) => prev.map((d) => (d.key === key ? { ...d, action } : d)));
  }, []);

  const importable = docs.filter((d) => !d.error && d.action !== 'skip');

  const handleImport = useCallback(async () => {
    if (importable.length === 0) return;
    setImporting(true);
    let created = 0;
    let replaced = 0;
    const failed: string[] = [];

    for (const doc of importable) {
      try {
        if (doc.action === 'overwrite' && doc.conflict) {
          await updateKnowledge(doc.conflict.id, { title: doc.title, content: doc.content });
          replaced++;
        } else {
          await createKnowledge({ title: doc.title, content: doc.content });
          created++;
        }
      } catch (err) {
        failed.push(`${doc.fileName}: ${err instanceof Error ? err.message : 'failed'}`);
      }
    }

    setImporting(false);

    const parts: string[] = [];
    if (created) parts.push(`${created} added`);
    if (replaced) parts.push(`${replaced} replaced`);
    if (parts.length > 0) toast.success(`Knowledge imported — ${parts.join(', ')}`);
    // Report failures separately: a partial import that only shows the success
    // count reads as a clean run.
    if (failed.length > 0) {
      toast.error(
        failed.length === 1
          ? `Import failed — ${failed[0]}`
          : `${failed.length} files failed to import`,
      );
    }

    onImported();
    onClose();
  }, [importable, createKnowledge, updateKnowledge, onImported, onClose]);

  const conflictCount = docs.filter((d) => !d.error && d.conflict).length;
  const errorCount = docs.filter((d) => d.error).length;

  const selectClass =
    'cursor-pointer rounded-lg border border-border/70 bg-surface1 px-2 py-1 text-xs text-foreground shadow-sm transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30';

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !importing) onClose(); }}>
      <DialogContent className="sm:max-w-2xl gap-0 p-0 overflow-hidden">
        <DialogHeader className="mb-0 border-b border-border/70 px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/10 text-amber-600 dark:bg-amber-400/10 dark:text-amber-400">
              <BookOpen className="size-4" />
            </span>
            <div className="min-w-0 text-start">
              <DialogTitle className="text-sm font-semibold tracking-tight text-foreground">
                Import to knowledge base
              </DialogTitle>
              <p className="mt-0.5 text-sm text-foreground-muted">
                Review what each document will do before anything is written.
              </p>
            </div>
          </div>
        </DialogHeader>

        <div className="px-6 py-5">
          {parsing ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => <DocSkeleton key={i} />)}
            </div>
          ) : (
            <>
              <div className="max-h-[46vh] overflow-y-auto -mx-1 px-1">
                <div className="grid grid-cols-1 gap-3">
                  {docs.map((doc, index) => (
                    <motion.div
                      key={doc.key}
                      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.25, delay: reduceMotion ? 0 : Math.min(index, 12) * 0.03 }}
                      className={cn(
                        'flex items-start gap-3 rounded-xl border bg-surface1 p-4 shadow-sm transition-all duration-200 hover:shadow-md',
                        doc.error
                          ? 'border-red-500/25 dark:border-red-400/25'
                          : 'border-border/70',
                      )}
                    >
                      <span
                        className={cn(
                          'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg',
                          doc.error
                            ? 'bg-red-500/10 text-red-500/70 dark:bg-red-400/10 dark:text-red-400/70'
                            : 'bg-surface2 text-foreground-muted',
                        )}
                      >
                        <FileText className="size-4" />
                      </span>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p
                            className={cn(
                              'truncate text-sm font-semibold tracking-tight',
                              doc.error
                                ? 'text-foreground-extra-muted line-through'
                                : 'text-foreground',
                            )}
                          >
                            {doc.title}
                          </p>
                          <StatusChip doc={doc} />
                        </div>
                        <p className={cn(MICRO, 'mt-1 truncate normal-case tracking-normal')}>
                          {doc.fileName} · {formatBytes(doc.bytes)}
                        </p>
                        {doc.error && (
                          <p className="mt-1.5 flex items-center gap-1 text-xs text-red-600 dark:text-red-400">
                            <AlertCircle className="size-3 shrink-0" />
                            {doc.error}
                          </p>
                        )}
                        {!doc.error && doc.conflict && (
                          <p className="mt-1.5 text-xs text-amber-600 dark:text-amber-400">
                            Already exists as{' '}
                            <span className="font-mono">@knowledge:{doc.conflict.slug}</span>
                          </p>
                        )}
                      </div>

                      {!doc.error && (
                        <div className="shrink-0">
                          {doc.conflict ? (
                            <select
                              value={doc.action}
                              onChange={(e) => setAction(doc.key, e.target.value as ImportAction)}
                              className={selectClass}
                              aria-label={`Action for ${doc.fileName}`}
                            >
                              <option value="overwrite">Replace</option>
                              <option value="create">Keep both</option>
                              <option value="skip">Skip</option>
                            </select>
                          ) : (
                            <select
                              value={doc.action}
                              onChange={(e) => setAction(doc.key, e.target.value as ImportAction)}
                              className={selectClass}
                              aria-label={`Action for ${doc.fileName}`}
                            >
                              <option value="create">Add</option>
                              <option value="skip">Skip</option>
                            </select>
                          )}
                        </div>
                      )}
                    </motion.div>
                  ))}
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <span className={cn(MICRO, 'tabular-nums')}>
                  {importable.length} of {docs.length} will be imported
                </span>
                {conflictCount > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400 tabular-nums">
                    {conflictCount} already exist
                  </span>
                )}
                {errorCount > 0 && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-400 tabular-nums">
                    {errorCount} unusable
                  </span>
                )}
              </div>
            </>
          )}
        </div>

        <DialogFooter className="border-t border-border/70 bg-surface2/50 px-6 py-4 pt-4">
          <Button variant="ghost" onClick={onClose} disabled={importing}>Cancel</Button>
          <Button onClick={handleImport} disabled={importing || parsing || importable.length === 0}>
            {importing ? 'Importing...' : `Import ${importable.length || ''}`.trim()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
