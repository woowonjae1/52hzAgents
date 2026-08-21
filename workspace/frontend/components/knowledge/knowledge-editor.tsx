'use client';

import { useState, useEffect, useMemo } from 'react';
import { FileText, PenLine, Sparkles } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/lib/workspace-context';
import type { KnowledgeEntry } from '@/lib/types';

interface KnowledgeEditorProps {
  open: boolean;
  entry: (KnowledgeEntry & { content: string }) | null;
  onClose: () => void;
  onSaved: () => void;
}

/** Micro-label typography shared with the rest of the knowledge surface. */
const MICRO =
  'text-3xs font-medium uppercase tracking-wider text-foreground-extra-muted';

export function KnowledgeEditor({ open, entry, onClose, onSaved }: KnowledgeEditorProps) {
  const { createKnowledge, updateKnowledge } = useWorkspace();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);

  const isEditing = !!entry;

  useEffect(() => {
    if (open) {
      if (entry) {
        setTitle(entry.title);
        setDescription(entry.description || '');
        setContent(entry.content || '');
      } else {
        setTitle('');
        setDescription('');
        setContent('');
      }
    }
  }, [open, entry]);

  // Purely for the "unsaved changes" affordance — never gates saving.
  const isDirty = useMemo(() => {
    if (entry) {
      return title !== entry.title
        || description !== (entry.description || '')
        || content !== (entry.content || '');
    }
    return title.length > 0 || description.length > 0 || content.length > 0;
  }, [entry, title, description, content]);

  const canSave = !!title.trim() && !!content.trim();
  const wordCount = content.trim() ? content.trim().split(/\s+/).length : 0;

  const handleSave = async () => {
    if (!title.trim() || !content.trim()) return;
    setSaving(true);
    try {
      if (isEditing && entry) {
        await updateKnowledge(entry.id, {
          title: title.trim(),
          content: content.trim(),
          description: description.trim() || undefined,
        });
      } else {
        await createKnowledge({
          title: title.trim(),
          content: content.trim(),
          description: description.trim() || undefined,
        });
      }
      onSaved();
    } catch {
      // ignore
    } finally {
      setSaving(false);
    }
  };

  const fieldClass =
    'h-9 rounded-lg border-border/70 bg-surface1 text-sm text-foreground shadow-sm transition-all duration-200 focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:border-primary/40';

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-3xl max-h-[88vh] flex flex-col gap-0 p-0 overflow-hidden">
        <DialogHeader className="shrink-0 mb-0 border-b border-border/70 px-6 py-4">
          <div className="flex items-center gap-3">
            <span
              className={cn(
                'flex size-9 shrink-0 items-center justify-center rounded-xl',
                isEditing
                  ? 'bg-surface2 text-foreground-muted'
                  : 'bg-primary/10 text-primary',
              )}
            >
              {isEditing ? <PenLine className="size-4" /> : <Sparkles className="size-4" />}
            </span>
            <div className="min-w-0 text-start">
              <DialogTitle className="text-sm font-semibold tracking-tight text-foreground">
                {isEditing ? 'Edit Knowledge Entry' : 'New Knowledge Entry'}
              </DialogTitle>
              <p className="mt-0.5 text-sm text-foreground-muted">
                {isEditing
                  ? 'Changes apply everywhere this entry is referenced.'
                  : 'Shared context every agent in this workspace can reference.'}
              </p>
            </div>
          </div>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <div className="mx-auto w-full max-w-2xl space-y-6">
            <div className="grid grid-cols-1 gap-4">
              <div className="space-y-2">
                <Label htmlFor="kb-title" className={MICRO}>Title</Label>
                <Input
                  id="kb-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. API Design Patterns"
                  className={fieldClass}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="kb-description" className={MICRO}>Description (optional)</Label>
                <Input
                  id="kb-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Short summary of what this entry covers"
                  className={fieldClass}
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="kb-content" className={MICRO}>Content (Markdown)</Label>
                <span className={cn(MICRO, 'tabular-nums')}>
                  {content.length.toLocaleString()} chars · {wordCount.toLocaleString()} words
                </span>
              </div>
              <div className="rounded-xl border border-border/70 bg-surface1 shadow-sm transition-all duration-200 focus-within:shadow-md focus-within:ring-2 focus-within:ring-primary/30 focus-within:border-primary/40">
                <div className="flex items-center gap-1.5 border-b border-border/70 px-3 py-2">
                  <FileText className="size-3.5 text-foreground-extra-muted" />
                  <span className={MICRO}>Markdown</span>
                </div>
                <textarea
                  id="kb-content"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="Write your knowledge entry in Markdown..."
                  spellCheck={false}
                  className="w-full min-h-[340px] resize-y rounded-b-xl bg-transparent px-4 py-3 text-sm font-mono leading-relaxed text-foreground placeholder:text-foreground-extra-muted focus-visible:outline-none"
                />
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="shrink-0 items-center border-t border-border/70 bg-surface2/50 px-6 py-4 pt-4 sm:justify-between">
          <div className="flex items-center gap-2 text-start">
            {isDirty ? (
              <>
                <span className="size-1.5 rounded-full bg-amber-500 dark:bg-amber-400" aria-hidden />
                <span className={MICRO}>Unsaved changes</span>
              </>
            ) : (
              <span className={MICRO}>
                {canSave ? 'Up to date' : 'Title and content are required'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2.5">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving || !title.trim() || !content.trim()}>
              {saving ? 'Saving...' : isEditing ? 'Save Changes' : 'Create'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
