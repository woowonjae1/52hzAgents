'use client';

import { Hint } from '@/components/ui/hint';
import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import {
  X,
  FileText,
  Code2,
  MessageSquare,
  Copy,
  Check,
  Download,
  Maximize2,
  Minimize2,
  Sparkles,
  Send,
  Globe,
  Activity,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { MarkdownContent } from '../chat/markdown-content';
import { AgentAvatar } from '../agents/agent-avatar';
import { useArtifacts, type ArtifactItem, type ArtifactAnnotation } from '@/lib/artifacts-context';
import { useWorkspace } from '@/lib/workspace-context';
import { useLayout } from '@/components/layout/layout-context';

const MIN_CANVAS_WIDTH = 380;
const DEFAULT_CANVAS_WIDTH = 580;

export function ArtifactsCanvas({ className, embedded }: { className?: string; embedded?: boolean }) {
  const { activeArtifact, isCanvasOpen, closeCanvas, addAnnotation, updateArtifactContent } = useArtifacts();
  const { setActiveRightTab } = useLayout();
  const { currentSessionId, sessions } = useWorkspace();
  const currentSession = sessions.find((s) => (s as { sessionId?: string; id?: string }).sessionId === currentSessionId || (s as { sessionId?: string; id?: string }).id === currentSessionId);
  const workingDir = currentSession?.workingDir ?? undefined;
  const [activeTab, setActiveTab] = useState<'document' | 'raw' | 'annotations' | 'diff'>('document');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [newComment, setNewComment] = useState('');
  const [selectedAgent, setSelectedAgent] = useState('claude');

  // ── Drag to Resize State ──
  const [canvasWidth, setCanvasWidth] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('artifacts_canvas_width');
        if (saved) return Math.max(MIN_CANVAS_WIDTH, parseInt(saved, 10));
      } catch {}
    }
    return DEFAULT_CANVAS_WIDTH;
  });
  const [isResizing, setIsResizing] = useState(false);
  const widthRef = useRef(canvasWidth);
  widthRef.current = canvasWidth;

  const annotations = useMemo(() => activeArtifact?.annotations || [], [activeArtifact]);

  // Handle ESC key to close Canvas
  useEffect(() => {
    if (!isCanvasOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const tag = (document.activeElement?.tagName || '').toLowerCase();
        if (tag !== 'textarea' && tag !== 'input') {
          closeCanvas();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isCanvasOpen, closeCanvas]);

  // Drag border resize logic
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  useEffect(() => {
    if (!isResizing) return;

    const onMove = (e: MouseEvent) => {
      const maxAllowed = typeof window !== 'undefined' ? Math.max(400, window.innerWidth - 380) : 1000;
      const newWidth = Math.min(maxAllowed, Math.max(MIN_CANVAS_WIDTH, window.innerWidth - e.clientX));
      setCanvasWidth(newWidth);
    };

    const onUp = () => {
      setIsResizing(false);
      try {
        localStorage.setItem('artifacts_canvas_width', widthRef.current.toString());
      } catch {}
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);

    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
    };
  }, [isResizing]);

  if (!isCanvasOpen || !activeArtifact) {
    return null;
  }

  const handleCopy = () => {
    if (!activeArtifact.content) return;
    navigator.clipboard.writeText(activeArtifact.content);
    setCopied(true);
    toast.success('Content copied to clipboard');
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    if (!activeArtifact.content) return;
    const blob = new Blob([activeArtifact.content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(activeArtifact.title || 'artifact').toLowerCase().replace(/\s+/g, '-')}.md`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Artifact downloaded');
  };

  const handleAddAnnotation = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim() || !activeArtifact) return;

    addAnnotation(activeArtifact.id, {
      authorAgent: selectedAgent,
      title: `${selectedAgent.toUpperCase()} Review Note`,
      type: 'review',
      content: newComment.trim(),
    });

    setNewComment('');
    toast.success('Review note added to canvas');
  };

  return (
    <div
      style={isFullscreen ? { width: '100vw' } : embedded ? undefined : { width: `${canvasWidth}px` }}
      className={cn(
        'relative flex flex-col bg-surface1 h-full select-text transition-all duration-75 z-20',
        !embedded && 'border-l border-border shrink-0',
        embedded && 'w-full flex-1 min-w-0 min-h-0',
        isFullscreen && 'fixed top-[var(--titlebar-height)] inset-x-0 bottom-0 w-screen z-50 bg-surface1',
        isResizing && !embedded && 'select-none transition-none',
        className
      )}
    >
      {/* ── Left Drag-to-Resize Handle & Quick Collapse (Only when not embedded) ── */}
      {!isFullscreen && !embedded && (
        <div
          onMouseDown={startResize}
          className="absolute -left-1.5 top-0 bottom-0 w-3 cursor-col-resize group z-30 flex items-center justify-center select-none"
          title="Drag to resize Canvas border width"
        >
          {/* Subtle Hover Glow Line */}
          <div className="w-[3px] h-full bg-transparent group-hover:bg-primary/50 group-active:bg-primary transition-colors" />
          {/* Central Grip Indicator */}
          <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 left-1/2 py-2 px-0.5 rounded-full bg-surface2/90 border border-border shadow-xs opacity-0 group-hover:opacity-100 transition-opacity flex flex-col gap-0.5">
            <div className="size-1 rounded-full bg-foreground-extra-muted" />
            <div className="size-1 rounded-full bg-foreground-extra-muted" />
            <div className="size-1 rounded-full bg-foreground-extra-muted" />
          </div>
        </div>
      )}

      {/* ── Single Unified Header Bar (38px) ── */}
      <div className="app-header justify-between px-3 flex-nowrap min-w-0 overflow-hidden shrink-0 border-b border-border bg-surface1 select-none">
        {/* Left: Artifact Icon, Title & Segmented Mode Switch */}
        <div className="flex items-center gap-2 min-w-0 flex-1 overflow-hidden">
          <div className="size-6 rounded-md bg-surface2 text-foreground-muted flex items-center justify-center shrink-0">
            {activeArtifact.type === 'code' ? <Code2 className="size-3.5" /> : <FileText className="size-3.5" />}
          </div>
          <div className="min-w-0 flex items-baseline gap-1.5 shrink truncate">
            <span className="text-xs font-semibold text-foreground truncate max-w-[120px] sm:max-w-[160px]" title={activeArtifact.title}>
              {activeArtifact.title}
            </span>
            {activeArtifact.version && (
              <span className="text-3xs font-mono text-foreground-extra-muted shrink-0">
                v{activeArtifact.version}
              </span>
            )}
          </div>

          {/* Quiet Segmented Mode Switcher */}
          <div className="flex items-center p-0.5 rounded-lg bg-surface2 text-2xs shrink-0 ml-1">
            <button
              type="button"
              onClick={() => setActiveTab('document')}
              className={cn(
                'px-2 py-0.5 rounded-md font-medium transition-colors cursor-pointer shrink-0',
                activeTab === 'document'
                  ? 'bg-surface0 text-foreground font-semibold shadow-xs'
                  : 'text-foreground-muted hover:text-foreground'
              )}
            >
              Doc
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('raw')}
              className={cn(
                'px-2 py-0.5 rounded-md font-medium transition-colors cursor-pointer shrink-0',
                activeTab === 'raw'
                  ? 'bg-surface0 text-foreground font-semibold shadow-xs'
                  : 'text-foreground-muted hover:text-foreground'
              )}
            >
              Code
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('annotations')}
              className={cn(
                'px-2 py-0.5 rounded-md font-medium transition-colors cursor-pointer flex items-center gap-1 shrink-0',
                activeTab === 'annotations'
                  ? 'bg-surface0 text-foreground font-semibold shadow-xs'
                  : 'text-foreground-muted hover:text-foreground'
              )}
            >
              <span>Reviews</span>
              {annotations.length > 0 && (
                <span className="size-3.5 rounded-full bg-surface3 text-foreground text-3xs flex items-center justify-center font-bold">
                  {annotations.length}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* Right: Quick Jumps + Actions + Close */}
        <div className="flex items-center gap-1 shrink-0 ml-1">
          {/* Quick jump to Live Preview */}
          <Hint label="Switch to Live Preview">
            <button
              type="button"
              onClick={() => setActiveRightTab('preview')}
              className="size-7 rounded-lg hover:bg-surface2 text-foreground-muted hover:text-foreground flex items-center justify-center transition-colors cursor-pointer"
            >
              <Globe className="size-3.5" />
            </button>
          </Hint>
          {/* Quick jump to Trace */}
          <Hint label="Switch to Execution Trace">
            <button
              type="button"
              onClick={() => setActiveRightTab('trace')}
              className="size-7 rounded-lg hover:bg-surface2 text-foreground-muted hover:text-foreground flex items-center justify-center transition-colors cursor-pointer"
            >
              <Activity className="size-3.5" />
            </button>
          </Hint>

          {/* Action icons */}
          <Hint label="Copy content">
            <button
              type="button"
              onClick={handleCopy}
              className="size-7 rounded-lg hover:bg-surface2 text-foreground-muted hover:text-foreground flex items-center justify-center transition-colors cursor-pointer"
            >
              {copied ? <Check className="size-3.5 text-status-success" /> : <Copy className="size-3.5" />}
            </button>
          </Hint>
          <Hint label="Download artifact">
            <button
              type="button"
              onClick={handleDownload}
              className="size-7 rounded-lg hover:bg-surface2 text-foreground-muted hover:text-foreground flex items-center justify-center transition-colors cursor-pointer"
            >
              <Download className="size-3.5" />
            </button>
          </Hint>
          <Hint label={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}>
            <button
              type="button"
              onClick={() => setIsFullscreen((prev) => !prev)}
              className="size-7 rounded-lg hover:bg-surface2 text-foreground-muted hover:text-foreground flex items-center justify-center transition-colors cursor-pointer"
            >
              {isFullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
            </button>
          </Hint>

          {/* Symmetrical Close Button */}
          <Hint label="Close Studio (Esc)">
            <button
              type="button"
              onClick={() => {
                closeCanvas();
                setActiveRightTab(null);
              }}
              className="size-7 rounded-lg hover:bg-surface2 text-foreground-muted hover:text-foreground flex items-center justify-center transition-colors cursor-pointer"
            >
              <X className="size-3.5" />
            </button>
          </Hint>
        </div>
      </div>

      {/* ── Canvas Main Content Area ── */}
      <div className="flex-1 min-h-0 overflow-y-auto p-5 lg:p-7">
        {activeTab === 'document' && (
          <div className="prose prose-sm dark:prose-invert max-w-none leading-relaxed select-text space-y-4">
            <MarkdownContent content={activeArtifact.content} workingDir={workingDir} />
          </div>
        )}

        {activeTab === 'raw' && (
          <div className="font-mono text-2xs leading-relaxed bg-surface2/60 p-4 rounded-xl border border-border overflow-x-auto whitespace-pre select-all text-foreground">
            {activeArtifact.content}
          </div>
        )}

        {activeTab === 'annotations' && (
          <div className="space-y-4">
            <div className="p-3 rounded-xl bg-primary/5 border border-primary/15 flex items-start gap-2.5 text-xs text-muted-foreground">
              <Sparkles className="size-4 text-primary shrink-0 mt-0.5" />
              <div className="leading-snug">
                <p className="font-semibold text-foreground">Multi-Agent Collaborative Review Layer</p>
                <p className="text-2xs mt-0.5">Reviews, critiques, and feedback from collaborating agents or humans attach here, preserving clear revision history.</p>
              </div>
            </div>

            {annotations.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-xs">
                No review notes yet. Add annotations or suggestions below.
              </div>
            ) : (
              <div className="space-y-3">
                {annotations.map((ann) => (
                  <div
                    key={ann.id}
                    className="p-3.5 rounded-xl bg-surface2/80 border border-border space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <AgentAvatar name={ann.authorAgent} size={16} />
                        <span className="text-xs font-semibold text-foreground">@{ann.authorAgent}</span>
                        <span className="text-3xs font-mono px-1.5 py-0.2 rounded bg-surface3 text-muted-foreground">
                          {ann.type}
                        </span>
                      </div>
                      <span className="text-3xs text-muted-foreground font-mono">
                        {new Date(ann.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>

                    <div className="text-xs leading-relaxed text-foreground/90">
                      {ann.content}
                    </div>

                    {ann.suggestedText && (
                      <div className="mt-2 p-2.5 rounded-lg bg-surface1 border border-border/60 font-mono text-2xs text-foreground-muted whitespace-pre-wrap">
                        {ann.suggestedText}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Input to add manual or agent review note */}
            <form onSubmit={handleAddAnnotation} className="pt-2 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-2xs text-muted-foreground">Reviewer:</span>
                <select
                  value={selectedAgent}
                  onChange={(e) => setSelectedAgent(e.target.value)}
                  className="px-2 py-1 rounded bg-surface2 border border-border text-2xs text-foreground cursor-pointer"
                >
                  <option value="claude">@claude (Reviewer)</option>
                  <option value="antigravity">@antigravity (Architect)</option>
                  <option value="human">@human (You)</option>
                </select>
              </div>

              <div className="flex gap-2">
                <textarea
                  value={newComment}
                  onChange={(e) => setNewComment(e.target.value)}
                  placeholder="Add a review note, suggestion, or critique for this artifact..."
                  rows={2}
                  className="flex-1 p-2.5 rounded-xl bg-surface2 border border-border text-xs text-foreground resize-none focus:border-primary/50"
                />
                <button
                  type="submit"
                  disabled={!newComment.trim()}
                  className="px-3 py-2 rounded-xl bg-primary text-primary-foreground text-xs font-medium hover:opacity-90 disabled:opacity-40 transition-opacity self-end cursor-pointer shrink-0 flex items-center gap-1"
                >
                  <Send className="size-3.5" />
                  <span>Submit</span>
                </button>
              </div>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
