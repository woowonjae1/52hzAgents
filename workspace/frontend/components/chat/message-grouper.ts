import { isThinkingText } from './message-kinds';
import { deduplicateAndSortMessages } from '@/lib/types';
import type { WorkspaceMessage } from '@/lib/types';

/** Two messages belong to one burst if they are less than this far apart. */
export const BURST_WINDOW_MS = 5 * 60_000;

export function withinBurst(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return false;
  return Math.abs(tb - ta) < BURST_WINDOW_MS;
}

export type MessageGroup =
  // `continuesFrom` is set when this message is preceded by its own thinking or
  // steps group. That group already printed the avatar and sender name, so this
  // one suppresses its header instead of printing a second identical one.
  // `isIntermediate` is set when this chat message is followed by more work
  // (thinking/status) from the same sender — i.e. it is a mid-run announcement
  // rather than the final answer. Used to suppress the action bar.
  | { type: 'chat'; message: WorkspaceMessage; steps?: WorkspaceMessage[]; continuesFrom?: boolean; isIntermediate?: boolean }
  | { type: 'speech_act'; message: WorkspaceMessage; actType: string; summary?: string }
  // `settled` means the agent has since posted its reply, so the trace below is
  // history rather than live output.
  | { type: 'thinking'; sender: string; messages: WorkspaceMessage[]; settled?: boolean }
  | { type: 'steps'; messages: WorkspaceMessage[]; settled?: boolean }
  /*
    A DAY BOUNDARY IN THE TRANSCRIPT.
    Messages carry a clock time and nothing else — `15:23`. In a channel that
    has been running for a week, scrolling up gives you a column of times with
    no way to tell which day any of them belongs to.
  */
  | { type: 'daybreak'; key: string; label: string };

export function groupMessages(messages: WorkspaceMessage[], isChannelActive = false): MessageGroup[] {
  const groups: MessageGroup[] = [];
  // Steps and thinking are held PER SENDER: in a multi-agent channel several agents work at
  // once, and a reply from one of them must not absorb another's tool calls or reasoning.
  const pendingSteps = new Map<string, WorkspaceMessage[]>();

  const takeSteps = (sender: string): WorkspaceMessage[] | undefined => {
    const own = pendingSteps.get(sender);
    if (!own || own.length === 0) return undefined;
    pendingSteps.delete(sender);
    return own;
  };

  // Steps / thinking from an agent that never followed up with a message yet (it is still
  // thinking/working) still have to be shown in real-time.
  // When the channel is inactive, orphan steps are marked as settled so historical
  // threads don't show spinning "thinking..." states.
  const flushOrphanSteps = (forceSettled?: boolean) => {
    for (const [sender, own] of pendingSteps) {
      if (own.length === 0) continue;
      const thinkingOnly = own.every(isThinkingText);
      const lastStep = own[own.length - 1];
      const isRecent = lastStep?.createdAt ? Date.now() - new Date(lastStep.createdAt).getTime() < 60_000 : false;
      const isSettled = forceSettled || !isChannelActive || !isRecent;
      if (thinkingOnly) {
        groups.push({ type: 'thinking', sender, messages: [...own], settled: isSettled });
      } else {
        groups.push({ type: 'steps', messages: [...own], settled: isSettled });
      }
    }
    pendingSteps.clear();
  };

  const dedupedMessages = deduplicateAndSortMessages(messages);
  const visibleMessages = dedupedMessages.filter(
    (msg) => !msg.content.startsWith('__queue_cancel:')
  );

  visibleMessages.forEach((msg) => {
    const isHuman =
      msg.senderType === 'human' ||
      msg.senderType === 'user' ||
      msg.senderName === 'user' ||
      msg.senderName === 'Guest';

    if (isHuman) {
      // A new user prompt marks the start of a new conversational turn.
      // Any prior in-progress or orphan steps from any agent belong to the previous
      // turn and must be flushed as settled history before this user prompt is added.
      flushOrphanSteps(true);
    }

    if (msg.metadata?.speech_act && msg.metadata?.act_type) {
      groups.push({
        type: 'speech_act',
        message: msg,
        actType: String(msg.metadata.act_type),
        summary: msg.metadata.summary ? String(msg.metadata.summary) : undefined,
      });
    } else if (msg.messageType === 'thinking' || msg.messageType === 'status' || msg.messageType === 'todos') {
      const own = pendingSteps.get(msg.senderName);
      if (own && own.length > 0) {
        const lastStep = own[own.length - 1];
        const gap = msg.createdAt && lastStep.createdAt
          ? new Date(msg.createdAt).getTime() - new Date(lastStep.createdAt).getTime()
          : 0;
        // If there's a gap exceeding the burst window (5 minutes) between consecutive steps,
        // the older steps belonged to an abandoned/prior execution. Flush them as settled.
        if (gap > BURST_WINDOW_MS) {
          const thinkingOnly = own.every(isThinkingText);
          groups.push(
            thinkingOnly
              ? { type: 'thinking', sender: msg.senderName, messages: [...own], settled: true }
              : { type: 'steps', messages: [...own], settled: true }
          );
          pendingSteps.set(msg.senderName, [msg]);
        } else {
          own.push(msg);
        }
      } else {
        pendingSteps.set(msg.senderName, [msg]);
      }
    } else {
      const own = takeSteps(msg.senderName);
      if (own) {
        const thinkingOnly = own.every(isThinkingText);
        groups.push(
          thinkingOnly
            ? { type: 'thinking', sender: msg.senderName, messages: own, settled: true }
            : { type: 'steps', messages: own, settled: true }
        );
      }
      /*
        CONSECUTIVE MESSAGES FROM ONE SENDER SHARE AN IDENTITY LINE.
        Identity is printed once per burst, and the continuation rows keep the avatar's indent.
      */
      const prev = groups[groups.length - 1];
      const sameSpeakerBurst =
        !own &&
        prev?.type === 'chat' &&
        prev.message.senderName === msg.senderName &&
        prev.message.senderType === msg.senderType &&
        !prev.message.metadata?.speech_act &&
        withinBurst(prev.message.createdAt, msg.createdAt);

      groups.push({ type: 'chat', message: msg, continuesFrom: Boolean(own) || sameSpeakerBurst });
    }
  });

  flushOrphanSteps();

  /*
    MARK INTERMEDIATE CHAT MESSAGES.
    A chat message followed by more thinking/steps from the same sender is a mid-run announcement.
  */
  for (let i = 0; i < groups.length - 1; i++) {
    const g = groups[i];
    if (g.type !== 'chat') continue;
    const next = groups[i + 1];
    if (!next) continue;
    const nextSender =
      next.type === 'thinking' ? next.sender
      : next.type === 'steps' ? next.messages[0]?.senderName
      : null;
    if (nextSender && nextSender === g.message.senderName) {
      g.isIntermediate = true;
    }
  }

  /*
    Insert day separators based on date boundaries between consecutive rendered items.
  */
  const withDays: MessageGroup[] = [];
  let lastDay: string | null = null;
  for (const g of groups) {
    const iso =
      g.type === 'chat' || g.type === 'speech_act'
        ? g.message.createdAt
        : g.type === 'thinking' || g.type === 'steps'
          ? g.messages[0]?.createdAt
          : null;
    const day = dayKeyOf(iso);
    if (day && day !== lastDay) {
      if (lastDay !== null) {
        withDays.push({ type: 'daybreak', key: day, label: dayLabel(iso!) });
      }
      lastDay = day;
    }
    withDays.push(g);
  }
  return withDays;
}

/**
 * "Today" / "Yesterday" / a written date. Calendar days, not rolling 24h windows.
 */
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const dayStart = start.getTime();
  const t = d.getTime();
  if (t >= dayStart) return 'Today';
  if (t >= dayStart - 86_400_000) return 'Yesterday';
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: d.getFullYear() === start.getFullYear() ? undefined : 'numeric',
  });
}

export function dayKeyOf(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function groupKey(group: MessageGroup, index: number): string {
  if (group.type === 'daybreak') {
    return `day-${group.key}`;
  }
  if (group.type === 'chat') {
    return group.message.messageId ? `chat-${group.message.messageId}` : `chat-idx-${index}`;
  }
  if (group.type === 'speech_act') {
    return group.message.messageId ? `speech-act-${group.message.messageId}` : `speech-act-idx-${index}`;
  }
  const firstId = group.messages[0]?.messageId;
  if (group.type === 'thinking') {
    return firstId ? `thinking-${firstId}` : `thinking-idx-${index}`;
  }
  return firstId ? `steps-${firstId}` : `steps-idx-${index}`;
}

export function normalizeForDedup(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]+/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}(?:[-+*]|\d{1,3}[.)])\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\.{3,}$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export const MIN_ECHO = 24;

export function isEchoOfReply(thinking: string, reply: string): boolean {
  const t = normalizeForDedup(thinking);
  const r = normalizeForDedup(reply);
  if (!t || !r) return false;
  if (t.length >= MIN_ECHO && r.includes(t)) return true;
  if (r.length >= MIN_ECHO && t.includes(r)) return true;
  return t.length >= MIN_ECHO && r.startsWith(t.slice(0, MIN_ECHO));
}

export function isTerminalStatus(msg: WorkspaceMessage): boolean {
  return /stopped|stopping failed|execution stopped/i.test(msg.content);
}
