/**
 * The token line under each answer: which model answered, the tokens it read and wrote, and how much of what it
 * read came from the engine's prompt cache. Built from the conversation's `usage` events, so it works the same on
 * the computer and in remote (the phone reads the same events).
 */

/** The fields of a `usage` event this file reads (see `AgentEvent` in packages/shared/src/agent.ts). */
interface UsageLike {
  type: "usage";
  modelId: string;
  role: string;
  input: number;
  output: number;
  estimated: boolean;
  cached?: number;
  cacheWrite?: number;
  pruned?: number;
}

/** One answer's tokens, summed over every model call between the question (or the answer before) and it. */
export interface AnswerTokens {
  /** The main model's id (the last main call; another role's when no main call was made). */
  modelId: string;
  input: number;
  output: number;
  /** Tokens read from the prompt cache; only when at least one call reported it. */
  cached?: number;
  /** The input of the calls that reported `cached` (the base for the cache share). */
  cacheBase?: number;
  /** Tokens written to the prompt cache (Anthropic); only when any. */
  cacheWrite?: number;
  /** Tokens the token budget did not send (pruned tool results, tools over the cap); only when any. */
  pruned?: number;
  /** True when any count was estimated from the text instead of reported by the provider. */
  estimated: boolean;
}

/**
 * Sums the `usage` events of each answer, keyed by the answer's `seq` (the same span as the answer's speed:
 * from the user's message, or the answer before, to this answer).
 *
 * @param events - The conversation's events in order (only `user`, `usage` and `assistant` are read).
 * @returns The tokens per answer `seq`; answers with no `usage` before them are left out.
 */
export function answerTokens(events: ReadonlyArray<{ type: string; seq: number }>): Map<number, AnswerTokens> {
  const out = new Map<number, AnswerTokens>();
  let cur: AnswerTokens | null = null;
  let mainSeen = false;
  for (const e of events) {
    if (e.type === "user") {
      cur = null;
    } else if (e.type === "usage") {
      const u = e as unknown as UsageLike;
      if (!cur) {
        cur = { modelId: u.modelId, input: 0, output: 0, estimated: false };
        mainSeen = false;
      }
      cur.input += u.input;
      cur.output += u.output;
      cur.estimated ||= u.estimated;
      if (u.role === "main" || !mainSeen) cur.modelId = u.modelId;
      if (u.role === "main") mainSeen = true;
      if (typeof u.cacheWrite === "number" && u.cacheWrite > 0) cur.cacheWrite = (cur.cacheWrite ?? 0) + u.cacheWrite;
      if (typeof u.pruned === "number" && u.pruned > 0) cur.pruned = (cur.pruned ?? 0) + u.pruned;
      if (typeof u.cached === "number") {
        cur.cached = (cur.cached ?? 0) + Math.min(u.cached, u.input);
        cur.cacheBase = (cur.cacheBase ?? 0) + u.input;
      }
    } else if (e.type === "assistant" && cur) {
      out.set(e.seq, cur);
      cur = null;
    }
  }
  return out;
}

/**
 * The share of the prompt read from the cache, as a whole percent from 0 to 100.
 *
 * @param cached - Tokens read from the cache.
 * @param input - All prompt tokens of the same calls.
 * @returns The percent, or `undefined` when there is nothing to divide by.
 */
export function cachePercent(cached: number | undefined, input: number | undefined): number | undefined {
  if (cached === undefined || !input || input <= 0) return undefined;
  return Math.round((Math.min(Math.max(cached, 0), input) / input) * 100);
}


/**
 * The tool results the user pinned (the last `tool_pin` event per call decides).
 *
 * @param events - The conversation's events.
 * @returns The pinned call ids.
 */
export function pinnedCalls(events: ReadonlyArray<{ type: string }>): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    if (e.type !== "tool_pin") continue;
    const p = e as unknown as { callId: string; pinned: boolean };
    if (p.pinned) out.add(p.callId);
    else out.delete(p.callId);
  }
  return out;
}
