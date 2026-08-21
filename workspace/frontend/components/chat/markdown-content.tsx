'use client';

import * as React from 'react';
import { memo, type ReactNode, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { deriveIdentityColor } from '@/lib/identity-colors';
import { cn } from '@/lib/utils';
import { MermaidBlock } from './mermaid-block';
import { DiffBlock } from './diff-block';
import { getMermaidSource, hasOpenMermaidFence } from './mermaid-utils';
import { toast } from 'sonner';
import { BookOpen } from 'lucide-react';
import { ApprovalCard, type ApprovalCardQuestion } from '@/components/ai-elements/approval-card';
import { workspaceApi } from '@/lib/api';

// Stable plugin arrays — avoids re-creating on every render
const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];

// Recursively flatten a React children tree to its raw text. rehype-highlight
// replaces a code block's string child with an array of highlight <span>s, so
// String(children) would yield "[object Object],…" — walk the tree instead.
function nodeToText(node: React.ReactNode): string {
  if (node == null || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join('');
  if (React.isValidElement(node)) {
    return nodeToText((node.props as { children?: React.ReactNode }).children);
  }
  return '';
}

interface MarkdownContentProps {
  content: string;
  agentNames?: string[];
  sessionId?: string;
}

/** Walk React children and colorize @agentname and @knowledge:slug tokens in text nodes. */
function renderMentions(children: ReactNode, agentNames: string[] = []): ReactNode {
  if (!children) return children;

  const escaped = agentNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const agentTokens = escaped.length > 0 ? `[@/](?:${escaped.join('|')})(?![\\w-])` : '';
  const knowledgeTokens = `@knowledge:[a-zA-Z0-9_-]+`;
  const pattern = agentTokens ? `(${knowledgeTokens}|${agentTokens})` : `(${knowledgeTokens})`;
  const mentionRegex = new RegExp(pattern, 'gi');

  let keyCounter = 0;

  const processNode = (node: ReactNode): ReactNode => {
    if (typeof node === 'string') {
      const parts = node.split(mentionRegex);
      if (parts.length === 1) return node;
      return parts.map((part) => {
        keyCounter++;
        if (part.toLowerCase().startsWith('@knowledge:')) {
          const slug = part.replace(/^@knowledge:/i, '');
          return (
            <span
              key={`knowledge-${keyCounter}`}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 my-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/25 text-emerald-600 dark:text-emerald-400 font-mono text-2xs font-medium align-baseline shadow-2xs"
            >
              <BookOpen className="size-3 shrink-0" />
              <span>{slug}</span>
            </span>
          );
        }

        const agentClean = part.replace(/^[@/]/, '');
        if ((part.startsWith('@') || part.startsWith('/')) && agentNames.includes(agentClean)) {
          const color = deriveIdentityColor(agentClean);
          return (
            <span
              key={`mention-${keyCounter}`}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 my-0.5 rounded-md bg-surface2 border border-border/70 text-foreground font-medium text-2xs align-baseline shadow-2xs"
              style={{ color }}
            >
              <span className="size-1.5 rounded-full shrink-0" style={{ background: color }} />
              <span>{part}</span>
            </span>
          );
        }
        return part;
      });
    }
    if (Array.isArray(node)) {
      return node.map((child) => {
        keyCounter++;
        return <span key={`node-${keyCounter}`}>{processNode(child)}</span>;
      });
    }
    return node;
  };

  if (Array.isArray(children)) {
    return children.map((child) => {
      keyCounter++;
      return <span key={`child-${keyCounter}`}>{processNode(child)}</span>;
    });
  }
  return processNode(children);
}

class MarkdownErrorBoundary extends React.Component<
  { fallbackContent: string; children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallbackContent: string; children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.warn('[MarkdownContent] Render fallback triggered:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground opacity-90">
          {this.props.fallbackContent}
        </div>
      );
    }
    return this.props.children;
  }
}

export const MarkdownContent = memo(function MarkdownContent({ content, agentNames = [], sessionId }: MarkdownContentProps) {
  const hasStreamingMermaidFence = hasOpenMermaidFence(content);

  const components: Components = useMemo(() => ({
    // Block elements
    h1: ({ children }) => (
      <h1 className="text-[17px] font-semibold mt-4.5 mb-2 first:mt-0 tracking-tight text-foreground">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="text-[15px] font-semibold mt-3.5 mb-1.5 first:mt-0 tracking-tight text-foreground">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="text-[14px] font-medium mt-3 mb-1 first:mt-0 text-foreground">{children}</h3>
    ),
    h4: ({ children }) => (
      <h4 className="text-[13.5px] font-medium mt-2 mb-1 first:mt-0 text-foreground">{children}</h4>
    ),
    p: ({ children }) => (
      <p className="leading-[1.72] text-foreground/95 mb-2.5 last:mb-0 text-[13.5px] sm:text-sm font-normal">
        {renderMentions(children, agentNames)}
      </p>
    ),
    ul: ({ children }) => (
      <ul className="list-disc pl-5 my-2 space-y-1 text-[13.5px] sm:text-sm leading-[1.65] text-foreground/90 font-normal">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="list-decimal pl-5 my-2 space-y-1 text-[13.5px] sm:text-sm leading-[1.65] text-foreground/90 font-normal">{children}</ol>
    ),
    li: ({ children }) => <li>{renderMentions(children, agentNames)}</li>,
    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-primary/40 pl-3 my-2.5 text-foreground/80 italic text-[13px] leading-[1.68]">
        {children}
      </blockquote>
    ),
    hr: () => <hr className="border-border my-4" />,

    // Tables
    table: ({ children }) => (
      <div className="overflow-x-auto my-3 rounded-lg border border-border/80">
        <table className="w-full text-xs text-left border-collapse">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-surface2/80 text-foreground font-semibold border-b border-border/80">{children}</thead>,
    tbody: ({ children }) => <tbody className="divide-y divide-border/50 bg-surface1/30">{children}</tbody>,
    tr: ({ children }) => <tr className="hover:bg-surface2/50 transition-colors">{children}</tr>,
    th: ({ children }) => <th className="px-3 py-2 text-xs font-semibold text-foreground">{children}</th>,
    td: ({ children }) => <td className="px-3 py-2 text-xs text-foreground/90">{children}</td>,

    // Code
    code: ({ className, children, ...props }) => {
      const isInline = !className && typeof children === 'string';
      if (isInline) {
        return (
          <code
            className="bg-surface2 text-foreground font-mono text-[0.9em] px-1.5 py-0.5 rounded-md border border-border/60 inline align-baseline font-normal"
            {...props}
          >
            {children}
          </code>
        );
      }
      return (
        <code className={cn(className, 'font-mono')} {...props}>
          {children}
        </code>
      );
    },
    pre: ({ children }) => {
      const mermaidSource = getMermaidSource(children);
      if (mermaidSource !== null) {
        return (
          <MermaidBlock
            chart={mermaidSource}
            deferErrors={hasStreamingMermaidFence}
          />
        );
      }

      // Safely extract codeElement without throwing if children is an array or contains text nodes
      const childArray = React.Children.toArray(children);
      const codeElement = childArray.find(
        (child): child is React.ReactElement<{ className?: string; children?: React.ReactNode }> =>
          React.isValidElement(child)
      );
      const className = codeElement?.props?.className || '';
      const match = /language-(\w+)/.exec(className);
      const language = match ? match[1].toUpperCase() : 'CODE';

      const rawCodeText = codeElement ? nodeToText(codeElement.props?.children) : nodeToText(children);

      // Fenced ```diff / ```patch → real unified-diff renderer
      if (language === 'DIFF' || language === 'PATCH') {
        return <DiffBlock code={rawCodeText.replace(/\n$/, '')} />;
      }

      // Fenced ```decision / ```oa-decision → render real interactive ApprovalCard!
      if (language === 'DECISION' || language === 'OA-DECISION' || language === 'OA:DECISION') {
        try {
          const parsed = JSON.parse(rawCodeText);
          const rawQuestions = Array.isArray(parsed) ? parsed : parsed?.questions;
          if (Array.isArray(rawQuestions) && rawQuestions.length > 0) {
            const formattedQuestions: ApprovalCardQuestion[] = rawQuestions.map((q: any, idx: number) => ({
              id: q.id || q.title || `q${idx + 1}`,
              title: q.title || q.question || '请选择',
              options: (q.options || q.choices || []).map((opt: any) =>
                typeof opt === 'string'
                  ? { value: opt, label: opt }
                  : { value: opt.value || opt.label, label: opt.label || opt.value, description: opt.description }
              ),
              allowCustom: q.allowCustom ?? q.allow_custom ?? true,
              customPlaceholder: q.customPlaceholder ?? q.custom_placeholder,
            }));
            return (
              <div className="my-3 not-prose">
                <ApprovalCard
                  questions={formattedQuestions}
                  onSubmit={(answers) => {
                    const titleById = new Map(formattedQuestions.map((q) => [q.id, q.title]));
                    const answerSummary = Object.entries(answers)
                      .map(([k, v]) => `${titleById.get(k) || k}: ${v}`)
                      .join('\n');
                    if (sessionId) {
                      workspaceApi.sendMessage(sessionId, `[Decision]\n${answerSummary}`, 'User');
                      toast.success('已提交选择');
                    }
                  }}
                />
              </div>
            );
          }
        } catch {
          // If JSON is invalid, fall through to default code block rendering
        }
      }

      // Code blocks stay dark in BOTH themes so the syntax-highlight palette
      // (tuned for a dark ground) keeps its contrast.
      return (
        <div className="my-3 overflow-hidden rounded-xl border border-[#2e2e2e] bg-[#1a1a1a] text-[#ececec] font-mono shadow-sm">
          <div className="flex items-center justify-between px-4 py-2 border-b border-[#2e2e2e]/80 bg-[#212121]/90 text-2xs font-medium text-[#b4b4b4]">
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-[#4d4d4d] inline-block" />
              <span>{language}</span>
            </span>
            <button
              onClick={() => {
                const text = rawCodeText.trim();
                if (text) {
                  navigator.clipboard.writeText(text);
                  toast.success('Code copied to clipboard');
                }
              }}
              className="hover:text-[#ececec] text-[#b4b4b4] transition-colors cursor-pointer text-2xs"
            >
              Copy
            </button>
          </div>
          <pre className="p-4 overflow-x-auto text-[12.5px] leading-[1.62] text-[#ececec] font-mono bg-[#1a1a1a] selection:bg-white/20">
            {children}
          </pre>
        </div>
      );
    },

    // Links
    a: ({ href, children }) => {
      const isFileLink = href && (href.startsWith('file://') || /^[a-zA-Z]:[\\/]/.test(href));
      const isEditorScheme = href && (href.startsWith('vscode:') || href.startsWith('cursor:'));

      const handleClick = (e: React.MouseEvent) => {
        if (isFileLink || isEditorScheme) {
          e.preventDefault();
          if (typeof window !== 'undefined' && (window as any).electronBridge?.openPath) {
            (window as any).electronBridge.openPath(href).then((opened: boolean) => {
              if (opened) {
                toast.success(`已在本地编辑器中打开文件`);
              } else {
                toast.error(`未能打开本地文件路径`);
              }
            });
          } else {
            toast.info(`本地文件: ${href}`);
          }
        }
      };

      return (
        <a
          href={href}
          onClick={handleClick}
          target={isFileLink ? undefined : '_blank'}
          rel="noopener noreferrer"
          className="text-primary underline underline-offset-2 hover:text-primary/80 cursor-pointer"
        >
          {children}
        </a>
      );
    },

    // Inline
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    del: ({ children }) => <del className="text-muted-foreground">{children}</del>,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [agentNames, hasStreamingMermaidFence, sessionId]);

  return (
    <MarkdownErrorBoundary fallbackContent={content}>
      <div className="markdown-content">
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={components}
        >
          {content}
        </ReactMarkdown>
      </div>
    </MarkdownErrorBoundary>
  );
}, arePropsEqual);

// Compare props by VALUE, not identity. The `agentNames` array is rebuilt on
// every discovery poll (every ~5s while an agent is active) even when the set
// of names is unchanged; the default shallow memo would then re-render and make
// ReactMarkdown re-parse + rehype-highlight rebuild the whole code-block DOM,
// which reads as a flash. Skipping the re-render when content and names are
// value-equal keeps rendered messages static between polls.
function arePropsEqual(prev: MarkdownContentProps, next: MarkdownContentProps): boolean {
  const prevNames = prev.agentNames || [];
  const nextNames = next.agentNames || [];
  return (
    prev.content === next.content &&
    prev.sessionId === next.sessionId &&
    prevNames.length === nextNames.length &&
    prevNames.every((name, i) => name === nextNames[i])
  );
}