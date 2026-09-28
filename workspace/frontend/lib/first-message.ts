/**
 * Hand a first message to the chat that is already open.
 *
 * Home's task box starts a session AND sends what was typed. Sending has to go
 * through ChatView's own send path -- it turns the draft into a real channel,
 * attaches the thread's models and Fix/Review mode, and draws the optimistic
 * row -- so Home does not post the message itself; it asks the open chat to.
 * ChatView ignores a request for any session other than the one on screen.
 */
export const SEND_FIRST_MESSAGE_EVENT = 'wwj:send-first-message';

export interface FirstMessageRequest {
  sessionId: string;
  text: string;
}

export function sendFirstMessage(sessionId: string, text: string): void {
  if (typeof window === 'undefined' || !text.trim()) return;
  window.dispatchEvent(
    new CustomEvent<FirstMessageRequest>(SEND_FIRST_MESSAGE_EVENT, { detail: { sessionId, text } }),
  );
}
