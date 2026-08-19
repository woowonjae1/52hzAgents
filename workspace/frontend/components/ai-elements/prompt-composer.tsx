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
} from 'lucide-react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { cn } from '@/lib/utils';
import type { WorkspaceAgent, KnowledgeEntry } from '@/lib/types';
import { DEFAULT_AGENT_CATALOG, catalogAsOfflineAgents } from '@/lib/agent-catalog';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { AgentModelSwitcher } from '@/components/chat/agent-model-switcher';

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

function basename(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
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

  const agentNames = React.useMemo(() => {
    const fromProps = agents.map((a) => a.agentName);
    const fromCatalog = DEFAULT_AGENT_CATALOG.map((c) => c.name);
    return Array.from(new Set([...fromProps, ...fromCatalog]));
  }, [agents]);

  const mergedAgents = React.useMemo(() => {
    const liveNames = new Set(agents.map((a) => a.agentName));
    const fallbackAgents = catalogAsOfflineAgents(DEFAULT_AGENT_CATALOG).filter(
      (a) => !liveNames.has(a.agentName)
    );
    return [...agents, ...fallbackAgents];
  }, [agents]);

  const extractMentions = (text: string): string[] => {
    const matches = text.match(/[@/]([\w-]+)/g) || [];
    return matches
      .map((m) => m.slice(1))
      .filter((name) => agentNames.includes(name));
  };

  const handleSend = () => {
    if ((!message.trim() && pendingFiles.length === 0) || disabled) return;
    const mentions = extractMentions(message);
    onSend(message, mentions, pendingFiles);
    setMessage('');
    setPendingFiles([]);
    setShowMentions(false);
    onDraftChange?.('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;

    if (showMentions) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((prev) => (prev + 1) % mentionItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((prev) => (prev - 1 + mentionItems.length) % mentionItems.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        if (mentionItems[mentionIndex]) {
          insertMention(mentionItems[mentionIndex]);
        }
        return;
      }
      if (e.key === 'Escape') {
        setShowMentions(false);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setMessage(val);
    onDraftChange?.(val);

    const cursorPos = e.target.selectionStart;
    const textBeforeCursor = val.slice(0, cursorPos);
    const atIndex = textBeforeCursor.lastIndexOf('@');
    const slashIndex = textBeforeCursor.lastIndexOf('/');
    const triggerIndex = Math.max(atIndex, slashIndex);

    if (triggerIndex !== -1) {
      const charBefore = triggerIndex > 0 ? textBeforeCursor[triggerIndex - 1] : ' ';
      if (/\s/.test(charBefore) || triggerIndex === 0) {
        const query = textBeforeCursor.slice(triggerIndex + 1);
        if (!/\s/.test(query)) {
          setMentionFilter(query.toLowerCase());
          setShowMentions(true);
          setMentionIndex(0);
          return;
        }
      }
    }

    setShowMentions(false);
  };

  const mentionGroups = React.useMemo(() => {
    const filterLower = mentionFilter.toLowerCase();
    const agentList = mergedAgents
      .map((a) => ({
        type: 'agent' as const,
        name: a.agentName,
        desc: a.description || a.agentType,
        agent: a,
      }))
      .filter(
        (item) =>
          !filterLower ||
          item.name.toLowerCase().includes(filterLower) ||
          (item.desc && item.desc.toLowerCase().includes(filterLower))
      );

    const knowledgeList = (knowledge || [])
      .map((k) => ({
        type: 'knowledge' as const,
        name: `knowledge:${k.slug || k.id}`,
        desc: k.title,
        knowledge: k,
      }))
      .filter(
        (item) =>
          !filterLower ||
          item.name.toLowerCase().includes(filterLower) ||
          (item.desc && item.desc.toLowerCase().includes(filterLower))
      );

    return {
      agents: agentList,
      knowledge: knowledgeList,
      all: [...agentList, ...knowledgeList],
    };
  }, [mergedAgents, knowledge, mentionFilter]);

  const mentionItems = mentionGroups.all;

  const insertMention = (item: (typeof mentionItems)[0]) => {
    const cursorPos = textareaRef.current?.selectionStart ?? message.length;
    const textBeforeCursor = message.slice(0, cursorPos);
    const atIndex = textBeforeCursor.lastIndexOf('@');
    const slashIndex = textBeforeCursor.lastIndexOf('/');
    const triggerIndex = Math.max(atIndex, slashIndex);

    let newText = '';
    let newCursorPos = cursorPos;

    // If cursor is immediately after '@' or '/' (active trigger word)
    if (triggerIndex !== -1 && !/\s/.test(textBeforeCursor.slice(triggerIndex + 1))) {
      const triggerChar = message[triggerIndex] === '/' && item.type === 'agent' ? '/' : '@';
      const before = message.slice(0, triggerIndex);
      const after = message.slice(cursorPos);
      const inserted = `${triggerChar}${item.name} `;
      newText = `${before}${inserted}${after}`;
      newCursorPos = before.length + inserted.length;
    } else {
      // User clicked bottom button without typing '@': cleanly append/insert
      const before = message.slice(0, cursorPos);
      const after = message.slice(cursorPos);
      const prefix = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
      const inserted = `${prefix}@${item.name} `;
      newText = `${before}${inserted}${after}`;
      newCursorPos = before.length + inserted.length;
    }

    setMessage(newText);
    onDraftChange?.(newText);
    setShowMentions(false);
    setMentionFilter('');

    requestAnimationFrame(() => {
      if (textareaRef.current) {
        textareaRef.current.focus();
        textareaRef.current.setSelectionRange(newCursorPos, newCursorPos);
      }
    });
  };

  const hasPayload = message.trim().length > 0 || pendingFiles.length > 0;
  const canSend = hasPayload && !disabled;
  // 键盘提示：聚焦且内容为空时露出，避免遮挡正在输入的文本
  const showHint = isFocused && !hasPayload && !isWorking;

  return (
    <div className={cn('relative w-full', className)}>
      {/* Autocomplete Dropdown */}
      <AnimatePresence>
        {showMentions && mentionItems.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98 }}
            transition={reduceMotion ? { duration: 0 } : { duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
            className="absolute bottom-full left-0 mb-2.5 w-80 max-h-80 overflow-y-auto rounded-2xl bg-surface1/95 backdrop-blur-xl border border-border/80 shadow-2xl z-50 p-2 space-y-2"
          >
            {/* Section 1: Agents */}
            {mentionGroups.agents.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-violet-600 dark:text-violet-400">
                  <AtSign className="size-3" />
                  <span>智能体 ({mentionGroups.agents.length})</span>
                </div>
                <div className="space-y-0.5">
                  {mentionGroups.agents.map((item) => {
                    const globalIdx = mentionItems.indexOf(item);
                    const isSelected = globalIdx === mentionIndex;
                    const isOnline = item.agent.status === 'online';
                    return (
                      <button
                        key={`${item.type}-${item.name}`}
                        type="button"
                        onClick={() => insertMention(item)}
                        className={cn(
                          'w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-xl text-left transition-all duration-150 cursor-pointer text-xs group',
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
                            <span className="truncate font-medium">{item.name}</span>
                            <span
                              className={cn(
                                'text-[9.5px] px-1.5 py-0.2 rounded font-mono',
                                isSelected
                                  ? 'bg-primary-foreground/20 text-primary-foreground'
                                  : isOnline
                                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                                  : 'bg-surface3 text-foreground-extra-muted'
                              )}
                            >
                              {isOnline ? 'online' : 'offline'}
                            </span>
                          </div>
                          {item.desc && (
                            <div
                              className={cn(
                                'text-[10.5px] truncate',
                                isSelected ? 'text-primary-foreground/80' : 'text-foreground-extra-muted'
                              )}
                            >
                              {item.desc}
                            </div>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Section 2: Knowledge Bases */}
            {mentionGroups.knowledge.length > 0 && (
              <div className={cn(mentionGroups.agents.length > 0 && 'border-t border-border/50 pt-1.5')}>
                <div className="flex items-center gap-1.5 px-2 py-1 text-[10.5px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                  <BookOpen className="size-3" />
                  <span>知识库文档 ({mentionGroups.knowledge.length})</span>
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
                          'w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-xl text-left transition-all duration-150 cursor-pointer text-xs group',
                          isSelected
                            ? 'bg-emerald-600 text-white font-medium shadow-xs'
                            : 'hover:bg-emerald-500/10 text-foreground border border-transparent hover:border-emerald-500/20'
                        )}
                      >
                        <div
                          className={cn(
                            'size-6 rounded-lg flex items-center justify-center shrink-0 border transition-colors',
                            isSelected
                              ? 'bg-white/20 border-white/30 text-white'
                              : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400'
                          )}
                        >
                          <BookOpen className="size-3.5" />
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-1">
                            <span className="truncate font-medium">
                              {item.knowledge.title || item.knowledge.slug}
                            </span>
                            <span
                              className={cn(
                                'text-[9.5px] px-1.5 py-0.2 rounded font-mono',
                                isSelected
                                  ? 'bg-white/20 text-white'
                                  : 'bg-surface2 text-foreground-extra-muted'
                              )}
                            >
                              doc
                            </span>
                          </div>
                          <div
                            className={cn(
                              'text-[10px] font-mono truncate',
                              isSelected ? 'text-white/80' : 'text-emerald-600/80 dark:text-emerald-400/80'
                            )}
                          >
                            @{item.name}
                          </div>
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

      {/* Main Composer Island */}
      <div
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        className={cn(
          'relative rounded-2xl overflow-hidden',
          'bg-surface1/90 dark:bg-surface1/60 backdrop-blur-xl',
          'border border-border/70 shadow-sm transition-all duration-200',
          'hover:border-border-accent/80',
          'focus-within:ring-2 focus-within:ring-primary/30 focus-within:border-primary/40 focus-within:shadow-md',
          isDragging && 'border-primary/60 ring-4 ring-primary/20 bg-primary/[0.03]'
        )}
      >
        {/* Drag Overlay */}
        <AnimatePresence>
          {isDragging && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={reduceMotion ? { duration: 0 } : undefined}
              className="absolute inset-0 rounded-2xl bg-primary/10 backdrop-blur-xs flex items-center justify-center gap-2 text-foreground font-medium text-xs z-30 pointer-events-none"
            >
              <Sparkles className={cn('size-4', !reduceMotion && 'animate-bounce')} />
              <span>拖放文件到此处附加</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Attachment Tray — 缩略图卡片，位于输入框上方、同一座岛内 */}
        <AnimatePresence initial={false}>
          {pendingFiles.length > 0 && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="overflow-hidden"
            >
              <div className="flex flex-wrap gap-2 px-3 pt-3">
                {pendingFiles.map((pf, idx) => (
                  <motion.div
                    key={`${pf.file.name}-${idx}`}
                    initial={reduceMotion ? false : { opacity: 0, scale: 0.94 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.15, ease: [0.16, 1, 0.3, 1] }}
                    className={cn(
                      'group/file relative flex items-center gap-2 pl-1 pr-2.5 py-1 rounded-xl',
                      'bg-surface2/80 border border-border/60 shadow-2xs',
                      'transition-colors duration-200 hover:border-border-accent/80'
                    )}
                  >
                    {pf.preview ? (
                      <img
                        src={pf.preview}
                        alt={pf.file.name}
                        className="size-7 rounded-lg object-cover border border-border/50 shrink-0"
                      />
                    ) : (
                      <span className="size-7 rounded-lg bg-surface1 border border-border/50 flex items-center justify-center shrink-0 text-foreground-muted">
                        <FileIcon className="size-3.5" />
                      </span>
                    )}

                    <span className="flex flex-col min-w-0 leading-tight">
                      <span className="max-w-[140px] truncate text-[11.5px] font-medium text-foreground">
                        {pf.file.name}
                      </span>
                      <span className="text-[10px] font-mono text-foreground-extra-muted tabular-nums">
                        {pf.file.size < 1024
                          ? `${pf.file.size} B`
                          : pf.file.size < 1024 * 1024
                          ? `${(pf.file.size / 1024).toFixed(0)} KB`
                          : `${(pf.file.size / 1024 / 1024).toFixed(1)} MB`}
                      </span>
                    </span>

                    {/* Hover 删除角标 */}
                    <button
                      type="button"
                      onClick={() => removeFile(idx)}
                      aria-label={`移除 ${pf.file.name}`}
                      className={cn(
                        'absolute -top-1.5 -right-1.5 size-4 rounded-full cursor-pointer',
                        'flex items-center justify-center',
                        'bg-foreground text-background border border-border/50 shadow-sm',
                        'opacity-0 group-hover/file:opacity-100 focus-visible:opacity-100',
                        'transition-opacity duration-200'
                      )}
                    >
                      <X className="size-2.5" />
                    </button>
                  </motion.div>
                ))}
              </div>
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
          placeholder={disabled ? '请先连接在线 Agent...' : '向 52hzAgents 发送指令，输入 @ 或 / 唤起 Agent 或知识库...'}
          disabled={disabled}
          rows={1}
          className="w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[13.5px] leading-relaxed text-foreground placeholder:text-foreground-extra-muted focus:outline-hidden disabled:opacity-50 min-h-[48px]"
        />

        {/* Bottom Control Row */}
        <div className="flex items-center justify-between gap-2 px-2.5 pb-2 pt-1">
          {/* Left Controls */}
          <div className="flex items-center gap-1 min-w-0">
            {/* Model Switcher Pill */}
            <AgentModelSwitcher />

            {/* Quick Mention Trigger (@) */}
            <button
              type="button"
              onClick={() => {
                setShowMentions((prev) => !prev);
                textareaRef.current?.focus();
              }}
              className={cn(pillButton, showMentions && 'bg-surface3 text-foreground border-border-accent')}
              title="呼叫 Agent 或知识库 (@)"
            >
              <AtSign className="size-3.5" />
              <span className="text-[11px] font-medium hidden sm:inline">Agent / 知识库</span>
            </button>

            {/* Attachment Button */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className={cn(pillButton, 'px-0 w-7 justify-center')}
              title="添加文件或图片"
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

            {/* Optional Routine Trigger */}
            {onCreateRoutine && (
              <button
                type="button"
                onClick={onCreateRoutine}
                className={pillButton}
                title="创建定时任务"
              >
                <CalendarClock className="size-3.5" />
                <span className="text-[11px] font-medium hidden md:inline">定时</span>
              </button>
            )}
          </div>

          {/* Right Controls (Hint + Send / Stop) */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Keyboard hint — 仅在聚焦且为空时显示 */}
            <AnimatePresence initial={false}>
              {showHint && (
                <motion.span
                  initial={reduceMotion ? false : { opacity: 0, x: 4 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 4 }}
                  transition={{ duration: 0.15 }}
                  className="hidden sm:inline select-none text-[10px] font-mono text-foreground-extra-muted"
                >
                  ↵ 发送 · ⇧↵ 换行
                </motion.span>
              )}
            </AnimatePresence>

            {/* Send ⇄ Stop —— 同一颗圆形按钮内形变 */}
            <button
              type="button"
              onClick={isWorking ? onStop : handleSend}
              disabled={isWorking ? stopping : !canSend}
              aria-label={isWorking ? '停止当前任务' : '发送消息'}
              title={isWorking ? '停止当前任务' : '发送消息 (Enter)'}
              className={cn(
                'relative flex items-center justify-center size-8 rounded-full shrink-0',
                'shadow-sm transition-all duration-200 cursor-pointer',
                'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/30',
                isWorking
                  ? cn(
                      'bg-status-danger text-white hover:opacity-90',
                      stopping && 'opacity-50 cursor-not-allowed'
                    )
                  : canSend
                  ? 'bg-primary text-primary-foreground hover:opacity-90 hover:scale-105 active:scale-95'
                  : 'bg-surface3 text-foreground-extra-muted opacity-40 cursor-not-allowed'
              )}
            >
              {/* 运行中的呼吸光环 */}
              {isWorking && !reduceMotion && (
                <motion.span
                  aria-hidden
                  className="absolute inset-0 rounded-full bg-status-danger/40"
                  animate={{ scale: [1, 1.35], opacity: [0.5, 0] }}
                  transition={{ duration: 1.6, repeat: Infinity, ease: 'easeOut' }}
                />
              )}
              <AnimatePresence mode="wait" initial={false}>
                {isWorking ? (
                  <motion.span
                    key="stop"
                    initial={reduceMotion ? false : { opacity: 0, scale: 0.6, rotate: -90 }}
                    animate={{ opacity: 1, scale: 1, rotate: 0 }}
                    exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6, rotate: 90 }}
                    transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                    className="relative flex items-center justify-center"
                  >
                    <Square className="size-3 fill-current" />
                  </motion.span>
                ) : (
                  <motion.span
                    key="send"
                    initial={reduceMotion ? false : { opacity: 0, scale: 0.6, rotate: 90 }}
                    animate={{ opacity: 1, scale: 1, rotate: 0 }}
                    exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.6, rotate: -90 }}
                    transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
                    className="relative flex items-center justify-center"
                  >
                    <ArrowUp className="size-4" />
                  </motion.span>
                )}
              </AnimatePresence>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
