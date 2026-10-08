'use client';

import { Hint } from '@/components/ui/hint';
import * as React from 'react';
import { memo, type ReactNode, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlightCached from '@/lib/rehype-highlight-cached';
import remarkGfm from 'remark-gfm';
import { deriveIdentityColor } from '@/lib/identity-colors';
import { cn } from '@/lib/utils';
import { MermaidBlock } from './mermaid-block';
import { DiffBlock } from './diff-block';
import { getMermaidSource, hasOpenMermaidFence } from './mermaid-utils';
import { toast } from '@/lib/toast';
import { getApiBaseUrl } from '@/lib/config';

/**
 * `C:\` or `D:/` — an absolute Windows path, which needs no resolving against a
 * working directory. Hoisted to one constant because it is tested in three
 * places, and a character class holding both separators is exactly the kind of
 * literal that gets mangled when this file is edited by a script.
 */
const WIN_DRIVE = /^[a-zA-Z]:[\\/]/;
import { BookOpen, Check, Copy, ChevronDown, ChevronUp, FileCode } from 'lucide-react';
import { ApprovalCard, type ApprovalCardQuestion, type ApprovalCardStatus } from '@/components/ai-elements/approval-card';
import { workspaceApi } from '@/lib/api';
import { downloadUrl } from '@/lib/download';
import { Citation, type CitationItem } from '@/components/agents/citations';
import { getBridge, copyTextToClipboard } from '@/lib/desktop';

import remarkBreaks from 'remark-breaks';

// Stable plugin arrays — avoids re-creating on every render
const remarkPlugins = [remarkGfm, remarkBreaks];
// Cached across mounts: the transcript is virtualised, so rows remount on scroll.
const rehypePlugins = [rehypeHighlightCached];

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
  citationSources?: CitationItem[];
  sourceIdPrefix?: string;
  onSelectCitation?: (citationId: string) => void;
}

/** Walk React children and colorize @agentname, @knowledge:slug, and [1] citation tokens in text nodes. */
function renderMentions(
  children: ReactNode,
  agentNames: string[] = [],
  citationSources?: CitationItem[],
  sourceIdPrefix?: string,
  onSelectCitation?: (citationId: string) => void,
): ReactNode {
  if (!children) return children;

  const escaped = agentNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const agentTokens = escaped.length > 0 ? `[@/](?:${escaped.join('|')})(?![\\w-])` : '';
  const knowledgeTokens = `@knowledge:[a-zA-Z0-9_-]+`;
  const citationTokens = citationSources && citationSources.length > 0 ? `\\[\\^?\\d+\\]` : '';

  const tokens = [citationTokens, knowledgeTokens, agentTokens].filter(Boolean);
  if (tokens.length === 0) return children;

  const pattern = `(${tokens.join('|')})`;
  const mentionRegex = new RegExp(pattern, 'gi');

  let keyCounter = 0;

  const processNode = (node: ReactNode): ReactNode => {
    if (typeof node === 'string') {
      const parts = node.split(mentionRegex);
      if (parts.length === 1) return node;
      return parts.map((part) => {
        keyCounter++;

        // Inline citation badge: [1], [2], [^1]
        const citeMatch = part.match(/^\[\^?(\d+)\]$/);
        if (citeMatch && citationSources && citationSources.length > 0) {
          const indexNum = parseInt(citeMatch[1], 10);
          const matchedItem = citationSources.find((c) => c.id === String(indexNum)) || citationSources[indexNum - 1];
          if (matchedItem) {
            return (
              <span
                key={`citation-${keyCounter}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectCitation?.(matchedItem.id);
                }}
                className="inline-block align-baseline"
              >
                <Citation
                  citationId={matchedItem.id}
                  index={indexNum}
                  idPrefix={sourceIdPrefix || 'response-source'}
                />
              </span>
            );
          }
        }

        if (part.toLowerCase().startsWith('@knowledge:')) {
          const slug = part.replace(/^@knowledge:/i, '');
          return (
            <span
              key={`knowledge-${keyCounter}`}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 my-0.5 rounded-base bg-surface2 border border-border text-status-success font-mono text-2xs font-medium align-baseline"
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
              className="mention-chip inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-surface2 border border-border text-foreground font-medium text-2xs leading-[1.35] align-middle"
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

interface InteractiveDecisionCardProps {
  questions: ApprovalCardQuestion[];
  sessionId?: string;
}

function InteractiveDecisionCard({ questions, sessionId }: InteractiveDecisionCardProps) {
  const [status, setStatus] = React.useState<ApprovalCardStatus>('pending');
  const [answers, setAnswers] = React.useState<Record<string, string>>({});

  const handleSubmit = async (submittedAnswers: Record<string, string>) => {
    if (status !== 'pending') return;
    if (!sessionId) {
      toast.error('Cannot submit decisions in read-only or shared view');
      return;
    }
    setStatus('submitting');
    try {
      const titleById = new Map(questions.map((q) => [q.id, q.title]));
      const answerSummary = Object.entries(submittedAnswers)
        .map(([k, v]) => `${titleById.get(k) || k}: ${v}`)
        .join('\n');
      await workspaceApi.sendMessage(sessionId, `[Decision]\n${answerSummary}`, 'User');
      setAnswers(submittedAnswers);
      setStatus('answered');
      toast.success('Answer sent');
    } catch (err) {
      setStatus('pending');
      toast.error(err instanceof Error ? err.message : 'Failed to send answer');
    }
  };

  return (
    <div className="my-3 not-prose">
      <ApprovalCard
        questions={questions}
        status={status}
        answers={status === 'answered' ? answers : undefined}
        onSubmit={handleSubmit}
      />
    </div>
  );
}

interface IdeCodeBlockProps {
  children: React.ReactNode;
  language: string;
  filename?: string;
  rawCodeText: string;
}

function IdeCodeBlock({ children, language, filename, rawCodeText }: IdeCodeBlockProps) {
  const [copied, setCopied] = React.useState(false);
  const cleanCode = React.useMemo(() => rawCodeText.replace(/\r\n/g, '\n').replace(/\n$/, ''), [rawCodeText]);
  const lineCount = React.useMemo(() => cleanCode ? cleanCode.split('\n').length : 1, [cleanCode]);
  const isLong = lineCount > 35;
  const [expanded, setExpanded] = React.useState(!isLong);
  const [wrapLines, setWrapLines] = React.useState(false);

  const handleCopy = async () => {
    const text = cleanCode.trim();
    if (!text) return;
    const ok = await copyTextToClipboard(text);
    if (ok) {
      setCopied(true);
      toast.success('Code copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast.error('Failed to copy');
    }
  };

  return (
    <div className="not-prose my-3 overflow-hidden rounded-lg border border-border/70 bg-surface3 text-foreground font-mono">
      <div className="flex items-center justify-between px-3 py-1.5 bg-surface4/70 text-3xs font-medium text-foreground-muted select-none border-b border-border/50">
        <div className="flex items-center gap-2 min-w-0">
          {filename ? (
            <div className="flex items-center gap-1.5 text-foreground font-medium truncate">
              <FileCode className="size-3.5 text-foreground-muted shrink-0" />
              <span className="truncate">{filename}</span>
            </div>
          ) : (
            <span className="font-mono uppercase tracking-wider font-semibold text-foreground/80">{language}</span>
          )}
          <span className="text-muted-foreground/60 text-3xs">({lineCount} line{lineCount === 1 ? '' : 's'})</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setWrapLines((w) => !w)}
            className={cn(
              "px-1.5 py-0.5 rounded text-3xs font-sans font-medium transition-colors cursor-pointer",
              wrapLines ? "bg-primary/10 text-primary" : "hover:bg-surface3 text-foreground-muted hover:text-foreground"
            )}
            title={wrapLines ? "Disable line wrap" : "Enable line wrap"}
          >
            Wrap
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded hover:bg-surface3 dark:hover:bg-white/10 hover:text-foreground transition-colors text-3xs font-sans font-medium cursor-pointer"
          >
            {copied ? <Check className="size-3 text-status-success" /> : <Copy className="size-3" />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
      </div>
      <div
        className={cn(
          "relative overflow-x-auto transition-all",
          expanded ? "max-h-none overflow-y-auto" : "max-h-[350px] overflow-hidden"
        )}
      >
        <pre className={cn("p-3.5 text-[12.5px] leading-[1.6] font-mono bg-transparent selection:bg-primary/20", wrapLines ? "whitespace-pre-wrap break-all" : "whitespace-pre")}>
          {children}
        </pre>
        {isLong && !expanded && (
          <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-surface3 to-transparent pointer-events-none flex items-end justify-center pb-2" />
        )}
      </div>
      {isLong && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs font-sans font-medium text-foreground-muted hover:text-foreground bg-surface4/40 hover:bg-surface4/70 border-t border-border/40 transition-colors cursor-pointer"
        >
          {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          <span>{expanded ? 'Collapse code' : `Show all ${lineCount} lines`}</span>
        </button>
      )}
    </div>
  );
}

const EMPTY_AGENT_NAMES: string[] = [];
const EMPTY_CITATION_SOURCES: CitationItem[] = [];

export const MarkdownContent = memo(function MarkdownContent({
  content,
  agentNames = EMPTY_AGENT_NAMES,
  sessionId,
  workingDir,
  citationSources = EMPTY_CITATION_SOURCES,
  sourceIdPrefix,
  onSelectCitation,
}: MarkdownContentProps) {
  const hasStreamingMermaidFence = hasOpenMermaidFence(content);

  const components: Components = useMemo(() => ({
    // Block elements
    h1: ({ children }) => (
      <h1 className="font-semibold mt-4 mb-2 first:mt-0 tracking-tight text-foreground text-[16px]">{children}</h1>
    ),
    h2: ({ children }) => (
      <h2 className="font-semibold mt-3.5 mb-1.5 first:mt-0 tracking-tight text-foreground text-[15px]">{children}</h2>
    ),
    h3: ({ children }) => (
      <h3 className="font-semibold mt-3 mb-1 first:mt-0 text-foreground text-[14px]">{children}</h3>
    ),
    h4: ({ children }) => (
      <h4 className="font-semibold mt-2.5 mb-1 first:mt-0 text-foreground text-[13.5px]">{children}</h4>
    ),
    p: ({ children }) => (
      <p className="text-foreground mb-2.5 last:mb-0 font-normal">
        {renderMentions(children, agentNames, citationSources, sourceIdPrefix, onSelectCitation)}
      </p>
    ),
    ul: ({ children }) => (
      <ul className="list-disc pl-5 my-2 space-y-1 text-foreground font-normal marker:text-foreground-extra-muted">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="list-decimal pl-5 my-2 space-y-1 text-foreground font-normal marker:text-foreground-muted">{children}</ol>
    ),
    li: ({ children }) => (
      <li className="pl-0.5">
        {renderMentions(children, agentNames, citationSources, sourceIdPrefix, onSelectCitation)}
      </li>
    ),
    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-border/80 pl-3.5 my-2.5 text-foreground/85 italic bg-transparent py-0.5">
        {children}
      </blockquote>
    ),
    hr: () => <hr className="border-border/60 my-5" />,

    // Tables
    table: ({ children }) => (
      <div className="overflow-x-auto my-3.5 rounded-lg border border-border">
        <table className="w-full text-left border-collapse">{children}</table>
      </div>
    ),
    thead: ({ children }) => <thead className="bg-surface2/90 text-foreground font-semibold border-b border-border">{children}</thead>,
    tbody: ({ children }) => <tbody className="divide-y divide-border/60 bg-surface1/40">{children}</tbody>,
    tr: ({ children }) => <tr className="hover:bg-surface2/50 transition-colors">{children}</tr>,
    th: ({ children }) => <th className="px-3.5 py-2.5 font-semibold text-foreground tracking-tight">{children}</th>,
    td: ({ children }) => <td className="px-3.5 py-2 text-foreground">{children}</td>,

    // Code
    code: ({ className, children, ...props }) => {
      const isInline = !className && typeof children === 'string';
      if (isInline) {
        const text = String(children).trim();
        const filePathMatch = /^([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+)(?::(\d+))?$/.exec(text);
        if (filePathMatch) {
          const filePath = filePathMatch[1];
          const lineNum = filePathMatch[2];
          return (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                const bridge = getBridge() as Record<string, unknown> | null;
                if (typeof bridge?.openFile === 'function') {
                  (bridge.openFile as (p: string, l?: number) => void)(filePath, lineNum ? parseInt(lineNum, 10) : undefined);
                } else if (workingDir) {
                  window.dispatchEvent(
                    new CustomEvent('oa:open-editor', {
                      detail: { path: `${workingDir}/${filePath}`, line: lineNum ? parseInt(lineNum, 10) : undefined },
                    })
                  );
                }
              }}
              className="bg-surface3 hover:bg-surface4 text-primary font-mono px-1.5 py-0.5 rounded text-[0.875em] border border-primary/20 hover:border-primary/40 inline-flex items-center gap-1 align-baseline cursor-pointer transition-colors"
              title={`Open ${filePath}${lineNum ? ` at line ${lineNum}` : ''}`}
            >
              <FileCode className="size-3 text-primary/70 shrink-0" />
              <span>{children}</span>
            </button>
          );
        }

        return (
          <code
            className="bg-surface3 text-foreground font-mono px-1.5 py-0.5 rounded text-[0.875em] border border-border/50 inline align-baseline font-normal"
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
            return <InteractiveDecisionCard questions={formattedQuestions} sessionId={sessionId} />;
          }
        } catch {
          // If JSON is invalid, fall through to default code block rendering
        }
      }

      // Modern IDE-grade Code Block with line counter, collapse & robust copy
      const rawMatch = /language-([a-zA-Z0-9_\-\.\/:]+)/.exec(className);
      let parsedLang = 'CODE';
      let parsedFilename: string | undefined = undefined;

      if (rawMatch && rawMatch[1]) {
        if (rawMatch[1].includes(':')) {
          const parts = rawMatch[1].split(':');
          parsedLang = parts[0].toUpperCase();
          parsedFilename = parts.slice(1).join(':');
        } else {
          parsedLang = rawMatch[1].toUpperCase();
        }
      }

      return (
        <IdeCodeBlock
          language={parsedLang}
          filename={parsedFilename}
          rawCodeText={rawCodeText}
        >
          {children}
        </IdeCodeBlock>
      );
    },

    // Links
    a: ({ href, children }) => {
      let normalizedHref = (href || '').trim();
      if (/^(javascript|data|vbscript):/i.test(normalizedHref)) {
        return <span className="text-muted-foreground">{children}</span>;
      }
      if (/^www\./i.test(normalizedHref)) {
        normalizedHref = `https://${normalizedHref}`;
      }
      const isInternalFile = Boolean(normalizedHref && (normalizedHref.includes('/api/files/') || normalizedHref.startsWith('/api/files/')));
      const isHttp = !isInternalFile && (normalizedHref.startsWith('http://') || normalizedHref.startsWith('https://'));
      const isEditorScheme = Boolean(normalizedHref && (normalizedHref.startsWith('vscode:') || normalizedHref.startsWith('cursor:')));
      const isExplicitLocal = Boolean(
        normalizedHref &&
        (normalizedHref.startsWith('file://') ||
         normalizedHref.startsWith('file:') ||
         WIN_DRIVE.test(normalizedHref) ||
         normalizedHref.startsWith('./') ||
         normalizedHref.startsWith('.\\') ||
         normalizedHref.startsWith('../') ||
         normalizedHref.startsWith('..\\') ||
         normalizedHref.startsWith('/'))
      );
      const isRelativeFilePath =
        Boolean(normalizedHref) &&
        !isHttp &&
        !isEditorScheme &&
        !isInternalFile &&
        !normalizedHref.startsWith('#') &&
        !normalizedHref.startsWith('mailto:') &&
        !normalizedHref.includes('://') &&
        Boolean(workingDir) &&
        (/[\/\\]/.test(normalizedHref) || /\.[a-zA-Z0-9]{1,8}(:\d+)?$/.test(normalizedHref));

      const isLocalPath = !isHttp && !isEditorScheme && !isInternalFile && (isExplicitLocal || isRelativeFilePath);

      if (isInternalFile) {
        return (
          <Hint label={normalizedHref}>
            <button
              type="button"
              onClick={() => {
                downloadUrl(normalizedHref);
              }}
              className="text-primary underline underline-offset-2 hover:text-primary/80 text-left"
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
          let targetPath = normalizedHref;

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

          const bridge = getBridge();

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
          <Hint label={`Open locally: ${normalizedHref}`}>
            <button
              type="button"
              onClick={openLocal}
              className="text-primary underline underline-offset-2 hover:text-primary/80 font-mono text-xs cursor-pointer inline-flex items-center gap-1"
            >
              <span>{children}</span>
            </button>
          </Hint>
        );
      }

      // Check if this link is a numeric citation like [1] or 1
      const textChild = String(children).trim();
      const numMatch = textChild.match(/^\[?\^?(\d+)\]?$/);
      if (numMatch) {
        const num = numMatch[1];
        const matchedItem = citationSources?.find((c) => c.id === num) || citationSources?.[parseInt(num, 10) - 1];
        return (
          <a
            href={href || (matchedItem ? `#${sourceIdPrefix || 'response-source'}-${matchedItem.id}` : undefined)}
            onClick={(e) => {
              if (matchedItem) {
                onSelectCitation?.(matchedItem.id);
              }
              const bridge = getBridge();
              if (href && isHttp && bridge?.openPath) {
                e.preventDefault();
                bridge.openPath(href);
              }
            }}
            target={href && isHttp ? "_blank" : undefined}
            rel={href && isHttp ? "noopener noreferrer" : undefined}
            aria-label={`View citation ${num}`}
            className="mx-0.5 inline-flex min-w-4 -translate-y-0.5 items-center justify-center rounded-md bg-muted/60 px-1 py-0.5 text-[10px] font-semibold leading-none text-muted-foreground no-underline outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            {num}
          </a>
        );
      }

      // A real external URL. `target`/`rel` belong only here.
      return (
        <a
          href={href}
          onClick={(e) => {
            const bridge = getBridge();
            if (isHttp && bridge?.openPath) {
              e.preventDefault();
              bridge.openPath(href!);
            }
          }}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline underline-offset-2 hover:text-primary/80"
        >
          {children}
        </a>
      );
    },

    // Inline
    strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
    del: ({ children }) => <del className="text-muted-foreground">{children}</del>,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [agentNames, citationSources, sourceIdPrefix, onSelectCitation, hasStreamingMermaidFence, sessionId, workingDir]);

  return (
    <MarkdownErrorBoundary fallbackContent={content}>
      <div className="markdown-content select-text selectable">
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
  const prevSources = prev.citationSources || [];
  const nextSources = next.citationSources || [];
  return (
    prev.content === next.content &&
    prev.sessionId === next.sessionId &&
    prev.workingDir === next.workingDir &&
    prev.sourceIdPrefix === next.sourceIdPrefix &&
    prevSources.length === nextSources.length &&
    prevNames.length === nextNames.length &&
    prevNames.every((name, i) => name === nextNames[i])
  );
}