'use client';

import { BookOpen, ExternalLink, FileText, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SourceItem {
  title: string;
  slug?: string;
  snippet?: string;
  url?: string;
  type?: 'knowledge' | 'file' | 'web';
}

export interface SourcesCardProps {
  sources: SourceItem[];
  onSelectSource?: (source: SourceItem) => void;
  className?: string;
}

export function SourcesCard({ sources, onSelectSource, className }: SourcesCardProps) {
  if (!sources || sources.length === 0) return null;

  return (
    <div className={cn('my-2.5 space-y-1.5', className)}>
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-muted-foreground uppercase tracking-wider select-none px-1">
        <BookOpen className="size-3 text-primary" />
        <span>参考来源 ({sources.length})</span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {sources.map((src, idx) => (
          <button
            key={idx}
            type="button"
            onClick={() => onSelectSource?.(src)}
            className="flex items-start gap-2.5 p-2.5 rounded-xl bg-surface1/80 hover:bg-surface2/90 border border-border/80 hover:border-primary/40 transition-all text-left group/source cursor-pointer shadow-2xs"
          >
            <div className="size-6 rounded-lg bg-surface2 flex items-center justify-center text-muted-foreground group-hover/source:text-primary group-hover/source:bg-primary/10 transition-colors shrink-0">
              {src.type === 'web' ? (
                <ExternalLink className="size-3" />
              ) : src.type === 'file' ? (
                <FileText className="size-3" />
              ) : (
                <BookOpen className="size-3" />
              )}
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-1">
                <span className="text-xs font-semibold text-foreground group-hover/source:text-primary transition-colors truncate">
                  {src.title || src.slug || '未命名文档'}
                </span>
                <ChevronRight className="size-3 text-muted-foreground opacity-0 group-hover/source:opacity-100 transition-opacity shrink-0" />
              </div>

              {src.snippet && (
                <p className="text-[11px] text-muted-foreground line-clamp-2 mt-0.5 leading-snug">
                  {src.snippet}
                </p>
              )}

              {src.slug && (
                <span className="inline-block mt-1 text-[10px] text-primary/80 font-mono">
                  @knowledge:{src.slug}
                </span>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
