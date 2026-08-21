'use client';

import * as React from 'react';
import {
  ArrowUp,
  Paperclip,
  X,
  FileIcon,
  CalendarClock,
  Square,
  Sparkles,
  BookOpen,
  AtSign,
  Crown,
  Waypoints,
  ChevronDown,
  FileEdit,
} from 'lucide-react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';
import type { WorkspaceAgent, KnowledgeEntry, WorkspaceSession } from '@/lib/types';
import { DEFAULT_AGENT_CATALOG, catalogAsOfflineAgents } from '@/lib/agent-catalog';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { AgentModelSwitcher } from '@/components/chat/agent-model-switcher';
import { WorkflowPlanDialog } from '@/components/chat/orchestration-control';

export type OrchestrationMode = 'dynamic' | 'master' | 'workflow';

export interface PendingFile {
  file: File;
  preview?: string; // data URL for images
}

export interface PromptComposerProps {
  onSend: (content: string, mentions: string[], files: PendingFile[]) => void;
  disabled?: boolean;
  className?: string;
  agents?: WorkspaceAgent[];
  knowledge?: KnowledgeEntry[];
  session?: WorkspaceSession;
  onOrchestrationChange?: (updates: { mode?: OrchestrationMode; instruction?: string | null }) => void;
  onMasterChange?: (agentName: string) => void;
  draft?: string;
  onDraftChange?: (draft: string) => void;
  onFocusChange?: (focused: boolean) => void;
  focusKey?: number;
  onCreateRoutine?: () => void;
  workingDir?: string;
  isWorking?: boolean;
  stopping?: boolean;
  onStop?: () => void;
}

function isImageFile(file: File): boolean {
  return file.type.startsWith('image/');
}

/** 底部控制条上的紧凑胶囊按钮样式 */
const pillButton = cn(
  'inline-flex items-center gap-1.5 h-7 px-2 rounded-lg cursor-pointer',
  'text-foreground-extra-muted hover:text-foreground hover:bg-surface2',
  'transition-colors duration-200',
  'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/30'
);

export function PromptComposer({
  onSend,
  disabled,
  className,
  agents = [],
  knowledge = [],
  session,
  onOrchestrationChange,
  onMasterChange,
  draft,
  onDraftChange,
  onFocusChange,
  focusKey,
  onCreateRoutine,
  workingDir,
  isWorking = false,
  stopping = false,
  onStop,
}: PromptComposerProps) {
  const [message, setMessage] = React.useState(draft ?? '');
  const [showMentions, setShowMentions] = React.useState(false);
  const [mentionFilter, setMentionFilter] = React.useState('');
  const [mentionIndex, setMentionIndex] = React.useState(0);
  const [pendingFiles, setPendingFiles] = React.useState<PendingFile[]>([]);
  const [isDragging, setIsDragging] = React.useState(false);
  const [isFocused, setIsFocused] = React.useState(false);

  // Real Multi-Agent Orchestration & Workflow State
  const currentMode: OrchestrationMode = (session?.orchestrationMode as OrchestrationMode) || 'dynamic';
  const onlineAgents = agents.filter((a) => a.status === 'online');
  const masterAgentName =
    session?.master ||
    (onlineAgents.length === 1 ? onlineAgents[0].agentName : null) ||
    agents.find((a) => a.role === 'master')?.agentName ||
    (onlineAgents.length > 0 ? onlineAgents[0].agentName : null) ||
    agents[0]?.agentName ||
    'claude';
  const [masterDropdownOpen, setMasterDropdownOpen] = React.useState(false);
  const [workflowPlanOpen, setWorkflowPlanOpen] = React.useState(false);

  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const dragCountRef = React.useRef(0);
  const reduceMotion = useReducedMotion();

  const resizeTextarea = React.useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const capped = Math.min(ta.scrollHeight, 220);
    ta.style.height = `${capped}px`;
    ta.style.overflowY = ta.scrollHeight > 220 ? 'auto' : 'hidden';
  }, []);

  React.useEffect(() => {
    if (draft !== undefined && draft !== message) {
      setMessage(draft);
      requestAnimationFrame(resizeTextarea);
    }
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    resizeTextarea();
  }, [message, resizeTextarea]);

  React.useEffect(() => {
    if (focusKey !== undefined && focusKey > 0) {
      textareaRef.current?.focus();
    }
  }, [focusKey]);

  const addFiles = React.useCallback((files: FileList | File[]) => {
    const newPending: PendingFile[] = [];
    Array.from(files).forEach((file) => {
      if (isImageFile(file)) {
        const reader = new FileReader();
        reader.onload = (e) => {
          setPendingFiles((prev) => [
            ...prev,
            { file, preview: e.target?.result as string },
          ]);
        };
        reader.readAsDataURL(file);
      } else {
        newPending.push({ file });
      }
    });
    if (newPending.length > 0) {
      setPendingFiles((prev) => [...prev, ...newPending]);
    }
  }, []);

  const removeFile = (index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current += 1;
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current -= 1;
    if (dragCountRef.current === 0) {
      setIsDragging(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCountRef.current = 0;
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  };

  // Mention parsing
  const mentionItems = React.useMemo(() => {
    const liveAgents: { type: 'agent'; name: string; agent: WorkspaceAgent; isOnline: boolean }[] = agents.map((a) => ({
      type: 'agent',
      name: a.agentName,
      agent: a,
      isOnline: a.status === 'online',
    }));

    const configuredNames = new Set(agents.map((a) => a.agentName.toLowerCase()));
    const unconfigured: { type: 'agent'; name: string; agent: WorkspaceAgent; isOnline: boolean }[] = catalogAsOfflineAgents(DEFAULT_AGENT_CATALOG)
      .filter((a) => !configuredNames.has(a.agentName.toLowerCase()))
      .map((a) => ({
        type: 'agent',
        name: a.agentName,
        agent: a,
        isOnline: false,
      }));

    const agentList = [...liveAgents, ...unconfigured];

    const knowledgeList: { type: 'knowledge'; name: string; knowledge: KnowledgeEntry }[] = knowledge.map((k) => ({
      type: 'knowledge',
      name: `knowledge:${k.slug || k.id}`,
      knowledge: k,
    }));

    return [...agentList, ...knowledgeList];
  }, [agents, knowledge]);

  const filteredMentions = React.useMemo(() => {
    if (!mentionFilter) return mentionItems;
    const q = mentionFilter.toLowerCase();
    return mentionItems.filter((item) => {
      if (item.type === 'agent') {
        return item.name.toLowerCase().includes(q) || item.agent.agentType?.toLowerCase().includes(q);
      }
      return (
        item.name.toLowerCase().includes(q) ||
        item.knowledge.title?.toLowerCase().includes(q) ||
        item.knowledge.slug?.toLowerCase().includes(q)
      );
    });
  }, [mentionItems, mentionFilter]);

  const mentionGroups = React.useMemo(() => {
    type AgentItem = { type: 'agent'; name: string; agent: WorkspaceAgent; isOnline: boolean };
    type KnowledgeItem = { type: 'knowledge'; name: string; knowledge: KnowledgeEntry };
    const agentMatches: AgentItem[] = [];
    const knowledgeMatches: KnowledgeItem[] = [];
    for (const item of filteredMentions) {
      if (item.type === 'agent') agentMatches.push(item);
      else knowledgeMatches.push(item);
    }
    return { agents: agentMatches, knowledge: knowledgeMatches };
  }, [filteredMentions]);

  const insertMention = (item: (typeof mentionItems)[number]) => {
    const ta = textareaRef.current;
    const val = message;
    const pos = ta?.selectionStart ?? val.length;
    const textBefore = val.slice(0, pos);
    const atIdx = textBefore.lastIndexOf('@');

    const mentionText = `@${item.name} `;
    const updated = atIdx >= 0 ? val.slice(0, atIdx) + mentionText + val.slice(pos) : mentionText + val;

    setMessage(updated);
    onDraftChange?.(updated);
    setShowMentions(false);
    setMentionFilter('');

    requestAnimationFrame(() => {
      if (ta) {
        const newPos = (atIdx >= 0 ? atIdx : 0) + mentionText.length;
        ta.setSelectionRange(newPos, newPos);
        ta.focus();
        resizeTextarea();
      }
    });
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setMessage(val);
    onDraftChange?.(val);

    const pos = e.target.selectionStart;
    const textBefore = val.slice(0, pos);
    const atIdx = textBefore.lastIndexOf('@');

    if (atIdx >= 0 && (atIdx === 0 || /\s/.test(val[atIdx - 1]))) {
      const query = textBefore.slice(atIdx + 1);
      if (!/\s/.test(query)) {
        setMentionFilter(query);
        setShowMentions(true);
        setMentionIndex(0);
        return;
      }
    }
    setShowMentions(false);
  };

  const handleSend = () => {
    const trimmed = message.trim();
    if ((!trimmed && pendingFiles.length === 0) || disabled || isWorking) return;

    const mentionMatches = trimmed.match(/@([\w:.-]+)/g) || [];
    const mentions = mentionMatches.map((m) => m.slice(1));

    onSend(trimmed, mentions, pendingFiles);

    setMessage('');
    setPendingFiles([]);
    onDraftChange?.('');
    setShowMentions(false);
    requestAnimationFrame(() => {
      resizeTextarea();
      textareaRef.current?.focus();
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMentions && filteredMentions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((prev) => (prev + 1) % filteredMentions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((prev) => (prev - 1 + filteredMentions.length) % filteredMentions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(filteredMentions[mentionIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowMentions(false);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const canSend = (message.trim().length > 0 || pendingFiles.length > 0) && !disabled;
  const showHint = isFocused && !message.trim() && pendingFiles.length === 0 && !isWorking;

  return (
    <div className={cn('relative w-full', className)}>
      {/* Mention Auto-complete Popup */}
      <AnimatePresence>
        {showMentions && filteredMentions.length > 0 && (
          <motion.div
            initial={reduceMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
            transition={{ duration: 0.15 }}
            className="absolute bottom-full left-0 right-0 mb-2 z-50 rounded-2xl bg-surface1/95 backdrop-blur-xl border border-border/80 shadow-xl max-h-72 overflow-y-auto p-1.5 space-y-1"
          >
            {mentionGroups.agents.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 px-2 py-1 text-3xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <AtSign className="size-3 text-primary" />
                  <span>Agents ({mentionGroups.agents.length})</span>
                </div>
                <div className="space-y-0.5">
                  {mentionGroups.agents.map((item) => {
                    const globalIdx = mentionItems.indexOf(item);
                    const isSelected = globalIdx === mentionIndex;
                    return (
                      <button
                        key={`${item.type}-${item.name}`}
                        type="button"
                        onClick={() => insertMention(item)}
                        className={cn(
                          'w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-xl text-left transition-colors cursor-pointer text-xs group',
                          isSelected
                            ? 'bg-primary text-primary-foreground font-medium shadow-xs'
                            : 'hover:bg-surface2 text-foreground'
                        )}
                      >
                        <AgentAvatar
                          name={item.name}
                          agentType={item.agent.agentType}
                          size={22}
                          status={item.agent.status}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-1">
                            <span className="truncate font-medium">@{item.name}</span>
                            <span
                              className={cn(
                                'text-3xs px-1 rounded font-mono',
                                isSelected ? 'bg-white/20 text-white' : 'bg-surface2 text-muted-foreground'
                              )}
                            >
                              {item.isOnline ? 'Online' : 'Not connected'}
                            </span>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {mentionGroups.knowledge.length > 0 && (
              <div className={cn(mentionGroups.agents.length > 0 && 'border-t border-border/50 pt-1.5')}>
                <div className="flex items-center gap-1.5 px-2 py-1 text-3xs font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                  <BookOpen className="size-3" />
                  <span>Knowledge ({mentionGroups.knowledge.length})</span>
                </div>
                <div className="space-y-0.5">
                  {mentionGroups.knowledge.map((item) => {
                    const globalIdx = mentionItems.indexOf(item);
                    const isSelected = globalIdx === mentionIndex;
                    return (
                      <button
                        key={`${item.type}-${item.name}`}
                        type="button"
                        onClick={() => insertMention(item)}
                        className={cn(
                          'w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-xl text-left transition-colors cursor-pointer text-xs group',
                          isSelected
                            ? 'bg-amber-600 text-white font-medium shadow-xs'
                            : 'hover:bg-amber-500/10 text-foreground'
                        )}
                      >
                        <BookOpen className="size-3.5 text-amber-500 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <span className="truncate font-medium">
                            {item.knowledge.title || item.knowledge.slug}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Composer Box */}
      <div
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        className={cn(
          'relative rounded-2xl overflow-hidden',
          'bg-surface1/95 dark:bg-surface1/60 backdrop-blur-xl',
          'border border-border/60 shadow-sm transition-all duration-200',
          'hover:border-border/90 focus-within:ring-2 focus-within:ring-primary/25 focus-within:border-primary/40',
          isDragging && 'border-primary/60 ring-4 ring-primary/20 bg-primary/[0.03]'
        )}
      >
        {/* Top Orchestration Strip: Channel Collaboration Modes */}
        <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-2 border-b border-border/25 text-xs select-none">
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            {/* Real Collaboration Mode Switcher */}
            <div className="flex items-center p-0.5 rounded-lg bg-surface2 text-2xs font-medium text-muted-foreground shrink-0 shadow-2xs">
              <button
                type="button"
                onClick={() => onOrchestrationChange?.({ mode: 'dynamic' })}
                className={cn(
                  'px-2 py-0.5 rounded-md transition-all cursor-pointer flex items-center gap-1',
                  currentMode === 'dynamic'
                    ? 'bg-surface1 text-foreground shadow-xs font-medium'
                    : 'hover:text-foreground'
                )}
                title="Dynamic routing — pick the best agent for each message from context"
              >
                <Sparkles className="size-3 text-primary" />
                <span>Dynamic</span>
              </button>

              <button
                type="button"
                onClick={() => onOrchestrationChange?.({ mode: 'master' })}
                className={cn(
                  'px-2 py-0.5 rounded-md transition-all cursor-pointer flex items-center gap-1',
                  currentMode === 'master'
                    ? 'bg-surface1 text-foreground shadow-xs font-medium'
                    : 'hover:text-foreground'
                )}
                title="Master / sub — one lead agent schedules and delegates subtasks"
              >
                <Crown className="size-3 text-amber-500" />
                <span>Master / Sub</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setWorkflowPlanOpen(true);
                  if (currentMode !== 'workflow') {
                    onOrchestrationChange?.({ mode: 'workflow' });
                  }
                }}
                className={cn(
                  'px-2 py-0.5 rounded-md transition-all cursor-pointer flex items-center gap-1',
                  currentMode === 'workflow'
                    ? 'bg-surface1 text-foreground shadow-xs font-medium'
                    : 'hover:text-foreground'
                )}
                title="Workflow — write an explicit execution plan"
              >
                <Waypoints className="size-3 text-violet-500" />
                <span>Workflow</span>
              </button>
            </div>

            {/* Mode-specific Controls */}
            {currentMode === 'master' && (
              <div className="flex items-center gap-1.5 min-w-0 pl-1">
                {/* Master Agent Dropdown */}
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setMasterDropdownOpen((v) => !v)}
                    className="inline-flex items-center gap-1 h-5 px-2 rounded-md bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/20 text-3xs font-medium cursor-pointer hover:bg-amber-500/20 transition-colors"
                  >
                    <Crown className="size-2.5" />
                    <span>Master: @{masterAgentName}</span>
                    <ChevronDown className="size-2.5" />
                  </button>

                  {masterDropdownOpen && (
                    <div className="absolute top-full left-0 mt-1 z-30 min-w-[140px] rounded-xl bg-surface1 border border-border/80 p-1 shadow-lg space-y-0.5">
                      {agents.map((a) => (
                        <button
                          key={a.agentName}
                          type="button"
                          onClick={() => {
                            onMasterChange?.(a.agentName);
                            setMasterDropdownOpen(false);
                          }}
                          className={cn(
                            'w-full text-left px-2 py-1 rounded-lg text-xs flex items-center gap-1.5 cursor-pointer',
                            masterAgentName === a.agentName
                              ? 'bg-primary text-primary-foreground font-semibold'
                              : 'hover:bg-surface2 text-foreground'
                          )}
                        >
                          <AgentAvatar name={a.agentName} size={16} />
                          <span>@{a.agentName}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <span className="text-3xs text-muted-foreground hidden sm:inline">
                  Sub-agents assist
                </span>
              </div>
            )}

            {currentMode === 'workflow' && (
              <div className="flex items-center gap-1 min-w-0 pl-1">
                <button
                  type="button"
                  onClick={() => setWorkflowPlanOpen(true)}
                  className="inline-flex items-center gap-1 h-5 px-2 rounded-md bg-violet-500/10 text-violet-700 dark:text-violet-300 border border-violet-500/20 text-3xs font-medium cursor-pointer hover:bg-violet-500/20 transition-colors"
                >
                  <FileEdit className="size-2.5" />
                  <span>Edit workflow plan…</span>
                </button>
              </div>
            )}

            {currentMode === 'dynamic' && (
              <span className="text-3xs text-muted-foreground/80 hidden md:inline pl-1">
                Agents are picked automatically from intent
              </span>
            )}
          </div>
        </div>

        {/* Pending Files Previews */}
        <AnimatePresence>
          {pendingFiles.length > 0 && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="px-3 pt-2.5 pb-1 flex flex-wrap gap-2"
            >
              {pendingFiles.map((pf, idx) => (
                <div
                  key={idx}
                  className="group/file relative flex items-center gap-2 p-1.5 pr-2 rounded-xl bg-surface2/70 border border-border/50 shadow-2xs"
                >
                  {pf.preview ? (
                    <img
                      src={pf.preview}
                      alt={pf.file.name}
                      className="size-7 rounded-lg object-cover border border-border/50 shrink-0"
                    />
                  ) : (
                    <span className="size-7 rounded-lg bg-surface1 border border-border/50 flex items-center justify-center shrink-0 text-muted-foreground">
                      <FileIcon className="size-3.5" />
                    </span>
                  )}
                  <span className="max-w-[120px] truncate text-2xs font-medium text-foreground">
                    {pf.file.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeFile(idx)}
                    className="size-4 rounded-full bg-foreground text-background flex items-center justify-center hover:opacity-80 cursor-pointer shadow-2xs"
                  >
                    <X className="size-2.5" />
                  </button>
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Text Area */}
        <textarea
          ref={textareaRef}
          value={message}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            setIsFocused(true);
            onFocusChange?.(true);
          }}
          onBlur={() => {
            setIsFocused(false);
            onFocusChange?.(false);
          }}
          placeholder={
            disabled
              ? 'Connect an agent first…'
              : 'Message 52hzAgents — type @ or / to call an agent or the knowledge base…'
          }
          disabled={disabled}
          rows={1}
          className="w-full resize-none bg-transparent px-4 pt-3 pb-2 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus:outline-hidden disabled:opacity-50 min-h-[46px]"
        />

        {/* Bottom Control Row */}
        <div className="flex items-center justify-between gap-2 px-2.5 pb-2 pt-1">
          <div className="flex items-center gap-1 min-w-0">
            <AgentModelSwitcher agentName={masterAgentName} sessionId={session?.sessionId} />

            <button
              type="button"
              onClick={() => {
                setShowMentions((prev) => !prev);
                textareaRef.current?.focus();
              }}
              className={cn(pillButton, showMentions && 'bg-surface3 text-foreground')}
              title="Mention an agent or knowledge doc (@)"
            >
              <AtSign className="size-3.5" />
              <span className="text-2xs font-medium hidden sm:inline">Agent / Knowledge</span>
            </button>

            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className={cn(pillButton, 'px-0 w-7 justify-center')}
              title="Attach a file or image"
            >
              <Paperclip className="size-3.5" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files && e.target.files.length > 0) {
                  addFiles(e.target.files);
                  e.target.value = '';
                }
              }}
            />

            {onCreateRoutine && (
              <button
                type="button"
                onClick={onCreateRoutine}
                className={pillButton}
                title="Create a scheduled task"
              >
                <CalendarClock className="size-3.5" />
                <span className="text-2xs font-medium hidden md:inline">Schedule</span>
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <AnimatePresence initial={false}>
              {showHint && (
                <motion.span
                  initial={{ opacity: 0, x: 4 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: 4 }}
                  className="hidden sm:inline select-none text-3xs font-mono text-muted-foreground/70"
                >
                  Enter to send · Shift+Enter for a new line
                </motion.span>
              )}
            </AnimatePresence>

            <button
              type="button"
              onClick={isWorking ? onStop : handleSend}
              disabled={isWorking ? stopping : !canSend}
              className={cn(
                'relative flex items-center justify-center size-8 rounded-full shrink-0',
                'shadow-sm transition-all duration-200 cursor-pointer',
                isWorking
                  ? 'bg-status-danger text-white hover:opacity-90'
                  : canSend
                  ? 'bg-primary text-primary-foreground hover:opacity-90 hover:scale-105 active:scale-95'
                  : 'bg-surface3 text-muted-foreground opacity-40 cursor-not-allowed'
              )}
            >
              <AnimatePresence mode="wait" initial={false}>
                {isWorking ? (
                  <Square className="size-3 fill-current" />
                ) : (
                  <ArrowUp className="size-4" />
                )}
              </AnimatePresence>
            </button>
          </div>
        </div>
      </div>

      {/* Workflow Plan Dialog */}
      {session && (
        <WorkflowPlanDialog
          open={workflowPlanOpen}
          onOpenChange={setWorkflowPlanOpen}
          agents={agents}
          initialValue={session.orchestrationInstruction || ''}
          onSave={(instruction) =>
            onOrchestrationChange?.({ mode: 'workflow', instruction: instruction || null })
          }
        />
      )}
    </div>
  );
}
