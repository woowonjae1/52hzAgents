'use client';

import { Hint } from '@/components/ui/hint';
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
  Waypoints,
  ChevronDown,
  ChevronRight,
  FileEdit,
  Info,
} from 'lucide-react';
import { toast } from '@/lib/toast';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { ActionSwapRollIcon } from '@/components/motion/action-swap-roll';
import { Magnetic } from '@/components/motion/magnetic';
import { cn } from '@/lib/utils';
import { isComposing } from '@/lib/ime';
import type { WorkspaceAgent, KnowledgeEntry, WorkspaceSession, WorkspaceCustomSkill } from '@/lib/types';
import { DEFAULT_AGENT_CATALOG, catalogAsOfflineAgents } from '@/lib/agent-catalog';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { AgentModelSwitcher } from '@/components/chat/agent-model-switcher';
import { composerPillClass } from './composer-pill';
import { OrchestrationControl } from '@/components/chat/orchestration-control';
import { AgentProfileControl } from '@/components/chat/agent-profile-control';
import { ContextHealthIndicator } from '@/components/chat/context-health-indicator';
import { CURATED_SKILLS, type CuratedSkill } from '@/lib/curated-skills';
import { workspaceApi } from '@/lib/api';

export type OrchestrationMode = 'dynamic' | 'master' | 'parallel';

export interface PendingFile {
  file: File;
  preview?: string; // data URL for images
}

export interface MentionSegment {
  agent: string;
  instruction: string;
}

export function extractMentionSegments(
  text: string,
  knownAgents?: (WorkspaceAgent | string)[]
): MentionSegment[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const allowedMap = new Map<string, string>();
  if (knownAgents && knownAgents.length > 0) {
    for (const a of knownAgents) {
      const name = typeof a === 'string' ? a : a.agentName;
      if (name && name.toLowerCase() !== 'knowledge') {
        allowedMap.set(name.toLowerCase(), name);
      }
    }
  }

  // Match mentions not preceded by word characters or @ (e.g. not email like bob@example.com),
  // and excluding trailing colons/periods
  const mentionRegex = /(?:^|[^\w@])@([a-zA-Z0-9_-]+)/g;
  const matches: { index: number; fullLength: number; name: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = mentionRegex.exec(trimmed)) !== null) {
    const rawName = m[1];
    if (rawName.toLowerCase() === 'knowledge') continue;
    // Calculate the index of the '@' character
    const atIndex = m.index + m[0].indexOf('@');
    // If known agents are given, only consider valid known agents
    if (allowedMap.size > 0 && !allowedMap.has(rawName.toLowerCase())) {
      continue;
    }
    const agentName = allowedMap.size > 0 ? allowedMap.get(rawName.toLowerCase())! : rawName;
    matches.push({
      index: atIndex,
      fullLength: rawName.length + 1, // '@' + name
      name: agentName,
    });
  }

  if (matches.length === 0) return [];

  const segments: MentionSegment[] = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const matchEnd = match.index + match.fullLength;
    const nextMatchStart = i + 1 < matches.length ? matches[i + 1].index : trimmed.length;

    let instruction = trimmed.slice(matchEnd, nextMatchStart).trim();
    instruction = instruction.replace(/^[:：\s]+/, '').trim();
    segments.push({
      agent: match.name,
      instruction,
    });
  }

  return segments;
}

export interface PromptComposerProps {
  onSend: (content: string, mentions: string[], files: PendingFile[], segments?: MentionSegment[]) => void;
  disabled?: boolean;
  disabledReason?: string;
  /**
   * Nobody can receive a message right now (e.g. every agent in the thread is
   * offline). Unlike `disabled`, the box stays editable -- a draft can be
   * written and files attached while waiting -- only sending is refused, and
   * Enter says why instead of doing nothing.
   */
  sendBlockedReason?: string;
  /** The caller already shows `sendBlockedReason` (a banner above), so do not repeat it here. */
  suppressSendBlockedNotice?: boolean;
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

/** See composer-pill.ts — shared with AgentModelSwitcher on the same row. */
const pillButton = composerPillClass;

export function PromptComposer({
  onSend,
  disabled,
  disabledReason,
  sendBlockedReason,
  suppressSendBlockedNotice = false,
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

  // Sync draft prop changes into local message state without requiring full ChatView re-renders
  React.useEffect(() => {
    if (draft !== undefined) {
      setMessage(draft);
      requestAnimationFrame(() => resizeTextarea());
    }
  }, [draft]);
  /*
    Which character opened the picker. `@` offers agents and knowledge docs;
    `/` offers knowledge only. One popover, two entrances -- the placeholder
    has promised both since it was written.
  */
  const [mentionTrigger, setMentionTrigger] = React.useState<'@' | '/'>('@');
  const [mentionFilter, setMentionFilter] = React.useState('');
  const [mentionIndex, setMentionIndex] = React.useState(0);
  const [pendingFiles, setPendingFiles] = React.useState<PendingFile[]>([]);
  const [isDragging, setIsDragging] = React.useState(false);
  const [isFocused, setIsFocused] = React.useState(false);

  // Real Multi-Agent Orchestration & Workflow State

  const onlineAgents = agents.filter((a) => a.status === 'online');
  const masterAgentName =
    session?.master ||
    (onlineAgents.length === 1 ? onlineAgents[0].agentName : null) ||
    agents.find((a) => a.role === 'master')?.agentName ||
    (onlineAgents.length > 0 ? onlineAgents[0].agentName : null) ||
    agents[0]?.agentName ||
    'claude';
  const [masterDropdownOpen, setMasterDropdownOpen] = React.useState(false);

  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  /*
   * SENT-MESSAGE RECALL.
   *
   * Every chat client and every shell gives you the last thing you typed back
   * with Up. This box did not, so a message sent one word short had to be
   * retyped from scratch — and the cost of that lands hardest on the long
   * multi-agent prompts this composer exists to write.
   *
   * Local to the composer on purpose: it is what THIS box sent, which is the
   * thing Up is expected to return. The history persists per channel across
   * reloads in localStorage.
   */
  const historyRef = React.useRef<string[]>([]);
  const [historyIndex, setHistoryIndex] = React.useState(-1);
  const sessionKey = session?.sessionId ?? null;
  React.useEffect(() => {
    // Clear pending files when switching threads to prevent cross-thread attachment leaks
    setPendingFiles([]);
    setHistoryIndex(-1);
    if (!sessionKey) {
      historyRef.current = [];
      return;
    }
    try {
      const stored = localStorage.getItem(`composer_history_${sessionKey}`);
      historyRef.current = stored ? JSON.parse(stored) : [];
    } catch {
      historyRef.current = [];
    }
  }, [sessionKey]);

  const [customSkills, setCustomSkills] = React.useState<WorkspaceCustomSkill[]>([]);
  React.useEffect(() => {
    let cancelled = false;
    workspaceApi.getCustomSkills()
      .then((skills) => {
        if (!cancelled && Array.isArray(skills)) setCustomSkills(skills);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [sessionKey]);

  const handleSelect = (e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    const ta = e.currentTarget;
    const pos = ta.selectionStart;
    const active = findActiveTrigger(ta.value.slice(0, pos));
    if (active) {
      setMentionTrigger(active.char);
      setMentionFilter(active.query);
      setShowMentions(true);
      setMentionIndex(0);
    } else {
      setShowMentions(false);
    }
  };

  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const mentionListRef = React.useRef<HTMLDivElement>(null);
  const dragCountRef = React.useRef(0);
  const reduceMotion = useReducedMotion();

  // Scroll active mention into view automatically
  React.useEffect(() => {
    if (!showMentions || !mentionListRef.current) return;
    const container = mentionListRef.current;
    const selectedEl = container.querySelector('[data-selected="true"]') as HTMLElement | null;
    if (selectedEl) {
      selectedEl.scrollIntoView({ block: 'nearest' });
    }
  }, [mentionIndex, showMentions]);

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

  const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
  const addFiles = React.useCallback((files: FileList | File[]) => {
    const newPending: PendingFile[] = [];
    Array.from(files).forEach((file) => {
      if (file.size > MAX_FILE_SIZE) {
        toast.error(`File "${file.name}" exceeds the 50MB size limit`);
        return;
      }
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

  /*
    Only FILE drags are ours. These handlers used to preventDefault every drag,
    which made the textarea refuse the one drop it handles natively: text
    dragged in from the transcript or another app. A text drag now falls
    through to the browser untouched. A file drag is still stopped here, so the
    window-level dropzone (shared-storage upload) never sees it as well.
  */
  const isFileDrag = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  const handleDragEnter = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current += 1;
    if (!disabled) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current = Math.max(0, dragCountRef.current - 1);
    if (dragCountRef.current === 0) {
      setIsDragging(false);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    // The cursor says up front whether the drop will be taken.
    e.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
  };

  /**
   * CTRL+V OF A SCREENSHOT.
   *
   * The box accepted files by drag and by the paperclip button, and pasting a
   * screenshot into it did nothing at all — the one gesture people actually
   * use to get an image into a chat. Snipping Tool, Cmd+Shift+4, "copy image"
   * from a browser: all of them put the bitmap on the clipboard and nothing
   * on disk, so there is no file to drag.
   *
   * Only intercept when the clipboard actually carries files. A paste that is
   * also carrying text (copying a cell out of a spreadsheet hands over both an
   * image and its text) stays a text paste, because that is what the user
   * meant; `preventDefault` is called only on the branch that consumes files,
   * so ordinary text paste keeps the native undo stack.
   */
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const data = e.clipboardData;
    if (!data) return;

    const text = data.getData('text/plain');
    if (text) return;

    const files: File[] = [];
    for (const item of Array.from(data.items)) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;
      // A pasted bitmap arrives as "image.png" on every platform, so several in
      // a row are indistinguishable in the pending-file strip. Stamp it.
      const named =
        file.name && file.name !== 'image.png'
          ? file
          : new File([file], `pasted-${Date.now()}.${(file.type.split('/')[1] || 'png')}`, {
              type: file.type,
            });
      files.push(named);
    }

    if (files.length === 0) return;
    e.preventDefault();
    addFiles(files);
  };

  const handleDrop = (e: React.DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCountRef.current = 0;
    // A disabled composer cannot send, so it must not collect attachments either.
    if (disabled) return;
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
    agentList.sort((a, b) => {
      // 1. Online agents first
      if (a.isOnline !== b.isOnline) {
        return a.isOnline ? -1 : 1;
      }
      // 2. Leader/master agent first among peers with same online status
      const aIsMaster = a.agent.role === 'master' || (!!masterAgentName && a.name.toLowerCase() === masterAgentName.toLowerCase());
      const bIsMaster = b.agent.role === 'master' || (!!masterAgentName && b.name.toLowerCase() === masterAgentName.toLowerCase());
      if (aIsMaster !== bIsMaster) {
        return aIsMaster ? -1 : 1;
      }
      // 3. Alphabetical order
      return a.name.localeCompare(b.name);
    });

    const knowledgeList: { type: 'knowledge'; name: string; knowledge: KnowledgeEntry }[] = knowledge.map((k) => ({
      type: 'knowledge',
      name: `knowledge:${k.slug || k.id}`,
      knowledge: k,
    }));

    return [...agentList, ...knowledgeList];
  }, [agents, knowledge, masterAgentName]);

  type AgentMentionItem = { type: 'agent'; name: string; agent: WorkspaceAgent; isOnline: boolean };
  type KnowledgeMentionItem = { type: 'knowledge'; name: string; knowledge: KnowledgeEntry };
  type SkillMentionItem = {
    type: 'skill';
    name: string;
    trigger: string;
    description: string;
    skill: CuratedSkill | WorkspaceCustomSkill;
    author?: string;
  };
  type MentionItem = AgentMentionItem | KnowledgeMentionItem | SkillMentionItem;

  const skillList: SkillMentionItem[] = React.useMemo(() => {
    const list: SkillMentionItem[] = CURATED_SKILLS.map((s) => ({
      type: 'skill',
      name: s.trigger.replace(/^\//, ''),
      trigger: s.trigger,
      description: s.description,
      skill: s,
      author: s.author,
    }));
    for (const c of customSkills) {
      const trig = c.trigger || `/${c.id.replace(/^[/-]+/, '')}`;
      list.push({
        type: 'skill',
        name: trig.replace(/^\//, ''),
        trigger: trig,
        description: c.description || c.name,
        skill: c,
        author: c.author || 'Custom',
      });
    }
    return list;
  }, [customSkills]);

  /*
    `/` offers skills and knowledge docs. `@` offers agents and knowledge docs.
  */
  const scopedMentionItems = React.useMemo<MentionItem[]>(
    () =>
      mentionTrigger === '/'
        ? [...skillList, ...mentionItems.filter((item): item is KnowledgeMentionItem => item.type === 'knowledge')]
        : mentionItems,
    [mentionItems, skillList, mentionTrigger],
  );

  const filteredMentions = React.useMemo(() => {
    if (!mentionFilter) return scopedMentionItems;
    const q = mentionFilter.toLowerCase();
    return scopedMentionItems.filter((item) => {
      if (item.type === 'agent') {
        return item.name.toLowerCase().includes(q) || item.agent.agentType?.toLowerCase().includes(q);
      }
      if (item.type === 'skill') {
        return (
          item.name.toLowerCase().includes(q) ||
          item.trigger.toLowerCase().includes(q) ||
          item.description.toLowerCase().includes(q) ||
          item.skill.name.toLowerCase().includes(q)
        );
      }
      return (
        item.name.toLowerCase().includes(q) ||
        item.knowledge.title?.toLowerCase().includes(q) ||
        item.knowledge.slug?.toLowerCase().includes(q)
      );
    });
  }, [scopedMentionItems, mentionFilter]);

  const mentionGroups = React.useMemo(() => {
    const agentMatches: AgentMentionItem[] = [];
    const skillMatches: SkillMentionItem[] = [];
    const knowledgeMatches: KnowledgeMentionItem[] = [];
    for (const item of filteredMentions) {
      if (item.type === 'agent') agentMatches.push(item);
      else if (item.type === 'skill') skillMatches.push(item);
      else knowledgeMatches.push(item);
    }
    return { agents: agentMatches, skills: skillMatches, knowledge: knowledgeMatches };
  }, [filteredMentions]);

  const insertMention = (item: MentionItem) => {
    const ta = textareaRef.current;
    const val = message;
    const pos = ta?.selectionStart ?? val.length;
    const textBefore = val.slice(0, pos);
    const active = findActiveTrigger(textBefore);

    if (item.type === 'skill') {
      const slashIdx = active ? active.index : textBefore.lastIndexOf('/');
      const insertText = `${item.trigger} `;
      const updated = slashIdx >= 0 ? val.slice(0, slashIdx) + insertText + val.slice(pos) : insertText + val;

      setMessage(updated);
      onDraftChange?.(updated);
      setShowMentions(false);
      setMentionFilter('');

      requestAnimationFrame(() => {
        if (ta) {
          const newPos = (slashIdx >= 0 ? slashIdx : 0) + insertText.length;
          ta.setSelectionRange(newPos, newPos);
          ta.focus();
          resizeTextarea();
        }
      });
      return;
    }

    const atIdx = active ? active.index : textBefore.lastIndexOf('@');
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
    // Editing a recalled message makes it a new draft, not a history entry.
    if (historyIndex !== -1) setHistoryIndex(-1);

    const pos = e.target.selectionStart;
    const active = findActiveTrigger(val.slice(0, pos));
    if (active) {
      setMentionTrigger(active.char);
      setMentionFilter(active.query);
      setShowMentions(true);
      setMentionIndex(0);
      return;
    }
    setShowMentions(false);
  };

  const activePipelineSegments = React.useMemo(() => {
    return extractMentionSegments(message, agents);
  }, [message, agents]);
  // In a parallel thread the backend turns a multi-@mention message into a
  // batch — every agent starts at once in its own lane — not a hand-off chain.
  // The preview must not draw numbered steps and arrows for that.
  const previewIsParallel = session?.orchestrationMode === 'parallel';

  const lastSendTimeRef = React.useRef(0);

  const handleStopClick = (e?: React.MouseEvent) => {
    e?.preventDefault();
    if (Date.now() - lastSendTimeRef.current < 800) {
      return;
    }
    onStop?.();
  };

  const handleSend = () => {
    const trimmed = message.trim();
    if ((!trimmed && pendingFiles.length === 0) || disabled) return;
    if (sendBlockedReason) {
      // The draft is kept; say why it did not go rather than swallowing Enter.
      toast.info(sendBlockedReason);
      return;
    }

    lastSendTimeRef.current = Date.now();
    const segments = extractMentionSegments(trimmed, agents);
    const mentionMatches = Array.from(trimmed.matchAll(/(?:^|[^\w@])@([a-zA-Z0-9_-]+)/g)).map((m) => m[1]);
    const filteredMatches = mentionMatches.filter((m) => m.toLowerCase() !== 'knowledge');
    const mentions = segments.length > 0 ? segments.map((s) => s.agent) : filteredMatches;

    onSend(trimmed, mentions, pendingFiles, segments.length >= 2 ? segments : undefined);

    if (trimmed) {
      const updatedHistory = [trimmed, ...historyRef.current.filter((h) => h !== trimmed)].slice(0, 50);
      historyRef.current = updatedHistory;
      if (sessionKey) {
        try {
          localStorage.setItem(`composer_history_${sessionKey}`, JSON.stringify(updatedHistory));
        } catch {}
      }
    }
    setHistoryIndex(-1);
    setMessage('');
    setPendingFiles([]);
    onDraftChange?.('');
    if (sessionKey) {
      try {
        localStorage.removeItem(`composer_draft_${sessionKey}`);
      } catch {}
    }
    setShowMentions(false);
    requestAnimationFrame(() => {
      resizeTextarea();
      textareaRef.current?.focus();
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    /*
      Nothing below this line is a command while an input method is composing.
      Enter commits the candidate the user is looking at, and ↑/↓ move between
      candidates — both were being read as "send" and "change mention", so
      picking a Chinese character sent half a line of pinyin.
    */
    if (isComposing(e)) return;

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

    // Recall — only from an empty box, or while already walking the history.
    // Anywhere else Up/Down are ordinary caret movement and must stay that way.
    if (e.key === 'ArrowUp' && (historyIndex !== -1 || message.length === 0)) {
      const next = historyIndex + 1;
      const entry = historyRef.current[next];
      if (entry !== undefined) {
        e.preventDefault();
        setHistoryIndex(next);
        setMessage(entry);
        onDraftChange?.(entry);
        requestAnimationFrame(() => {
          resizeTextarea();
          const ta = textareaRef.current;
          ta?.setSelectionRange(entry.length, entry.length);
        });
      }
      return;
    }
    if (e.key === 'ArrowDown' && historyIndex !== -1) {
      e.preventDefault();
      const next = historyIndex - 1;
      const entry = next < 0 ? '' : historyRef.current[next] ?? '';
      setHistoryIndex(next < 0 ? -1 : next);
      setMessage(entry);
      onDraftChange?.(entry);
      requestAnimationFrame(resizeTextarea);
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      // On a touch keyboard Return is the only way to get a newline, so it
      // stays a newline there. Decided by the input device, not the width:
      // a desktop window dragged narrow still has a hardware keyboard, and
      // Enter silently stopped sending in it.
      const isTouchKeyboard = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
      if (isTouchKeyboard) {
        return;
      }
      e.preventDefault();
      handleSend();
    }
  };

  const canSend = (message.trim().length > 0 || pendingFiles.length > 0) && !disabled && !sendBlockedReason;
  const notice = disabled ? disabledReason : !suppressSendBlockedNotice ? sendBlockedReason : undefined;
  const showHint = isFocused && !message.trim() && pendingFiles.length === 0 && !isWorking;

  return (
    <div className={cn('relative w-full', className)}>
      {/* Mention Auto-complete Popup */}
      <AnimatePresence>
        {showMentions && filteredMentions.length > 0 && (
          <motion.div
            ref={mentionListRef}
            initial={reduceMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
            transition={{ duration: 0.15 }}
            className="absolute bottom-full left-0 right-0 mb-2 z-50 rounded-2xl bg-surface1/95 backdrop-blur-xl border border-border shadow-xl max-h-72 overflow-y-auto p-1.5 space-y-1"
          >
            {mentionGroups.agents.length > 0 && (
              <div>
                <div className="flex items-center justify-between px-2.5 py-1 text-3xs font-semibold uppercase tracking-wider text-muted-foreground select-none">
                  <div className="flex items-center gap-1.5">
                    <AtSign className="size-3 text-primary" />
                    <span>Agents ({mentionGroups.agents.length})</span>
                  </div>
                  {mentionGroups.agents.some((a) => a.isOnline) && (
                    <span className="text-3xs font-mono font-normal text-status-success lowercase flex items-center gap-1">
                      <span className="size-1.5 rounded-full bg-status-success" />
                      {mentionGroups.agents.filter((a) => a.isOnline).length} online
                    </span>
                  )}
                </div>
                <div className="space-y-0.5">
                  {mentionGroups.agents.map((item) => {
                    const globalIdx = filteredMentions.indexOf(item);
                    const isSelected = globalIdx === mentionIndex;
                    return (
                      <button
                        key={`${item.type}-${item.name}`}
                        type="button"
                        data-selected={isSelected ? 'true' : undefined}
                        onClick={() => insertMention(item)}
                        className={cn(
                          'w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-xl text-left transition-colors text-xs group select-none',
                          isSelected
                            ? 'bg-surface3 text-foreground font-medium ring-1 ring-border/60'
                            : 'hover:bg-surface2/80 text-foreground'
                        )}
                      >
                        <AgentAvatar
                          name={item.name}
                          agentType={item.agent.agentType}
                          size={22}
                          status={item.isOnline ? 'online' : 'offline'}
                          showStatus={true}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-1.5">
                            <span className="truncate font-medium text-foreground">
                              @{item.name}
                              {item.agent.role === 'master' && (
                                <span className="ml-1.5 text-3xs font-normal text-status-warning font-sans">
                                  leader
                                </span>
                              )}
                            </span>
                            {item.isOnline ? (
                              <span className="inline-flex items-center gap-1 text-3xs px-1.5 py-0.5 rounded-full font-mono bg-status-success/15 text-status-success border border-status-success/30 shrink-0 font-medium">
                                <span className="size-1.5 rounded-full bg-status-success" />
                                Online
                              </span>
                            ) : (
                              <span className="text-3xs px-1.5 py-0.5 rounded-full font-mono text-muted-foreground/60 bg-surface2 border border-border/60 shrink-0">
                                Not connected
                              </span>
                            )}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {mentionGroups.skills.length > 0 && (
              <div className={cn(mentionGroups.agents.length > 0 && 'pt-2.5')}>
                <div className="flex items-center justify-between px-2.5 py-1 text-3xs font-semibold uppercase tracking-wider text-primary select-none">
                  <div className="flex items-center gap-1.5">
                    <Sparkles className="size-3 text-primary" />
                    <span>Skills ({mentionGroups.skills.length})</span>
                  </div>
                  <span className="text-3xs text-muted-foreground font-mono">Slash Commands</span>
                </div>
                <div className="space-y-0.5">
                  {mentionGroups.skills.map((item) => {
                    const globalIdx = filteredMentions.indexOf(item);
                    const isSelected = globalIdx === mentionIndex;
                    return (
                      <button
                        key={`${item.type}-${item.trigger}`}
                        type="button"
                        data-selected={isSelected ? 'true' : undefined}
                        onClick={() => insertMention(item)}
                        className={cn(
                          'w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-xl text-left transition-colors text-xs group select-none',
                          isSelected
                            ? 'bg-surface3 text-foreground font-medium ring-1 ring-border/60'
                            : 'hover:bg-surface2/80 text-foreground'
                        )}
                      >
                        <div className="size-6 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0 font-mono text-xs font-bold">
                          /
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-1.5">
                            <span className="truncate font-semibold font-mono text-primary text-xs">
                              {item.trigger}
                            </span>
                            <span className="text-3xs text-muted-foreground truncate font-sans">
                              {item.skill.name}
                            </span>
                          </div>
                          <p className="text-2xs text-muted-foreground truncate leading-tight mt-0.5">
                            {item.description}
                          </p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {mentionGroups.knowledge.length > 0 && (
              <div className={cn((mentionGroups.agents.length > 0 || mentionGroups.skills.length > 0) && 'pt-2.5')}>
                <div className="flex items-center gap-1.5 px-2.5 py-1 text-3xs font-semibold uppercase tracking-wider text-status-warning select-none">
                  <BookOpen className="size-3" />
                  <span>Knowledge ({mentionGroups.knowledge.length})</span>
                </div>
                <div className="space-y-0.5">
                  {mentionGroups.knowledge.map((item) => {
                    const globalIdx = filteredMentions.indexOf(item);
                    const isSelected = globalIdx === mentionIndex;
                    return (
                      <button
                        key={`${item.type}-${item.name}`}
                        type="button"
                        data-selected={isSelected ? 'true' : undefined}
                        onClick={() => insertMention(item)}
                        className={cn(
                          'w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-xl text-left transition-colors text-xs group select-none',
                          isSelected
                            ? 'bg-surface3 text-foreground font-medium ring-1 ring-border/60'
                            : 'hover:bg-surface2/80 text-foreground'
                        )}
                      >
                        <BookOpen className="size-3.5 text-foreground-extra-muted shrink-0" />
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
          /*
           * The composer is the control the user looks at longest, so it is
           * the one element in the window that is allowed to be the visual
           * centre of gravity. Two things were stopping it.
           *
           * IT WAS DARKER THAN THE PAGE. `bg-surface1/90` is #f4f4f6 over a
           * #fafafa ground: a recessed well, not a floating island, and the
           * comment this replaces claimed the opposite. Raised means brighter
           * on a light ground, so it is `--surface2` — and opaque, because a
           * translucent input that shows the transcript scrolling underneath
           * it is a novelty the hundredth time you use it.
           *
           * THE SHADOWS WERE HAND-WRITTEN. Six literals across resting and
           * focus, none of them on the ramp in globals.css, and the light pair
           * had no ring while the dark pair had an inset highlight the light
           * one could not express. `shadow-lg`/`shadow-xl` are `--elevation-4`
           * and `-5`, the app's top two steps, which is the correct claim: the
           * composer floats over the whole transcript.
           *
           * `backdrop-blur-2xl` goes with the translucency. It was compositing
           * a full-width layer every frame to blur something now painted over.
           *
           * Focus borrows the brand accent's ring rather than inventing a
           * grey. It is the same colour the keyboard ring uses, which is the
           * point — focus should look like one idea across the app.
           */
          /*
            `rounded-2xl` (14px), NOT an arbitrary 24.

            globals.css defines the radius ramp — 2 / 4 / 6 / 8 / 10 / 14 — and
            explains that 8px is the base because 12 "read soft rather than
            dense, which is most of the gap against a desktop-native tool".
            This element then ignored all of it and wrote 24: nearly double the
            top of the scale, on the single largest control in the window. The
            user bubble did the same with 22. Two arbitrary values, both larger
            than anything the ramp can express, on the two surfaces the eye
            spends the most time on — so the scale was correct everywhere
            except where it mattered.

            14px on an 88px-tall composer still reads as a rounded island; it
            just reads as one belonging to the same family as the banner above
            it and the sidebar rows beside it.
          */
          /*
            beUI `PromptInput`, value for value:
            `relative w-full rounded-2xl border border-border/80 bg-background
            p-2 transition-colors focus-within:border-foreground/25`.

            The reference puts the composer on the PAGE ground, not on a
            lifted surface, and separates it with a hairline alone — no
            shadow, no brand focus colour. `bg-surface2` + `shadow-xs` +
            `focus-within:border-brand-border` were this app's own three
            mechanisms for the same edge; the replication drops all three.
          */
          'relative w-full rounded-2xl overflow-hidden transition-colors',
          'bg-background',
          /*
            One token, no `dark:` variant. This read `border-border/80
            dark:border-white/[0.10]`, and that hardcoded white was simply
            `--border`'s own dark value written out again (0.10 against 0.09) —
            a variant that restated what the token already says, and one more
            same-specificity rule competing with the focus colour below for no
            gain. `--border` covers both themes on its own.
          */
          'border border-border/80',
          /*
            ── Flat in the page; elevation is reserved for what floats ──

            This is the rule the window was missing, and it is the one Claude's
            own client follows: a surface that is PART OF THE PAGE is separated
            by a hairline and a fill, and elevation belongs to things that are
            genuinely above it — popovers, dialogs, toasts, the mention picker
            two hundred lines up. The composer does not float. It sits at the
            bottom of the view, anchored, never overlapping anything.

            `shadow-lg` (`--elevation-4`) claimed otherwise, and that claim was
            the source of the "half flat, half layered" feel: with a drop
            shadow AND a border AND a 14px radius, three mechanisms were each
            announcing the same edge. `shadow-xs` is `--elevation-1`, which in
            the light ramp is a 1px ring and a 1px drop — enough to lift the
            control off the ground it shares a family with, not enough to
            pretend it is over it.

            The mention popover keeps `shadow-xl`. It really does float.
          */
          'focus-within:border-foreground/25',
          isDragging && 'border-primary ring-2 ring-primary/20'
        )}
      >

        {/* Pending Files Previews */}
        <AnimatePresence>
          {pendingFiles.length > 0 && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="px-3.5 pt-2.5 pb-1 flex flex-wrap gap-2"
            >
              {pendingFiles.map((pf, idx) => (
                <div
                  key={idx}
                  // Inset into the composer like the pills are, and no blur —
                  // there is nothing translucent left in here to blur through.
                  className="group/file relative flex items-center gap-2 p-1.5 pr-2 rounded-xl bg-surface1 border border-border/60"
                >
                  {pf.preview ? (
                    <img
                      src={pf.preview}
                      alt={pf.file.name}
                      className="size-7 rounded-lg object-cover border border-border/60 shrink-0"
                    />
                  ) : (
                    <span className="size-7 rounded-lg bg-surface3 border border-border/60 flex items-center justify-center shrink-0 text-muted-foreground">
                      <FileIcon className="size-3.5" />
                    </span>
                  )}
                  <span className="max-w-[120px] truncate text-2xs font-medium text-foreground">
                    {pf.file.name}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeFile(idx)}
                    className="size-4 rounded-full bg-foreground text-background flex items-center justify-center hover:opacity-80 shadow-xs"
                  >
                    <X className="size-2.5" />
                  </button>
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Deterministic Multi-Agent Pipeline Live Preview */}
        <AnimatePresence>
          {activePipelineSegments.length >= 2 && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="px-3.5 pt-2 pb-1 overflow-hidden"
            >
              <div
                className={cn(
                  'flex gap-2 p-2 rounded-xl bg-primary/8 border border-primary/25 text-2xs text-foreground backdrop-blur-xs',
                  previewIsParallel ? 'flex-col items-start' : 'items-center',
                )}
              >
                <div className="flex items-center gap-1 text-primary font-semibold shrink-0">
                  <Waypoints className="size-3.5" />
                  <span>{previewIsParallel ? 'Runs in parallel:' : 'Pipeline Preview:'}</span>
                </div>
                <div
                  className={cn(
                    'flex gap-1.5 min-w-0 py-0.5 flex-1',
                    previewIsParallel ? 'flex-col items-start w-full' : 'items-center overflow-x-auto',
                  )}
                >
                  {activePipelineSegments.map((seg, idx) => (
                    <React.Fragment key={idx}>
                      {idx > 0 && !previewIsParallel && (
                        <ChevronRight
                          className="size-3 shrink-0 text-foreground-extra-muted"
                          aria-hidden
                        />
                      )}
                      <Hint label={seg.instruction ? `@${seg.agent}: ${seg.instruction}` : `@${seg.agent}`}>
                      <div
                        className={cn(
                          'inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-surface1 border border-primary/20 shrink-0 font-medium text-foreground',
                          previewIsParallel ? 'max-w-full' : 'max-w-[220px]',
                        )}
                      >
                        {/* A step number implies an order; parallel lanes have none. */}
                        {!previewIsParallel && (
                          <span className="size-3.5 rounded-full bg-primary text-primary-foreground text-3xs font-bold flex items-center justify-center shrink-0">
                            {idx + 1}
                          </span>
                        )}
                        <AgentAvatar name={seg.agent} size={13} />
                        <span className="font-semibold truncate">@{seg.agent}</span>
                        {seg.instruction && (
                          <span
                            className={cn(
                              'text-3xs text-muted-foreground truncate',
                              previewIsParallel ? 'min-w-0' : 'max-w-[100px]',
                            )}
                          >
                            {seg.instruction}
                          </span>
                        )}
                      </div>
                      </Hint>
                    </React.Fragment>
                  ))}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {notice && (
          <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-status-warning bg-status-warning/10 border-b border-status-warning/20 rounded-t-xl select-none">
            <Info className="size-3.5 shrink-0" />
            <span>{notice}</span>
          </div>
        )}

        {/* Text Area */}
        <textarea
          ref={textareaRef}
          data-chat-input="true"
          value={message}
          onChange={handleInput}
          onSelect={handleSelect}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
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
              ? (disabledReason || 'Connect an agent to start chatting…')
              : 'Message 52hzAgents… (@ for agents, / for skills)'
          }
          disabled={disabled}
          rows={1}
          className="scrollbar-hide block w-full resize-none overflow-y-auto bg-transparent px-2 pt-1.5 pb-1 text-sm leading-6 text-foreground placeholder:text-muted-foreground/55 focus:outline-hidden disabled:opacity-50 min-h-[38px]"
        />

        {/* Bottom Control Row */}
        <div className="mt-1 flex min-h-8 items-center justify-between gap-1.5 px-2 pb-1 overflow-x-auto scrollbar-hide flex-nowrap">
          <div className="flex items-center gap-1.5 min-w-0 shrink flex-nowrap overflow-x-auto scrollbar-hide">
            <AgentModelSwitcher
              agentName={masterAgentName}
              participants={session?.participants}
              sessionId={session?.sessionId}
            />

            {/*
              THE MODE MOVED HERE, AND BECAME A CONTROL.

              In a single-agent thread, switching orchestration modes is meaningless.
              Only display OrchestrationControl when more than 1 agent is present.
            */}
            {session && onOrchestrationChange && agents.length > 1 && (
              <OrchestrationControl
                session={session}
                agents={agents}
                onChange={onOrchestrationChange}
                onMasterChange={onMasterChange}
              />
            )}

            {/* Fix / Review: the other "what happens when I send" setting —
                whether the agents may edit. Profiles live in lib/agent-profiles. */}
            {session && <AgentProfileControl session={session} />}

            {/*
              THE SAME TWO KINDS OF THING AS THE HEADER ROW, NOW SAID THE SAME WAY.

              This row mixes state and actions with one flat gap: the model and
              the mode REPORT how the next message will be handled, while
              schedule and attach PERFORM something. The thread header
              already solved exactly this — see its "row of assorted widgets"
              note — with a hairline, so the same divider is reused here rather
              than a second convention being invented for the same idea.
            */}
            <span className="h-3.5 w-px bg-border shrink-0 mx-0.5" aria-hidden />

            {/*
              No "@ Agent" button. Typing `@` opens the same picker, and the
              placeholder says so; the button was a second door to it that
              spent the widest pill in the row on a keystroke.
            */}
            {onCreateRoutine && (
              <Hint label="Create a scheduled task">
                <button
                  type="button"
                  onClick={onCreateRoutine}
                  className={pillButton}
                >
                  <CalendarClock className="size-3.5 shrink-0 text-foreground-extra-muted" />
                  <span className="hidden md:inline">Schedule</span>
                </button>
              </Hint>
            )}

            <Hint label="Mention an agent (@)">
              <button
                type="button"
                onClick={() => {
                  if (showMentions && mentionTrigger === '@') {
                    setShowMentions(false);
                  } else {
                    setMentionTrigger('@');
                    setMentionFilter('');
                    setShowMentions(true);
                    setMentionIndex(0);
                    textareaRef.current?.focus();
                  }
                }}
                className={cn(
                  pillButton,
                  'size-7 px-0 justify-center font-mono font-bold text-xs text-foreground-extra-muted hover:text-foreground transition-colors cursor-pointer active:scale-95',
                  showMentions && mentionTrigger === '@' && 'bg-surface3 text-primary font-bold border border-primary/30',
                )}
                aria-label="Mention agent"
              >
                @
              </button>
            </Hint>

            <Hint label="Browse skills & slash commands (/)">
              <button
                type="button"
                onClick={() => {
                  if (showMentions && mentionTrigger === '/') {
                    setShowMentions(false);
                  } else {
                    setMentionTrigger('/');
                    setMentionFilter('');
                    setShowMentions(true);
                    setMentionIndex(0);
                    textareaRef.current?.focus();
                  }
                }}
                className={cn(
                  pillButton,
                  'size-7 px-0 justify-center font-mono font-bold text-xs text-foreground-extra-muted hover:text-foreground transition-colors cursor-pointer active:scale-95',
                  showMentions && mentionTrigger === '/' && 'bg-surface3 text-primary font-bold border border-primary/30',
                )}
                aria-label="Slash commands"
              >
                /
              </button>
            </Hint>

            <Hint label="Attach files or images">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className={cn(
                  pillButton,
                  'size-7 px-0 justify-center',
                  pendingFiles.length > 0 && 'bg-surface3 text-foreground font-medium border border-border'
                )}
              >
                <Paperclip className="size-3.5 shrink-0 text-foreground-extra-muted" />
              </button>
            </Hint>
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
          </div>

          {/*
            THE KEYBOARD HINT IS GONE, NOT WIDENED.

            It was a line of text competing with the pill row for the same
            strip, and it lost that fight as soon as the column narrowed to
            beUI's 48rem — it rendered straight over the attach button.

            It is also not in the reference: beUI's composer carries only the
            model select, the add button and send. And the hint said three
            things every chat client does the same way, to a reader who has
            already typed into the box — the shortcut list (`?`) still has
            all three for anyone who wants them.
          */}
          <div className="flex min-w-0 items-center gap-2.5">
            {/*
              The context ring sits with send, not in the thread header.

              It measures what the next message will cost, so it belongs beside
              the control that sends it — and next to send it needs no label to
              explain what it is about, which is what the header version had to
              spend a word on.
            */}
            {session && <ContextHealthIndicator channelName={session.sessionId} />}

            {/*
              `Magnetic` WRAPS the hint, and the hint still wraps the button.

              Two things forced this order. beUI's own `MagneticButton`
              bundles its `Button` and that button's variant classes, which
              would overwrite the three states this control already draws
              (working / can-send / inert) — so only the pull is taken, not
              the button. And `Magnetic` renders its own `motion.div` without
              forwarding a ref or spreading props, so putting it INSIDE
              `Hint` would hand the tooltip that div instead of the button
              and quietly drop the ref and `aria-describedby`.

              `Magnetic` is a no-op under `prefers-reduced-motion` and on
              touch, so nothing below changes on either.
            */}
            {isWorking && (
              <Magnetic strength={0.2}>
                <Hint label="Stop response">
                  <button
                    type="button"
                    onClick={handleStopClick}
                    disabled={stopping}
                    className="relative flex items-center justify-center size-8 rounded-full shrink-0 bg-destructive text-destructive-foreground hover:opacity-90 shadow-md shadow-destructive/25 cursor-pointer transition-all duration-150 select-none active:scale-95"
                    aria-label="Stop response"
                  >
                    <Square className="size-3 fill-current" />
                  </button>
                </Hint>
              </Magnetic>
            )}

            {(!isWorking || canSend) && (
              <Magnetic strength={0.2}>
                <Hint label={sendBlockedReason ? sendBlockedReason : isWorking ? 'Queue message (Enter)' : 'Send message (Enter)'}>
                  <button
                    type="button"
                    onClick={handleSend}
                    disabled={!canSend}
                    className={cn(
                      'relative flex items-center justify-center size-8 rounded-full shrink-0',
                      'transition-all duration-150 select-none active:scale-95',
                      canSend
                        ? 'bg-brand text-brand-foreground hover:bg-brand-hover shadow-md shadow-brand/25 cursor-pointer'
                        : 'bg-surface1 dark:bg-white/[0.05] text-foreground-extra-muted/40 cursor-not-allowed border border-border/40'
                    )}
                    aria-label={isWorking ? 'Queue message' : 'Send message'}
                  >
                    <ArrowUp className="size-4 stroke-[2.5]" />
                  </button>
                </Hint>
              </Magnetic>
            )}
          </div>
        </div>
      </div>

      {/*
        The workflow plan dialog is gone with the mode it configured. It wrote
        `mode: 'workflow'`, which no longer exists — and the text it saved was
        never read by anything but the router's own prompt.
      */}
    </div>
  );
}

/**
 * Which picker trigger the caret is sitting in, if any.
 *
 * `/` IS DELIBERATELY THE SAME STRICTNESS AS `@`, NOT LOOSER: it only counts at
 * the very start of the message or straight after whitespace. `src/lib/foo`,
 * `go test ./...` and `and/or` are all ordinary things to type into a message to
 * an agent, and none of them should open a document picker. The check on the
 * character BEFORE the trigger is what makes that hold.
 *
 * When both characters are present the later one wins, so typing
 * `@claude look at /` opens knowledge rather than re-opening the agent list.
 */
function findActiveTrigger(
  textBefore: string,
): { char: '@' | '/'; index: number; query: string } | null {
  let best: { char: '@' | '/'; index: number } | null = null;
  for (const char of ['@', '/'] as const) {
    const index = textBefore.lastIndexOf(char);
    if (index < 0) continue;
    // Reject if preceded by ASCII word character (e.g. bob@example.com, and/or, file/path)
    // but permit CJK characters, whitespace, and punctuation (e.g. 请@claude, @pi)
    if (index !== 0 && /[a-zA-Z0-9_]/.test(textBefore[index - 1])) continue;
    if (!best || index > best.index) best = { char, index };
  }
  if (!best) return null;
  const query = textBefore.slice(best.index + 1);
  // Whitespace after the trigger means the thought moved on.
  if (/\s/.test(query)) return null;
  return { char: best.char, index: best.index, query };
}
