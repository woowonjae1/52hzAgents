'use client';

import { cn } from '@/lib/utils';
import { ChatMessage } from './chat-message';
import { IntermediateSteps } from './intermediate-steps';
import { ThinkingMessage } from './thinking-message';
import { isThinkingText } from './message-kinds';
import { SpeechActEvent } from './speech-act-event';
import { WorkingIndicator } from './working-indicator';
import { AgentAvatar } from '@/components/agents/agent-avatar';
import { Button } from '@/components/ui/button';
import { ArrowDown } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { flushSync } from 'react-dom';
import { PreviewRail, type PreviewRailItem } from '@/components/motion/preview-rail';
import { deduplicateAndSortMessages } from '@/lib/types';
import type { WorkspaceMessage, WorkspaceAgent } from '@/lib/types';
import { useLayout } from '@/components/layout/layout-context';
import { useWorkspace } from '@/lib/workspace-context';

const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * "Show me this message in the thread."
 *
 * Dispatched by the trace panel when a step is clicked. It carries a
 * `messageId` and nothing else: only this component knows how the transcript
 * is grouped and virtualised, so only it can turn an id into a scroll
 * position. An event rather than shared state because the two panels are
 * siblings with no common owner below the shell, and because the correct
 * behaviour when the message is outside the loaded window is to do nothing —
 * which a listener expresses for free.
 */
export const TRANSCRIPT_REVEAL_EVENT = 'transcript:reveal';

// ── Message Grouping ──

import {
  type MessageGroup,
  groupMessages,
  groupKey,
  isEchoOfReply,
  isTerminalStatus,
} from './message-grouper';

export {
  type MessageGroup,
  groupMessages,
  groupKey,
  isEchoOfReply,
  isTerminalStatus,
};

// Scroll diagnostics. Always on in dev; in production it's opt-in via
// `localStorage.setItem('oa_debug_scroll','1')` so we can diagnose the rare
// scroll-jump in the wild (e.g. on network reconnect) without shipping console
// noise to every user. Evaluated once at module load.
const DEBUG_SCROLL =
  process.env.NODE_ENV !== 'production' ||
  (() => {
    try {
      return typeof window !== 'undefined' && window.localStorage.getItem('oa_debug_scroll') === '1';
    } catch {
      return false;
    }
  })();
function scrollDebug(source: string, el: HTMLElement | null, extra?: Record<string, unknown>) {
  if (!DEBUG_SCROLL || !el) return;
  const isNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  // eslint-disable-next-line no-console
  console.debug('[chat-scroll]', source, {
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    isNearBottom,
    ...extra,
  });
}

// ── Component ──

interface ChatMessagesProps {
  messages: WorkspaceMessage[];
  agents?: WorkspaceAgent[];
  showAllSteps: boolean;
  className?: string;
  /** Increment to force scroll to bottom (e.g. after user sends a message). */
  scrollKey?: number;
  /** Callback to load older messages (infinite scroll upward). */
  loadOlder?: () => Promise<void>;
  /** Whether there are older messages available to load. */
  hasOlder?: boolean;
  /** Whether older messages are currently being loaded. */
  loadingOlder?: boolean;
  /** Current session working directory for resolving local path links */
  workingDir?: string;
  onRegenerate?: (message: WorkspaceMessage) => void;
  onQuoteReply?: (message: WorkspaceMessage) => void;
  onReusePrompt?: (message: WorkspaceMessage) => void;
}

const sessionScrollPositions = new Map<string, number>();

export function ChatMessages({ messages, agents, showAllSteps, className, scrollKey, loadOlder, hasOlder, loadingOlder, workingDir, onRegenerate, onQuoteReply, onReusePrompt }: ChatMessagesProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [unseenCount, setUnseenCount] = useState(0);

  const { openPreview } = useLayout();

  // Auto-open the Local Preview panel when an agent reports a live dev server.
  //
  // Keyed on the reporting message's id, not on the URL: re-opening on every
  // render would fight the user if they navigated the panel elsewhere, and
  // keying on the URL alone would miss a restart that lands on the same port.
  // Only the newest report acts, and only once — a channel scrolled back into
  // view must not re-hijack the panel with an hours-old address.
  const handledPreviewRef = useRef<string | null>(null);
  useEffect(() => {
    // Only auto-open if window is wide enough (>= 1024px) so narrow windows aren't crushed
    if (typeof window !== 'undefined' && window.innerWidth < 1024) return;

    for (let i = messages.length - 1; i >= 0; i--) {
      const preview = messages[i].metadata?.preview;
      if (!preview?.url) continue;
      const id = messages[i].messageId;
      if (!id || handledPreviewRef.current === id) return;
      handledPreviewRef.current = id;
      // Only auto-open for live servers reported recently (< 30s)
      const ca = messages[i].createdAt;
      const msgTime = typeof ca === 'string' || typeof ca === 'number' ? new Date(ca).getTime() : 0;
      if (msgTime > 0 && Date.now() - msgTime > 30_000) return;

      openPreview(preview.url);
      return;
    }
  }, [messages, openPreview]);

  const prevLengthRef = useRef(0);
  // Track first/last message identity to distinguish prepend (older history
  // loaded at the top) from append (new message at the bottom).
  const prevFirstIdRef = useRef<string | null>(null);
  const prevLastIdRef = useRef<string | null>(null);
  // Track the last scrollKey value so the force-scroll effect only fires when
  // scrollKey *actually* changes — not when scrollToBottom's identity changes
  // (which it does on every message-count change, including history prepend).
  const prevScrollKeyRef = useRef(scrollKey);
  // Track session identity to reset scroll state on thread switch
  const prevSessionRef = useRef<string | null>(null);
  // True when the user has intentionally scrolled away from the bottom.
  // Prevents auto-scroll from yanking them back while reading history.
  const userScrolledUpRef = useRef(false);

  // Smooth scroll compensation refs when prepending older messages
  const prevScrollHeightRef = useRef<number | null>(null);
  const prevScrollTopRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef(0);

  // Separate loading indicators (optimistic) from real messages
  const loadingMessages = useMemo(() => messages.filter((m) => m.messageType === 'loading'), [messages]);
  const realMessages = useMemo(() => messages.filter((m) => m.messageType !== 'loading'), [messages]);

  // Filter: skip empty status messages; when toggle is off, only show status messages after the last chat message
  const filteredMessages = useMemo(() => {
    const isStep = (msg: WorkspaceMessage) => msg.messageType === 'status' || msg.messageType === 'thinking' || msg.messageType === 'todos';

    /*
     * Drop a `thinking` message that is really the answer, streamed early.
     *
     * NINE OF THE ELEVEN ADAPTERS DO THIS ON PURPOSE. `amp`, `claude`, `cline`,
     * `codex`, `copilot`, `cursor`, `gemini`, `opencode` and `pi` all push each
     * chunk of the model's REPLY through `sendThinking` while it generates, keep
     * a copy, and then post the assembled text again as the real message —
     * `codex` even comments "Stream as thinking (like Claude adapter)". So the
     * same answer arrives twice: once live inside a "Thought" disclosure, once
     * as the reply underneath. This filter is the only thing standing between
     * the reader and that duplication on every one of those agents.
     *
     * It cannot be done by sequence alone. Genuine chain-of-thought arrives
     * through the SAME `messageType: 'thinking'` — `cline` and `copilot` each
     * have one branch doing it correctly (`reasoning`) and one doing it wrongly
     * (`text`), a few lines apart — so position in the stream does not
     * distinguish the two. Only the content does.
     */
    const deduped = realMessages.filter((msg, i) => {
      if (!isThinkingText(msg)) return true;
      const flagged = msg.metadata?.reply_preview === true;
      // Look ahead for a chat message from the same agent
      for (let j = i + 1; j < realMessages.length; j++) {
        const next = realMessages[j];
        if (next.senderName !== msg.senderName) continue;
        if (next.messageType === 'status' || next.messageType === 'thinking') continue;
        /*
         * The reply has landed. A flagged preview goes without asking any
         * questions — the adapter said what it was, so there is nothing to
         * infer. Everything else falls back to comparing normalised text, which
         * is all that can be done for messages written before the flag existed
         * and for any adapter still to be updated.
         */
        if (flagged || isEchoOfReply(msg.content, next.content)) return false;
        break;
      }
      // No reply yet: this is the live edge. A flagged preview is kept, because
      // it is the answer being typed out and the only thing to look at — but it
      // renders as prose rather than as reasoning. See `StepRuns`.
      return true;
    });

    const nonEmpty = deduped.filter((msg) => !isStep(msg) || msg.content.trim());
    if (showAllSteps) return nonEmpty;

    let lastChatIndex = -1;
    for (let i = nonEmpty.length - 1; i >= 0; i--) {
      if (!isStep(nonEmpty[i])) {
        lastChatIndex = i;
        break;
      }
    }

    // Check if the very last message is a step (agent still working)
    const lastIsStep = nonEmpty.length > 0 && isStep(nonEmpty[nonEmpty.length - 1]);

    // Keep: all non-step messages, all thinking messages (they persist),
    // and trailing status only if agent is still actively working
    const trailing = nonEmpty.filter((msg, index) => {
      if (!isStep(msg)) return true;
      // Always keep thinking and todos — they provide reasoning context
      if (msg.messageType === 'thinking' || msg.messageType === 'todos') return true;
      // Only keep trailing status if agent is still working
      // (last message is a step, meaning no chat response yet)
      return lastIsStep && index > lastChatIndex;
    });
    // Find the last status-only message and keep only that one
    let lastStatusIndex = -1;
    for (let i = trailing.length - 1; i >= 0; i--) {
      if (trailing[i].messageType === 'status') {
        lastStatusIndex = i;
        break;
      }
    }
    return trailing.filter((msg, index) => {
      if (msg.messageType !== 'status') return true;
      return index === lastStatusIndex;
    });
  }, [realMessages, showAllSteps]);

  const { activeSessionIds } = useWorkspace();
  const currentSessionId = messages.length > 0 ? messages[0].sessionId : null;
  const isChannelActive = currentSessionId ? activeSessionIds.has(currentSessionId) : false;

  // Group into chat messages and intermediate step clusters
  const groups = useMemo(
    () => groupMessages(filteredMessages, isChannelActive),
    [filteredMessages, isChannelActive]
  );

  // Only the NEWEST message can mean "this run is over". Scanning the whole
  // history meant one old "Execution stopped by user." (or any answer that
  // merely contained the word "stopped") suppressed the working indicator in
  // that thread forever, so every later send looked like nothing happened.
  const hasTerminalStatus = realMessages.length > 0
    && isTerminalStatus(realMessages[realMessages.length - 1]);

  // Loading indicator counts as a virtual row when present (only if the channel is active)
  const hasLoading = loadingMessages.length > 0 && !hasTerminalStatus && isChannelActive;
  const totalCount = groups.length + (hasLoading ? 1 : 0);

  // Precompute approval responses and answered decision card IDs for fast O(1) row lookups
  const approvalResponses = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const m of messages) {
      const resp = m.metadata?.tool_approval_response;
      if (resp?.approval_id) {
        map.set(resp.approval_id, !!resp.granted);
      }
    }
    return map;
  }, [messages]);

  const { answeredDecisionIds, answeredDecisions } = useMemo(() => {
    const ids = new Set<string>();
    const map = new Map<string, Record<string, string>>();
    for (const m of messages) {
      const resp = m.metadata?.decision_response as { source_message_id?: string; answers?: Record<string, string | string[]> } | undefined;
      const srcId = resp?.source_message_id;
      if (srcId) {
        ids.add(srcId);
        if (resp?.answers) {
          const flatAnswers: Record<string, string> = {};
          for (const [k, v] of Object.entries(resp.answers)) {
            flatAnswers[k] = Array.isArray(v) ? v.join(', ') : String(v);
          }
          map.set(srcId, flatAnswers);
        }
      }
    }
    return { answeredDecisionIds: ids, answeredDecisions: map };
  }, [messages]);

  const [initialLastReadId, setInitialLastReadId] = useState<string | null>(null);

  useEffect(() => {
    if (!currentSessionId) return;
    try {
      const stored = localStorage.getItem(`last_read_msg_${currentSessionId}`);
      setInitialLastReadId(stored);
    } catch {}
  }, [currentSessionId]);

  // Update last read on idle or after messages load
  useEffect(() => {
    if (!currentSessionId || realMessages.length === 0) return;
    const latestId = realMessages[realMessages.length - 1]?.messageId;
    if (!latestId) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(`last_read_msg_${currentSessionId}`, latestId);
      } catch {}
    }, 4000);
    return () => clearTimeout(t);
  }, [currentSessionId, realMessages]);

  const lastReadIndex = useMemo(() => {
    if (!initialLastReadId || groups.length === 0) return -1;
    const idx = groups.findIndex((g) => {
      const msg = 'message' in g ? (g as { message?: WorkspaceMessage }).message : ('messages' in g ? (g as { messages?: WorkspaceMessage[] }).messages?.[0] : undefined);
      return msg?.messageId === initialLastReadId;
    });
    if (idx >= 0 && idx < groups.length - 1) {
      return idx + 1;
    }
    return -1;
  }, [groups, initialLastReadId]);

  // ── Virtualizer ──
  const getItemKey = useCallback(
    (index: number) => {
      if (index < groups.length) return groupKey(groups[index], index);
      return 'loading-indicator';
    },
    [groups]
  );

  const virtualizer = useVirtualizer({
    count: totalCount,
    getScrollElement: () => containerRef.current,
    estimateSize: () => 140, // 140px is a much closer match to typical message height, preventing scroll jumps
    overscan: 10,
    getItemKey,
  });

  /*
    ROWS THAT GROW MOVE THE ROWS BELOW IN THE SAME FRAME.

    A "Thought" or tool line is a native <details> whose height animates open
    in CSS, so its row grows a little every frame for the whole animation.
    The virtualizer does observe its rows, but it applies a size change with
    an ordinary async re-render -- so on every frame of that animation the rows
    below were still placed for the previous frame's height, and the opening
    row drew its text over the reply underneath it.

    This observer is created during the first render, before the virtualizer
    creates its own in the ref callbacks, so ResizeObserver (which calls
    observers in creation order) runs it first. It applies the new size inside
    flushSync, before paint; the virtualizer's own observer then sees an
    unchanged size and does nothing.
  */
  const virtualizerRef = useRef(virtualizer);
  virtualizerRef.current = virtualizer;
  const [syncResizeObserver] = useState(() =>
    typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver((entries, observer) => {
          const v = virtualizerRef.current;
          flushSync(() => {
            for (const entry of entries) {
              const el = entry.target as HTMLElement;
              if (!el.isConnected) {
                observer.unobserve(el);
                continue;
              }
              const index = Number(el.dataset.index);
              if (!Number.isFinite(index)) continue;
              v.resizeItem(index, v.options.measureElement(el, entry, v));
            }
          });
        })
  );
  useEffect(() => () => syncResizeObserver?.disconnect(), [syncResizeObserver]);
  const measureRow = useCallback(
    (el: HTMLDivElement | null) => {
      virtualizer.measureElement(el);
      if (el) syncResizeObserver?.observe(el);
    },
    [virtualizer, syncResizeObserver]
  );

  /*
    THE TRANSCRIPT RAIL.

    beUI ships a `MessageScroller` that drives `PreviewRail` by querying
    `[data-slot="message"]` out of the DOM. That cannot work here: this
    transcript is virtualized, so the DOM only ever holds the dozen rows in
    view and the rail would show a dozen ticks for a thousand-message thread,
    changing as you scroll. The rail is built from `groups` instead — the same
    array the virtualizer is counting — so every message has a tick whether or
    not it is currently mounted.

    Only `chat` and `speech_act` groups get one. Day separators are not
    destinations, and thinking/steps traces are the noise the rail exists to
    scroll past.
  */
  const { railItems, railIndexById, railIdByIndex } = useMemo(() => {
    const items: PreviewRailItem[] = [];
    const indexById = new Map<string, number>();
    const idByIndex = new Map<number, string>();

    groups.forEach((group, index) => {
      if (group.type !== 'chat' && group.type !== 'speech_act') return;
      const message = group.message;
      const text = (message.content || '').replace(/\s+/g, ' ').trim();
      if (!text) return;

      const id = groupKey(group, index);
      const sender = message.senderName || 'Message';
      items.push({
        id,
        label: sender,
        description: text.length > 96 ? `${text.slice(0, 96).trim()}…` : text,
        ariaLabel: `Jump to ${sender}: ${text.slice(0, 48)}`,
      });
      indexById.set(id, index);
      idByIndex.set(index, id);
    });

    return { railItems: items, railIndexById: indexById, railIdByIndex: idByIndex };
  }, [groups]);

  const handleRailSelect = useCallback(
    (item: PreviewRailItem) => {
      const index = railIndexById.get(item.id);
      if (index === undefined) return;
      // A deliberate jump is not "tailing" — same rule as the reveal event.
      userScrolledUpRef.current = true;
      virtualizer.scrollToIndex(index, { align: 'center' });
    },
    [railIndexById, virtualizer]
  );

  // A settle-to-bottom pass is in progress. Any real user scroll gesture
  // cancels it (see the wheel/touch/mousedown listeners below) so we never
  // fight the user, and it self-terminates once the height stabilizes.
  const settlingRef = useRef(false);

  const scrollToBottom = useCallback(() => {
    if (totalCount === 0) return;
    // Why a loop and not a single scrollTop=scrollHeight: the virtualizer
    // estimates every unmeasured row at 80px, so one corrective pin lands at
    // the *estimated* bottom. The real bottom rows (tall markdown, tables) are
    // then measured, the total height grows, and the view is left ABOVE the
    // true bottom — the visible "flash then not at the bottom". Two frames
    // isn't enough for tall rows to finish measuring. So re-pin every frame
    // until scrollHeight stops changing (measurement done), with a safety cap
    // to guarantee termination.
    settlingRef.current = true;
    let lastHeight = -1;
    let stableFrames = 0;
    let frames = 0;
    const step = () => {
      const el = containerRef.current;
      if (!el || !settlingRef.current) return;
      el.scrollTop = el.scrollHeight;
      if (el.scrollHeight === lastHeight) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
        lastHeight = el.scrollHeight;
      }
      frames += 1;
      // Done once the height has held steady for a few frames, or after a
      // ~1s cap (60 frames) as an unconditional backstop.
      if (stableFrames >= 3 || frames >= 60) {
        settlingRef.current = false;
        scrollDebug('scroll-settled', el, { frames, scrollHeight: el.scrollHeight });
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, [totalCount]);

  // Derive first/last message identity from messages.
  const firstId = messages.length > 0 ? messages[0].messageId : null;
  const lastId = messages.length > 0 ? messages[messages.length - 1].messageId : null;

  // Auto-scroll on new messages — but NOT when the user has scrolled up to read
  // history, and NOT when older history is prepended at the top.
  useIsomorphicLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // ① Thread switch: restore previous position for this session if saved, else scroll to bottom
    if (currentSessionId !== prevSessionRef.current) {
      if (prevSessionRef.current && el) {
        sessionScrollPositions.set(prevSessionRef.current, el.scrollTop);
      }
      prevSessionRef.current = currentSessionId;
      prevLengthRef.current = messages.length;
      prevFirstIdRef.current = firstId;
      prevLastIdRef.current = lastId;
      prevScrollHeightRef.current = null;
      prevScrollTopRef.current = null;
      lastScrollTopRef.current = 0;
      settlingRef.current = false; // cancel any in-flight settle from the old session
      setUnseenCount(0);

      const savedScroll = currentSessionId ? sessionScrollPositions.get(currentSessionId) : undefined;
      if (savedScroll !== undefined && savedScroll > 0) {
        userScrolledUpRef.current = true;
        setShowScrollBtn(true);
        requestAnimationFrame(() => {
          if (el) el.scrollTop = savedScroll;
        });
      } else if (lastReadIndex > 0) {
        userScrolledUpRef.current = true;
        setShowScrollBtn(true);
        requestAnimationFrame(() => {
          virtualizer.scrollToIndex(lastReadIndex, { align: 'start' });
        });
      } else {
        userScrolledUpRef.current = false;
        setShowScrollBtn(false);
        requestAnimationFrame(() => scrollToBottom());
      }
      return;
    }

    // ② Prepend detection: count grew, the first message changed, but the last
    //    message is unchanged → older history loaded at the top. Never scroll to bottom.
    const grew = messages.length > prevLengthRef.current;
    const isPrepend = grew && firstId !== prevFirstIdRef.current && lastId === prevLastIdRef.current;
    const addedCount = grew ? messages.length - prevLengthRef.current : 0;
    prevLengthRef.current = messages.length;
    prevFirstIdRef.current = firstId;
    prevLastIdRef.current = lastId;
    if (isPrepend) {
      if (prevScrollHeightRef.current !== null) {
        const delta = el.scrollHeight - prevScrollHeightRef.current;
        if (delta > 0) {
          el.scrollTop = (prevScrollTopRef.current ?? el.scrollTop) + delta;
          lastScrollTopRef.current = el.scrollTop;
          scrollDebug('history-prepend-compensate', el, {
            prevScrollHeight: prevScrollHeightRef.current,
            newScrollHeight: el.scrollHeight,
            delta,
            newScrollTop: el.scrollTop,
          });
        }
        prevScrollHeightRef.current = null;
        prevScrollTopRef.current = null;
      }
      scrollDebug('history-prepend', el, { messageCount: messages.length, totalCount });
      return;
    }

    // ③ Append / replace / new (streamed) message: follow only when the user is
    //    already near the bottom.
    if (userScrolledUpRef.current) {
      if (grew && !isPrepend) {
        setUnseenCount((c) => c + addedCount);
      }
      scrollDebug('append-skip-userUp', el, { messageCount: messages.length, totalCount });
      return;
    }
    scrollDebug('append-follow', el, { messageCount: messages.length, totalCount });
    requestAnimationFrame(() => scrollToBottom());
  }, [messages.length, currentSessionId, firstId, lastId, totalCount, scrollToBottom]);

  // Force scroll when scrollKey *actually* changes (user sent a message, clicked
  // "New messages", or a backfill bumped it). Guard on the real value so a mere
  // scrollToBottom identity change (from a message-count change such as history
  // prepend) does not re-trigger a scroll-to-bottom.
  useEffect(() => {
    if (scrollKey !== prevScrollKeyRef.current) {
      prevScrollKeyRef.current = scrollKey;
      userScrolledUpRef.current = false;
      scrollDebug('scrollKey-change', containerRef.current, { scrollKey });
      requestAnimationFrame(() => scrollToBottom());
    }
  }, [scrollKey, scrollToBottom]);

  // Track scroll position for "scroll to bottom" button + infinite scroll upward
  const loadingOlderInternalRef = useRef(false);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onScroll = async () => {
      const currentScrollTop = el.scrollTop;
      if (currentSessionId) {
        sessionScrollPositions.set(currentSessionId, currentScrollTop);
      }
      const isScrollingUp = currentScrollTop < lastScrollTopRef.current;
      const isNearBottom = el.scrollHeight - currentScrollTop - el.clientHeight < 100;
      setShowScrollBtn(!isNearBottom);
      userScrolledUpRef.current = !isNearBottom;
      if (isNearBottom) {
        setUnseenCount(0);
      }

      // Infinite scroll: ONLY trigger when user is actively scrolling UP and is near the top
      if (
        isScrollingUp &&
        currentScrollTop < 30 &&
        hasOlder &&
        !loadingOlder &&
        !loadingOlderInternalRef.current &&
        loadOlder
      ) {
        loadingOlderInternalRef.current = true;
        prevScrollHeightRef.current = el.scrollHeight;
        prevScrollTopRef.current = currentScrollTop;
        scrollDebug('load-older-start', el, { prevScrollHeight: el.scrollHeight, currentScrollTop });
        try {
          await loadOlder();
        } finally {
          loadingOlderInternalRef.current = false;
          setTimeout(() => {
            prevScrollHeightRef.current = null;
            prevScrollTopRef.current = null;
          }, 500);
        }
      }

      lastScrollTopRef.current = currentScrollTop;
    };

    // A real user scroll gesture cancels any in-flight settle-to-bottom so we
    // never yank them back while they're reading. Measurement-driven reflows
    // (which are what the settle loop exists to absorb) don't fire these.
    const cancelSettle = () => { settlingRef.current = false; };

    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', cancelSettle, { passive: true });
    el.addEventListener('touchmove', cancelSettle, { passive: true });
    el.addEventListener('mousedown', cancelSettle);
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', cancelSettle);
      el.removeEventListener('touchmove', cancelSettle);
      el.removeEventListener('mousedown', cancelSettle);
    };
  }, [hasOlder, loadingOlder, loadOlder, currentSessionId]);

  // Re-stick to bottom when late images/diagrams finish rendering and user is tailing
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (!userScrolledUpRef.current) {
        scrollToBottom();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [scrollToBottom]);

  /*
    Reveal a message the trace panel pointed at.
  */
  useEffect(() => {
    const onReveal = async (e: Event) => {
      const id = (e as CustomEvent<{ messageId?: string }>).detail?.messageId;
      if (!id) return;
      let index = groups.findIndex((g) =>
        g.type === 'chat'
          ? g.message.messageId === id || g.steps?.some((st) => st.messageId === id)
          : g.type === 'thinking' || g.type === 'steps'
            ? g.messages.some((m) => m.messageId === id)
            : g.type === 'speech_act'
              ? g.message.messageId === id
              : false,
      );
      if (index < 0 && hasOlder && loadOlder) {
        await loadOlder();
        index = groups.findIndex((g) =>
          g.type === 'chat'
            ? g.message.messageId === id || g.steps?.some((st) => st.messageId === id)
            : g.type === 'thinking' || g.type === 'steps'
              ? g.messages.some((m) => m.messageId === id)
              : g.type === 'speech_act'
                ? g.message.messageId === id
                : false,
        );
      }
      if (index < 0) return;
      userScrolledUpRef.current = true; // a deliberate jump is not "tailing"
      virtualizer.scrollToIndex(index, { align: 'center' });
    };
    window.addEventListener(TRANSCRIPT_REVEAL_EVENT, onReveal);
    return () => window.removeEventListener(TRANSCRIPT_REVEAL_EVENT, onReveal);
  }, [groups, virtualizer, hasOlder, loadOlder]);

  /*
    Which tick is lit. Derived during render from the rows the virtualizer has
    mounted (it re-renders on scroll anyway), picking the one nearest the
    vertical centre of the viewport. No scroll listener of its own.
  */
  const activeRailId = (() => {
    if (railItems.length === 0) return '';
    const viewportHeight = containerRef.current?.clientHeight ?? 0;
    const centre = (virtualizer.scrollOffset ?? 0) + viewportHeight / 2;
    let nearestId = '';
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const row of virtualizer.getVirtualItems()) {
      const id = railIdByIndex.get(row.index);
      if (!id) continue;
      const distance = Math.abs(row.start + row.size / 2 - centre);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestId = id;
      }
    }
    return nearestId;
  })();

  return (
    <div className="relative flex-1 min-h-0">
      <PreviewRail
        items={railItems.length > 1 ? railItems : []}
        label="Transcript navigation"
        activeId={activeRailId}
        onItemSelect={handleRailSelect}
        previewSide="after"
        highlightActive
        itemSize={14}
        className="h-full min-h-0 overflow-hidden"
        previewContainerClassName="left-8 right-3"
        previewClassName="mr-1 w-64 max-w-full [&_[data-slot=preview-rail-card]]:h-20 [&_[data-slot=preview-rail-card]]:overflow-hidden [&_[data-slot=preview-rail-card]]:p-3 [&_[data-slot=preview-rail-title]]:line-clamp-1 [&_[data-slot=preview-rail-title]]:text-xs [&_[data-slot=preview-rail-title]]:leading-4 [&_[data-slot=preview-rail-description]]:line-clamp-2 [&_[data-slot=preview-rail-description]]:text-xs [&_[data-slot=preview-rail-description]]:leading-4"
        railClassName={cn(
          'absolute inset-y-3 left-1 w-7 content-center py-1 [&_[data-slot=preview-rail-item]]:w-7 [&_[data-slot=preview-rail-item]]:justify-start [&_[data-slot=preview-rail-tick]]:h-px [&_[data-slot=preview-rail-tick]]:w-4 [&_[data-slot=preview-rail-tick]]:origin-left',
          railItems.length > 1 ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
        )}
      >
      <div
        ref={containerRef}
        className={cn('h-full overflow-y-auto scroll-fade-top', className)}
      >
        {/* The last ring spinner in the transcript. globals.css says there is
            one "still going" signal in this app and it is `.event-running`;
            a rotating ring at the top of the scroller was a second one, in the
            one place where the reader is already looking at running text. */}
        {loadingOlder && (
          <div className="flex items-center justify-center py-3">
            <span className="event-running text-2xs text-foreground-muted">Loading earlier messages</span>
          </div>
        )}
        {hasOlder && !loadingOlder && loadOlder && (
          <div className="flex items-center justify-center py-2">
            <button
              onClick={async () => {
                const el = containerRef.current;
                if (!el || loadingOlder || !loadOlder) return;
                prevScrollHeightRef.current = el.scrollHeight;
                prevScrollTopRef.current = el.scrollTop;
                scrollDebug('load-older-start(button)', el, { prevScrollHeight: el.scrollHeight, scrollTop: el.scrollTop });
                try {
                  await loadOlder();
                } finally {
                  setTimeout(() => {
                    prevScrollHeightRef.current = null;
                    prevScrollTopRef.current = null;
                  }, 500);
                }
              }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              Load older messages
            </button>
          </div>
        )}
        <div
          /* beUI's viewport padding: `px-3 py-5 sm:px-5`. */
          className="mx-auto w-full max-w-(--chat-column) px-3 py-5 sm:px-5"
          role="log"
          aria-live="polite"
          style={{
            height: virtualizer.getTotalSize(),
            position: 'relative',
          }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const index = virtualRow.index;

            // Loading indicator row (last virtual item when loading)
            if (index >= groups.length) {
              return (
                <div
                  key="loading-indicator"
                  ref={measureRow}
                  data-index={index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  {/*
                    Acknowledge the send immediately and say who is handling it.
                    This row used to be a 32px empty spacer next to seven 2px
                    animated bars: it was technically present the whole time an
                    agent was working, but with no avatar and no words it read as
                    blank space, so sending a message looked like nothing had
                    happened until the finished answer appeared.
                  */}
                  {(() => {
                    const pending = loadingMessages[0];
                    const pendingName = pending?.senderName || 'Agent';
                    const pendingAgent = agents?.find((a) => a.agentName === pendingName);

                    // An offline agent is not working on anything. Without this
                    // check the row kept animating after the connector dropped,
                    // so the header read "antigravity Working" at the same time
                    // as the banner read "No agents are online" — and the user
                    // had no way to tell which one was lying.
                    if (pendingAgent && pendingAgent.status !== 'online') {
                      return null;
                    }

                    // ...and this agent is not ALREADY reporting for itself
                    // further up. Once it starts emitting thinking or tool
                    // steps, `IntermediateSteps` renders its own live-edge row
                    // and `ThinkingMessage` shimmers its own label — so keeping
                    // this acknowledgement alive meant one working agent
                    // announced itself twice on adjacent lines (plus a third
                    // time in the channel header). This row's job is to cover
                    // the gap BEFORE the first step arrives; after that it is
                    // someone else's turn to speak.
                    const alreadyReporting = groups.some((g) =>
                      g.type === 'thinking'
                        ? !g.settled && g.sender === pendingName
                        : g.type === 'steps'
                          ? !g.settled && g.messages[0]?.senderName === pendingName
                          : false
                    );
                    if (alreadyReporting) return null;

                    return (
                      <div className="flex items-start gap-3 py-1">
                        <AgentAvatar
                          name={pendingName}
                          agentType={pendingAgent?.agentType}
                          size={32}
                          square
                          className="mt-1 shrink-0"
                        />
                        <div className="flex items-baseline gap-2 py-1.5 min-w-0">
                          <span className="text-xs font-semibold text-foreground truncate">{pendingName}</span>
                          <WorkingIndicator
                            label="Starting"
                            startTime={
                              pending?.createdAt ? new Date(pending.createdAt).getTime() : undefined
                            }
                          />
                        </div>
                      </div>
                    );
                  })()}
                </div>
              );
            }

            const group = groups[index];
            const isLastReadBoundary = index === lastReadIndex;
            return (
              <div
                key={groupKey(group, index)}
                ref={measureRow}
                data-index={index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {isLastReadBoundary && (
                  <div className="my-4 flex items-center gap-3 select-none" role="separator" aria-label="You last read here">
                    <div className="h-px flex-1 bg-border/60" />
                    <span className="text-3xs font-medium uppercase tracking-wider text-muted-foreground bg-surface2 px-2.5 py-0.5 rounded-full border border-border/60">
                      You last read here
                    </span>
                    <div className="h-px flex-1 bg-border/60" />
                  </div>
                )}
                {group.type === 'chat' ? (
                  (() => {
                    const approvalRequest = group.message.metadata?.tool_approval_request;
                    const approvalId = approvalRequest?.approval_id;
                    const isApproved = approvalId ? approvalResponses.get(approvalId) === true : false;
                    const isRejected = approvalId ? approvalResponses.get(approvalId) === false : false;

                    const meta = group.message.metadata;
                    const hasCard =
                      (Array.isArray(meta?.questions) && meta.questions.length > 0) ||
                      (Array.isArray(meta?.decision_questions) && meta.decision_questions.length > 0);
                    const isDecisionAnswered = Boolean(
                      hasCard &&
                      group.message.messageId &&
                      answeredDecisionIds.has(group.message.messageId)
                    );

                    return (
                      <ChatMessage
                        message={group.message}
                        agents={agents}
                        isApproved={isApproved}
                        isRejected={isRejected}
                        steps={group.steps}
                        hideHeader={group.continuesFrom}
                        isDecisionAnswered={isDecisionAnswered}
                        savedDecisionAnswers={group.message.messageId ? answeredDecisions.get(group.message.messageId) : undefined}
                        isLast={index === groups.length - 1}
                        isStreaming={
                          index === groups.length - 1 &&
                          isChannelActive &&
                          !hasTerminalStatus &&
                          group.message.messageType === 'chat' &&
                          (group.message.createdAt ? Date.now() - new Date(group.message.createdAt).getTime() < 12_000 : true)
                        }
                        isIntermediate={group.isIntermediate}
                        workingDir={workingDir}
                        onRegenerate={onRegenerate}
                        onQuoteReply={onQuoteReply}
                        onReusePrompt={onReusePrompt}
                      />
                    );
                  })()
                ) : group.type === 'daybreak' ? (
                  <div className="py-3 select-none" role="separator">
                    {/* beUI `MessageMarker`: a centred pill, not a rule with a
                        label punched through it. */}
                    <div className="mx-auto flex w-fit max-w-[88%] items-center gap-1.5 rounded-full bg-muted/70 px-2.5 py-1 text-center text-xs text-muted-foreground">
                      {group.label}
                    </div>
                  </div>
                ) : group.type === 'speech_act' ? (
                  <SpeechActEvent
                    message={group.message}
                    actType={group.actType}
                    summary={group.summary}
                  />
                ) : group.type === 'thinking' ? (
                  <ThinkingMessage
                    sender={group.sender}
                    messages={group.messages}
                    agents={agents}
                    settled={group.settled}
                  />
                ) : (
                  <IntermediateSteps
                    steps={group.messages}
                    agents={agents}
                    isActive={!group.settled && index === groups.length - 1}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
      </PreviewRail>

      {showScrollBtn && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-20">
          <Button
            variant="secondary"
            size="sm"
            className="rounded-full shadow-lg border border-border/60 bg-surface2 hover:bg-surface3 text-foreground transition-all duration-150"
            onClick={() => {
              scrollDebug('user-click-scroll-bottom', containerRef.current);
              userScrolledUpRef.current = false;
              setUnseenCount(0);
              scrollToBottom();
            }}
          >
            <ArrowDown className="size-3.5 mr-1.5" />
            <span>
              {unseenCount > 0 ? `${unseenCount} new message${unseenCount > 1 ? 's' : ''}` : 'Scroll to bottom'}
            </span>
          </Button>
        </div>
      )}
    </div>
  );
}
