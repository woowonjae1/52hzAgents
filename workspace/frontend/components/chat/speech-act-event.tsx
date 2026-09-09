'use client';

import { Gavel, HelpCircle, Lightbulb, MessageSquare, Shield, ThumbsUp } from 'lucide-react';
import type { ReactNode } from 'react';
import { EventLine } from '@/components/ai-elements/event-line';
import type { WorkspaceMessage } from '@/lib/types';

/**
 * ONE MOVE IN A COUNCIL DEBATE.
 *
 * A speech act is a message an agent contributed to a structured deliberation —
 * it proposed something, challenged a proposal, defended its own, backed
 * someone else's, or closed the debate. The transcript needs to show WHICH of
 * those it was, because a challenge and a resolution mean different things for
 * what the reader should do next.
 *
 * This shipped as a hand-rolled card and it reversed most of the transcript's
 * rules in one place:
 *
 *   - Two emoji (`📜` / `🏛️`) in a UI whose every other glyph is a lucide icon.
 *   - Five decorative hues — blue PROPOSAL, amber CHALLENGE, purple DEFENSE,
 *     emerald SUPPORT, teal RESOLUTION — which is the exact pattern that was
 *     removed from every other event kind. Colour across this transcript is
 *     spent only on `--destructive` and the two diff tokens; five more hues
 *     here made the debate the loudest thing on screen while saying nothing a
 *     word could not.
 *   - `rounded-xl border shadow-sm` plus a tinted fill AND a `ring-1` on the
 *     resolution badge: a background and a border and a ring are three answers
 *     to one question.
 *   - `font-extrabold` + `uppercase tracking-wider` on RESOLUTION, i.e. a
 *     fourth simultaneous emphasis on the same six characters.
 *
 * The act type is IDENTITY, not state — so it is carried by an icon and a word,
 * the same way every other event kind carries what it is. The gavel is the only
 * thing that marks a resolution as the end of the debate, and that is enough:
 * it is the one icon in the set that cannot be mistaken for another move.
 *
 * `alwaysOpen` because the content IS the point here. Every other event kind
 * collapses because its body is machine output the reader usually skips; a
 * debate whose arguments are hidden behind five disclosures is not a debate the
 * reader can follow.
 */
const ACT_KINDS: Record<string, { label: string; icon: ReactNode }> = {
  PROPOSAL: { label: 'Proposal', icon: <Lightbulb /> },
  CHALLENGE: { label: 'Challenge', icon: <HelpCircle /> },
  DEFENSE: { label: 'Defense', icon: <Shield /> },
  SUPPORT: { label: 'Support', icon: <ThumbsUp /> },
  RESOLUTION: { label: 'Resolution', icon: <Gavel /> },
};

/**
 * An unknown act type keeps its raw name rather than being hidden or relabelled
 * "Message" — a new act type the server starts emitting should be visible as
 * itself, not silently flattened into the default case.
 */
function actKind(actType: string): { label: string; icon: ReactNode } {
  return (
    ACT_KINDS[actType] ?? {
      label: actType.charAt(0) + actType.slice(1).toLowerCase(),
      icon: <MessageSquare />,
    }
  );
}

export interface SpeechActEventProps {
  message: WorkspaceMessage;
  actType: string;
  summary?: string;
}

export function SpeechActEvent({ message, actType, summary }: SpeechActEventProps) {
  const { label, icon } = actKind(actType);
  const time = message.createdAt
    ? new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;

  return (
    <EventLine
      icon={icon}
      label={label}
      // Who spoke, not what they spoke about — the summary needs more than the
      // one truncated line the detail chip gives it, so it leads the body.
      detail={message.senderName || 'Council Supervisor'}
      detailMono={false}
      meta={time}
      alwaysOpen
    >
      {summary && <p className="mb-1 font-medium text-foreground">{summary}</p>}
      <p className="whitespace-pre-wrap leading-relaxed text-foreground-muted">
        {message.content}
      </p>
    </EventLine>
  );
}
