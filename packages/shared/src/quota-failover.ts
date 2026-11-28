/**
 * Quota failover for the task inbox (Roee, 27.11: "when a provider's quota runs out, juggle the work to where quota is
 * left, to get more tasks done").
 *
 * {@link pickFailover} is the one decision: a task that waits on an executor with no quota now (used up, capped,
 * rate-limited, cooling down) moves to the next executor in its order that has quota now and may take it. The order is
 * the task's own preference first, then the user's fallback order for its kind (Settings › Task inbox). Safety comes
 * before throughput, but only for what is private (Roee, 28.11): a task WITHOUT security issues or private data may run
 * on ANY ready provider, free ones that train on data included, so its candidates are every ready executor of its kind;
 * a task flagged sensitive, private or security-related never goes to a relay or a service that may train and goes only
 * where it may go today. Nothing that costs extra money is ever picked.
 *
 * No bouncing: only a task that has not started moves (never a running one), and never back to the executor it was moved
 * from; when that executor's quota comes back, new tasks go to it again by the normal routing.
 *
 * Pure (no I/O), so the PC, the page and the tests share it.
 */
import type { InboxExecutor, InboxKind, InboxStatus } from "./task-inbox.js";

/** An executor a task may move to when its own is out of quota. */
export type FailoverTarget = "ghostcli" | "opencode" | "antigravity" | "local" | "gemini";

/** Settings › Task inbox › "When a quota runs out" (config `taskInbox.failover`). */
export interface FailoverSettings {
  /** Move tasks too when quota ends (default on); off: the failover is off altogether. */
  enabled: boolean;
  /** Also move a task whose executor was picked by hand (default on); off: the PC asks instead. */
  moveManual: boolean;
  /** The fallback order of code tasks. */
  code: FailoverTarget[];
  /** The fallback order of research tasks. */
  research: FailoverTarget[];
}

/** Which executors may take each kind (anything else in a saved order is dropped). */
export const FAILOVER_TARGETS: Readonly<Record<InboxKind, readonly FailoverTarget[]>> = {
  code: ["ghostcli", "opencode", "antigravity", "local"],
  research: ["gemini", "ghostcli", "antigravity"],
};

/**
 * The defaults (Roee, 27.11): code GhostCLI → OpenCode Go (its free models first, inside its own runner) → Antigravity
 * (waits for the Run tap) → the local model for small tasks; research Gemini → GhostCLI → Antigravity.
 */
export const FAILOVER_DEFAULTS: FailoverSettings = { enabled: true, moveManual: true, code: [...FAILOVER_TARGETS.code], research: [...FAILOVER_TARGETS.research] };

/**
 * A fallback order as the user saved it, cleaned: only the kind's executors, each once; the ones left out keep their
 * default place at the end (so a new executor is never lost from an older saved order).
 *
 * @param kind - The task kind.
 * @param saved - What was saved (anything).
 * @returns The order.
 */
export function cleanFailoverOrder(kind: InboxKind, saved: unknown): FailoverTarget[] {
  const allowed = FAILOVER_TARGETS[kind];
  const given = Array.isArray(saved) ? saved.filter((x): x is FailoverTarget => allowed.includes(x as FailoverTarget)) : [];
  return [...new Set([...given, ...allowed])];
}

/** What one executor can do right now, as the PC knows it. */
export interface ExecutorRoom {
  /** It can take a task now (not off, connected, quota left, under its cap, not cooling down). */
  open: boolean;
  /** When it is expected back, if it is not open and that is known (ms). */
  until?: number;
  /** It starts only on the user's Run tap (Antigravity): a task moved there waits for it instead of moving on. */
  needsTap?: boolean;
  /** A flat-rate relay (GhostCLI): only tasks that pass safeForRelay and the privacy scan. */
  relay?: boolean;
  /** A service that may train on prompts (the free Gemini key): only tasks that are safe to send there. */
  training?: boolean;
  /** Using it now would cost money beyond what the user already pays: never picked. */
  extraCost?: boolean;
  /** How much of today's allowance is left, 0 to 1 (unknown: absent). The target with the most left is picked first. */
  left?: number;
  /** The same in words for the task's note ("47/60 left"). */
  leftText?: string;
  /** Why it is not open, in words for the note ("cooling down till 10:58", "daily cap reached"). */
  reason?: string;
}

/** The most times a task moves without having started anywhere in between (no endless juggling). */
export const MAX_QUOTA_MOVES = 3;

/** The task as the decision sees it. */
export interface FailoverTask {
  kind?: InboxKind;
  /** S, M or L. */
  size: "S" | "M" | "L";
  risk: "low" | "medium" | "high";
  status: InboxStatus;
  /** What the task asked for (`auto`, or an executor picked by hand or in its file). */
  executor: InboxExecutor;
  /** Where it is now. */
  runBy: Exclude<InboxExecutor, "auto">;
  /** It passed safeForRelay and the privacy scan on what would be sent. */
  relayOk: boolean;
  /** It may go to a service that may train (safeForTrainingProvider for code; the relay check for research). */
  trainOk: boolean;
  /** It touches security (risk high, or safeForRelay refused it for a security path or word). */
  sensitive: boolean;
  /** "Only this executor" (the user wants to wait for it): the task never moves. */
  onlyThis?: boolean;
  /** How many times it moved since it last started (absent: 0). At {@link MAX_QUOTA_MOVES} it stays where it is. */
  moves?: number;
  /** Set when it was moved before: never moved back to any executor it left (`from` and the earlier `via`). */
  movedFrom?: { from: string; via?: readonly string[] };
}

/** What to do with a task. */
export type FailoverDecision =
  | { action: "stay"; why: string }
  | { action: "move"; to: FailoverTarget; back?: number }
  | { action: "ask"; to: FailoverTarget; back?: number };

/** Statuses of a task that has not started (or stopped on its quota) and may move. */
const MOVABLE = new Set<InboxStatus>(["waiting", "queued", "deferred-quota"]);

/**
 * Why a task may not go to an executor (the safety rules), or undefined when it may.
 *
 * @param t - The task.
 * @param to - The executor.
 * @param room - What the executor can do now.
 * @returns The reason in English, or undefined.
 */
export function failoverBlock(t: FailoverTask, to: FailoverTarget, room: ExecutorRoom | undefined): string | undefined {
  const kind = t.kind ?? "code";
  if (!FAILOVER_TARGETS[kind].includes(to)) return `${to} does not take ${kind} tasks`;
  if (!room) return `${to} is not set up`;
  if (room.extraCost) return `${to} would cost extra money`;
  if (t.sensitive && to !== "antigravity") return "a security-sensitive task goes only to Antigravity";
  if (room.relay && !t.relayOk) return "not safe for a relay";
  if (room.training && !t.trainOk) return "not safe for a service that may train";
  if (to === "local" && (t.size !== "S" || t.risk !== "low")) return "the local model takes only small low-risk tasks";
  // Big work stays off OpenCode Go (Roee, 21.11: L tasks go to Antigravity, or to GhostCLI when safe).
  if (to === "opencode" && t.size === "L") return "L tasks stay off OpenCode Go";
  if (!room.open) return `${to} has no quota now`;
  return undefined;
}

/**
 * The order to try for a task: its own preference first (when it is one of the kind's executors), then the settings'
 * order for its kind.
 *
 * @param t - The task.
 * @param s - The settings.
 * @returns The executors, each once.
 */
export function failoverOrder(t: Pick<FailoverTask, "kind" | "executor">, s: FailoverSettings): FailoverTarget[] {
  const kind = t.kind ?? "code";
  const order = cleanFailoverOrder(kind, s[kind]);
  const own = FAILOVER_TARGETS[kind].includes(t.executor as FailoverTarget) ? [t.executor as FailoverTarget] : [];
  return [...new Set([...own, ...order])];
}

/**
 * Decides whether a waiting task moves because its executor has no quota now, and where.
 *
 * @param t - The task.
 * @param rooms - Each executor's room now (the task's own executor included, even when it is not a target).
 * @param s - The settings.
 * @returns `stay` (with why), `move` to an executor, or `ask` (a hand-picked task while "move my tasks too" is off).
 */
export function pickFailover(t: FailoverTask, rooms: Partial<Record<Exclude<InboxExecutor, "auto">, ExecutorRoom>>, s: FailoverSettings): FailoverDecision {
  if (!s.enabled) return { action: "stay", why: "the failover is off" };
  // No bounce: a task that runs (or waits for a step's answer) stays where it is.
  if (!MOVABLE.has(t.status)) return { action: "stay", why: "it is not waiting" };
  // A named executor is a preference, not a lock; "only this executor" is the lock (the user chose to wait).
  if (t.onlyThis) return { action: "stay", why: "only this executor" };
  if ((t.moves ?? 0) >= MAX_QUOTA_MOVES) return { action: "stay", why: "it already moved too many times without starting" };
  // Claude's Opus agent has no quota here: it is never moved.
  if (t.runBy === "opus") return { action: "stay", why: "Claude's own agent" };
  const here = rooms[t.runBy];
  if (!here || here.open) return { action: "stay", why: "its executor has quota" };
  const back = here.until;
  const handPicked = t.executor !== "auto";
  const ok = failoverOrder(t, s).filter((to) => to !== t.runBy && to !== t.movedFrom?.from && !t.movedFrom?.via?.includes(to) && !failoverBlock(t, to, rooms[to]));
  // The one with the most quota left first; a target that waits for the user's Run tap comes after those that start by
  // themselves; the settings' order breaks ties (the sort is stable).
  const rank = (to: FailoverTarget) => (rooms[to]?.needsTap ? -1 : 0) + (rooms[to]?.left ?? 0.5);
  const to = [...ok].sort((a, b) => rank(b) - rank(a))[0];
  if (to) {
    if (handPicked && !s.moveManual) return { action: "ask", to, ...(back ? { back } : {}) };
    return { action: "move", to, ...(back ? { back } : {}) };
  }
  return { action: "stay", why: "no other executor has quota and may take it" };
}

/**
 * The reason line of a move, for the task's note: why the first executor cannot take it and what the new one has left
 * ("GhostCLI cooling down till 10:58, OpenCode Go has 47/60 left").
 *
 * @param from - The first executor's name.
 * @param here - Its room (its `reason`).
 * @param to - The new executor's name.
 * @param room - Its room (its `leftText`).
 */
export function failoverWhy(from: string, here: ExecutorRoom | undefined, to: string, room: ExecutorRoom | undefined): string {
  return `${from} ${here?.reason ?? "has no quota"}, ${to} ${room?.leftText ? `has ${room.leftText}` : "has quota"}`;
}

/** Display names of the executors (the task row and the hub use them in "moved from X"). */
export const EXECUTOR_NAMES: Readonly<Record<Exclude<InboxExecutor, "auto">, string>> = {
  antigravity: "Antigravity",
  ghostcli: "GhostCLI",
  opencode: "OpenCode Go",
  gemini: "Gemini",
  local: "Local model",
  claude: "Claude Code",
  opus: "Claude Opus",
};
