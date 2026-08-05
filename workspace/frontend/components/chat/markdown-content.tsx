'use client';

import * as React from 'react';
import { memo, type ReactNode, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { getAgentColor } from '@/lib/helpers';
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
  agentNames: string[];
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
          const color = getAgentColor(part.slice(1), agentNames);
          return (
            <span key={`mention-${keyCounter}`} className={cn('font-medium rounded px-0.5', color.text)}>
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

export const MarkdownContent = memo(function MarkdownContent({ content, agentNames }: MarkdownContentProps) {
  const hasStreamingMermaidFence = hasOpenMermaidFence(content);

  const components: Components = useMemo(() => ({
    // Block elements
    h1: ({ children }) => (
      <h1 className="text-lg font-bold mt-4 mb-2 first:mt-0">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="text-base font-bold mt-3 mb-1.5 first:mt-0">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="font-semibold text-[15px] mt-3 mb-1 first:mt-0">{children}</h3>
    ),
    p: ({ children }) => (
      <p className="leading-relaxed mb-2 last:mb-0">{renderMentions(children, agentNames)}</p>
    ),
    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-border-accent pl-3 my-2 text-muted-foreground italic">
        {children}
      </blockquote>
    ),
    hr: () => <hr className="my-3 border-border" />,

    // Lists
    ul: ({ children }) => (
      <ul className="my-2 ml-4 space-y-0.5 list-disc">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="my-2 ml-4 space-y-0.5 list-decimal">{children}</ol>
    ),
    li: ({ children }) => (
      <li className="leading-relaxed">{renderMentions(children, agentNames)}</li>
    ),

    // Tables
    table: ({ children }) => (
      <div className="my-3 overflow-x-auto rounded-md border border-border">
        <table className="min-w-full text-sm">{children}</table>
      </div>
    ),
    thead: ({ children }) => (
      <thead className="bg-surface1/50">{children}</thead>
    ),
    tbody: ({ children }) => <tbody>{children}</tbody>,
    tr: ({ children }) => (
      <tr className="border-b border-border last:border-0">
        {children}
      </tr>
    ),
    th: ({ children }) => (
      <th className="px-3 py-1.5 text-left font-semibold text-xs text-muted-foreground">
        {children}
      </th>
    ),
    td: ({ children }) => (
      <td className="px-3 py-1.5">{renderMentions(children, agentNames)}</td>
    ),

    // Code
    code: ({ className, children, ...props }: { className?: string; children?: ReactNode; inline?: boolean }) => {
      const textContent = String(children || '');
      const isInline = props.inline ?? (!className && !textContent.includes('\n'));
      if (isInline) {
        return (
          <code className="text-[13px] px-1.5 py-0.5 rounded bg-surface2/80 text-foreground font-mono">
            {children}
          </code>
        );
      }
      return (
        <code className={cn('text-[13px] bg-transparent text-inherit p-0', className)}>
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

      // Attempt to extract language class
      const codeElement = React.Children.only(children) as React.ReactElement<{ className?: string; children?: React.ReactNode }>;
      const className = codeElement?.props?.className || '';
      const match = /language-(\w+)/.exec(className);
      const language = match ? match[1].toUpperCase() : 'CODE';

      // Fenced ```diff / ```patch → real unified-diff renderer
      if (language === 'DIFF' || language === 'PATCH') {
        return <DiffBlock code={nodeToText(codeElement?.props?.children).replace(/\n$/, '')} />;
      }

      return (
        <div className="my-3 overflow-hidden rounded-xl border border-border bg-primary text-primary-foreground font-mono shadow-sm">
          <div className="flex items-center justify-between px-4 py-2 border-b border-primary bg-primary/60 text-[10px] font-bold tracking-wider text-foreground-muted uppercase">
            <span>{language}</span>
            <button
              onClick={() => {
                const text = nodeToText(codeElement?.props?.children).trim();
                if (text) {
                  navigator.clipboard.writeText(text);
                  toast.success('Code copied to clipboard');
                }
              }}
              className="hover:text-foreground-extra-muted transition-colors"
            >
              Copy
            </button>
          </div>
          <pre className="p-4 overflow-x-auto text-[13px] leading-relaxed text-primary-foreground font-mono">
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
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}, arePropsEqual);

// Compare props by VALUE, not identity. The `agentNames` array is rebuilt on
// every discovery poll (every ~5s while an agent is active) even when the set
// of names is unchanged; the default shallow memo would then re-render and make
// ReactMarkdown re-parse + rehype-highlight rebuild the whole code-block DOM,
// which reads as a flash. Skipping the re-render when content and names are
// value-equal keeps rendered messages static between polls.
function arePropsEqual(prev: MarkdownContentProps, next: MarkdownContentProps): boolean {
  return (
    prev.content === next.content &&
    prev.agentNames.length === next.agentNames.length &&
    prev.agentNames.every((name, i) => name === next.agentNames[i])
  );
}
