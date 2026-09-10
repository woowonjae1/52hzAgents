'use client';

import { Hint } from '@/components/ui/hint';
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
import { getApiBaseUrl } from '@/lib/config';

/**
 * `C:\` or `D:/` — an absolute Windows path, which needs no resolving against a
 * working directory. Hoisted to one constant because it is tested in three
 * places, and a character class holding both separators is exactly the kind of
 * literal that gets mangled when this file is edited by a script.
 */
const WIN_DRIVE = /^[a-zA-Z]:[\\/]/;
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
  workingDir?: string;
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
              className="inline-flex items-center gap-1 px-1.5 py-0.5 my-0.5 rounded-base bg-surface2 border border-border text-status-success font-mono text-2xs font-medium align-baseline shadow-2xs"
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
              className="inline-flex items-center gap-1 px-1.5 py-0.5 my-0.5 rounded-md bg-surface2 border border-border text-foreground font-medium text-2xs align-baseline shadow-2xs"
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

export const MarkdownContent = memo(function MarkdownContent({ content, agentNames = [], sessionId, workingDir }: MarkdownContentProps) {
  const hasStreamingMermaidFence = hasOpenMermaidFence(content);

  const components: Components = useMemo(() => ({
    // Block elements
    h1: ({ children }) => (
      <h1 className="text-[18px] font-semibold mt-6 mb-3 pb-1.5 border-b border-border/60 first:mt-0 tracking-tight text-foreground">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="text-[16px] font-semibold mt-5 mb-2.5 first:mt-0 tracking-tight text-foreground">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="text-[14.5px] font-medium mt-4 mb-2 first:mt-0 text-foreground">{children}</h3>
    ),
    h4: ({ children }) => (
      <h4 className="text-[13.5px] font-medium mt-3 mb-1.5 first:mt-0 text-foreground">{children}</h4>
    ),
    p: ({ children }) => (
      <p className="leading-[1.8] text-foreground/95 mb-3 last:mb-0 text-[13.5px] sm:text-sm font-normal">
        {renderMentions(children, agentNames)}
      </p>
    ),
    ul: ({ children }) => (
      <ul className="list-disc pl-5 my-2.5 space-y-1.5 text-[13.5px] sm:text-sm leading-[1.75] text-foreground/90 font-normal">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="list-decimal pl-5 my-2.5 space-y-1.5 text-[13.5px] sm:text-sm leading-[1.75] text-foreground/90 font-normal">{children}</ol>
    ),
    li: ({ children }) => <li className="pl-0.5">{renderMentions(children, agentNames)}</li>,
    blockquote: ({ children }) => (
      <blockquote className="border-l-[3px] border-primary/50 bg-surface1/60 dark:bg-surface2/50 rounded-r-lg pl-3.5 pr-3 py-2 my-3 text-foreground/85 not-italic text-[13px] leading-[1.75] shadow-2xs">
        {children}
      </blockquote>
    ),
    hr: () => <hr className="border-border/60 my-5" />,

    // Tables
    table: ({ children }) => (
      <div className="overflow-x-auto my-3.5 rounded-lg border border-border shadow-2xs">
        <table className="w-full text-xs text-left border-collapse">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-surface2/90 text-foreground font-semibold border-b border-border">{children}</thead>,
    tbody: ({ children }) => <tbody className="divide-y divide-border/60 bg-surface1/40">{children}</tbody>,
    tr: ({ children }) => <tr className="hover:bg-surface2/50 transition-colors">{children}</tr>,
    th: ({ children }) => <th className="px-3.5 py-2.5 text-xs font-semibold text-foreground tracking-tight">{children}</th>,
    td: ({ children }) => <td className="px-3.5 py-2 text-xs text-foreground/90 leading-relaxed">{children}</td>,

    // Code
    code: ({ className, children, ...props }) => {
      const isInline = !className && typeof children === 'string';
      if (isInline) {
        return (
          <code
            className="bg-surface2 text-foreground font-mono text-[0.88em] px-1.5 py-0.5 rounded-md border border-border inline align-baseline font-normal shadow-2xs mx-0.5"
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
              title: q.title || q.question || 'Choose one',
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
                      toast.success('Answer sent');
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

      // Modern IDE-grade Code Block (Optimized for both Light & Dark themes)
      return (
        <div className="not-prose my-3.5 overflow-hidden rounded-xl border border-border dark:border-white/[0.08] bg-[#f6f8fa] dark:bg-[#0e0f13] text-foreground font-mono shadow-xs dark:shadow-md">
          <div className="flex items-center justify-between px-3.5 py-2 bg-surface2/80 dark:bg-[#13141a] text-3xs font-medium text-foreground-muted dark:text-neutral-400 select-none">
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-1.5 mr-1 opacity-80">
                <span className="size-2.5 rounded-full bg-[#ff5f56] inline-block" />
                <span className="size-2.5 rounded-full bg-[#ffbd2e] inline-block" />
                <span className="size-2.5 rounded-full bg-[#27c93f] inline-block" />
              </div>
              <span className="font-mono uppercase tracking-wider font-semibold">{language}</span>
            </div>
            <button
              onClick={() => {
                const text = rawCodeText.trim();
                if (text) {
                  navigator.clipboard.writeText(text);
                  toast.success('Code copied to clipboard');
                }
              }}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md hover:bg-surface3 dark:hover:bg-white/10 hover:text-foreground dark:hover:text-white text-foreground-muted dark:text-neutral-400 transition-colors cursor-pointer text-3xs font-sans font-medium"
            >
              <span>Copy</span>
            </button>
          </div>
          <pre className="p-4 overflow-x-auto text-[12.5px] leading-[1.65] font-mono bg-transparent selection:bg-primary/20">
            {children}
          </pre>
        </div>
      );
    },

    // Links
    a: ({ href, children }) => {
      const isInternalFile = href && (href.includes('/api/files/') || href.startsWith('/api/files/'));
      const isHttp = href && !isInternalFile && (href.startsWith('http://') || href.startsWith('https://'));
      const isEditorScheme = href && (href.startsWith('vscode:') || href.startsWith('cursor:'));
      const isLocalPath = href && !isHttp && !isEditorScheme && !isInternalFile && (
        href.startsWith('file://') ||
        href.startsWith('file:') ||
        WIN_DRIVE.test(href) ||
        href.startsWith('/') ||
        href.startsWith('./') ||
        href.startsWith('../') ||
        (!href.includes('://') && !href.startsWith('mailto:') && !href.startsWith('#'))
      );

      if (isInternalFile) {
        return (
          <Hint label={href}>
            <button
              type="button"
              onClick={() => {
                const a = document.createElement('a');
                a.href = href!;
                a.download = '';
                a.click();
              }}
              className="text-primary underline underline-offset-2 hover:text-primary/80 cursor-pointer text-left"
            >
              {children}
            </button>
          </Hint>
        );
      }

      /**
       * A LOCAL PATH IS A BUTTON, NOT AN ANCHOR.
       */
      if (isLocalPath || isEditorScheme) {
        const openLocal = async () => {
          let targetPath = href || '';

          if (
            workingDir &&
            !targetPath.startsWith('file:') &&
            !WIN_DRIVE.test(targetPath) &&
            !isEditorScheme
          ) {
            const lineMatch = targetPath.match(/(:L\d+.*$|:\d+(?::\d+)?$)/i);
            const lineSuffix = lineMatch ? lineMatch[1] : '';
            const barePath = targetPath.replace(/:L\d+.*$/i, '').replace(/:\d+(?::\d+)?$/, '');
            const sep = workingDir.includes('\\') ? '\\' : '/';
            const cleanRel = barePath.replace(/^\.?[/\\]+/, '');
            targetPath = `${workingDir}${sep}${cleanRel}${lineSuffix}`;
          } else if (
            !workingDir &&
            !isEditorScheme &&
            !targetPath.startsWith('file:') &&
            !targetPath.startsWith('/') &&
            !WIN_DRIVE.test(targetPath)
          ) {
            toast.error(`Cannot resolve ${targetPath} — this conversation has no working directory set`);
            return;
          }

          const bridge =
            typeof window !== 'undefined'
              ? (window as unknown as { electronBridge?: { openPath?: (p: string) => Promise<boolean> } }).electronBridge
              : undefined;

          if (bridge?.openPath) {
            const opened = await bridge.openPath(targetPath);
            if (opened) toast.success('Opened locally');
            else toast.error(`Could not open ${targetPath}`);
            return;
          }

          try {
            const res = await fetch(`${getApiBaseUrl()}/v1/system/open-path`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: targetPath }),
            });
            if (res.ok) toast.success('Opened on the host machine');
            else toast.error(`Could not open ${targetPath}`);
          } catch {
            toast.error(`Could not reach the workspace backend to open ${targetPath}`);
          }
        };

        return (
          <Hint label={href}>
            <button
              type="button"
              onClick={() => void openLocal()}
              className="text-primary underline underline-offset-2 hover:text-primary/80 cursor-pointer text-left"
            >
              {children}
            </button>
          </Hint>
        );
      }

      // A real external URL. `target`/`rel` belong only here.
      return (
        <a
          href={href}
          onClick={(e) => {
            const bridge = (window as unknown as { electronBridge?: { openPath?: (p: string) => void } }).electronBridge;
            if (isHttp && bridge?.openPath) {
              e.preventDefault();
              bridge.openPath(href!);
            }
          }}
          target="_blank"
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
  }), [agentNames, hasStreamingMermaidFence, sessionId, workingDir]);

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
    prev.workingDir === next.workingDir &&
    prevNames.length === nextNames.length &&
    prevNames.every((name, i) => name === nextNames[i])
  );
}