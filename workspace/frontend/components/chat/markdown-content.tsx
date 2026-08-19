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
}

/** Walk React children and colorize @agentname tokens in text nodes. */
function renderMentions(children: ReactNode, agentNames: string[]): ReactNode {
  if (!children || agentNames.length === 0) return children;

  const escaped = agentNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const mentionRegex = new RegExp(`(@(?:${escaped.join('|')}))(?![\\w-])`, 'g');

  let keyCounter = 0;

  const processNode = (node: ReactNode): ReactNode => {
    if (typeof node === 'string') {
      const parts = node.split(mentionRegex);
      if (parts.length === 1) return node;
      return parts.map((part) => {
        keyCounter++;
        if (part.startsWith('@') && agentNames.includes(part.slice(1))) {
          // Same source as the message rail and the roster dot, so one agent is
          // one colour everywhere. It used to come from a second, parallel
          // Tailwind palette keyed on the agent's index in the roster, which
          // meant a mention changed colour whenever someone joined or left.
          return (
            <span
              key={`mention-${keyCounter}`}
              className="font-medium rounded px-0.5"
              style={{ color: deriveIdentityColor(part.slice(1)) }}
            >
              {part}
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
        <div className="whitespace-pre-wrap font-mono text-[13px] leading-relaxed text-foreground opacity-90">
          {this.props.fallbackContent}
        </div>
      );
    }
    return this.props.children;
  }
}

export const MarkdownContent = memo(function MarkdownContent({ content, agentNames = [] }: MarkdownContentProps) {
  const hasStreamingMermaidFence = hasOpenMermaidFence(content);

  const components: Components = useMemo(() => ({
    // Block elements
    //
    // `p`/`li` carry no leading of their own so they inherit the 1.78 the
    // message body sets — that reading rhythm is the point of the direction,
    // and a local `leading-relaxed` here would quietly override it.
    h1: ({ children }) => (
      <h1 className="text-base font-semibold mt-3 mb-1.5 first:mt-0">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="text-[14.5px] font-semibold mt-2.5 mb-1 first:mt-0">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="font-semibold text-[13.5px] mt-2 mb-1 first:mt-0">{children}</h3>
    ),
    p: ({ children }) => (
      <p className="mb-2 last:mb-0 leading-[1.65]">{renderMentions(children, agentNames)}</p>
    ),
    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-border-accent pl-3 my-2 text-muted-foreground italic text-[13px]">
        {children}
      </blockquote>
    ),
    hr: () => <hr className="my-2.5 border-border" />,

    // Lists
    ul: ({ children }) => (
      <ul className="my-1.5 ml-4 space-y-0.5 list-disc text-[13.5px]">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="my-1.5 ml-4 space-y-0.5 list-decimal text-[13.5px]">{children}</ol>
    ),
    li: ({ children }) => (
      <li className="leading-[1.6]">{renderMentions(children, agentNames)}</li>
    ),

    // Tables
    table: ({ children }) => (
      <div className="my-2.5 overflow-x-auto rounded-lg border border-border/80 bg-surface1/30">
        <table className="min-w-full text-[12.5px] leading-snug">{children}</table>
      </div>
    ),
    thead: ({ children }) => (
      <thead className="bg-surface2/60">{children}</thead>
    ),
    tbody: ({ children }) => <tbody>{children}</tbody>,
    tr: ({ children }) => (
      <tr className="border-b border-border/50 last:border-0 hover:bg-surface1/40 transition-colors">
        {children}
      </tr>
    ),
    th: ({ children }) => (
      <th className="px-2.5 py-1.5 text-left font-semibold text-[11px] text-muted-foreground uppercase tracking-wider">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="px-2.5 py-1.5">{renderMentions(children, agentNames)}</td>
    ),

    // Code
    code: ({ className, children, ...props }: { className?: string; children?: ReactNode; inline?: boolean }) => {
      const textContent = String(children || '');
      const isInline = props.inline ?? (!className && !textContent.includes('\n'));
      if (isInline) {
        return (
          <code className="text-[12px] px-2 py-0.5 rounded-md bg-surface3 text-foreground font-mono font-medium border border-border-accent/60 shadow-xs inline-block my-0.5">
            {children}
          </code>
        );
      }
      return (
        <code className={cn('text-[13px] bg-transparent text-inherit p-0 font-mono', className)}>
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

      // Code blocks stay dark in BOTH themes so the syntax-highlight palette
      // (tuned for a dark ground) keeps its contrast.
      return (
        <div className="my-3 overflow-hidden rounded-xl border border-[#2e2e2e] bg-[#1a1a1a] text-[#ececec] font-mono shadow-sm">
          <div className="flex items-center justify-between px-4 py-2 border-b border-[#2e2e2e]/80 bg-[#212121]/90 text-[11px] font-semibold text-[#b4b4b4]">
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
              className="hover:text-[#ececec] text-[#b4b4b4] transition-colors cursor-pointer text-[11px]"
            >
              Copy
            </button>
          </div>
          <pre className="p-4 overflow-x-auto text-[13px] leading-relaxed text-[#ececec] font-mono bg-[#1a1a1a]">
            {children}
          </pre>
        </div>
      );
    },

    // Links
    a: ({ href, children }) => (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline underline-offset-2 hover:text-primary/80"
      >
        {children}
      </a>
    ),

    // Inline
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    del: ({ children }) => <del className="text-muted-foreground">{children}</del>,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [agentNames, hasStreamingMermaidFence]);

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
    prevNames.length === nextNames.length &&
    prevNames.every((name, i) => name === nextNames[i])
  );
}