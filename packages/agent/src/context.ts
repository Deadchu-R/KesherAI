import type { AgentMessage } from "@kesher/shared";

/**
 * Keeping long conversations within what a model can read, without losing
 * what matters. The conversation itself is never changed or deleted; only
 * the copy sent to the model is fitted:
 *
 * 1. Long outputs of older tool calls are shortened (their start and end
 *    are kept — that is where errors and results are).
 * 2. If it is still too long, the oldest part is replaced by a summary the
 *    model wrote of it, and the recent turns are sent word for word.
 */

/** About four characters per token for English and code; Hebrew is a little denser. */
export const CHARS_PER_TOKEN = 4;
/** The most recent messages are always sent in full. */
const KEEP_FULL = 8;

/** @returns Approximate size of messages, in characters. */
export function sizeOf(messages: readonly AgentMessage[]): number {
  // A picture costs about as much as 6000 characters of text.
  return messages.reduce((n, m) => n + m.content.length + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0) + (m.images?.length ?? 0) * 6000 + 16, 0);
}

/**
 * Shortens the outputs of older tool calls.
 *
 * The line between shortened and full moves in steps of `step` messages, not with every message: a local engine
 * keeps what it already read only up to the first change, so a line that moved every turn made it read thousands
 * of tokens again on each step (found on the PC: 6,345 tokens, 53 s per step, with Qwen3.6).
 *
 * @param messages - The conversation.
 * @param keepFull - How many recent messages stay untouched (at least).
 * @param step - How many messages the line moves at a time (1: every message).
 * @returns A copy with long older tool outputs cut to their start and end.
 */
export function shortenOldToolOutputs(messages: readonly AgentMessage[], keepFull = KEEP_FULL, step = 1): AgentMessage[] {
  const line = Math.floor(Math.max(0, messages.length - keepFull) / Math.max(1, step)) * Math.max(1, step);
  return messages.map((m, i) =>
    i < line && m.role === "tool" && m.content.length > 1500
      ? { ...m, content: `${m.content.slice(0, 700)}\n… [shortened to save space; the full output is still in the conversation] …\n${m.content.slice(-500)}` }
      : m,
  );
}

/**
 * Where to cut so the part after it fits: always at a user message, so a
 * tool call is never separated from its result.
 *
 * @param messages - Shortened messages.
 * @param budget - Characters the recent part may use.
 * @returns Index of the first message to keep in full, or 0 if everything fits.
 */
export function cutPoint(messages: readonly AgentMessage[], budget: number): number {
  if (sizeOf(messages) <= budget) return 0;
  const users = messages.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i > 0);
  for (const i of users) if (sizeOf(messages.slice(i)) <= budget) return i;
  return users.at(-1) ?? 0;
}

/**
 * Writes the older part of a conversation as plain text for summarising.
 *
 * @param messages - The part to summarise.
 * @param maxChars - Budget for the transcript.
 * @returns A transcript.
 */
export function transcript(messages: readonly AgentMessage[], maxChars: number): string {
  const lines = messages.map((m) => {
    const who = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : m.role === "tool" ? `Tool ${m.toolName ?? ""} result` : "System";
    const calls = m.toolCalls?.length ? ` [called: ${m.toolCalls.map((c) => `${c.name}(${JSON.stringify(c.arguments).slice(0, 200)})`).join(", ")}]` : "";
    return `${who}: ${m.content.slice(0, 1500)}${calls}`;
  });
  let text = lines.join("\n\n");
  // Keep the end if it is still too long: the latest of the old part matters most.
  if (text.length > maxChars) text = `…\n${text.slice(-maxChars)}`;
  return text;
}

/** The instruction for writing a summary. */
export const SUMMARY_PROMPT =
  "Summarise the conversation below so the assistant can continue it without the full text. Keep: what the user wants and decided, facts and preferences they gave, names of files, folders, programs and commands that matter, what was built or changed and where, errors met and how they were solved, and what is still open. Write it as short bullet points in the user's language. Do not add anything that is not in the conversation.";
