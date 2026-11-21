/**
 * The status line under a busy answer (docs/FEATURE_REVIEW.md, 2026-11-21; as Cursor): what the turn is doing now
 * and how long it has run ("Running read_file · 12s", "Waiting for your approval · 1m 05s").
 */

/** What this reads of the chat's events. */
type Ev = {
  type: string; at?: string; seq?: number; callId?: string; name?: string; steered?: boolean; requestId?: string;
  role?: string; output?: number | string; writeMs?: number;
};

/** What a busy turn is doing. */
export interface TurnStatus {
  kind: "approval" | "question" | "tool" | "writing" | "thinking";
  /** The tool running, or the one waiting for approval. */
  tool?: string;
  /** When the turn began (its user message), ISO time. */
  since?: string;
  /** Tool calls made so far in this turn (the running one included): "Step 2". 0 before the first. */
  step: number;
  /** Tokens per second the main model wrote in this turn so far; absent until a model call has reported tokens. */
  tps?: number;
}

/**
 * Speed of the main model over the model calls (`usage` events) of one turn.
 *
 * @param turn - The events of the turn.
 * @returns Tokens per second: written tokens over writing time (reading the prompt is not counted), or undefined
 *   when no call reported tokens and timing.
 */
export function turnSpeed(turn: readonly Ev[]): number | undefined {
  let tokens = 0;
  let ms = 0;
  for (const e of turn) {
    if (e.type !== "usage" || e.role !== "main" || typeof e.output !== "number" || !e.output || !e.writeMs) continue;
    tokens += e.output;
    ms += e.writeMs;
  }
  return tokens > 0 && ms > 200 ? tokens / (ms / 1000) : undefined;
}

/**
 * The events of the turn that is running or ran last: after the last user message that was not a steer.
 *
 * @param events - The chat's events.
 * @returns The user message that began it (or undefined) and what followed it.
 */
function lastTurn(events: readonly Ev[]): { head: Ev | undefined; turn: readonly Ev[] } {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "user" && !e.steered) return { head: e, turn: events.slice(i + 1) };
  }
  return { head: undefined, turn: events };
}

/** What a finished turn shows: "Done in 0:42 · 38 tok/s". */
export interface TurnSummary {
  ms: number;
  tps?: number;
  steps: number;
}

/**
 * How the last turn went, once it has ended.
 *
 * @param events - The chat's events.
 * @returns The duration (from the user message to the last event), speed and tool calls, or undefined when the turn
 *   has no timestamps or did nothing yet.
 */
export function turnSummary(events: readonly Ev[]): TurnSummary | undefined {
  const { head, turn } = lastTurn(events);
  const from = head?.at ? Date.parse(head.at) : NaN;
  const to = turn.length ? Date.parse(turn.at(-1)!.at ?? "") : NaN;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || !turn.some((e) => e.type === "assistant")) return undefined;
  const tps = turnSpeed(turn);
  return { ms: to - from, ...(tps ? { tps } : {}), steps: turn.filter((e) => e.type === "tool_call").length };
}

/**
 * What a busy turn is doing now.
 *
 * @param events - The chat's events.
 * @param info - The session's pending approvals and questions.
 * @param writing - Whether answer text is streaming right now.
 * @returns The status (the turn starts at the last message of the user's that was not a steer).
 */
export function turnStatus(events: readonly Ev[], info: { pendingApprovals?: readonly string[]; pendingQuestions?: readonly string[] }, writing: boolean): TurnStatus {
  const { head, turn } = lastTurn(events);
  const since = head?.at;
  const tps = turnSpeed(turn);
  const at = { step: turn.filter((e) => e.type === "tool_call").length, ...(since ? { since } : {}), ...(tps ? { tps } : {}) };
  if (info.pendingApprovals?.length) {
    const req = turn.findLast((e) => e.type === "approval_request" && info.pendingApprovals!.includes(e.requestId ?? ""));
    return { kind: "approval", ...(req?.name ? { tool: req.name } : {}), ...at };
  }
  if (info.pendingQuestions?.length) return { kind: "question", ...at };
  const done = new Set(turn.filter((e) => e.type === "tool_result").map((e) => e.callId));
  const running = turn.findLast((e) => e.type === "tool_call" && !done.has(e.callId));
  if (running?.name) return { kind: "tool", tool: running.name, ...at };
  return { kind: writing ? "writing" : "thinking", ...at };
}

/**
 * A duration as the status line shows it.
 *
 * @param ms - Milliseconds.
 * @returns "8s", "1m 05s" or "1h 02m".
 */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/**
 * A duration as a clock, for the live line and the summary.
 *
 * @param ms - Milliseconds.
 * @returns "0:42", "12:05" or "1:02:09".
 */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const sec = String(s % 60).padStart(2, "0");
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${sec}`;
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${sec}`;
}

/**
 * Tokens per second as shown ("38 tok/s"; one decimal under 10).
 *
 * @param tps - Tokens per second.
 * @returns The text.
 */
export function speedText(tps: number): string {
  return `${tps < 10 ? tps.toFixed(1) : Math.round(tps)} tok/s`;
}
