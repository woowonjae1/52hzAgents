'use client';

import { Copy, Check, RotateCw, Download, ThumbsUp, ThumbsDown } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface MessageActionsProps {
  content: string;
  senderType?: 'user' | 'agent' | 'system';
  variant?: 'capsule' | 'toolbar';
  onRegenerate?: () => void;
  onExportMarkdown?: () => void;
  className?: string;
}

/** 统一的幽灵图标按钮样式 */
const ghostButton = cn(
  'inline-flex items-center justify-center size-7 rounded-md cursor-pointer',
  'text-foreground-extra-muted hover:text-foreground hover:bg-surface2',
  'transition-colors duration-150',
  'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/30'
);

export function MessageActions({
  content,
  senderType = 'agent',
  variant = 'capsule',
  onRegenerate,
  onExportMarkdown,
  className,
}: MessageActionsProps) {
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<'like' | 'dislike' | null>(null);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!content) return;
    navigator.clipboard.writeText(content);
    setCopied(true);
    toast.success('已复制到剪贴板');
    setTimeout(() => setCopied(false), 2000);
  };

  const handleFeedback = (type: 'like' | 'dislike') => {
    setFeedback((prev) => (prev === type ? null : type));
    toast.success(type === 'like' ? '感谢您的正面反馈' : '已记录您的反馈');
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
    toast.success('已导出为 Markdown');
  };

  if (variant === 'toolbar') {
    return (
      <div className={cn('flex items-center gap-0.5 text-foreground-extra-muted select-none mt-1.5 -ml-1', className)}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" onClick={handleCopy} className={ghostButton} aria-label="复制内容">
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {copied ? '已复制' : '复制内容'}
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
            <TooltipContent side="top" sideOffset={4}>
              重新生成
            </TooltipContent>
          </Tooltip>
        )}

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => handleFeedback('like')}
              className={cn(ghostButton, feedback === 'like' && 'text-primary bg-primary/10')}
              aria-label="有用"
            >
              <ThumbsUp className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            有用
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => handleFeedback('dislike')}
              className={cn(ghostButton, feedback === 'dislike' && 'text-status-danger bg-status-danger/10')}
              aria-label="不满意"
            >
              <ThumbsDown className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            不满意
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" onClick={handleExport} className={ghostButton} aria-label="导出 Markdown">
              <Download className="size-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            导出 Markdown
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
        'inline-flex items-center gap-0.5 p-0.5 rounded-lg',
        'bg-surface1/90 dark:bg-surface1/70 backdrop-blur-md',
        'border border-border',
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
          {copied ? '已复制' : '复制内容'}
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
            重新生成
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
            导出 Markdown
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
