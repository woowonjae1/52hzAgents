'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';

export type DiffSide = 'old' | 'new';

export interface ReviewComment {
  id: string;
  filePath: string;
  lineNumber: number;
  side: DiffSide;
  text: string;
  codeLine?: string;
}

export interface ReviewDraft {
  filePath: string;
  side: DiffSide;
  lineNumber: number;
  text: string;
  codeLine?: string;
}

export interface ReviewContextType {
  comments: ReviewComment[];
  drafts: Record<string, ReviewDraft>;
  addComment: (comment: Omit<ReviewComment, 'id'>) => void;
  updateComment: (id: string, text: string) => void;
  deleteComment: (id: string) => void;
  clearComments: () => void;
  setDraft: (key: string, draft: ReviewDraft | null) => void;
  generateReviewMarkdown: () => string;
}

const ReviewContext = createContext<ReviewContextType | null>(null);

function genReviewId(): string {
  return `rev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildReviewKey(filePath: string, side: DiffSide, lineNumber: number): string {
  return `${filePath}::${side}::${lineNumber}`;
}

export function buildAgentPromptWithReview(
  rawUserMessage: string,
  contextParts: (string | null | undefined)[]
): { prompt: string; isSlashCommand: boolean } {
  const trimmed = rawUserMessage.trim();
  const isSlashCommand = Boolean(trimmed && trimmed.startsWith('/') && !trimmed.includes('\n'));

  const validContext = contextParts.map((p) => (p ? p.trim() : '')).filter(Boolean);
  const parts = isSlashCommand
    ? [trimmed]
    : [...validContext, trimmed].filter(Boolean);

  return {
    prompt: parts.join('\n\n'),
    isSlashCommand,
  };
}

export function ReviewProvider({
  children,
  workspaceId,
}: {
  children: ReactNode;
  workspaceId?: string | null;
}) {
  const [comments, setComments] = useState<ReviewComment[]>([]);
  const [drafts, setDrafts] = useState<Record<string, ReviewDraft>>({});

  const addComment = useCallback((comment: Omit<ReviewComment, 'id'>) => {
    const newComment: ReviewComment = {
      ...comment,
      id: genReviewId(),
    };
    setComments((prev) => [...prev, newComment]);
  }, []);

  const updateComment = useCallback((id: string, text: string) => {
    setComments((prev) =>
      prev.map((comment) =>
        comment.id === id ? { ...comment, text } : comment
      )
    );
  }, []);

  const deleteComment = useCallback((id: string) => {
    setComments((prev) => prev.filter((comment) => comment.id !== id));
  }, []);

  const clearComments = useCallback(() => {
    setComments([]);
    setDrafts({});
  }, []);

  useEffect(() => {
    return () => clearComments();
  }, [workspaceId, clearComments]);

  const setDraft = useCallback((key: string, draft: ReviewDraft | null) => {
    setDrafts((prev) => {
      if (draft === null) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: draft };
    });
  }, []);

  const generateReviewMarkdown = useCallback(() => {
    if (comments.length === 0) return '';

    const commentsNum = comments.length;
    const header = `## Review Comments (${commentsNum})\n\n`;
    const formatCodeLine = (line?: string) => {
      if (!line) return '';
      const trimmedLine = line.trim();
      if (!trimmedLine) return '';
      if (trimmedLine.includes('`')) {
        return `\`\`\`\n${trimmedLine}\n\`\`\``;
      }
      return `\`${trimmedLine}\``;
    };

    const commentsMd = comments
      .map((comment) => {
        const codeLine = formatCodeLine(comment.codeLine);
        const bodyWithFormattedPaths = comment.text
          .trim()
          .replace(/([/\\]?[\w.-]+(?:[/\\][\w.-]+)+)/g, '`$1`');
        if (codeLine) {
          return `**${comment.filePath}** (Line ${comment.lineNumber})\n${codeLine}\n\n> ${bodyWithFormattedPaths}\n`;
        }
        return `**${comment.filePath}** (Line ${comment.lineNumber})\n\n> ${bodyWithFormattedPaths}\n`;
      })
      .join('\n');

    return header + commentsMd;
  }, [comments]);

  const contextValue = useMemo<ReviewContextType>(
    () => ({
      comments,
      drafts,
      addComment,
      updateComment,
      deleteComment,
      clearComments,
      setDraft,
      generateReviewMarkdown,
    }),
    [
      comments,
      drafts,
      addComment,
      updateComment,
      deleteComment,
      clearComments,
      setDraft,
      generateReviewMarkdown,
    ]
  );

  return (
    <ReviewContext.Provider value={contextValue}>
      {children}
    </ReviewContext.Provider>
  );
}

export function useReview(): ReviewContextType {
  const context = useContext(ReviewContext);
  if (!context) {
    throw new Error('useReview must be used within a ReviewProvider');
  }
  return context;
}

export function useReviewOptional(): ReviewContextType | null {
  return useContext(ReviewContext);
}
