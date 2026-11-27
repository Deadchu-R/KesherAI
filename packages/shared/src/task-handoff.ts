/**
 * The relay between executors (Roee, 27.11: "GhostCLI does half-tasks — use that: let it do half and bring the rest
 * to the other agents").
 *
 * When a run ends partial — or failed but with a pushed diff or a useful report — the task is handed to the next
 * executor instead of being retried on the same one. The next run starts from the partial branch (so one branch per
 * task keeps every agent's commits) with a short handoff note at the top of its prompt: what was done, what is left,
 * what went wrong and where to continue.
 *
 * - {@link handoffWorth}: whether a run's end is worth handing on.
 * - {@link buildHandoffNote}: the note (at most {@link HANDOFF_MAX_LINES} lines, through the leak guard).
 * - {@link pickHandoff}: the next executor, by the quota failover's order and its safety rules (quota-failover.ts).
 * - {@link handoffPromptHead}: the lines the continuation's prompt starts with.
 * - {@link handoffChainText}: "GhostCLI (partial: 3 files) → OpenCode Go free (finished)" for the task page.
 *
 * Pure (no I/O), so the PC, the page and the tests share it.
 */
import { redactLeaks, type LeakContext } from "./leak-guard.js";
import { cleanFailoverOrder, EXECUTOR_NAMES, failoverBlock, type ExecutorRoom, type FailoverSettings, type FailoverTarget, type FailoverTask } from "./quota-failover.js";
import type { HandoffStep, HandoffTarget, InboxExecutor, InboxHandoff, InboxStatus } from "./task-inbox.js";

export type { HandoffStep, HandoffTarget, InboxHandoff };

/** An executor that ran or runs a task. */
type Executor = Exclude<InboxExecutor, "auto">;

/** The note's line limit. */
export const HANDOFF_MAX_LINES = 40;
/** A task is handed on at most this many times (no endless A → B → A → B). */
export const HANDOFF_MAX = 4;
/** A report at least this long (characters) is worth handing on even without a diff. */
const USEFUL_REPORT = 80;

/**
 * Whether a run's end is worth handing to the next executor: a partial run, or a failed one, that pushed a diff or
 * wrote a useful report. A run blocked by a safety rule (privacy, paths, security files, version) is never handed on.
 *
 * @param r - The run's end.
 * @returns True when the next executor should continue it.
 */
export function handoffWorth(r: { status: InboxStatus; files: number; pushed?: boolean; summary?: string; blocked?: boolean }): boolean {
  if (r.blocked || (r.status !== "partial" && r.status !== "failed")) return false;
  return (r.files > 0 && !!r.pushed) || (r.summary ?? "").trim().length >= USEFUL_REPORT;
}

/**
 * The size of what is left: one step smaller than the task when some files were already done (L → M, M → S).
 *
 * @param size - The task's size.
 * @param filesDone - Files the stopped run changed.
 */
export function leftoverSize(size: "S" | "M" | "L", filesDone: number): "S" | "M" | "L" {
  if (filesDone <= 0) return size;
  return size === "L" ? "M" : "S";
}

/** What the note is built from. */
export interface HandoffInput {
  /** Who stopped (its display name is used). */
  by: Executor;
  /** Its model, when known. */
  model?: string;
  status: InboxStatus;
  /** Files changed, with their diff stats. */
  files: ReadonlyArray<{ path: string; added: number; removed: number }>;
  /** The branch to continue from (when the work was pushed). */
  branch?: string;
  /** The agent's own final report. */
  summary?: string;
  /** The task's acceptance (what must be true at the end). */
  acceptance?: string;
  /** Why it stopped (the fail note). */
  failNote?: string;
  /** The watchdog's last lines (newest last). */
  watch?: readonly string[];
}

/** Words that start the "left" part of an agent's report. */
const LEFT_WORDS = /\b(left|open|todo|to do|remaining|not done|still|next steps?|unfinished|missing)\b/i;

/** Non-empty lines of a text, each cut to `max` characters. */
const linesOf = (text: string | undefined, max = 200): string[] => (text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => (l.length > max ? `${l.slice(0, max - 1)}…` : l));

/**
 * What is left, from the agent's report: the lines from the first one that names what is left (at most 6), else the
 * report's last 4 lines.
 */
function leftFromReport(summary: string | undefined): string[] {
  const lines = linesOf(summary);
  const at = lines.findIndex((l) => LEFT_WORDS.test(l));
  return (at >= 0 ? lines.slice(at, at + 6) : lines.slice(-4)).map((l) => (l.startsWith("-") ? l : `- ${l}`));
}

/**
 * The handoff note: what was done (files with their diff stats), what is left (the agent's report and the task's
 * acceptance), what went wrong (the fail note, the watchdog's last lines) and the branch to continue from. Capped at
 * {@link HANDOFF_MAX_LINES} lines and passed through the leak guard (keys, emails, personal paths become placeholders).
 *
 * @param r - The stopped run.
 * @param ctx - The leak guard's context (this computer's user name and home folder).
 * @returns The note.
 */
export function buildHandoffNote(r: HandoffInput, ctx: LeakContext = {}): string {
  const files = [...r.files].sort((a, b) => b.added + b.removed - (a.added + a.removed));
  const shown = files.slice(0, 10);
  const out: string[] = [`Handed on from ${EXECUTOR_NAMES[r.by]}${r.model ? ` (${r.model})` : ""}: it ended ${r.status}.`, ""];
  out.push(files.length ? `Done so far (${files.length} file${files.length === 1 ? "" : "s"}${r.branch ? `, on ${r.branch}` : ""}):` : "Done so far: no files changed; its findings are below.");
  for (const f of shown) out.push(`- ${f.path} +${f.added} -${f.removed}`);
  if (files.length > shown.length) out.push(`- … and ${files.length - shown.length} more`);
  out.push("", "Left:");
  const left = leftFromReport(r.summary);
  out.push(...(left.length ? left : ["- (the agent did not say; compare the acceptance with the diff)"]));
  const acc = linesOf(r.acceptance).slice(0, 6);
  if (acc.length) out.push("Acceptance to meet:", ...acc.map((l) => (l.startsWith("-") ? l : `- ${l}`)));
  const wrong = linesOf(r.failNote, 300).slice(0, 2);
  const watch = (r.watch ?? []).map((l) => linesOf(l)[0]).filter((l): l is string => !!l).slice(-3);
  if (wrong.length || watch.length) {
    out.push("", "What went wrong:", ...wrong.map((l) => `- ${l}`), ...watch.map((l) => `- watchdog: ${l}`));
  }
  out.push("", r.branch ? `Continue from the branch ${r.branch}.` : "Start from the task's base; nothing was pushed.");
  const capped = out.length > HANDOFF_MAX_LINES ? [...out.slice(0, HANDOFF_MAX_LINES - 1), "…"] : out;
  return redactLeaks(capped.join("\n"), ctx).text;
}

/**
 * How many runs in a row at the end of the chain were by this executor and did not finish.
 *
 * @param chain - The task's runs, oldest first.
 * @param ex - The executor.
 */
export function stopsInRow(chain: readonly HandoffStep[], ex: Executor): number {
  let n = 0;
  for (let i = chain.length - 1; i >= 0 && chain[i]!.by === ex && chain[i]!.status !== "done"; i--) n++;
  return n;
}

/**
 * The next executor for a continuation. The failover order of the task's kind (Settings › Task inbox), reordered by
 * what is left: a small leftover goes to the local model or OpenCode Go (its free models first) first, a bigger one to
 * Antigravity or GhostCLI first. The same safety rules as the quota failover apply ({@link failoverBlock}: relay and
 * training checks, security work only to Antigravity, no extra money). The executor that just stopped comes last, and
 * not at all once it stopped twice in a row on this task. Claude's Opus agent takes it only when the task is
 * security-sensitive or L and nothing else may. No more than {@link HANDOFF_MAX} handoffs per task.
 *
 * @param t - The task as the failover sees it (`size` is the leftover's size, see {@link leftoverSize}).
 * @param rooms - Each executor's room now.
 * @param s - The failover settings (only the orders are used).
 * @param chain - The task's runs so far, the one that just stopped included (oldest first).
 * @returns Where it goes and why, or undefined when nobody may take it now.
 */
export function pickHandoff(t: FailoverTask, rooms: Partial<Record<Executor, ExecutorRoom>>, s: Pick<FailoverSettings, "code" | "research">, chain: readonly HandoffStep[]): { to: HandoffTarget; why: string } | undefined {
  if (chain.filter((c) => c.status !== "done").length > HANDOFF_MAX) return undefined;
  const kind = t.kind ?? "code";
  const stopped = t.runBy;
  const prefer: readonly FailoverTarget[] = t.size === "S" ? ["local", "opencode"] : ["antigravity", "ghostcli"];
  const order = cleanFailoverOrder(kind, s[kind]);
  const ranked = [...order.filter((x) => prefer.includes(x)), ...order.filter((x) => !prefer.includes(x))];
  const twice = stopsInRow(chain, stopped) >= 2;
  const tries = [...ranked.filter((x) => x !== stopped), ...(!twice && ranked.includes(stopped as FailoverTarget) ? [stopped as FailoverTarget] : [])];
  for (const to of tries) {
    if (!failoverBlock(t, to, rooms[to])) return { to, why: to === stopped ? "nobody else may take it now" : t.size === "S" ? "a small leftover" : "a bigger leftover" };
  }
  if (kind === "code" && (t.sensitive || t.size === "L") && stopped !== "opus") return { to: "opus", why: t.sensitive ? "security-sensitive" : "an L leftover" };
  return undefined;
}

/**
 * The lines a continuation's prompt starts with: the instruction and the note in a marked block.
 *
 * @param h - The handoff.
 */
export function handoffPromptHead(h: Pick<InboxHandoff, "note" | "branch">): string {
  return [
    `Continue this task. Another agent started it and stopped; ${h.branch ? `its commits are already in this branch (from ${h.branch})` : "nothing of it was pushed"}. Do not redo the done parts: check them quickly, then do what is left.`,
    "<handoff>",
    h.note,
    "</handoff>",
    "",
  ].join("\n");
}

/** Status words of the chain. */
const WORD: Partial<Record<InboxStatus, [string, string]>> = {
  done: ["הסתיים", "finished"],
  partial: ["חלקי", "partial"],
  failed: ["נכשל", "failed"],
  running: ["רץ", "running"],
  waiting: ["ממתין", "waiting"],
  queued: ["בתור", "queued"],
  "deferred-quota": ["ממתין למכסה", "waiting for quota"],
};

/**
 * The chain for the task page: "GhostCLI (partial: 3 files) → OpenCode Go free (finished)". In Hebrew the arrow
 * points left (the line reads right to left).
 *
 * @param chain - The runs, oldest first.
 * @param he - Hebrew words.
 * @param now - The run going on now or waiting (the task's executor and status), when it has not ended.
 * @returns The text, or "" when there was no handoff (fewer than two entries).
 */
export function handoffChainText(chain: readonly HandoffStep[], he: boolean, now?: { by: Executor; status: InboxStatus }): string {
  const all: Array<Pick<HandoffStep, "by" | "status"> & { free?: boolean; files?: number }> = [...chain, ...(now ? [now] : [])];
  if (all.length < 2) return "";
  return all
    .map((c) => {
      const name = `${EXECUTOR_NAMES[c.by]}${c.free ? (he ? " חינמי" : " free") : ""}`;
      const word = WORD[c.status]?.[he ? 0 : 1] ?? c.status;
      const files = c.status !== "done" && c.files ? (he ? (c.files === 1 ? ": קובץ אחד" : `: ${c.files} קבצים`) : `: ${c.files} file${c.files === 1 ? "" : "s"}`) : "";
      return `${name} (${word}${files})`;
    })
    .join(he ? " ← " : " → ");
}
