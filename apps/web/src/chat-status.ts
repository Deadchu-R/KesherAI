/** "/status" in the message box: the chat's model, how much context the last call used, and the tokens so far. */

/** The usage events this reads (as the chat sends them). */
export type UsageLike = { type: string } & ({ type: "usage"; role: string; input: number; output: number } | object);

/**
 * Adds up a chat's usage.
 *
 * @param events - The chat's events.
 * @returns The last main call's prompt size (the context in use), and all input and output tokens.
 */
export function chatStatus(events: UsageLike[]): { context: number; input: number; output: number; calls: number } {
  let context = 0;
  let input = 0;
  let output = 0;
  let calls = 0;
  for (const e of events) {
    if (e.type !== "usage" || !("input" in e)) continue;
    const u = e as { role: string; input: number; output: number };
    calls++;
    input += u.input;
    output += u.output;
    if (u.role === "main") context = u.input;
  }
  return { context, input, output, calls };
}

/** 12345 → "12.3K". */
export const kTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}K` : String(n));
