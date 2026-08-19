'use client';

import { BookOpen, ExternalLink, FileText, Link2 } from 'lucide-react';
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

/** 从 URL 中取出可读的 domain/path，作为引用条的第二行 */
function describeSource(src: SourceItem): string | null {
  if (src.url) {
    try {
      const parsed = new URL(src.url);
      const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
      return `${parsed.hostname.replace(/^www\./, '')}${path}`;
    } catch {
      return src.url;
    }
  }
  if (src.slug) return `@knowledge:${src.slug}`;
  return null;
}

function SourceIcon({ type }: { type?: SourceItem['type'] }) {
  if (type === 'web') return <ExternalLink className="size-3" />;
  if (type === 'file') return <FileText className="size-3" />;
  return <BookOpen className="size-3" />;
}

export function SourcesCard({ sources, onSelectSource, className }: SourcesCardProps) {
  if (!sources || sources.length === 0) return null;

  return (
    <div className={cn('my-2.5 space-y-1.5', className)}>
      <div className="flex items-center gap-1.5 px-0.5 select-none text-[10px] font-medium uppercase tracking-wider text-foreground-extra-muted">
        <Link2 className="size-3" />
        <span>参考来源</span>
        <span className="tabular-nums">({sources.length})</span>
      </div>

      {/* 紧凑引用条，随宽度自然换行 */}
      <div className="flex flex-wrap gap-1.5">
        {sources.map((src, idx) => {
          const label = src.title || src.slug || '未命名文档';
          const description = describeSource(src);
          return (
            <button
              key={idx}
              type="button"
              onClick={() => onSelectSource?.(src)}
              title={src.snippet || label}
              className={cn(
                'group/source flex items-center gap-2 min-w-0 max-w-full sm:max-w-[19rem] cursor-pointer text-left',
                'pl-1.5 pr-2.5 py-1 rounded-xl',
                'border border-border/70 bg-surface1/80 dark:bg-surface1/40 shadow-2xs',
                'transition-all duration-200',
                'hover:bg-surface2/70 hover:border-border-accent/80 hover:shadow-sm',
                'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/30'
              )}
            >
              {/* 序号 + 图标 */}
              <span
                className={cn(
                  'relative size-5 rounded-lg shrink-0 flex items-center justify-center',
                  'bg-surface2 text-foreground-extra-muted',
                  'group-hover/source:bg-primary/10 group-hover/source:text-foreground',
                  'transition-colors duration-200'
                )}
              >
                <SourceIcon type={src.type} />
              </span>

              <span className="flex flex-col min-w-0 leading-tight">
                <span className="truncate text-[11.5px] font-medium text-foreground">
                  <span className="text-foreground-extra-muted tabular-nums mr-1">{idx + 1}.</span>
                  {label}
                </span>
                {description && (
                  <span className="truncate text-[10px] font-mono text-foreground-extra-muted">
                    {description}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
