/**
 * The work loop's decisions (autonomy loop 5/5, a-20261122-05), as pure functions so each one is tested with a fake
 * clock. The inbox (inbox-runner.ts) runs them from one light timer every {@link LOOP_TICK_MS}:
 *
 * - {@link loopState}: running, or paused until Antigravity can take work again (its quota, every model family's
 *   quota, or today's cap). While paused nothing new is fed to Antigravity; the local model and OpenCode Go's free
 *   models still are.
 * - {@link standingDue}: when the backlog has nothing for Antigravity, the standing "what to research next" task is
 *   offered ("Run this task in Antigravity?" on the PC and the phone), at most once a (local) day. Run starts it.
 * - {@link summaryDue} and {@link dailySummary}: the 21:00 summary on the phone (done, failed, branches to review, next).
 *
 * Times are the PC's local time (the server runs on the PC), so "21:00" and "once a day" follow the user's own day.
 */

import type { InboxTaskView } from "@kesher/shared";

/** How often the loop looks (one timer; each look is a few in-memory checks unless something is due). */
export const LOOP_TICK_MS = 5 * 60_000;
/** The local hour of the daily summary. */
export const SUMMARY_HOUR = 21;
/** The loop keeps an executor's line at most this long. */
export const LINE_TARGET = 3;

/**
 * Added to the standing "what to research next" task when the loop queues it: where to read first and what to aim at
 * (Roee's priorities, 2026-11-22).
 */
export const STANDING_LOOP_NOTE =
  "\n\n## Loop focus\nThe work loop offered this because the research backlog is empty. Read docs/research/INDEX.md and docs/WORK_LIST.md first. Aim the new topics at, in this order: the co-developer (KesherAI working beside Roee in his tools), one chat for all tools, and the game-engine tools (Unity, Unreal, Godot). Write each new task into the report's `## Tasks` section (the format in docs/research/BACKLOG.md) so the loop can pick it up.";

/** The local day of a time, `YYYY-MM-DD`. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The next local midnight after a time (when today's cap resets). */
export function nextLocalMidnight(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

/** What the loop looks at to say whether it runs. */
export interface LoopInput {
  /** Settings › Task inbox › Keep the work loop running (`loop`, default on). */
  on: boolean;
  /** The inbox itself is on and not paused. */
  inboxOn: boolean;
  /** Antigravity's plan quota ran out until then (ms), if it did. */
  quotaUntil?: number | undefined;
  /** Each model family's quota end (ms). */
  familyUntil?: Partial<Record<string, number>> | undefined;
  /** The model families Antigravity can use. */
  families: readonly string[];
  /** Today's Antigravity cap is reached. */
  capReached: boolean;
  now: number;
}

/** The loop's state for the hub and the phone. */
export interface LoopState {
  state: "running" | "paused" | "off";
  /** Paused: when Antigravity can take work again (ms). */
  until?: number;
  /** Paused: why, in English (`quota`, `models`, `cap`). */
  why?: "quota" | "models" | "cap";
}

/**
 * Whether the loop runs, and if paused, until when. Paused while Antigravity cannot take a task: its plan's quota,
 * every model family out, or today's cap. The end is the latest of the reasons that apply (all must be over).
 *
 * @param i - The situation.
 */
export function loopState(i: LoopInput): LoopState {
  if (!i.on || !i.inboxOn) return { state: "off" };
  const reasons: Array<{ why: NonNullable<LoopState["why"]>; until: number }> = [];
  if ((i.quotaUntil ?? 0) > i.now) reasons.push({ why: "quota", until: i.quotaUntil! });
  const ends = i.families.map((f) => i.familyUntil?.[f] ?? 0);
  if (ends.length && ends.every((u) => u > i.now)) reasons.push({ why: "models", until: Math.min(...ends) });
  if (i.capReached) reasons.push({ why: "cap", until: nextLocalMidnight(i.now) });
  if (!reasons.length) return { state: "running" };
  const last = reasons.reduce((a, b) => (b.until > a.until ? b : a));
  return { state: "paused", until: last.until, why: last.why };
}

/** What decides whether the standing "what to research next" task is offered now. */
export interface StandingDueInput {
  /** The loop runs (not off, not paused). */
  running: boolean;
  /** The backlog has no task left for Antigravity. */
  backlogEmpty: boolean;
  /** Antigravity has no real (not standing) task waiting, queued or running. */
  idle: boolean;
  /** The local day the loop last offered it, if ever. */
  lastDay?: string | undefined;
  now: number;
}

/**
 * Whether the loop offers the standing "what to research next" task now: running, the backlog empty for Antigravity,
 * Antigravity idle, and not yet today.
 *
 * @param i - The situation.
 */
export function standingDue(i: StandingDueInput): boolean {
  return i.running && i.backlogEmpty && i.idle && i.lastDay !== localDay(i.now);
}

/**
 * Whether the daily summary is due: it is {@link SUMMARY_HOUR}:00 or later (local) and today's was not sent. A PC that
 * was off at 21:00 sends it when it comes back the same evening; the next morning it waits for the evening.
 *
 * @param now - Now (ms).
 * @param lastDay - The local day of the last summary sent.
 * @param hour - The hour (default {@link SUMMARY_HOUR}).
 */
export function summaryDue(now: number, lastDay: string | undefined, hour = SUMMARY_HOUR): boolean {
  return new Date(now).getHours() >= hour && lastDay !== localDay(now);
}

/** What the summary counts. */
export interface SummaryInput {
  tasks: readonly Pick<InboxTaskView, "id" | "title" | "status" | "endedAt" | "pushed" | "merged" | "runBy">[];
  /** Titles next in line (the lines first, then the backlog). */
  next: readonly string[];
  /** Counted from here (the last summary, or a day back). */
  since: number;
  state: LoopState;
}

/**
 * The daily summary's push: Hebrew title, English and Hebrew body lines. Done, failed, branches waiting for review
 * (pushed, not merged), and what is next.
 *
 * @param i - The tasks and what is next.
 */
export function dailySummary(i: SummaryInput): { title: string; body: string } {
  const ended = i.tasks.filter((t) => (t.endedAt ?? 0) >= i.since);
  const done = ended.filter((t) => t.status === "done" || t.status === "partial").length;
  const failed = ended.filter((t) => t.status === "failed").length;
  const review = i.tasks.filter((t) => t.pushed && !t.merged && (t.endedAt ?? 0) >= i.since - 6 * 24 * 60 * 60_000 && (t.status === "done" || t.status === "partial")).length;
  const cut = (s: string) => (s.length > 60 ? `${s.slice(0, 59).trimEnd()}…` : s);
  const next = i.next.slice(0, 3).map(cut);
  const paused = i.state.state === "paused" && i.state.until ? ` · paused until ${clock(i.state.until)}` : "";
  const pausedHe = i.state.state === "paused" && i.state.until ? ` · מושהית עד ${clock(i.state.until)}` : "";
  return {
    title: `📋 סיכום יומי: ${done} הושלמו · ${failed} נכשלו · ${review} ענפים לבדיקה${pausedHe}`,
    body: [
      `Today: ${done} done, ${failed} failed, ${review} branches to review${paused}.`,
      next.length ? `הבא בתור / Next: ${next.join(" · ")}` : "אין עוד משימות בתור / Nothing in line.",
    ].join("\n"),
  };
}

/** A local time as HH:MM. */
export function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
