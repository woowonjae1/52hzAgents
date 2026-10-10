'use client';

import { Hint } from '@/components/ui/hint';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import React, { useState, useMemo, useEffect, useRef } from 'react';
import {
  X,
  FileText,
  Code2,
  Copy,
  Download,
  Maximize2,
  Minimize2,
  Globe,
  PanelLeft,
  GitCompare,
  Eye,
  FileCode,
  Wand2,
  Send,
  ArrowRightLeft,
  FileDiff,
  Loader2,
  BookOpen,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { downloadBlob } from '@/lib/download';
import { copyWithToast } from '@/lib/desktop';
import { workspaceApi } from '@/lib/api';
import { MarkdownContent } from '../chat/markdown-content';
import { DiffBlock } from '../chat/diff-block';
import { useSessionMessages } from '../chat/chat-view';
import { FilePreview } from '../files/file-preview';
import { useArtifacts, type OutputSelection } from '@/lib/artifacts-context';
import { useWorkspace, isDraftSessionId } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';
import {
  collectOutputs,
  downloadName,
  lineDiff,
  mimeType,
  revisionRequest,
  type ArtifactGroup,
  type ArtifactItem,
  type ChangedFile,
} from '@/lib/artifacts';

/*
  THE OUTPUTS PANEL (formerly Canvas, now also the File tab).

  What the agents in this thread produced, in one place: documents they
  delivered (with versions), pipeline handoffs, files they changed, and the
  workspace file you opened. Everything is derived from the thread's messages
  (lib/artifacts.ts), so it survives reloads and never disagrees with the
  transcript.

  Removed with this rewrite, and why:
  - The "Reviews" layer. Notes lived only in this tab, reached no agent, and
    the reviewer list was a hard-coded @claude/@antigravity -- a human's note
    was signed as an agent. Its real job, getting an agent to change the
    document, is now "Revise", which sends an actual message.
  - The Doc / Code toggle. Each type has one right view: markdown is read,
    code is highlighted, HTML/SVG is rendered (with its source one click away).
  - A version badge that could only ever say v1. Versions are real now.
*/

const LIST_OPEN_KEY = 'outputs_list_open';

function readListOpen(): boolean {
  try {
    return localStorage.getItem(LIST_OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}

function sameSelection(a: OutputSelection | null, b: OutputSelection | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'document' && b.kind === 'document') return a.key === b.key;
  if (a.kind === 'change' && b.kind === 'change') return a.path === b.path;
  return true;
}

function selectionKey(s: OutputSelection | null): string {
  if (!s) return 'none';
  if (s.kind === 'document') return `doc:${s.key}:${s.versionId ?? 'latest'}`;
  if (s.kind === 'change') return `change:${s.path}:${s.turnId}`;
  return 'file';
}

function basename(p: string) {
  return p.split(/[\\/]/).pop() || p;
}

export function ArtifactsCanvas({ className }: { className?: string; embedded?: boolean }) {
  const { selection, openOutput, closeCanvas } = useArtifacts();
  const { activeRightTab, setActiveRightTab } = useLayout();
  const { currentSessionId, sessions, files, selectedFileId } = useWorkspace();
  const { messages } = useSessionMessages();
  const currentSession = sessions.find((s) => s.sessionId === currentSessionId);
  const workingDir = currentSession?.workingDir ?? undefined;

  const outputs = useMemo(() => collectOutputs(messages), [messages]);
  const openFile = files.find((f) => f.id === selectedFileId);

  const [listOpen, setListOpen] = useState(readListOpen);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // The File tab is this panel showing the file picked in the Files view.
  const effective: OutputSelection | null =
    activeRightTab === 'file' && openFile
      ? { kind: 'file' }
      : selection ??
        (outputs.documents[0]
          ? { kind: 'document', key: outputs.documents[0].key }
          : outputs.changedFiles[0]
          ? { kind: 'change', path: outputs.changedFiles[0].path, turnId: outputs.changedFiles[0].turnId }
          : null);

  const select = (next: OutputSelection) => {
    openOutput(next);
    if (activeRightTab === 'file') setActiveRightTab('canvas');
  };

  const toggleList = () => {
    setListOpen((open) => {
      try {
        localStorage.setItem(LIST_OPEN_KEY, open ? '0' : '1');
      } catch {
        /* per-viewer convenience only */
      }
      return !open;
    });
  };

  // Esc leaves fullscreen first. Closing the panel is the global Esc handler's
  // job; this one used to close the panel too, taking two layers per press.
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setIsFullscreen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isFullscreen]);

  const group = effective?.kind === 'document' ? outputs.documents.find((g) => g.key === effective.key) : undefined;
  const change =
    effective?.kind === 'change' ? outputs.changedFiles.find((f) => f.path === effective.path) ?? null : null;

  const totalOutputs =
    outputs.documents.length +
    outputs.changedFiles.length +
    (openFile ? 1 : 0);
  const shouldShowList = listOpen && totalOutputs > 1;

  const close = () => {
    closeCanvas();
    setActiveRightTab(null);
  };

  return (
    <div
      className={cn(
        'relative flex flex-col bg-surface1 h-full w-full flex-1 min-w-0 min-h-0 select-text',
        isFullscreen && 'fixed top-[var(--titlebar-height)] inset-x-0 bottom-0 z-50',
        className
      )}
    >
      <div className="flex flex-1 min-h-0">
        {shouldShowList && (
          <OutputsList
            documents={outputs.documents}
            changedFiles={outputs.changedFiles}
            openFileName={openFile?.filename}
            active={effective}
            onSelect={select}
            onSelectFile={() => setActiveRightTab('file')}
            onCloseList={toggleList}
          />
        )}

        <div className="flex flex-1 min-w-0 flex-col">
          {effective?.kind === 'file' ? (
            // FilePreview brings its own header, so a collapsed list gets a
            // small way back instead of a second header row.
            <div className="relative flex-1 min-h-0 flex flex-col">
              <FilePreview onClose={close} />
              {!listOpen && totalOutputs > 1 && (
                <Hint label="Show outputs list">
                  <button
                    type="button"
                    onClick={toggleList}
                    className="absolute bottom-3 left-3 z-10 flex size-7 items-center justify-center rounded-lg border border-border bg-surface1 text-foreground-muted shadow-sm hover:text-foreground"
                  >
                    <PanelLeft className="size-3.5" />
                  </button>
                </Hint>
              )}
            </div>
          ) : group ? (
            <DocumentView
              key={selectionKey(effective)}
              group={group}
              versionId={effective?.kind === 'document' ? effective.versionId : undefined}
              onVersion={(versionId) => select({ kind: 'document', key: group.key, versionId })}
              workingDir={workingDir}
              sessionId={currentSessionId}
              header={(actions) => (
                <PanelHeader
                  listOpen={listOpen}
                  onToggleList={toggleList}
                  isFullscreen={isFullscreen}
                  onFullscreen={() => setIsFullscreen((v) => !v)}
                  onPreview={() => setActiveRightTab('preview')}
                  onKnowledge={() => setActiveRightTab('knowledge')}
                  onClose={close}
                  actions={actions}
                  totalOutputs={totalOutputs}
                />
              )}
            />
          ) : change && currentSessionId ? (
            <ChangeView
              key={selectionKey(effective)}
              change={change}
              channelId={currentSessionId}
              header={
                <PanelHeader
                  listOpen={listOpen}
                  onToggleList={toggleList}
                  isFullscreen={isFullscreen}
                  onFullscreen={() => setIsFullscreen((v) => !v)}
                  onPreview={() => setActiveRightTab('preview')}
                  onKnowledge={() => setActiveRightTab('knowledge')}
                  onClose={close}
                  actions={{
                    title: change.path,
                    icon: <FileDiff className="size-3.5" />,
                    meta: `@${change.agent}`,
                  }}
                  totalOutputs={totalOutputs}
                />
              }
            />
          ) : (
            <>
              <PanelHeader
                listOpen={listOpen}
                onToggleList={toggleList}
                isFullscreen={isFullscreen}
                onFullscreen={() => setIsFullscreen((v) => !v)}
                onPreview={() => setActiveRightTab('preview')}
                onKnowledge={() => setActiveRightTab('knowledge')}
                onClose={close}
                actions={{ title: 'Outputs', icon: <FileText className="size-3.5" /> }}
                totalOutputs={totalOutputs}
              />
              <div className="flex flex-1 items-center justify-center p-8 text-center text-xs text-muted-foreground">
                <div className="max-w-xs space-y-1.5">
                  <p className="font-medium text-foreground">No outputs in this thread yet</p>
                  <p>
                    Documents an agent delivers, pipeline handoffs and files changed during a turn appear here.
                  </p>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── List ──

function OutputsList({
  documents,
  changedFiles,
  openFileName,
  active,
  onSelect,
  onSelectFile,
  onCloseList,
}: {
  documents: ArtifactGroup[];
  changedFiles: ChangedFile[];
  openFileName?: string;
  active: OutputSelection | null;
  onSelect: (s: OutputSelection) => void;
  onSelectFile: () => void;
  onCloseList?: () => void;
}) {
  const row = (isActive: boolean) =>
    cn(
      'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
      isActive ? 'bg-surface3 text-foreground' : 'text-foreground-muted hover:bg-surface2 hover:text-foreground'
    );
  const heading = 'px-2 pb-1 pt-2.5 text-3xs font-semibold uppercase tracking-wider text-foreground-extra-muted';

  return (
    <nav aria-label="Thread outputs" className="w-44 shrink-0 overflow-y-auto border-r border-border bg-surface1 px-1.5 pb-3">
      <div className="flex items-center justify-between px-1.5 pt-2 pb-1 border-b border-border/40 mb-1">
        <span className="text-3xs font-semibold uppercase tracking-wider text-foreground-extra-muted">Outputs</span>
        {onCloseList && (
          <Hint label="Hide outputs list">
            <button
              type="button"
              onClick={onCloseList}
              className="size-5 rounded hover:bg-surface2 text-foreground-muted hover:text-foreground flex items-center justify-center transition-colors cursor-pointer active:scale-95"
            >
              <PanelLeft className="size-3" />
            </button>
          </Hint>
        )}
      </div>
      {openFileName && (
        <>
          <div className={heading}>Open file</div>
          <button type="button" className={row(active?.kind === 'file')} onClick={onSelectFile}>
            <FileText className="size-3.5 shrink-0" />
            <span className="truncate">{openFileName}</span>
          </button>
        </>
      )}

      <div className={heading}>Documents</div>
      {documents.length === 0 ? (
        <p className="px-2 py-1 text-2xs text-foreground-extra-muted">None yet</p>
      ) : (
        documents.map((g) => {
          const cur = g.versions[g.versions.length - 1];
          const Icon = cur.type === 'code' ? Code2 : cur.type === 'html' || cur.type === 'svg' ? Eye : cur.type === 'deliverable' ? ArrowRightLeft : FileText;
          return (
            <button
              key={g.key}
              type="button"
              className={row(sameSelection(active, { kind: 'document', key: g.key }))}
              onClick={() => onSelect({ kind: 'document', key: g.key })}
            >
              <Icon className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{cur.title}</span>
              {g.versions.length > 1 && (
                <span className="shrink-0 font-mono text-3xs text-foreground-extra-muted">v{g.versions.length}</span>
              )}
            </button>
          );
        })
      )}

      <div className={heading}>Changed files</div>
      {changedFiles.length === 0 ? (
        <p className="px-2 py-1 text-2xs text-foreground-extra-muted">None yet</p>
      ) : (
        changedFiles.map((f) => (
          <Hint key={f.path} label={`${f.path} · @${f.agent}`} side="left">
            <button
              type="button"
              className={row(sameSelection(active, { kind: 'change', path: f.path, turnId: f.turnId }))}
              onClick={() => onSelect({ kind: 'change', path: f.path, turnId: f.turnId })}
            >
              <span
                className={cn(
                  'w-3 shrink-0 text-center font-mono text-3xs',
                  f.status === 'A' || f.status === '?' ? 'text-diff-addition' : f.status === 'D' ? 'text-diff-deletion' : 'text-foreground-extra-muted'
                )}
              >
                {f.status === '?' ? 'U' : f.status}
              </span>
              <span className="min-w-0 flex-1 truncate">{basename(f.path)}</span>
              <span className="shrink-0 font-mono text-3xs">
                <span className="text-diff-addition">+{f.additions}</span>{' '}
                <span className="text-diff-deletion">-{f.deletions}</span>
              </span>
            </button>
          </Hint>
        ))
      )}
    </nav>
  );
}

// ── Header ──

interface HeaderActions {
  title: string;
  icon: React.ReactNode;
  meta?: string;
  controls?: React.ReactNode;
}

function PanelHeader({
  listOpen,
  onToggleList,
  isFullscreen,
  onFullscreen,
  onPreview,
  onKnowledge,
  onClose,
  actions,
  totalOutputs = 0,
}: {
  listOpen: boolean;
  onToggleList: () => void;
  isFullscreen: boolean;
  onFullscreen: () => void;
  onPreview: () => void;
  onKnowledge?: () => void;
  onClose: () => void;
  actions: HeaderActions;
  totalOutputs?: number;
}) {
  const iconBtn =
    'size-7 shrink-0 rounded-lg hover:bg-surface2 text-foreground-muted hover:text-foreground flex items-center justify-center transition-colors cursor-pointer active:scale-95';
  return (
    <div className="app-header justify-between gap-2 px-2 flex-nowrap min-w-0 overflow-hidden shrink-0 border-b border-border bg-surface1 select-none">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {totalOutputs > 1 && (
          <>
            <Hint label={listOpen ? 'Hide outputs list' : `Show outputs list (${totalOutputs})`}>
              <button type="button" onClick={onToggleList} aria-pressed={listOpen} className={iconBtn}>
                <PanelLeft className="size-3.5" />
              </button>
            </Hint>
            <span className="h-3.5 w-px bg-border/60 shrink-0 mx-0.5" aria-hidden />
          </>
        )}
        <span className="shrink-0 text-foreground-muted">{actions.icon}</span>
        <Hint label={actions.title}>
          <span className="min-w-0 truncate text-xs font-semibold text-foreground">{actions.title}</span>
        </Hint>
        {actions.meta && <span className="shrink-0 text-3xs text-foreground-extra-muted">{actions.meta}</span>}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {actions.controls}
        <Hint label="Switch to Live Preview">
          <button type="button" onClick={onPreview} className={iconBtn}>
            <Globe className="size-3.5" />
          </button>
        </Hint>
        {onKnowledge && (
          <Hint label="Switch to Knowledge Base">
            <button type="button" onClick={onKnowledge} className={iconBtn}>
              <BookOpen className="size-3.5" />
            </button>
          </Hint>
        )}
        <Hint label={isFullscreen ? 'Exit fullscreen (Esc)' : 'Fullscreen'}>
          <button type="button" onClick={onFullscreen} className={iconBtn}>
            {isFullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
        </Hint>
        <span className="h-3.5 w-px bg-border/60 shrink-0 mx-0.5" aria-hidden />
        <Hint label="Close Studio (Esc)">
          <button type="button" onClick={onClose} aria-label="Close Studio" className={iconBtn}>
            <X className="size-3.5" />
          </button>
        </Hint>
        <span className="desktop-only h-4 w-px bg-border/60 shrink-0 ms-1 me-0.5" aria-hidden />
      </div>
    </div>
  );
}

// ── Document ──

/** A fence longer than any backtick run inside, so code containing ``` renders intact. */
function fenced(language: string | undefined, content: string) {
  const longest = Math.max(2, ...(content.match(/`+/g) || []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${language || ''}\n${content}\n${fence}`;
}

function htmlDocument(a: ArtifactItem) {
  if (a.type === 'svg') {
    return `<!doctype html><html><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#fff">${a.content}</body></html>`;
  }
  return a.content;
}

function DocumentView({
  group,
  versionId,
  onVersion,
  workingDir,
  sessionId,
  header,
}: {
  group: ArtifactGroup;
  versionId?: string;
  onVersion: (versionId: string) => void;
  workingDir?: string;
  sessionId: string | null;
  header: (actions: HeaderActions) => React.ReactNode;
}) {
  const found = versionId ? group.versions.findIndex((v) => v.id === versionId) : -1;
  // An unknown or absent version id means "latest".
  const index = found >= 0 ? found : group.versions.length - 1;
  const current = group.versions[index];
  const previous = index > 0 ? group.versions[index - 1] : null;
  const isRendered = current.type === 'html' || current.type === 'svg';

  const [compare, setCompare] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [revising, setRevising] = useState(false);
  const [selectedText, setSelectedText] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);

  const diff = useMemo(
    () =>
      compare && previous
        ? lineDiff(previous.content, current.content, [`v${index}`, `v${index + 1}`])
        : null,
    [compare, previous, current, index]
  );

  // Text selected inside the document becomes the part a revision is about.
  const captureSelection = () => {
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? '';
    if (text && bodyRef.current && sel?.anchorNode && bodyRef.current.contains(sel.anchorNode)) {
      setSelectedText(text);
    } else if (!revising) {
      setSelectedText('');
    }
  };

  const iconBtn = (active = false) =>
    cn(
      'h-7 shrink-0 rounded-lg px-1.5 flex items-center justify-center gap-1 text-2xs transition-colors',
      active ? 'bg-surface3 text-foreground' : 'text-foreground-muted hover:bg-surface2 hover:text-foreground'
    );

  const controls = (
    <>
      {group.versions.length > 1 && (
        <Select value={current.id} onValueChange={onVersion}>
          <SelectTrigger size="sm" className="h-7 w-auto gap-1 px-2 text-2xs" aria-label="Version">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {group.versions.map((v, i) => (
              <SelectItem key={v.id} value={v.id}>
                v{i + 1}
                {i === group.versions.length - 1 ? ' (latest)' : ''} · @{v.authorAgent}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {previous && (
        <Hint label={compare ? 'Show this version' : `Compare with v${index}`}>
          <button type="button" onClick={() => setCompare((c) => !c)} aria-pressed={compare} className={iconBtn(compare)}>
            <GitCompare className="size-3.5" />
          </button>
        </Hint>
      )}
      {isRendered && (
        <Hint label={showSource ? 'Show rendered' : 'Show source'}>
          <button type="button" onClick={() => setShowSource((s) => !s)} aria-pressed={showSource} className={iconBtn(showSource)}>
            {showSource ? <Eye className="size-3.5" /> : <FileCode className="size-3.5" />}
          </button>
        </Hint>
      )}
      {sessionId && !isDraftSessionId(sessionId) && (
        <Hint label={selectedText ? 'Ask an agent to revise the selected part' : 'Ask an agent to revise this document'}>
          <button type="button" onClick={() => setRevising(true)} className={iconBtn(revising)}>
            <Wand2 className="size-3.5" />
          </button>
        </Hint>
      )}
      <Hint label="Copy content">
        <button type="button" onClick={() => void copyWithToast(current.content, 'Copied')} className={iconBtn()}>
          <Copy className="size-3.5" />
        </button>
      </Hint>
      <Hint label={`Download ${downloadName(current)}`}>
        <button
          type="button"
          onClick={() => {
            downloadBlob(current.content, downloadName(current), mimeType(current));
            toast.success(`Downloaded ${downloadName(current)}`);
          }}
          className={iconBtn()}
        >
          <Download className="size-3.5" />
        </button>
      </Hint>
    </>
  );

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {header({
        title: current.title,
        icon: current.type === 'code' ? <Code2 className="size-3.5" /> : <FileText className="size-3.5" />,
        meta: current.authorAgent ? `@${current.authorAgent}` : undefined,
        controls,
      })}

      <div
        ref={bodyRef}
        onMouseUp={captureSelection}
        onKeyUp={captureSelection}
        className={cn('flex-1 min-h-0 overflow-y-auto', isRendered && !showSource && !compare ? 'p-0' : 'p-5 lg:p-7')}
      >
        {compare && previous ? (
          diff ? (
            <DiffBlock code={diff} embedded />
          ) : (
            <p className="text-xs text-muted-foreground">These versions are too large to compare here.</p>
          )
        ) : isRendered && !showSource ? (
          <iframe
            title={current.title}
            srcDoc={htmlDocument(current)}
            // Scripts may run (it is a page) but in an opaque origin: no access
            // to the app, its storage, or its cookies.
            sandbox="allow-scripts allow-forms allow-popups"
            className="h-full w-full border-0 bg-white"
          />
        ) : current.type === 'code' || isRendered ? (
          <MarkdownContent content={fenced(current.language, current.content)} workingDir={workingDir} />
        ) : (
          <div className="prose prose-sm dark:prose-invert max-w-none leading-relaxed">
            <MarkdownContent content={current.content} workingDir={workingDir} />
          </div>
        )}
      </div>

      {revising && sessionId && (
        <ReviseBar
          artifact={current}
          sessionId={sessionId}
          selection={selectedText}
          onClearSelection={() => setSelectedText('')}
          onClose={() => setRevising(false)}
        />
      )}
    </div>
  );
}

// ── Revise ──

function ReviseBar({
  artifact,
  sessionId,
  selection,
  onClearSelection,
  onClose,
}: {
  artifact: ArtifactItem;
  sessionId: string;
  selection: string;
  onClearSelection: () => void;
  onClose: () => void;
}) {
  const { agents, currentUser } = useWorkspace();
  const names = agents.map((a) => a.agentName);
  const online = agents.filter((a) => a.status === 'online').map((a) => a.agentName);
  const [agent, setAgent] = useState(() =>
    artifact.authorAgent && names.includes(artifact.authorAgent)
      ? artifact.authorAgent
      : online[0] || names[0] || ''
  );
  const [instruction, setInstruction] = useState('');
  const [sending, setSending] = useState(false);

  const send = async () => {
    if (!agent || !instruction.trim() || sending) return;
    setSending(true);
    try {
      await workspaceApi.sendMessage(
        sessionId,
        revisionRequest(artifact, agent, instruction, selection || undefined),
        currentUser.name,
        [agent],
        undefined,
        currentUser.id,
        `revise-${Date.now()}`
      );
      toast.success(`Sent to @${agent}. The new version will appear here when it replies.`);
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send the revision request');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="shrink-0 border-t border-border bg-surface1 p-3 space-y-2">
      {selection && (
        <div className="flex items-start gap-2 rounded-md bg-surface2 px-2.5 py-1.5 text-2xs text-foreground-muted">
          <span className="line-clamp-2 flex-1 border-l-2 border-border pl-2">{selection}</span>
          <button type="button" onClick={onClearSelection} aria-label="Revise the whole document instead" className="shrink-0 hover:text-foreground">
            <X className="size-3" />
          </button>
        </div>
      )}
      <div className="flex items-end gap-2">
        <Select value={agent} onValueChange={setAgent}>
          <SelectTrigger size="sm" className="w-auto min-w-28 text-2xs" aria-label="Agent">
            <SelectValue placeholder="Agent" />
          </SelectTrigger>
          <SelectContent>
            {names.map((n) => (
              <SelectItem key={n} value={n}>
                @{n}
                {online.includes(n) ? '' : ' (offline)'}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <textarea
          autoFocus
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
          rows={1}
          placeholder={selection ? 'What should change in the selected part?' : 'What should change?'}
          className="min-h-8 flex-1 resize-none rounded-lg border border-border bg-surface2 px-2.5 py-1.5 text-xs text-foreground focus:border-primary/50 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={!agent || !instruction.trim() || sending}
          className="flex h-8 shrink-0 items-center gap-1 rounded-lg bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-40"
        >
          {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
          <span>Send</span>
        </button>
        <button type="button" onClick={onClose} aria-label="Cancel" className="flex size-8 shrink-0 items-center justify-center rounded-lg text-foreground-muted hover:bg-surface2">
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

// ── Changed file ──

function ChangeView({ change, channelId, header }: { change: ChangedFile; channelId: string; header: React.ReactNode }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setError(null);
    workspaceApi
      .getGitDiff(channelId, change.path, change.turnId)
      .then((res) => {
        if (!cancelled) setDiff(res.diff || '');
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load the diff');
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, change.path, change.turnId]);

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {header}
      <div className="flex-1 min-h-0 overflow-y-auto p-5">
        {error ? (
          <p className="text-xs text-status-danger">{error}</p>
        ) : diff === null ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Loading diff…
          </p>
        ) : diff.trim() ? (
          <DiffBlock code={diff} embedded />
        ) : (
          <p className="text-xs text-muted-foreground">No textual changes against the turn&apos;s baseline.</p>
        )}
      </div>
    </div>
  );
}
