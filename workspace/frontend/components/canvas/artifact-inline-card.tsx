'use client';

import React from 'react';
import { FileText, Code2, ArrowUpRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AgentAvatar } from '../agents/agent-avatar';
import { useArtifacts, type ArtifactItem } from '@/lib/artifacts-context';

export function ArtifactInlineCard({
  artifact,
  className,
}: {
  artifact: ArtifactItem;
  className?: string;
}) {
  const { openArtifact, activeArtifact, isCanvasOpen } = useArtifacts();
  const isActive = isCanvasOpen && activeArtifact?.id === artifact.id;

  /*
   * The first two lines of prose, with the markdown taken off.
   *
   * The heading is dropped because it is already the card's title -- repeating
   * it as the preview would spend both lines saying the same thing. Fences,
   * table rules and list bullets go too: this is a one-line summary in a 10px
   * face, and `| --- | --- |` renders there as noise, not as a table.
   */
  const preview = React.useMemo(() => {
    const lines = artifact.content
      .split('\n')
      .map((l) => l.trim())
      .filter(
        (l) =>
          l &&
          !/^#{1,6}\s/.test(l) &&
          !/^```/.test(l) &&
          !/^\|?\s*:?-{2,}/.test(l) &&
          !/^[-*+]\s*$/.test(l)
      )
      .map((l) => l.replace(/^[-*+]\s+/, '').replace(/[*`_>#|]/g, '').trim())
      .filter(Boolean);
    const text = lines.slice(0, 2).join(' ');
    return text.length > 180 ? `${text.slice(0, 180)}…` : text || `${artifact.content.length} characters`;
  }, [artifact.content]);

  return (
    <div
      onClick={() => openArtifact(artifact)}
      className={cn(
        'my-2.5 p-3.5 rounded-2xl border transition-all duration-200 cursor-pointer group select-none shadow-2xs hover:shadow-xs',
        isActive
          ? 'bg-primary/10 border-primary/40 shadow-xs'
          : 'bg-surface1/90 hover:bg-surface2/90 border-border hover:border-border-accent'
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={cn(
              'size-9 rounded-xl flex items-center justify-center shrink-0 transition-colors',
              isActive
                ? 'bg-primary text-primary-foreground'
                : 'bg-surface2 group-hover:bg-primary/15 group-hover:text-primary text-muted-foreground'
            )}
          >
            {artifact.type === 'code' ? <Code2 className="size-4.5" /> : <FileText className="size-4.5" />}
          </div>

          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-foreground group-hover:text-primary transition-colors truncate">
                {artifact.title}
              </span>
              {artifact.authorAgent && (
                <div className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-surface2 text-muted-foreground text-3xs font-medium border border-border/60 shrink-0">
                  <AgentAvatar name={artifact.authorAgent} size={12} />
                  <span>@{artifact.authorAgent}</span>
                </div>
              )}
            </div>

            {/*
              A REAL PREVIEW, because this card now stands in for the document
              rather than heading it. "Structured deliverable and findings" was
              boilerplate printed identically on every artifact -- fine when
              the full text was rendered immediately below, useless once the
              card is the only thing in the transcript. The reader needs enough
              to decide whether to open it, so they get the opening lines.
            */}
            <p className="text-2xs text-muted-foreground line-clamp-2 mt-0.5 leading-snug">
              {artifact.filePath ? `Path: ${artifact.filePath}` : preview}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="text-2xs font-medium text-primary hidden sm:inline-flex items-center gap-1 group-hover:translate-x-0.5 transition-transform">
            <span>Open in Canvas</span>
            <ArrowUpRight className="size-3.5" />
          </span>
        </div>
      </div>
    </div>
  );
}
