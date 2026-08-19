'use client';

import { Copy, Check, RotateCw, Download, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

export interface MessageActionsProps {
  content: string;
  senderType?: 'user' | 'agent' | 'system';
  onRegenerate?: () => void;
  onExportMarkdown?: () => void;
  className?: string;
}

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
        'opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-all duration-150',
        'inline-flex items-center gap-1 p-1 rounded-lg bg-surface1/90 backdrop-blur-md border border-border/80 shadow-xs',
        className
      )}
    >
      <button
        type="button"
        onClick={handleCopy}
        className="p-1 rounded-md text-foreground-muted hover:text-foreground hover:bg-surface2 transition-colors cursor-pointer"
        title="复制内容"
      >
        {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
      </button>

      {senderType === 'agent' && onRegenerate && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRegenerate();
          }}
          className="p-1 rounded-md text-foreground-muted hover:text-foreground hover:bg-surface2 transition-colors cursor-pointer"
          title="重新生成"
        >
          <RotateCw className="size-3.5" />
        </button>
      )}

      <button
        type="button"
        onClick={handleExport}
        className="p-1 rounded-md text-foreground-muted hover:text-foreground hover:bg-surface2 transition-colors cursor-pointer"
        title="导出 Markdown"
      >
        <Download className="size-3.5" />
      </button>
    </div>
  );
}
