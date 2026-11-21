/**
 * Messages typed while a chat is working (docs/FEATURE_REVIEW.md, 2026-11-21 "Chat and UI"; as Jan 0.8 and Cursor):
 * they wait as chips under the message box, where each can be edited, removed or sent now. In "steer" mode (or after
 * "Send now") a message is not kept for after the answer: it goes into the running turn at the model's next step.
 * Pure helpers, used by the server's queue (conversations.ts), the agent loop (session.ts) and the page's Stop button.
 */

/** One waiting message. `steer`: it goes into the running turn at its next step, not after the answer. */
export interface QueuedMessage {
  id: string;
  text: string;
  steer?: boolean;
}

/** What a message typed while the chat works does: waits for the answer (`queue`) or joins the running turn (`steer`). */
export type QueueMode = "queue" | "steer";

/** The longest queued message kept (the same as one typed message is allowed to be). */
export const QUEUED_MAX_CHARS = 100_000;

/**
 * Changes a waiting message's text.
 *
 * @param list - The queue.
 * @param id - The message to change.
 * @param text - Its new text (trimmed; empty is refused).
 * @returns The new queue, or `undefined` when the message is not there or the text is empty.
 */
export function editQueued<T extends QueuedMessage>(list: readonly T[], id: string, text: string): T[] | undefined {
  const clean = text.trim().slice(0, QUEUED_MAX_CHARS);
  if (!clean || !list.some((q) => q.id === id)) return undefined;
  return list.map((q) => (q.id === id ? { ...q, text: clean } : q));
}

/**
 * "Send now": the message goes first, marked to join the running turn at its next step.
 *
 * @param list - The queue.
 * @param id - The message.
 * @returns The new queue, or `undefined` when the message is not there.
 */
export function sendNowQueued<T extends QueuedMessage>(list: readonly T[], id: string): T[] | undefined {
  const hit = list.find((q) => q.id === id);
  if (!hit) return undefined;
  return [{ ...hit, steer: true }, ...list.filter((q) => q.id !== id)];
}

/**
 * Takes the messages that join the running turn now (the agent loop calls it before each step).
 *
 * @param list - The queue.
 * @returns The steering messages in order, and the queue without them.
 */
export function takeSteers<T extends QueuedMessage>(list: readonly T[]): { steer: T[]; rest: T[] } {
  return { steer: list.filter((q) => q.steer), rest: list.filter((q) => !q.steer) };
}

/**
 * The two-stage Stop: with messages waiting, the first press clears them and the answer goes on; the next press
 * stops the answer.
 *
 * @param queued - How many messages wait.
 * @param paused - Whether the queue already waits for the user (after an earlier Stop).
 * @returns `clear` to empty the queue, `stop` to stop the answer.
 */
export function stopStage(queued: number, paused?: boolean): "clear" | "stop" {
  return queued > 0 && !paused ? "clear" : "stop";
}
