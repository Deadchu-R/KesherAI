/**
 * The status line under a busy answer (docs/FEATURE_REVIEW.md, 2026-11-21; as Cursor): what the turn is doing now
 * and how long it has run ("Running read_file · 12s", "Waiting for your approval · 1m 05s").
 */

/** What this reads of the chat's events. */
type Ev = { type: string; at?: string; seq?: number; callId?: string; name?: string; steered?: boolean; requestId?: string };

/** What a busy turn is doing. */
export interface TurnStatus {
  kind: "approval" | "question" | "tool" | "writing" | "thinking";
  /** The tool running, or the one waiting for approval. */
  tool?: string;
  /** When the turn began (its user message), ISO time. */
  since?: string;
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
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "user" && !e.steered) {
      start = i;
      break;
    }
  }
  const turn = events.slice(start + 1);
  const since = start >= 0 ? events[start]!.at : undefined;
  const at = since ? { since } : {};
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
