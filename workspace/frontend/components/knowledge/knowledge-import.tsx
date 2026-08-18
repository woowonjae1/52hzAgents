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

import { AlertCircle, BookOpen, FileText, UploadCloud } from 'lucide-react';
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
  if (!visible) return null;
  return (
    <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed border-border-accent bg-surface1/95 backdrop-blur-sm p-6 text-center">
      <div className="size-14 rounded-full bg-surface3 border border-border-accent flex items-center justify-center">
        <UploadCloud className="size-7 text-status-warning" />
      </div>
      <p className="text-sm font-semibold">Drop documents to import</p>
      <p className="text-xs text-muted-foreground max-w-xs">
        Markdown or plain text — each file becomes a knowledge entry your agents can reference
      </p>
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

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v && !importing) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpen className="size-4 text-status-warning" />
            Import to knowledge base
          </DialogTitle>
        </DialogHeader>

        {parsing ? (
          <div className="py-10 text-center text-sm text-muted-foreground">Reading files...</div>
        ) : (
          <>
            <div className="max-h-[50vh] overflow-y-auto -mx-1 px-1">
              <div className="divide-y divide-border rounded-md border border-border">
                {docs.map((doc) => (
                  <div key={doc.key} className="flex items-start gap-3 p-3">
                    <FileText className={`size-4 mt-0.5 shrink-0 ${doc.error ? 'text-muted-foreground/40' : 'text-muted-foreground'}`} />
                    <div className="min-w-0 flex-1">
                      <p className={`text-sm font-medium truncate ${doc.error ? 'text-muted-foreground line-through' : ''}`}>
                        {doc.title}
                      </p>
                      <p className="text-[11px] text-muted-foreground/70 truncate mt-0.5">
                        {doc.fileName} · {formatBytes(doc.bytes)}
                      </p>
                      {doc.error && (
                        <p className="text-[11px] text-status-danger mt-1 flex items-center gap-1">
                          <AlertCircle className="size-3 shrink-0" />
                          {doc.error}
                        </p>
                      )}
                      {!doc.error && doc.conflict && (
                        <p className="text-[11px] text-status-warning mt-1">
                          Already exists as <span className="font-mono">@knowledge:{doc.conflict.slug}</span>
                        </p>
                      )}
                    </div>

                    {!doc.error && (
                      <div className="shrink-0">
                        {doc.conflict ? (
                          <select
                            value={doc.action}
                            onChange={(e) => setAction(doc.key, e.target.value as ImportAction)}
                            className="text-xs bg-surface2 border border-border rounded-md px-2 py-1 cursor-pointer"
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
                            className="text-xs bg-surface2 border border-border rounded-md px-2 py-1 cursor-pointer"
                            aria-label={`Action for ${doc.fileName}`}
                          >
                            <option value="create">Add</option>
                            <option value="skip">Skip</option>
                          </select>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <p className="text-[11px] text-muted-foreground">
              {importable.length} of {docs.length} will be imported
              {conflictCount > 0 && ` · ${conflictCount} already exist`}
              {errorCount > 0 && ` · ${errorCount} unusable`}
            </p>
          </>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={importing}>Cancel</Button>
          <Button onClick={handleImport} disabled={importing || parsing || importable.length === 0}>
            {importing ? 'Importing...' : `Import ${importable.length || ''}`.trim()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
