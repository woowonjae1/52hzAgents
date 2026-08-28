'use client';

import React from 'react';
import { FileText, Code2, Sparkles, ArrowUpRight, CheckCircle2 } from 'lucide-react';
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

  return (
    <div
      onClick={() => openArtifact(artifact)}
      className={cn(
        'my-2.5 p-3.5 rounded-2xl border transition-all duration-200 cursor-pointer group select-none shadow-2xs hover:shadow-xs',
        isActive
          ? 'bg-primary/10 border-primary/40 shadow-xs'
          : 'bg-surface1/90 hover:bg-surface2/90 border-border/80 hover:border-border-accent'
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

            <p className="text-2xs text-muted-foreground line-clamp-1 mt-0.5">
              {artifact.filePath ? `Path: ${artifact.filePath}` : `${artifact.content.length} chars · Structured deliverable and findings`}
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
