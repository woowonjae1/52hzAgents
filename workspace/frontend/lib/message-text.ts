/**
 * Split an agent message into its inline reasoning and its answer. Shared by
 * the transcript (chat-message.tsx) and the Outputs panel, which must agree on
 * what counts as the answer when it looks for deliverables.
 */
export function extractThinking(text: string): { thinking: string | null; answer: string; isStreamingThink?: boolean } {
  if (!text || typeof text !== 'string') return { thinking: null, answer: text || '', isStreamingThink: false };

  // 1. Tag-based thinking: <think>...</think> or <thinking>...</thinking>
  const tagRegex = /<(?:think|thinking)>([\s\S]*?)<\/(?:think|thinking)>/i;
  const thinkMatch = text.match(tagRegex);
  if (thinkMatch) {
    const thinking = thinkMatch[1].trim();
    const answer = text.replace(tagRegex, '').trim();
    return { thinking, answer, isStreamingThink: false };
  }

  // 2. Open thinking tag while streaming: <think>... (not yet closed)
  if (/^<(?:think|thinking)>/i.test(text)) {
    const thinking = text.replace(/^<(?:think|thinking)>/i, '').trim();
    return { thinking, answer: '', isStreamingThink: true };
  }

  // 3. Explicit Thought headers at the start: e.g. "Thought:\n..."
  const headerPrefix = text.match(/^(?:(?:\*\*|\*|#+)?\s*(?:Thought|Thinking Process|Reasoning|Planning Process|思考过程)\s*(?:\*\*|\*|#+)?:?\s*\n+)/i);
  if (headerPrefix) {
    const rest = text.slice(headerPrefix[0].length);
    const answerDivider = rest.match(/\n+(?:(?:\*\*|\*|#+)?\s*(?:Answer|Deliverable|Response|Final Response|回答|总结|结论)\s*(?:\*\*|\*|#+)?:?\s*\n+|#{1,3}\s+|经过|基于|根据|Here is|Based on)/i);
    if (answerDivider && answerDivider.index !== undefined) {
      const thinking = rest.slice(0, answerDivider.index).trim();
      const answer = rest.slice(answerDivider.index).trim();
      return { thinking, answer, isStreamingThink: false };
    }
  }

  return { thinking: null, answer: text, isStreamingThink: false };
}
