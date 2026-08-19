'use client';

import { ChevronDown, Sparkles, Clock, Copy, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useState, useMemo } from 'react';
import { toast } from 'sonner';
import { MarkdownContent } from '@/components/chat/markdown-content';
import { cn } from '@/lib/utils';

export interface ReasoningProps {
  content: string;
  isStreaming?: boolean;
  durationMs?: number;
  startTime?: number;
  defaultExpanded?: boolean;
  className?: string;
}

export function Reasoning({
  content,
  isStreaming = false,
  durationMs,
  startTime,
  defaultExpanded = false,
  className,
}: ReasoningProps) {
  const [isExpanded, setIsExpanded] = useState<boolean>(defaultExpanded || isStreaming);
  const [copied, setCopied] = useState(false);

  // Calculate thinking duration text
  const durationText = useMemo(() => {
    if (durationMs && durationMs > 0) {
      const sec = (durationMs / 1000).toFixed(1);
      return `${sec}s`;
    }
    if (startTime && startTime > 0) {
      const sec = Math.max(0.1, (Date.now() - startTime) / 1000).toFixed(1);
      return `${sec}s`;
    }
    return null;
  }, [durationMs, startTime]);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!content) return;
    navigator.clipboard.writeText(content);
    setCopied(true);
    toast.success('思考过程已复制');
    setTimeout(() => setCopied(false), 2000);
  };

  if (!content && !isStreaming) return null;

  return (
    <div
      className={cn(
        'group/reasoning my-2 rounded-xl border border-violet-500/20 dark:border-violet-500/30',
        'bg-violet-500/[0.02] dark:bg-violet-950/20 backdrop-blur-xs',
        'transition-all duration-200 overflow-hidden',
        className
      )}
    >
      {/* Header Bar */}
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        className={cn(
          'w-full flex items-center justify-between px-3.5 py-2 select-none text-left cursor-pointer',
          'hover:bg-violet-500/[0.04] dark:hover:bg-violet-500/[0.08] transition-colors'
        )}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div
            className={cn(
              'size-5 rounded-lg flex items-center justify-center shrink-0 transition-colors',
              isStreaming
                ? 'bg-violet-500/15 text-violet-600 dark:text-violet-400'
                : 'bg-violet-500/10 text-violet-500 dark:text-violet-400'
            )}
          >
            <Sparkles className={cn('size-3', isStreaming && 'animate-pulse')} />
          </div>

          <div className="flex items-center gap-1.5 text-xs font-medium text-violet-950 dark:text-violet-200">
            <span>{isStreaming ? '正在深度思考...' : '思考过程'}</span>
            {durationText && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-violet-500/10 text-[10px] text-violet-600 dark:text-violet-400 font-mono">
                <Clock className="size-2.5 opacity-70" />
                {durationText}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {content && (
            <button
              type="button"
              onClick={handleCopy}
              className="opacity-0 group-hover/reasoning:opacity-100 p-1 rounded-md text-violet-400 hover:text-violet-600 dark:hover:text-violet-200 hover:bg-violet-500/10 transition-all cursor-pointer"
              title="复制思考过程"
            >
              {copied ? <Check className="size-3 text-emerald-500" /> : <Copy className="size-3" />}
            </button>
          )}

          <motion.div
            animate={{ rotate: isExpanded ? 180 : 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="text-violet-400 dark:text-violet-500"
          >
            <ChevronDown className="size-3.5" />
          </motion.div>
        </div>
      </button>

      {/* Collapsible Content */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          >
            <div className="px-4 pb-3 pt-1 border-t border-violet-500/10 dark:border-violet-500/20 text-xs text-muted-foreground/90 font-mono leading-relaxed overflow-x-auto">
              <div className="relative pl-3 border-l-2 border-violet-500/30 dark:border-violet-500/40 my-1">
                {content ? (
                  <div className="text-xs text-foreground/80 leading-relaxed font-sans">
                    <MarkdownContent content={content} />
                  </div>
                ) : (
                  <span className="italic text-muted-foreground animate-pulse">正在梳理推理逻辑与上下文...</span>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
