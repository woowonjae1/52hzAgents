import type { WorkspaceMessage } from '@/lib/types';

/**
 * A structured tool call: a message carrying `metadata.tool_name` (or one of
 * its older aliases).
 *
 * Adapters send these through `sendToolCall`, which posts them as
 * `messageType: 'thinking'` so they survive the transcript's "only the last
 * status" pruning. That makes `messageType` alone useless for telling a tool
 * call from reasoning: every place that joins thinking text into one block has
 * to exclude these first, or a run of calls renders as
 * "run_command run_command view_file ..." inside a Thought box.
 */
export function isToolCallMessage(m: WorkspaceMessage): boolean {
  const tool = m.metadata?.tool_name ?? m.metadata?.tool ?? m.metadata?.tool_call;
  return typeof tool === 'string' && tool.trim() !== '';
}

/** Reasoning text (or a streamed reply preview) — `thinking` that is not a tool call. */
export function isThinkingText(m: WorkspaceMessage): boolean {
  return m.messageType === 'thinking' && !isToolCallMessage(m);
}
