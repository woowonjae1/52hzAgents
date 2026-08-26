'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  FileText,
  PenLine,
  Sparkles,
  Columns2,
  Eye,
  Edit3,
  Bold,
  Italic,
  Code,
  Heading1,
  Heading2,
  Quote,
  List,
  Table,
  Link,
  Bot,
  Layers,
} from 'lucide-react';
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
import { MarkdownContent } from '@/components/chat/markdown-content';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/lib/workspace-context';
import type { KnowledgeEntry } from '@/lib/types';
import { toast } from 'sonner';

interface KnowledgeEditorProps {
  open: boolean;
  entry: (KnowledgeEntry & { content: string }) | null;
  onClose: () => void;
  onSaved: () => void;
}

const MICRO = 'text-3xs font-medium uppercase tracking-wider text-foreground-extra-muted';

type EditorViewMode = 'edit' | 'split' | 'preview';

export function KnowledgeEditor({ open, entry, onClose, onSaved }: KnowledgeEditorProps) {
  const { createKnowledge, updateKnowledge, agents } = useWorkspace();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [viewMode, setViewMode] = useState<EditorViewMode>('split');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const isDirty = useMemo(() => {
    if (entry) {
      return (
        title !== entry.title ||
        description !== (entry.description || '') ||
        content !== (entry.content || '')
      );
    }
    return title.length > 0 || description.length > 0 || content.length > 0;
  }, [entry, title, description, content]);

  const canSave = !!title.trim() && !!content.trim();
  const wordCount = content.trim() ? content.trim().split(/\s+/).length : 0;
  const lineCount = content.split('\n').length;
  const readTimeMin = Math.max(1, Math.ceil(wordCount / 200));

  const insertFormatting = useCallback((prefix: string, suffix = '', placeholder = 'text') => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selectedText = content.substring(start, end) || placeholder;
    const replacement = `${prefix}${selectedText}${suffix}`;
    const newContent = content.substring(0, start) + replacement + content.substring(end);
    setContent(newContent);

    setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(start + prefix.length, start + prefix.length + selectedText.length);
    }, 0);
  }, [content]);

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
        toast.success(`Knowledge updated: ${title.trim()}`);
      } else {
        await createKnowledge({
          title: title.trim(),
          content: content.trim(),
          description: description.trim() || undefined,
        });
        toast.success(`Knowledge created: ${title.trim()}`);
      }
      onSaved();
    } catch {
      toast.error('Failed to save knowledge entry');
    } finally {
      setSaving(false);
    }
  };

  const fieldClass =
    'h-9 rounded-lg border-border/70 bg-surface1 text-sm text-foreground shadow-xs transition-all duration-200 focus-visible:ring-2 focus-visible:ring-primary/30 focus-visible:border-primary/40';

  const toolBtnClass =
    'p-1.5 rounded-md text-foreground-muted hover:text-foreground hover:bg-surface3 transition-colors cursor-pointer text-xs';

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="sm:max-w-5xl max-h-[92vh] flex flex-col gap-0 p-0 overflow-hidden border-border/80 shadow-2xl">
        {/* Header */}
        <DialogHeader className="shrink-0 mb-0 border-b border-border/70 px-6 py-3.5 bg-surface1/80 backdrop-blur-md">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 min-w-0">
              <span
                className={cn(
                  'flex size-8 shrink-0 items-center justify-center rounded-xl',
                  isEditing ? 'bg-surface2 text-foreground-muted' : 'bg-primary/10 text-primary'
                )}
              >
                {isEditing ? <PenLine className="size-4" /> : <Sparkles className="size-4" />}
              </span>
              <div className="min-w-0 text-start">
                <DialogTitle className="text-sm font-semibold tracking-tight text-foreground truncate">
                  {isEditing ? `Edit: ${entry.title}` : 'Create Knowledge Base Entry'}
                </DialogTitle>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <span className="flex items-center gap-1 text-3xs text-emerald-600 dark:text-emerald-400 font-medium">
                    <Bot className="size-3" />
                    <span>Global Agent Sync · 对全量智能体自动共享生效</span>
                  </span>
                </div>
              </div>
            </div>

            {/* View Mode Switcher */}
            <div className="flex items-center bg-surface2/80 rounded-lg p-0.5 border border-border/60 shrink-0">
              <button
                type="button"
                onClick={() => setViewMode('edit')}
                className={cn(
                  'flex items-center gap-1 px-2.5 py-1 rounded-md text-2xs font-medium transition-all cursor-pointer',
                  viewMode === 'edit'
                    ? 'bg-surface1 text-foreground shadow-xs font-semibold'
                    : 'text-foreground-muted hover:text-foreground'
                )}
                title="Editor only"
              >
                <Edit3 className="size-3" />
                <span className="hidden sm:inline">Editor</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('split')}
                className={cn(
                  'flex items-center gap-1 px-2.5 py-1 rounded-md text-2xs font-medium transition-all cursor-pointer',
                  viewMode === 'split'
                    ? 'bg-surface1 text-foreground shadow-xs font-semibold'
                    : 'text-foreground-muted hover:text-foreground'
                )}
                title="Split live preview"
              >
                <Columns2 className="size-3" />
                <span className="hidden sm:inline">Split</span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode('preview')}
                className={cn(
                  'flex items-center gap-1 px-2.5 py-1 rounded-md text-2xs font-medium transition-all cursor-pointer',
                  viewMode === 'preview'
                    ? 'bg-surface1 text-foreground shadow-xs font-semibold'
                    : 'text-foreground-muted hover:text-foreground'
                )}
                title="Preview only"
              >
                <Eye className="size-3" />
                <span className="hidden sm:inline">Preview</span>
              </button>
            </div>
          </div>
        </DialogHeader>

        {/* Body */}
        <div className="flex-1 overflow-hidden flex flex-col p-6 space-y-4 bg-background">
          {/* Metadata Row */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 shrink-0">
            <div className="space-y-1.5">
              <Label htmlFor="kb-title" className={MICRO}>Document Title *</Label>
              <Input
                id="kb-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Code Review Standards & API Guidelines"
                className={fieldClass}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="kb-description" className={MICRO}>Summary / Scope (Optional)</Label>
              <Input
                id="kb-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Core architectural principles for all agents"
                className={fieldClass}
              />
            </div>
          </div>

          {/* Main Editor / Preview Container */}
          <div className="flex-1 min-h-[380px] flex flex-col rounded-xl border border-border/80 bg-surface1/60 shadow-xs overflow-hidden">
            {/* Markdown Toolbar */}
            <div className="flex items-center justify-between border-b border-border/70 px-3 py-1.5 bg-surface2/60 shrink-0">
              <div className="flex items-center gap-0.5 overflow-x-auto">
                <button
                  type="button"
                  onClick={() => insertFormatting('**', '**', 'bold text')}
                  className={toolBtnClass}
                  title="Bold (**text**)"
                >
                  <Bold className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => insertFormatting('*', '*', 'italic text')}
                  className={toolBtnClass}
                  title="Italic (*text*)"
                >
                  <Italic className="size-3.5" />
                </button>
                <div className="h-3 w-px bg-border/80 mx-1" />
                <button
                  type="button"
                  onClick={() => insertFormatting('# ', '', 'Heading 1')}
                  className={toolBtnClass}
                  title="Heading 1"
                >
                  <Heading1 className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => insertFormatting('## ', '', 'Heading 2')}
                  className={toolBtnClass}
                  title="Heading 2"
                >
                  <Heading2 className="size-3.5" />
                </button>
                <div className="h-3 w-px bg-border/80 mx-1" />
                <button
                  type="button"
                  onClick={() => insertFormatting('`', '`', 'code')}
                  className={toolBtnClass}
                  title="Inline Code"
                >
                  <Code className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => insertFormatting('```ts\n', '\n```', '// code snippet')}
                  className={toolBtnClass}
                  title="Code Block"
                >
                  <FileText className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => insertFormatting('> [!NOTE]\n> ', '', 'Important note for agents')}
                  className={toolBtnClass}
                  title="Callout Box"
                >
                  <Quote className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => insertFormatting('- ', '', 'List item')}
                  className={toolBtnClass}
                  title="Bullet List"
                >
                  <List className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => insertFormatting('| Column 1 | Column 2 |\n|---|---|\n| Item 1 | Item 2 |\n', '', '')}
                  className={toolBtnClass}
                  title="Markdown Table"
                >
                  <Table className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => insertFormatting('[', '](https://...)', 'Link title')}
                  className={toolBtnClass}
                  title="Link"
                >
                  <Link className="size-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => insertFormatting('```mermaid\ngraph TD\n  A[Client] --> B[Server]\n```\n', '', '')}
                  className={toolBtnClass}
                  title="Mermaid Diagram"
                >
                  <Layers className="size-3.5" />
                </button>
              </div>

              <div className="flex items-center gap-2 text-3xs font-mono text-foreground-extra-muted tabular-nums shrink-0 pl-2">
                <span>{lineCount} lines</span>
                <span>·</span>
                <span>{wordCount} words</span>
                <span>·</span>
                <span>~{readTimeMin} min read</span>
              </div>
            </div>

            {/* Split Content Area */}
            <div className="flex-1 flex min-h-0 overflow-hidden">
              {/* Editor Pane */}
              {(viewMode === 'edit' || viewMode === 'split') && (
                <div className={cn(
                  'h-full flex flex-col bg-background/50',
                  viewMode === 'split' ? 'w-1/2 border-r border-border/70' : 'w-full'
                )}>
                  <textarea
                    ref={textareaRef}
                    id="kb-content"
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder="Write detailed knowledge specifications, rules, or system documentation in Markdown..."
                    spellCheck={false}
                    className="w-full h-full p-4 resize-none bg-transparent font-mono text-xs leading-relaxed text-foreground placeholder:text-foreground-extra-muted focus-visible:outline-none overflow-y-auto"
                  />
                </div>
              )}

              {/* Preview Pane */}
              {(viewMode === 'preview' || viewMode === 'split') && (
                <div className={cn(
                  'h-full overflow-y-auto p-5 bg-surface0/70',
                  viewMode === 'split' ? 'w-1/2' : 'w-full'
                )}>
                  {content.trim() ? (
                    <div className="prose prose-xs dark:prose-invert max-w-none">
                      <MarkdownContent content={content} />
                    </div>
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center text-center text-foreground-extra-muted text-xs">
                      <Eye className="size-8 mb-2 opacity-40" />
                      <p>Live Markdown preview will appear here as you type.</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <DialogFooter className="shrink-0 items-center border-t border-border/70 bg-surface1/80 px-6 py-3.5 sm:justify-between">
          <div className="flex items-center gap-2 text-start">
            {isDirty ? (
              <>
                <span className="size-2 rounded-full bg-amber-500 animate-pulse" aria-hidden />
                <span className={MICRO}>Unsaved modifications</span>
              </>
            ) : (
              <span className={MICRO}>
                {canSave ? 'Document is synchronized' : 'Title and Markdown content are required'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2.5">
            <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving || !title.trim() || !content.trim()}>
              {saving ? 'Saving...' : isEditing ? 'Save Changes' : 'Create Knowledge'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
