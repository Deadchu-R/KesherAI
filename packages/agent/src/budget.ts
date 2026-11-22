import type { AgentMessage } from "@kesher/shared";

/**
 * The token budget of a chat on a local model (docs/WORK_LIST.md, "Models and agents"): what is left out of the
 * copy sent to the model, without changing the stored conversation.
 *
 * Tool-output pruning: a tool result from before the last two turns is sent as one summary line with its id; the
 * full output stays in the saved conversation and the model opens it again with `tool_output`. The line between
 * pruned and full moves only when a new turn starts, so within a turn the prompt's start stays the same and the
 * engine keeps its cache. The latest result and results the user pinned are never pruned.
 *
 * Superseded reads: when the same file range is read again, every older read of it is sent as one marker line,
 * in any turn (the newer read has the fresher text). This changes the prompt once, at the older read, when the
 * newer read arrives; every later call then sends less.
 *
 * Command and check outputs (`run_command`, `check_code`) keep their last line too in the summary, since that is
 * where the exit code or the pass/fail count is.
 */

/** The tool that opens a pruned tool output again by its id. */
export const TOOL_OUTPUT_TOOL = "tool_output";
/** Tool results of this many recent turns are sent in full. */
export const KEEP_TURNS = 2;
/** Outputs shorter than this are sent as they are (their summary line would save almost nothing). */
const MIN_PRUNE_CHARS = 400;
/** The start of a pruned output's line (also how the context explorer recognises one). */
export const PRUNED_MARK = "[pruned output";
/** The start of a superseded read's line. */
export const SUPERSEDED_MARK = "[read_file";
/** Tools whose summary line also keeps the output's last line (the exit code, the pass/fail count). */
const STATUS_LAST_TOOLS = new Set(["run_command", "check_code"]);
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

/**
 * The summary of a command or check output: its first meaningful line and its last one (where the exit code is).
 *
 * @param content - The full output.
 * @returns At most about 250 characters.
 */
export function statusSummary(content: string): string {
  const lines = content.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^[-=`*#\s]+$/.test(l));
  const first = summaryLine(content);
  const last = lines[lines.length - 1] ?? "";
  if (!last || last === first || lines.length < 2) return first;
  return `${first} … ${last.length > 80 ? `${last.slice(0, 77)}…` : last}`;
}

/**
 * The read_file results that a later read of the same file range makes stale: a later read covers an older one
 * when it is of the same path and either got the whole file (no offset and limit, and no "read on" tail) or used
 * the same offset and limit.
 *
 * @param messages - The conversation (tool calls are matched to their results by id).
 * @returns The call ids of the stale reads, each with the path it read.
 */
export function supersededReads(messages: readonly AgentMessage[]): Map<string, string> {
  const calls = new Map<string, { path: string; range: string }>();
  for (const m of messages) {
    for (const c of m.toolCalls ?? []) {
      // A call can come without parsed arguments (a model that sent none, or a turn still being built).
      const args = (c.arguments ?? {}) as Record<string, unknown>;
      if (c.name !== "read_file" || typeof args.path !== "string") continue;
      const path = args.path.replace(/\\/g, "/").replace(/^\.\//, "");
      const range = args.offset === undefined && args.limit === undefined ? "" : `${String(args.offset ?? 1)}:${String(args.limit ?? "")}`;
      calls.set(c.id, { path, range });
    }
  }
  const out = new Map<string, string>();
  // Walk from the newest: a read is stale when a newer successful read of the same path covers its range.
  const whole = new Set<string>();
  const ranges = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "tool" || !m.toolCallId) continue;
    const call = calls.get(m.toolCallId);
    if (!call) continue;
    if (whole.has(call.path) || ranges.has(`${call.path}#${call.range}`)) {
      out.set(m.toolCallId, call.path);
      continue;
    }
    // Only a read that returned numbered lines supersedes (not an error or a refusal).
    if (!/^\s*\d+ {2}/.test(m.content)) continue;
    ranges.add(`${call.path}#${call.range}`);
    // A plain read that ended without "read on with offset" had the whole file: it covers every range of it.
    if (!call.range && !/\n… \d+ more lines: read on with offset \d+$/.test(m.content)) whole.add(call.path);
  }
  return out;
}

/** What {@link pruneToolOutputs} sends instead of the conversation. */
export interface Pruned {
  /** A copy of the messages, with old outputs as summary lines (same length and order as the input). */
  messages: AgentMessage[];
  /** Characters left out (pictures count 6000 each, as in sizeOf). */
  prunedChars: number;
  /** The call ids whose outputs were pruned (superseded reads included). */
  ids: string[];
  /** Of `ids`, the reads a later read of the same file made stale. */
  superseded: number;
}

/**
 * Replaces tool results older than the last `keepTurns` turns by a summary line with their id, and reads that a
 * later read of the same file covers by a marker line (in any turn).
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
  const stale = supersededReads(messages);
  let prunedChars = 0;
  let superseded = 0;
  const ids: string[] = [];
  const out = messages.map((m, i) => {
    if (i === lastTool || m.role !== "tool" || !m.toolCallId || opts.pinned?.has(m.toolCallId)) return m;
    const stalePath = stale.get(m.toolCallId);
    if (stalePath !== undefined) {
      const content = `${SUPERSEDED_MARK} ${stalePath} superseded by a later read] (id "${m.toolCallId}")`;
      if (content.length >= m.content.length) return m;
      prunedChars += m.content.length - content.length;
      superseded++;
      ids.push(m.toolCallId);
      return { ...m, content };
    }
    if (i >= line) return m;
    const pictures = m.images?.length ?? 0;
    if (m.content.length < MIN_PRUNE_CHARS && !pictures) return m;
    const summary = STATUS_LAST_TOOLS.has(m.toolName ?? "") ? statusSummary(m.content) : summaryLine(m.content);
    const content = `${PRUNED_MARK} ${m.toolCallId}] ${m.toolName ?? "tool"}: ${summary} (${m.content.length} characters${pictures ? `, ${pictures} picture(s)` : ""}; open it again with ${TOOL_OUTPUT_TOOL} id "${m.toolCallId}")`;
    prunedChars += m.content.length - content.length + pictures * 6000;
    ids.push(m.toolCallId);
    const { images: _drop, ...rest } = m;
    void _drop;
    return { ...rest, content };
  });
  return { messages: out, prunedChars: Math.max(0, prunedChars), ids, superseded };
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

/**
 * The pinned tool results in the part of a conversation a summary replaces ("/compact" or the context ring's
 * Compact): pinning means "always sent in full", so they go on after the summary instead of being dropped.
 *
 * @param messages - The conversation part the summary replaces.
 * @param pinned - Pinned call ids (from {@link pinnedOutputs}).
 * @param maxChars - The most characters to keep in all (the newest pins are kept first).
 * @returns A block to add after the summary, or "" when nothing pinned is there.
 */
export function pinnedBefore(messages: readonly AgentMessage[], pinned: ReadonlySet<string>, maxChars = 24_000): string {
  const parts: string[] = [];
  let room = maxChars;
  for (let i = messages.length - 1; i >= 0 && room > 0; i--) {
    const m = messages[i]!;
    if (m.role !== "tool" || !m.toolCallId || !pinned.has(m.toolCallId)) continue;
    const text = `[${m.toolName ?? "tool"} ${m.toolCallId}]\n${m.content.slice(0, room)}`;
    parts.unshift(text);
    room -= text.length;
  }
  return parts.length ? `Pinned tool results (the user pinned them; they stay in full):\n${parts.join("\n\n")}` : "";
}

/** Tool instructions sent in full per turn when nothing else is set (Settings → Models → the model team). */
export const DEFAULT_TOOL_CAP = 24;

/**
 * The per-turn cap on loaded tools: which tools go to the model in full when there are more than `cap`. Ranked: the
 * tools this message loaded (routed, named, or asked for with more_tools; newest first), then the chat's core tools
 * in their order, then tools loaded earlier (newest first). The chat's core set is never cut below its own size (a
 * Unity chat keeps every Unity tool). The kept tools stay in their given order, so the prompt's start does not move.
 *
 * @param full - The tools that would go in full, in prompt order.
 * @param opts.core - The chat's core tool names, most needed first.
 * @param opts.rank - When each loaded tool was last loaded (higher is newer).
 * @param opts.since - The rank at the start of this message (higher ranks were loaded by it).
 * @param opts.cap - The most tools in full.
 * @returns The tools to keep (prompt order) and the names left for more_tools.
 */
export function capTools<T extends { name: string }>(full: readonly T[], opts: { core: readonly string[]; rank: ReadonlyMap<string, number>; since: number; cap: number }): { keep: T[]; over: string[] } {
  const limit = Math.max(1, Math.floor(opts.cap), full.filter((t) => opts.core.includes(t.name)).length);
  if (full.length <= limit) return { keep: [...full], over: [] };
  const score = (name: string): number => {
    const r = opts.rank.get(name) ?? -1;
    if (r > opts.since) return 2e9 + r;
    const c = opts.core.indexOf(name);
    if (c >= 0) return 1e9 - c;
    return r;
  };
  const kept = new Set([...full].sort((a, b) => score(b.name) - score(a.name)).slice(0, limit).map((t) => t.name));
  return { keep: full.filter((t) => kept.has(t.name)), over: full.filter((t) => !kept.has(t.name)).map((t) => t.name) };
}
