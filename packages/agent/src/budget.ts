import type { AgentMessage } from "@kesher/shared";

/**
 * The token budget of a chat on a local model (docs/WORK_LIST.md, "Models and agents"): what is left out of the
 * copy sent to the model, without changing the stored conversation.
 *
 * Tool-output pruning: a tool result from before the last two turns is sent as one summary line with its id; the
 * full output stays in the saved conversation and the model opens it again with `tool_output`. The line between
 * pruned and full moves only when a new turn starts, so within a turn the prompt's start stays the same and the
 * engine keeps its cache. The latest result and results the user pinned are never pruned.
 */

/** The tool that opens a pruned tool output again by its id. */
export const TOOL_OUTPUT_TOOL = "tool_output";
/** Tool results of this many recent turns are sent in full. */
export const KEEP_TURNS = 2;
/** Outputs shorter than this are sent as they are (their summary line would save almost nothing). */
const MIN_PRUNE_CHARS = 400;
/** The start of a pruned output's line (also how the context explorer recognises one). */
export const PRUNED_MARK = "[pruned output";
/** The most characters one `tool_output` call returns. */
export const OPEN_CHARS = 20_000;

/**
 * Whether a message starts a turn: a user message the person wrote (or a helper's report that wakes the chat), not
 * one of KesherAI's own notes inside a run (nudges, a teammate's plan or review, an undo notice).
 *
 * @param m - A message.
 * @returns True for the start of a turn.
 */
export function isTurnStart(m: AgentMessage): boolean {
  return m.role === "user" && !/^(\[KesherAI\]|\(A plan from your teammate|Your teammate |\(The user undid)/.test(m.content);
}

/**
 * The one line that stands in for a pruned output: its first meaningful line, shortened.
 *
 * @param content - The full output.
 * @returns At most 160 characters.
 */
export function summaryLine(content: string): string {
  const first = content.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/^[-=`*#\s]+$/.test(l)) ?? "";
  return first.length > 160 ? `${first.slice(0, 157)}…` : first;
}

/** What {@link pruneToolOutputs} sends instead of the conversation. */
export interface Pruned {
  /** A copy of the messages, with old outputs as summary lines (same length and order as the input). */
  messages: AgentMessage[];
  /** Characters left out (pictures count 6000 each, as in sizeOf). */
  prunedChars: number;
  /** The call ids whose outputs were pruned. */
  ids: string[];
}

/**
 * Replaces tool results older than the last `keepTurns` turns by a summary line with their id.
 *
 * @param messages - The stored conversation (not changed).
 * @param opts.keepTurns - Turns whose results stay in full (default {@link KEEP_TURNS}).
 * @param opts.pinned - Call ids the user pinned (never pruned).
 * @returns The copy to send, what it saved, and the pruned ids.
 */
export function pruneToolOutputs(messages: readonly AgentMessage[], opts: { keepTurns?: number; pinned?: ReadonlySet<string> } = {}): Pruned {
  const keep = Math.max(1, opts.keepTurns ?? KEEP_TURNS);
  const starts = messages.flatMap((m, i) => (isTurnStart(m) ? [i] : []));
  // Everything before the start of the oldest kept turn may be pruned; with fewer turns than that, nothing is.
  const line = starts.length >= keep ? starts[starts.length - keep]! : 0;
  const lastTool = messages.findLastIndex((m) => m.role === "tool");
  let prunedChars = 0;
  const ids: string[] = [];
  const out = messages.map((m, i) => {
    if (i >= line || i === lastTool || m.role !== "tool" || !m.toolCallId || opts.pinned?.has(m.toolCallId)) return m;
    const pictures = m.images?.length ?? 0;
    if (m.content.length < MIN_PRUNE_CHARS && !pictures) return m;
    const content = `${PRUNED_MARK} ${m.toolCallId}] ${m.toolName ?? "tool"}: ${summaryLine(m.content)} (${m.content.length} characters${pictures ? `, ${pictures} picture(s)` : ""}; open it again with ${TOOL_OUTPUT_TOOL} id "${m.toolCallId}")`;
    prunedChars += m.content.length - content.length + pictures * 6000;
    ids.push(m.toolCallId);
    const { images: _drop, ...rest } = m;
    void _drop;
    return { ...rest, content };
  });
  return { messages: out, prunedChars: Math.max(0, prunedChars), ids };
}

/**
 * Reads a stored tool output by its call id, for `tool_output`.
 *
 * @param messages - The stored conversation.
 * @param id - The call id from the summary line.
 * @param from - The first character to return (for long outputs, in parts).
 * @returns The text the model reads.
 * @throws Error when no tool result has that id.
 */
export function openToolOutput(messages: readonly AgentMessage[], id: string, from = 0): string {
  const m = messages.find((x) => x.role === "tool" && x.toolCallId === id);
  if (!m) throw new Error(`No tool output with id ${id}. Use the id from a "${PRUNED_MARK} …]" line.`);
  const start = Math.max(0, Math.min(Math.floor(from) || 0, m.content.length));
  const part = m.content.slice(start, start + OPEN_CHARS);
  const end = start + part.length;
  return end < m.content.length ? `${part}\n… [characters ${start}-${end} of ${m.content.length}; the rest: ${TOOL_OUTPUT_TOOL} id "${id}" from ${end}]` : part;
}

/**
 * The call ids the user pinned, from the conversation's `tool_pin` events (the last one per id decides).
 *
 * @param events - The conversation's events.
 * @returns The pinned ids.
 */
export function pinnedOutputs(events: ReadonlyArray<{ type: string; callId?: string; pinned?: boolean }>): Set<string> {
  const pinned = new Set<string>();
  for (const e of events) {
    if (e.type !== "tool_pin" || !e.callId) continue;
    if (e.pinned) pinned.add(e.callId);
    else pinned.delete(e.callId);
  }
  return pinned;
}
