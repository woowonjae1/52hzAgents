'use client';

import React, { useState, useCallback, memo, type ReactNode } from 'react';
import { SquarePen, Trash2, Check, X, MessageSquarePlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isComposing } from '@/lib/ime';
import { useReview, type ReviewComment, type ReviewDraft } from '@/lib/review-context';

export type CommentCardVariant = 'user' | 'github' | 'input';

interface CommentCardProps {
  variant: CommentCardVariant;
  children: ReactNode;
  header?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

const variantStyles: Record<CommentCardVariant, string> = {
  user: 'bg-primary/[0.06] border-primary/35 dark:bg-primary/[0.10] dark:border-primary/40',
  github: 'bg-surface2 border-border',
  input: 'bg-surface1 border-primary/40 shadow-xs',
};

/**
 * Shared primitive for displaying inline review comments in diff views.
 * Ported from cdesktop `@vibe/ui/components/CommentCard`.
 */
export function CommentCard({
  variant,
  children,
  header,
  actions,
  className,
}: CommentCardProps) {
  return (
    <div
      className="px-3 py-2 bg-surface1/90 border-y border-border/60 font-sans text-xs select-text"
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className={cn(
          'p-2.5 rounded-lg border transition-colors',
          variantStyles[variant],
          className
        )}
      >
        {header && <div className="mb-1.5">{header}</div>}
        {children}
        {actions && <div className="mt-2 flex items-center gap-1.5">{actions}</div>}
      </div>
    </div>
  );
}

interface CommentWidgetLineProps {
  draft: ReviewDraft;
  widgetKey: string;
  onSave?: () => void;
  onCancel?: () => void;
}

/**
 * Inline draft editor for adding a line-level review comment on a diff line.
 * Ported from cdesktop `CommentWidgetLine.tsx`.
 */
export const CommentWidgetLine = memo(function CommentWidgetLine({
  draft,
  widgetKey,
  onSave,
  onCancel,
}: CommentWidgetLineProps) {
  const { setDraft, addComment } = useReview();
  const [value, setValue] = useState(draft.text);

  const handleCancel = useCallback(() => {
    setDraft(widgetKey, null);
    onCancel?.();
  }, [setDraft, widgetKey, onCancel]);

  const handleSave = useCallback(() => {
    const trimmed = value.trim();
    if (!trimmed) return;
    addComment({
      filePath: draft.filePath,
      side: draft.side,
      lineNumber: draft.lineNumber,
      text: trimmed,
      codeLine: draft.codeLine,
    });
    setDraft(widgetKey, null);
    onSave?.();
  }, [value, draft, setDraft, widgetKey, onSave, addComment]);

  return (
    <CommentCard
      variant="input"
      header={
        <div className="flex items-center justify-between text-3xs text-foreground-muted font-mono">
          <span className="inline-flex items-center gap-1">
            <MessageSquarePlus className="size-3 text-primary" />
            <span>
              Review comment on <strong className="text-foreground">{draft.filePath.split(/[/\\]/).pop()}</strong> : Line {draft.lineNumber}
            </span>
          </span>
          <span className="text-foreground-extra-muted">Ctrl+Enter to add</span>
        </div>
      }
      actions={
        <>
          <button
            type="button"
            onClick={handleSave}
            disabled={!value.trim()}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-primary text-primary-foreground text-2xs font-medium hover:opacity-90 transition-opacity disabled:opacity-40 cursor-pointer"
          >
            <Check className="size-3" />
            <span>Add review comment</span>
          </button>
          <button
            type="button"
            onClick={handleCancel}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-surface2 hover:bg-surface3 text-foreground-muted hover:text-foreground text-2xs font-medium border border-border/60 transition-colors cursor-pointer"
          >
            <X className="size-3" />
            <span>Cancel</span>
          </button>
        </>
      }
    >
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Write proofreading / code review feedback for this line…"
        autoFocus
        rows={2}
        onKeyDown={(e) => {
          if (isComposing(e)) return;
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
            e.preventDefault();
            handleSave();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            handleCancel();
          }
        }}
        className="w-full rounded-md bg-surface0/80 px-2.5 py-1.5 text-xs text-foreground placeholder:text-foreground-extra-muted border border-border/60 focus:border-primary/50 outline-hidden resize-y min-h-[52px]"
      />
    </CommentCard>
  );
});

interface ReviewCommentRendererProps {
  comment: ReviewComment;
}

/**
 * Renders a saved line-level review comment inside the diff with Edit / Delete controls.
 * Ported from cdesktop `ReviewCommentRenderer.tsx`.
 */
export const ReviewCommentRenderer = memo(function ReviewCommentRenderer({
  comment,
}: ReviewCommentRendererProps) {
  const { deleteComment, updateComment } = useReview();
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(comment.text);

  const handleSave = () => {
    if (editText.trim()) {
      updateComment(comment.id, editText.trim());
    }
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditText(comment.text);
    setIsEditing(false);
  };

  if (isEditing) {
    return (
      <CommentCard
        variant="user"
        actions={
          <>
            <button
              type="button"
              onClick={handleSave}
              disabled={!editText.trim()}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-primary text-primary-foreground text-2xs font-medium hover:opacity-90 transition-opacity disabled:opacity-40 cursor-pointer"
            >
              <Check className="size-3" />
              <span>Save changes</span>
            </button>
            <button
              type="button"
              onClick={handleCancel}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-surface2 hover:bg-surface3 text-foreground-muted hover:text-foreground text-2xs font-medium border border-border/60 transition-colors cursor-pointer"
            >
              <span>Cancel</span>
            </button>
          </>
        }
      >
        <textarea
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          placeholder="Edit review comment…"
          autoFocus
          rows={2}
          onKeyDown={(e) => {
            if (isComposing(e)) return;
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
              e.preventDefault();
              handleSave();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              handleCancel();
            }
          }}
          className="w-full rounded-md bg-surface0 px-2.5 py-1.5 text-xs text-foreground border border-border/60 outline-hidden resize-y min-h-[52px]"
        />
      </CommentCard>
    );
  }

  return (
    <CommentCard
      variant="user"
      header={
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1.5 text-3xs font-mono text-primary font-semibold">
            <span>Review Comment</span>
            <span className="text-foreground-extra-muted">·</span>
            <span className="text-foreground-muted">Line {comment.lineNumber}</span>
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                setEditText(comment.text);
                setIsEditing(true);
              }}
              className="p-1 rounded hover:bg-surface2 text-foreground-muted hover:text-foreground transition-colors cursor-pointer"
              title="Edit comment"
              aria-label="Edit comment"
            >
              <SquarePen className="size-3" />
            </button>
            <button
              type="button"
              onClick={() => deleteComment(comment.id)}
              className="p-1 rounded hover:bg-destructive/15 text-foreground-muted hover:text-destructive transition-colors cursor-pointer"
              title="Delete comment"
              aria-label="Delete comment"
            >
              <Trash2 className="size-3" />
            </button>
          </div>
        </div>
      }
    >
      <p className="text-xs text-foreground whitespace-pre-wrap leading-relaxed">{comment.text}</p>
    </CommentCard>
  );
});
