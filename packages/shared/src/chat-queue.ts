/**
 * Messages typed while a chat is working (docs/FEATURE_REVIEW.md, 2026-11-21 "Chat and UI"; as Jan 0.8 and Cursor):
 * they wait as chips under the message box, where each can be edited, removed or sent now. In "steer" mode (or after
 * "Send now") a message is not kept for after the answer: it goes into the running turn at the model's next step.
 * Pure helpers, used by the server's queue (conversations.ts), the agent loop (session.ts), the page's composer
 * (Alt+Enter steers) and its Stop button ("Stop and send next" or "Stop and clear queue").
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
 * Moves a waiting message to another place in the queue (its chip's up and down buttons, or dragging it).
 *
 * @param list - The queue.
 * @param id - The message to move.
 * @param to - Its new index; kept inside the queue.
 * @returns The new queue, or `undefined` when the message is not there or would not move.
 */
export function moveQueued<T extends QueuedMessage>(list: readonly T[], id: string, to: number): T[] | undefined {
  const from = list.findIndex((q) => q.id === id);
  if (from < 0 || !Number.isFinite(to)) return undefined;
  const at = Math.max(0, Math.min(list.length - 1, Math.trunc(to)));
  if (at === from) return undefined;
  const next = list.filter((q) => q.id !== id);
  next.splice(at, 0, list[from]!);
  return next;
}

/**
 * Whether a message typed now steers the running turn: only while the chat works and the running turn can take it,
 * when the Steer mode is on or the message was sent with Alt+Enter. Otherwise it waits in the queue.
 *
 * @param p.busy - Whether the chat works now.
 * @param p.mode - The Queue / Steer switch.
 * @param p.alt - Whether it was sent with Alt+Enter.
 * @param p.canSteer - Whether the running turn takes steering (an outside agent does not); `undefined` counts as yes.
 * @returns `true` to steer, `false` to queue (or send at once when the chat is free).
 */
export function wantsSteer(p: { busy: boolean; mode: QueueMode; alt?: boolean; canSteer?: boolean }): boolean {
  return p.busy && p.canSteer !== false && (p.alt === true || p.mode === "steer");
}

/** What Stop does with the waiting messages: send the next one when the answer stops, or clear them all. */
export type StopAfter = "next" | "clear";

/**
 * Whether Stop asks first what to do with the queue ("Stop and send next" or "Stop and clear queue"): only when
 * messages wait and the queue is not already paused by an earlier Stop.
 *
 * @param queued - How many messages wait.
 * @param paused - Whether the queue already waits for the user (after an earlier Stop).
 * @returns `true` to offer the two choices, `false` to stop at once.
 */
export function stopAsks(queued: number, paused?: boolean): boolean {
  return queued > 0 && !paused;
}
