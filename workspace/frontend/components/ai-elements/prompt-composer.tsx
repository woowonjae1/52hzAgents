'use client';

import * as React from 'react';
import {
  ArrowUp,
  Paperclip,
  X,
  FileIcon,
  ImageIcon,
  Plus,
  CalendarClock,
  FolderOpen,
  Square,
  Sparkles,
  BookOpen,
  AtSign,
  Command,
  Loader2,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '@/lib/utils';
import type { WorkspaceAgent, KnowledgeEntry } from '@/lib/types';
import { DEFAULT_AGENT_CATALOG, catalogAsOfflineAgents } from '@/lib/agent-catalog';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { AgentModelSwitcher } from '@/components/chat/agent-model-switcher';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';

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

  const mentionItems = React.useMemo(() => {
    const agentList = mergedAgents.map((a) => ({
      type: 'agent' as const,
      name: a.agentName,
      desc: a.description || a.agentType,
      agent: a,
    }));
    const knowledgeList = (knowledge || []).map((k) => ({
      type: 'knowledge' as const,
      name: `knowledge:${k.slug || k.id}`,
      desc: k.title,
      knowledge: k,
    }));
    const all = [...agentList, ...knowledgeList];
    if (!mentionFilter) return all;
    return all.filter(
      (item) =>
        item.name.toLowerCase().includes(mentionFilter) ||
        (item.desc && item.desc.toLowerCase().includes(mentionFilter))
    );
  }, [mergedAgents, knowledge, mentionFilter]);

  const insertMention = (item: (typeof mentionItems)[0]) => {
    const cursorPos = textareaRef.current?.selectionStart || message.length;
    const textBeforeCursor = message.slice(0, cursorPos);
    const atIndex = textBeforeCursor.lastIndexOf('@');
    const slashIndex = textBeforeCursor.lastIndexOf('/');
    const triggerIndex = Math.max(atIndex, slashIndex);

    if (triggerIndex !== -1) {
      const triggerChar = message[triggerIndex] === '/' ? '/' : '@';
      const before = message.slice(0, triggerIndex);
      const after = message.slice(cursorPos);
      const newText = `${before}${triggerChar}${item.name} ${after}`;
      setMessage(newText);
      onDraftChange?.(newText);
    }
    setShowMentions(false);
    setTimeout(() => {
      textareaRef.current?.focus();
    }, 0);
  };

  const canSend = (message.trim().length > 0 || pendingFiles.length > 0) && !disabled;

  return (
    <div className={cn('relative w-full', className)}>
      {/* Autocomplete Dropdown */}
      <AnimatePresence>
        {showMentions && mentionItems.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className="absolute bottom-full left-0 mb-2.5 w-72 max-h-64 overflow-y-auto rounded-2xl bg-surface1/95 backdrop-blur-xl border border-border/80 shadow-xl z-50 p-1.5 space-y-0.5"
          >
            <div className="px-2 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              {mentionFilter ? '匹配的 Agent 与知识库' : '选择呼叫的 Agent 或知识库'}
            </div>
            {mentionItems.map((item, idx) => {
              const isSelected = idx === mentionIndex;
              return (
                <button
                  key={`${item.type}-${item.name}`}
                  type="button"
                  onClick={() => insertMention(item)}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-xl text-left transition-colors cursor-pointer text-xs',
                    isSelected
                      ? 'bg-primary text-primary-foreground font-medium'
                      : 'hover:bg-surface2 text-foreground'
                  )}
                >
                  {item.type === 'agent' ? (
                    <AgentAvatar
                      name={item.name}
                      agentType={item.agent.agentType}
                      size={20}
                      status={item.agent.status}
                    />
                  ) : (
                    <div
                      className={cn(
                        'size-5 rounded-lg flex items-center justify-center shrink-0',
                        isSelected ? 'bg-primary-foreground/20' : 'bg-primary/10 text-primary'
                      )}
                    >
                      <BookOpen className="size-3" />
                    </div>
                  )}

                  <div className="flex-1 min-w-0">
                    <div className="truncate font-medium">{item.name}</div>
                    {item.desc && (
                      <div
                        className={cn(
                          'text-[10px] truncate',
                          isSelected ? 'text-primary-foreground/80' : 'text-muted-foreground'
                        )}
                      >
                        {item.desc}
                      </div>
                    )}
                  </div>
                </button>
              );
            })}
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
          'relative rounded-2xl bg-surface1/90 dark:bg-surface1/60 backdrop-blur-xl',
          'border border-border/80 shadow-xs transition-all duration-200',
          isFocused ? 'border-primary/50 ring-2 ring-primary/15 shadow-md' : 'hover:border-border-accent/80',
          isDragging && 'border-primary ring-4 ring-primary/20 bg-primary/[0.03]'
        )}
      >
        {/* Drag Overlay */}
        <AnimatePresence>
          {isDragging && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 rounded-2xl bg-primary/10 backdrop-blur-xs flex items-center justify-center gap-2 text-primary font-medium text-xs z-30 pointer-events-none"
            >
              <Sparkles className="size-4 animate-bounce" />
              <span>拖放文件到此处附加</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Pending Files Tray */}
        {pendingFiles.length > 0 && (
          <div className="flex flex-wrap gap-2 p-3 pb-0">
            {pendingFiles.map((pf, idx) => (
              <div
                key={idx}
                className="group relative flex items-center gap-2 pl-2 pr-1.5 py-1 rounded-xl bg-surface2/90 border border-border/70 text-xs text-foreground shadow-2xs animate-in fade-in zoom-in-95 duration-150"
              >
                {pf.preview ? (
                  <img
                    src={pf.preview}
                    alt={pf.file.name}
                    className="size-5 rounded-md object-cover border border-border/50 shrink-0"
                  />
                ) : (
                  <FileIcon className="size-4 text-primary shrink-0" />
                )}
                <span className="max-w-[130px] truncate font-medium text-[11.5px]">{pf.file.name}</span>
                <button
                  type="button"
                  onClick={() => removeFile(idx)}
                  className="size-4 rounded-full hover:bg-surface3 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                >
                  <X className="size-3" />
                </button>
              </div>
            ))}
          </div>
        )}

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
          className="w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[13.5px] leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus:outline-hidden disabled:opacity-50 min-h-[48px]"
        />

        {/* Bottom Actions Bar */}
        <div className="flex items-center justify-between px-3 pb-2.5 pt-1 border-t border-border/40">
          {/* Left Controls */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {/* Model Switcher Pill */}
            <AgentModelSwitcher />

            {/* Quick Mention Trigger (@) */}
            <button
              type="button"
              onClick={() => {
                setMessage((prev) => prev + '@');
                textareaRef.current?.focus();
                setShowMentions(true);
              }}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-surface2 transition-colors text-xs cursor-pointer"
              title="呼叫 Agent 或知识库 (@)"
            >
              <AtSign className="size-3.5" />
              <span className="text-[11px] font-medium hidden sm:inline">Agent / 知识库</span>
            </button>

            {/* Attachment Button */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center justify-center size-7 rounded-lg text-muted-foreground hover:text-foreground hover:bg-surface2 transition-colors cursor-pointer"
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
                className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-muted-foreground hover:text-foreground hover:bg-surface2 transition-colors text-xs cursor-pointer"
                title="创建定时任务"
              >
                <CalendarClock className="size-3.5" />
                <span className="text-[11px] font-medium hidden md:inline">定时</span>
              </button>
            )}
          </div>

          {/* Right Controls (Send / Stop Button) */}
          <div className="flex items-center gap-2 shrink-0">
            {/* Word/Char Counter & Shortcut Hint */}
            <span className="text-[10px] text-muted-foreground/60 hidden sm:inline select-none font-mono">
              ↵ 发送
            </span>

            {/* Send or Stop Action */}
            {isWorking ? (
              <button
                type="button"
                onClick={onStop}
                disabled={stopping}
                className={cn(
                  'flex items-center justify-center size-7 rounded-xl bg-status-danger text-white shadow-xs hover:opacity-90 transition-all cursor-pointer',
                  stopping && 'opacity-50 cursor-not-allowed'
                )}
                title="停止当前任务"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSend}
                disabled={!canSend}
                className={cn(
                  'flex items-center justify-center size-7 rounded-xl transition-all shadow-xs cursor-pointer',
                  canSend
                    ? 'bg-primary text-primary-foreground hover:opacity-90 hover:scale-105 active:scale-95'
                    : 'bg-surface3 text-muted-foreground opacity-40 cursor-not-allowed'
                )}
                title="发送消息 (Enter)"
              >
                <ArrowUp className="size-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
