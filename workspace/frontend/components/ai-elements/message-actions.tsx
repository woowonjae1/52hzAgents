'use client';

import { Copy, Check, RotateCw, Download } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface MessageActionsProps {
  content: string;
  senderType?: 'user' | 'agent' | 'system';
  onRegenerate?: () => void;
  onExportMarkdown?: () => void;
  className?: string;
}

/** 统一的幽灵图标按钮样式 */
const ghostButton = cn(
  'inline-flex items-center justify-center size-6 rounded-md cursor-pointer',
  'text-foreground-extra-muted hover:text-foreground hover:bg-surface2',
  'transition-colors duration-200',
  'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/30'
);

export function MessageActions({
  content,
  senderType = 'agent',
  onRegenerate,
  onExportMarkdown,
  className,
}: MessageActionsProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!content) return;
    navigator.clipboard.writeText(content);
    setCopied(true);
    toast.success('已复制到剪贴板');
    setTimeout(() => setCopied(false), 2000);
  };

  const handleExport = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onExportMarkdown) {
      onExportMarkdown();
      return;
    }
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `message-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('已导出 Markdown');
  };

  return (
    <div
      className={cn(
        // 悬停消息时淡入；同时兼容外层未命名 group 与 chat-message 的具名 group
        'opacity-0 group-hover:opacity-100 group-hover/usermsg:opacity-100 group-hover/agentmsg:opacity-100',
        'focus-within:opacity-100 transition-opacity duration-200',
        'inline-flex items-center gap-0.5 p-0.5 rounded-lg',
        'bg-surface1/90 dark:bg-surface1/70 backdrop-blur-md',
        'border border-border/70 shadow-sm',
        className
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" onClick={handleCopy} className={ghostButton} aria-label="复制内容">
            {copied ? (
              <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <Copy className="size-3.5" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          {copied ? '已复制 ✓' : '复制内容'}
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
              aria-label="重新生成"
            >
              <RotateCw className="size-3.5 transition-transform duration-300 group-hover/regen:-rotate-180" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6}>
            重新生成
          </TooltipContent>
        </Tooltip>
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" onClick={handleExport} className={ghostButton} aria-label="导出 Markdown">
            <Download className="size-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>
          导出 Markdown
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
