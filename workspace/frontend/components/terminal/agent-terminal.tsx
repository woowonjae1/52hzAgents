'use client';

import React, { useMemo, useRef, useEffect, useState } from 'react';
import { useWorkspace } from '@/lib/workspace-context';
import { useMessagePolling } from '@/hooks/use-polling';
import { workspaceApi } from '@/lib/api';
import { Terminal, Search, Cpu, TerminalSquare, RefreshCw, ArrowDownToLine, Eraser } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

// Strip markdown so log lines read as plain terminal output.
function cleanLogContent(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '[code block]')
    .replace(/\*\*/g, '')
    .replace(/`{1,3}/g, '')
    .trim();
}

// Lightweight command highlighter — dims flags, accents known binaries.
const CMD_KEYWORDS = ['npm', 'pnpm', 'yarn', 'bun', 'node', 'git', 'python', 'pip', 'cargo', 'go', 'docker', 'kubectl', 'pytest', 'make', 'curl', 'ls', 'cat', 'cd', 'mkdir', 'rm', 'cp', 'mv', 'grep', 'sed', 'awk', 'echo'];
function highlightCommand(cmd: string) {
  return cmd.split(' ').map((part, idx) => {
    const clean = part.toLowerCase().trim();
    const isKeyword = idx === 0 && CMD_KEYWORDS.some((k) => clean === k || clean.startsWith(k + '/'));
    const isOption = part.startsWith('-');
    return (
      <span
        key={idx}
        className={cn(
          isKeyword ? 'text-emerald-400 font-semibold' : isOption ? 'text-foreground-muted' : 'text-foreground-extra-muted',
        )}
      >
        {part}
        {idx < cmd.split(' ').length - 1 ? ' ' : ''}
      </span>
    );
  });
}

interface TerminalLine {
  id?: string;
  time: string;
  type: 'info' | 'command' | 'success' | 'error' | 'thinking';
  sender: string;
  content: string;
  commandArgs?: string;
}

// Per-type presentation: a glyph, the sender/text colors, and an optional
// left gutter accent. Kept intentionally restrained — colour marks meaning,
// it is not decoration.
const LINE_STYLE: Record<TerminalLine['type'], { glyph: string; sender: string; text: string; gutter: string; bg: string }> = {
  command: { glyph: '$', sender: 'text-foreground-extra-muted', text: 'text-primary-foreground', gutter: 'bg-foreground-muted/60', bg: 'bg-white/[0.02]' },
  success: { glyph: '✓', sender: 'text-emerald-400', text: 'text-foreground-extra-muted', gutter: 'bg-emerald-500/50', bg: '' },
  error: { glyph: '✕', sender: 'text-red-400', text: 'text-red-300', gutter: 'bg-red-500/70', bg: 'bg-red-500/[0.05]' },
  thinking: { glyph: '◦', sender: 'text-foreground-extra-muted', text: 'text-foreground-extra-muted italic', gutter: 'bg-foreground-muted/40', bg: '' },
  info: { glyph: '›', sender: 'text-foreground-extra-muted', text: 'text-foreground-extra-muted', gutter: 'bg-transparent', bg: '' },
};

export function AgentTerminal() {
  const { currentSessionId, sessions, currentUser } = useWorkspace();
  const { messages } = useMessagePolling({ sessionId: currentSessionId });
  const [filter, setFilter] = useState('');
  const [inputValue, setInputValue] = useState('');
  const [sending, setSending] = useState(false);
  const [isAutoScroll, setIsAutoScroll] = useState(true);

  const [localLines, setLocalLines] = useState<TerminalLine[]>([]);
  // Lines before this index are hidden by a manual "clear".
  const [clearedBefore, setClearedBefore] = useState(0);

  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const terminalEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const activeSession = useMemo(
    () => sessions.find((s) => s.sessionId === currentSessionId),
    [sessions, currentSessionId],
  );

  const activeOperator = useMemo(() => {
    if (!activeSession) return 'system';
    return activeSession.master || activeSession.participants?.[0] || 'system';
  }, [activeSession]);

  // Sync polled backend messages into terminal lines.
  useEffect(() => {
    const rawMsgs = messages || [];
    const parsedLines: TerminalLine[] = [];

    rawMsgs.forEach((msg) => {
      const timeStr = (msg.createdAt ? new Date(msg.createdAt) : new Date()).toLocaleTimeString('en-GB', { hour12: false });

      if (msg.messageType === 'step') {
        const isRun = msg.content.includes('**Running:**') || msg.content.includes('run_command') || /\bcommand\b/.test(msg.content);
        const isEdit = msg.content.includes('**Editing:**') || /\b(Write|Edit)\b/.test(msg.content);
        let type: TerminalLine['type'] = 'info';
        let displayContent = cleanLogContent(msg.content);
        if (isRun) {
          type = 'command';
          const m = msg.content.match(/\*\*Running:\*\*\s*`([^`]+)`/);
          displayContent = m ? m[1] : displayContent;
        } else if (isEdit) {
          const m = msg.content.match(/\*\*Editing:\*\*\s*`([^`]+)`/);
          displayContent = m ? `edit ${m[1]}` : displayContent;
        }
        parsedLines.push({
          id: msg.messageId, time: timeStr, type, sender: msg.senderName, content: displayContent,
          commandArgs: msg.metadata?.args ? JSON.stringify(msg.metadata.args, null, 2) : undefined,
        });
      } else if (msg.messageType === 'thinking' || msg.content === 'thinking...' || msg.content.toLowerCase().startsWith('thinking')) {
        parsedLines.push({
          id: msg.messageId, time: timeStr, type: 'thinking', sender: msg.senderName,
          content: msg.content === 'thinking...' ? 'reasoning…' : cleanLogContent(msg.content),
        });
      } else if (msg.messageType === 'status') {
        const isErr = /failed|error|stopped|denied/i.test(msg.content);
        parsedLines.push({
          id: msg.messageId, time: timeStr, type: isErr ? 'error' : 'success', sender: msg.senderName,
          content: cleanLogContent(msg.content),
        });
      } else if (msg.messageType === 'chat') {
        if (msg.content.startsWith('Please run this command:')) {
          parsedLines.push({
            id: msg.messageId, time: timeStr, type: 'command', sender: msg.senderName,
            content: msg.content.replace('Please run this command:', '').trim(),
          });
        } else {
          parsedLines.push({
            id: msg.messageId, time: timeStr, type: 'info', sender: msg.senderName,
            content: cleanLogContent(msg.content),
          });
        }
      }
    });

    setLocalLines((prev) => {
      const localOnly = prev.filter((l) => !l.id);
      return [...parsedLines, ...localOnly];
    });
  }, [messages]);

  // Reset local log buffer and pagination markers when changing threads
  useEffect(() => {
    setLocalLines([]);
    setClearedBefore(0);
  }, [currentSessionId]);

  const isAgentWorking = useMemo(() => {
    const last = localLines[localLines.length - 1];
    return last?.type === 'thinking';
  }, [localLines]);

  useEffect(() => {
    if (isAutoScroll && terminalEndRef.current) {
      terminalEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [localLines, isAutoScroll]);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    setIsAutoScroll(el.scrollHeight - el.scrollTop <= el.clientHeight + 60);
  };

  const handleInputKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      if (!inputValue.trim()) return;
      if (!currentSessionId) {
        toast.error('No active session selected');
        return;
      }
      const cmd = inputValue.trim();
      const newHistory = [...history, cmd];
      setHistory(newHistory);
      setHistoryIndex(newHistory.length);
      setInputValue('');
      setSending(true);

      const t = () => new Date().toLocaleTimeString('en-GB', { hour12: false });
      setLocalLines((prev) => [...prev, { time: t(), type: 'command', sender: 'you', content: cmd }]);

      try {
        const result = await workspaceApi.executeTerminalCommand(cmd);
        const hasError = result.output.includes('[SYSTEM ERROR]');
        setLocalLines((prev) => [...prev, { time: t(), type: hasError ? 'error' : 'success', sender: 'shell', content: result.output }]);
        await workspaceApi.sendMessage(currentSessionId, `Please run this command: ${cmd}`, currentUser.name, [], [], currentUser.id);
      } catch {
        setLocalLines((prev) => [...prev, { time: t(), type: 'error', sender: 'shell', content: '[exec failed] could not reach workspace host shell.' }]);
        toast.error('Command transmission failed');
      } finally {
        setSending(false);
        setIsAutoScroll(true);
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length === 0) return;
      const idx = historyIndex > 0 ? historyIndex - 1 : 0;
      setHistoryIndex(idx);
      setInputValue(history[idx] || '');
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const idx = historyIndex < history.length - 1 ? historyIndex + 1 : history.length;
      setHistoryIndex(idx);
      setInputValue(idx === history.length ? '' : history[idx] || '');
    }
  };

  const visibleLines = useMemo(() => localLines.slice(clearedBefore), [localLines, clearedBefore]);
  const filteredLines = useMemo(() => {
    if (!filter.trim()) return visibleLines;
    const f = filter.toLowerCase();
    return visibleLines.filter((l) => l.content.toLowerCase().includes(f) || l.sender.toLowerCase().includes(f));
  }, [visibleLines, filter]);

  return (
    <div
      className="flex flex-col h-full bg-[#0b0d10] text-foreground-extra-muted font-mono text-[12px] leading-5 select-text relative overflow-hidden"
      onClick={() => inputRef.current?.focus()}
    >
      <style>{`
        @keyframes term-cursor { 0%,100%{opacity:1} 50%{opacity:0} }
        .term-cursor { animation: term-cursor 1.1s step-end infinite; }
      `}</style>

      {/* Header */}
      <div className="relative z-10 flex items-center justify-between pl-3.5 pr-12 h-11 shrink-0 border-b border-border/70 bg-primary/40 backdrop-blur-md select-none">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-[#ff5f57]" />
            <span className="size-2.5 rounded-full bg-[#febc2e]" />
            <span className="size-2.5 rounded-full bg-[#28c840]" />
          </div>
          <TerminalSquare className="size-3.5 text-foreground-extra-muted ml-1" />
          <span className="text-[11px] text-foreground-extra-muted font-medium truncate">
            {activeSession?.title || currentSessionId || 'openagents-shell'}
          </span>
          <span className="hidden sm:flex items-center gap-1 pl-2 ml-1 border-l border-border text-[10px]">
            <Cpu className={cn('size-2.5', isAgentWorking ? 'text-amber-400 animate-spin' : 'text-emerald-400')} />
            <span className={cn('font-semibold tracking-wide', isAgentWorking ? 'text-amber-400' : 'text-emerald-400')}>
              {activeOperator}
            </span>
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="flex items-center gap-1.5 px-2 h-6 rounded-md bg-primary/70 border border-border/70 focus-within:border-border-accent transition-colors">
            <Search className="size-3 text-foreground-muted" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter"
              className="bg-transparent border-0 outline-none text-[10px] w-16 focus:w-24 transition-all text-foreground-extra-muted placeholder:text-foreground-muted"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); setClearedBefore(localLines.length); }}
            className="size-6 flex items-center justify-center rounded-md text-foreground-muted hover:text-foreground-extra-muted hover:bg-primary/60 transition-colors"
            title="Clear console"
          >
            <Eraser className="size-3.5" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setIsAutoScroll((v) => !v); }}
            className={cn(
              'size-6 flex items-center justify-center rounded-md border transition-colors',
              isAutoScroll ? 'text-emerald-400 border-emerald-500/30 bg-emerald-950/20' : 'text-foreground-muted border-border hover:text-foreground-extra-muted',
            )}
            title={isAutoScroll ? 'Auto-scroll on' : 'Auto-scroll off'}
          >
            <ArrowDownToLine className="size-3.5" />
          </button>
        </div>
      </div>

      {/* Output */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="relative z-10 flex-grow overflow-y-auto py-2 scrollbar-thin scrollbar-thumb-zinc-800/70"
      >
        {filteredLines.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-foreground-muted select-none">
            <Terminal className="size-6 text-foreground" />
            <span className="text-[11px]">
              {currentSessionId ? 'Console ready — type a command below' : 'Select a thread to attach the shell'}
            </span>
          </div>
        ) : (
          filteredLines.map((line, idx) => {
            const s = LINE_STYLE[line.type];
            return (
              <div
                key={line.id || `local-${idx}`}
                className={cn('group grid grid-cols-[auto_auto_1fr] items-baseline gap-x-2.5 px-3 py-[3px] hover:bg-primary/25', s.bg)}
              >
                {/* gutter + time */}
                <span className="flex items-center gap-2 shrink-0">
                  <span className={cn('w-[2px] self-stretch rounded-full', s.gutter)} />
                  <span className="text-foreground-muted tabular-nums text-[10px]">{line.time}</span>
                </span>
                {/* sender + glyph */}
                <span className={cn('shrink-0 font-semibold', s.sender)}>
                  <span className="opacity-60 mr-1">{s.glyph}</span>
                  {line.sender}
                </span>
                {/* content */}
                <div className="min-w-0">
                  <span className={cn('break-words whitespace-pre-wrap', s.text)}>
                    {line.type === 'command' ? highlightCommand(line.content) : line.content}
                  </span>
                  {line.commandArgs && (
                    <pre className="mt-1 mb-0.5 p-2 rounded-md bg-black/40 border border-border/70 text-[10px] text-foreground-muted overflow-x-auto max-h-40 whitespace-pre scrollbar-thin">
                      {line.commandArgs}
                    </pre>
                  )}
                </div>
              </div>
            );
          })
        )}
        <div ref={terminalEndRef} />
      </div>

      {/* Working banner */}
      {sending && (
        <div className="relative z-10 flex items-center gap-2 px-3.5 py-1.5 bg-primary/40 border-t border-border-accent/50 text-amber-400 text-[10px] select-none">
          <RefreshCw className="size-3 animate-spin" />
          <span>executing on workspace host…</span>
        </div>
      )}

      {/* Prompt */}
      <div className="relative z-10 shrink-0 px-3 py-2.5 border-t border-border/70 bg-primary/40 backdrop-blur-md">
        <div className="flex items-center gap-2 px-2.5 h-9 rounded-lg bg-primary/80 border border-border/70 focus-within:border-border-accent transition-colors">
          <span className="shrink-0 select-none font-semibold text-[11px] text-emerald-400">
            52hz@openagents
          </span>
          <span className="shrink-0 text-foreground-muted select-none">~$</span>
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleInputKeyDown}
            disabled={sending}
            className="flex-grow bg-transparent border-0 outline-none text-primary-foreground text-xs p-0 min-w-0 placeholder:text-foreground-muted"
            placeholder={sending ? 'transmitting…' : 'type a command…'}
          />
          {!inputValue && !sending && <span className="w-1.5 h-4 bg-emerald-400/90 rounded-[1px] term-cursor shrink-0" />}
        </div>
      </div>
    </div>
  );
}
