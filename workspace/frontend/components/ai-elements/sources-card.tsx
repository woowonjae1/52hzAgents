'use client';

import { BookOpen, ExternalLink, FileText, Link2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { EventLine } from './event-line';

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

/**
 * What the answer was drawn from.
 *
 * `alwaysOpen`: a citation the reader has to go looking for is not a citation.
 * The row is a heading here, not a disclosure — the difference from a tool call
 * is deliberate and is the reason `EventLine` has the flag.
 */
export function SourcesCard({ sources, onSelectSource, className }: SourcesCardProps) {
  if (!sources || sources.length === 0) return null;

  return (
    <EventLine
      className={className}
      icon={<Link2 />}
      label="Sources"
      meta={sources.length}
      alwaysOpen
    >
      <div className="flex flex-col py-0.5">
        {sources.map((src, idx) => {
          const label = src.title || src.slug || 'Untitled document';
          const description = describeSource(src);
          return (
            <button
              key={idx}
              type="button"
              onClick={() => onSelectSource?.(src)}
              title={src.snippet || label}
              className={cn(
                // No chip, no border, no shadow: these are list rows in a body
                // that already has a rail. A bordered pill inside a bordered
                // rail is two frames doing one frame's job.
                'group/source -mx-1 flex min-w-0 cursor-pointer items-baseline gap-2 rounded-base px-1 py-1 text-left',
                'transition-colors hover:bg-surface2',
                'focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2'
              )}
            >
              <span className="shrink-0 translate-y-px text-foreground-extra-muted group-hover/source:text-foreground-muted">
                <SourceIcon type={src.type} />
              </span>
              <span className="shrink-0 font-mono text-3xs tabular-nums text-foreground-extra-muted">
                {idx + 1}
              </span>
              <span className="truncate text-xs text-foreground">{label}</span>
              {description && (
                <span className="truncate font-mono text-3xs text-foreground-extra-muted">
                  {description}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </EventLine>
  );
}
