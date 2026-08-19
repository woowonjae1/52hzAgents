'use client';

import { ChevronDown, Brain, Copy, Check } from 'lucide-react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
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
  const reduceMotion = useReducedMotion();

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

  // Collapsed capsule label: live shimmer while streaming, "思考了 x.xs" once settled
  const label = isStreaming ? '正在思考…' : durationText ? `思考了 ${durationText}` : '思考过程';

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
    <div className={cn('group/reasoning my-2 w-full', className)}>
      {/* Collapsed capsule / toggle */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setIsExpanded((prev) => !prev)}
          aria-expanded={isExpanded}
          className={cn(
            'inline-flex items-center gap-2 select-none cursor-pointer',
            'rounded-full border border-border/70 bg-surface1/70 dark:bg-surface1/40',
            'pl-2 pr-2.5 py-1 shadow-2xs backdrop-blur-xs',
            'transition-all duration-200',
            'hover:bg-surface2/70 hover:border-border-accent/80',
            'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/30'
          )}
        >
          <span
            className={cn(
              'size-4 rounded-full flex items-center justify-center shrink-0 transition-colors duration-200',
              isStreaming
                ? 'bg-primary/10 text-foreground'
                : 'bg-surface2/80 text-foreground-muted group-hover/reasoning:text-foreground'
            )}
          >
            <Brain className="size-2.5" />
          </span>

          {isStreaming && !reduceMotion ? (
            // Gentle shimmer sweep across the label while reasoning streams in
            <motion.span
              className="text-[11px] font-medium bg-clip-text text-transparent"
              style={{
                backgroundImage:
                  'linear-gradient(90deg, var(--foreground-muted) 0%, var(--foreground) 50%, var(--foreground-muted) 100%)',
                backgroundSize: '220% 100%',
              }}
              animate={{ backgroundPositionX: ['160%', '-60%'] }}
              transition={{ duration: 1.8, repeat: Infinity, ease: 'linear' }}
            >
              {label}
            </motion.span>
          ) : (
            <span
              className={cn(
                'text-[11px] font-medium transition-colors duration-200',
                'text-foreground-muted group-hover/reasoning:text-foreground'
              )}
            >
              {label}
            </span>
          )}

          <motion.span
            animate={{ rotate: isExpanded ? 180 : 0 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="text-foreground-extra-muted"
          >
            <ChevronDown className="size-3" />
          </motion.span>
        </button>

        {content && (
          <button
            type="button"
            onClick={handleCopy}
            className={cn(
              'opacity-0 group-hover/reasoning:opacity-100 focus-visible:opacity-100',
              'p-1 rounded-md text-foreground-extra-muted hover:text-foreground hover:bg-surface2',
              'transition-all duration-200 cursor-pointer'
            )}
            title="复制思考过程"
          >
            {copied ? <Check className="size-3 text-status-success" /> : <Copy className="size-3" />}
          </button>
        )}
      </div>

      {/* Collapsible Content */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            {/* Soft left gradient rail keeps reasoning visually subordinate to the answer */}
            <div className="relative mt-2 ml-2 pl-3.5 pr-1 pb-1">
              <span
                aria-hidden
                className="absolute left-0 top-0.5 bottom-0.5 w-px rounded-full bg-gradient-to-b from-border-accent/80 via-border/60 to-transparent"
              />
              {content ? (
                <div className="text-xs leading-[1.7] text-foreground-muted [&_*]:text-xs [&_p]:my-1 [&_pre]:text-[11px]">
                  <MarkdownContent content={content} />
                </div>
              ) : (
                <span className="text-xs italic text-foreground-extra-muted animate-pulse">
                  正在梳理推理逻辑与上下文...
                </span>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
