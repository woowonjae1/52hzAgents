'use client';

import { Copy, Check, RotateCw, Download, FileText, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { toast } from '@/lib/toast';
import { downloadBlob } from '@/lib/download';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface MessageActionsProps {
  content: string;
  senderType?: 'user' | 'agent' | 'system';
  variant?: 'capsule' | 'toolbar';
  onRegenerate?: () => void;
  onExportMarkdown?: () => void;
  onOpenCanvas?: () => void;
  className?: string;
}

/** 统一的幽灵图标按钮样式 */
const ghostButton = cn(
  'grid size-7 place-items-center rounded-md',
  'text-muted-foreground hover:text-foreground hover:bg-muted',
  'transition-colors duration-150',
  'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/30'
);

export function MessageActions({
  content,
  senderType = 'agent',
  variant = 'capsule',
  onRegenerate,
  onExportMarkdown,
  onOpenCanvas,
  className,
}: MessageActionsProps) {
  const [copied, setCopied] = useState(false);


  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!content) return;
    navigator.clipboard.writeText(content);
    setCopied(true);
    toast.success('Copied to clipboard');
    setTimeout(() => setCopied(false), 2000);
  };


  const handleExport = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onExportMarkdown) {
      onExportMarkdown();
      return;
    }
    downloadBlob(content, `message-${Date.now()}.md`, 'text/markdown;charset=utf-8;');
    toast.success('Exported as Markdown');
  };

  if (variant === 'toolbar') {
    /*
      Revealed on hover, like the other variant already was.

      A transcript of twenty messages carried eighty permanently visible icons,
      none of which is part of reading. The actions matter once you have decided
      to act on a particular message, which is exactly when the pointer is on
      it. focus-within keeps them reachable by keyboard.
    */
    return (
      <div
        className={cn(
          'flex min-h-5 items-center gap-1 px-1 mt-1.5 text-[11px] text-muted-foreground select-none',
          'opacity-0 transition-opacity focus-within:opacity-100',
          'group-hover:opacity-100 group-hover/usermsg:opacity-100 group-hover/agentmsg:opacity-100',
          className
        )}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" onClick={handleCopy} className={ghostButton} aria-label="Copy content">
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {copied ? 'Copied' : 'Copy content'}
          </TooltipContent>
        </Tooltip>

        {senderType === 'agent' && onRegenerate && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRegenerate();
                }}
                className={cn(ghostButton, 'group/regen')}
                aria-label="Regenerate"
              >
                <RotateCw className="size-3.5 transition-transform duration-300 group-hover/regen:-rotate-180" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              Regenerate
            </TooltipContent>
          </Tooltip>
        )}

        {/*
          Helpful / Unhelpful are gone.

          They set a local flag and showed a toast. Nothing read the value —
          it was not sent anywhere, not stored, and not used to change what the
          agent does next. Two permanent buttons under every message in the
          transcript, collecting nothing. A rating control is worth having only
          once something consumes the rating.
        */}

        {onOpenCanvas && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenCanvas();
                }}
                className={ghostButton}
                aria-label="Open in Canvas"
              >
                <Sparkles className="size-3.5 text-primary" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              Open in Canvas
            </TooltipContent>
          </Tooltip>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" onClick={handleExport} className={ghostButton} aria-label="Export Markdown">
              <Download className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            Export Markdown
          </TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div
      className={cn(
        // 悬停消息时淡入；同时兼容外层未命名 group 与 chat-message 的具名 group
        'opacity-0 group-hover:opacity-100 group-hover/usermsg:opacity-100 group-hover/agentmsg:opacity-100',
        'focus-within:opacity-100 transition-opacity duration-200',
        /*
          NO PLATE. beUI's `MessageFooter` is a bare row of glyphs; this one
          carried a blurred, bordered surface of its own, which sat directly
          under the message it belongs to and read as a second card colliding
          with the first. The hover fade is the affordance — it does not also
          need a background to be found.
        */
        'inline-flex items-center gap-0.5 mt-1 rounded-lg',
        className
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" onClick={handleCopy} className={ghostButton} aria-label="Copy message">
            {copied ? (
              <Check className="size-3.5" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          {copied ? 'Copied' : 'Copy'}
        </TooltipContent>
      </Tooltip>

      {senderType === 'agent' && onRegenerate && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRegenerate();
              }}
              className={cn(ghostButton, 'group/regen')}
              aria-label="Regenerate"
            >
              <RotateCw className="size-3.5 transition-transform duration-300 group-hover/regen:-rotate-180" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>
            Regenerate
          </TooltipContent>
        </Tooltip>
      )}

      {senderType === 'agent' && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" onClick={handleExport} className={ghostButton} aria-label="Export as Markdown">
              <Download className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>
            Export Markdown
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
