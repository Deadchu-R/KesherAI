/**
 * The task inbox's queue per executor (Roee, 2026-11-22): the user taps "Add to queue" on several tasks, and when the
 * executor's slot frees, the next task of its line starts by itself, unless that executor's "ask before the next
 * task" setting is on (then the PC asks "Next in line - Start?" as before). A queued task also waits while a heavy
 * job runs (heavy-gate.ts). The tap that queued a task is the user's own tap for it (Antigravity starts only from one).
 * This file is the pure part (the lines and the decision); inbox-runner.ts does the starting.
 */

/** The executors that have a line: Antigravity (one run at a time) and the local model (self-work). */
export type QueueExecutor = "antigravity" | "local";

/** Both executors, in the order they are shown. */
export const QUEUE_EXECUTORS: readonly QueueExecutor[] = ["antigravity", "local"];

export { BUSY_RUN_TEXT } from "@kesher/shared";

/** The lines of task ids, first in line first. Memory only: a restart empties them (nothing starts without a fresh tap). */
export class TaskLines {
  private readonly lines: Record<QueueExecutor, string[]> = { antigravity: [], local: [] };

  /**
   * Adds a task to the end of an executor's line (a task already in a line keeps its place).
   *
   * @param ex - The executor.
   * @param id - The task id.
   * @returns Its place in the line (1 = next).
   */
  add(ex: QueueExecutor, id: string): number {
    this.remove(id);
    return this.lines[ex].push(id);
  }

  /**
   * Takes a task out of whatever line it is in.
   *
   * @param id - The task id.
   * @returns Whether it was queued.
   */
  remove(id: string): boolean {
    let found = false;
    for (const ex of QUEUE_EXECUTORS) {
      const i = this.lines[ex].indexOf(id);
      if (i >= 0) {
        this.lines[ex].splice(i, 1);
        found = true;
      }
    }
    return found;
  }

  /** @returns Whether the task is in any line. */
  has(id: string): boolean {
    return this.place(id) !== undefined;
  }

  /** @returns The task's place (1 = next) in its line, or undefined. */
  place(id: string): number | undefined {
    for (const ex of QUEUE_EXECUTORS) {
      const i = this.lines[ex].indexOf(id);
      if (i >= 0) return i + 1;
    }
    return undefined;
  }

  /** @returns The ids of an executor's line, first in line first (a copy). */
  ids(ex: QueueExecutor): string[] {
    return [...this.lines[ex]];
  }

  /** @returns The number of tasks in an executor's line. */
  size(ex: QueueExecutor): number {
    return this.lines[ex].length;
  }

  /** @returns The next id of an executor's line without taking it. */
  first(ex: QueueExecutor): string | undefined {
    return this.lines[ex][0];
  }

  /** @returns The next id of an executor's line, taken out of it. */
  shift(ex: QueueExecutor): string | undefined {
    return this.lines[ex].shift();
  }

  /**
   * Empties an executor's line.
   *
   * @returns The ids that were in it.
   */
  clear(ex: QueueExecutor): string[] {
    return this.lines[ex].splice(0);
  }

  /** @returns Whether both lines are empty. */
  get empty(): boolean {
    return QUEUE_EXECUTORS.every((e) => this.lines[e].length === 0);
  }
}

/** What to do with the head of a line now. */
export type QueueStep =
  | { kind: "idle" }
  | { kind: "wait"; job: string }
  | { kind: "ask" }
  | { kind: "start" };

/** What the decision looks at. */
export interface QueueInput {
  /** Tasks in the line. */
  queued: number;
  /** The executor's slot is free (nothing of it runs or waits on the board). */
  slotFree: boolean;
  /** The heavy job that runs now (heavy-gate.ts), if any. */
  heavy?: string;
  /** The executor's "ask before the next task" setting. */
  ask: boolean;
  /** A task of this executor just ended, so the next one is "the next task" (not the first tap on a free slot). */
  afterEnd: boolean;
}

/**
 * Decides what to do with the head of a line: nothing (empty line or the slot is busy), wait for a heavy job, ask
 * "Next in line - Start?" (the setting is on and a task just ended), or start it. A tap on a free slot starts at once
 * (it is the user's own start); only the task after an ended one is asked about.
 *
 * @param i - The line and the situation.
 */
export function queueStep(i: QueueInput): QueueStep {
  if (i.queued <= 0 || !i.slotFree) return { kind: "idle" };
  if (i.heavy) return { kind: "wait", job: i.heavy };
  if (i.ask && i.afterEnd) return { kind: "ask" };
  return { kind: "start" };
}

/** What happened to the line when an Antigravity task ended. */
export interface FreedInput {
  /** The task that ended and whether it succeeded. */
  ended: { title: string; ok: boolean };
  /** The queued task that started by itself (nothing was asked). */
  started?: string;
  /** The queued task the PC now asks about ("Next in line - Start?"). */
  asked?: string;
  /** The first Antigravity task that waits for the user's Run (not queued), when nothing else follows. */
  waiting?: string;
}

/**
 * The one notification for a freed Antigravity slot (Roee, 2026-11-22): who ended, and either "<next> started" (the
 * queue started it without asking), "next in line: <title>" (asked, or waiting for Run; a tap opens it), or just that
 * Antigravity is free. One per freed slot, never two.
 *
 * @param i - What ended and what follows.
 * @returns The title and body (Hebrew first, English on the second line) and the task title that a tap opens, if any.
 */
export function freedSlotNote(i: FreedInput): { title: string; body: string; open?: "asked" | "waiting" } {
  const mark = i.ended.ok ? "✓" : "✕";
  const cut = (s: string) => (s.length > 70 ? `${s.slice(0, 69).trimEnd()}…` : s);
  const ended = cut(i.ended.title);
  if (i.started) {
    return { title: `🟢 אנטיגרוויטי: ${ended} הסתיימה ${mark} · ${cut(i.started)} התחילה`, body: `Antigravity: ${ended} ${i.ended.ok ? "done" : "failed"}; ${cut(i.started)} started.` };
  }
  const next = i.asked ?? i.waiting;
  return {
    title: `🟢 אנטיגרוויטי פנוי — ${ended} הסתיימה ${mark}`,
    body: next ? `הבאה בתור: ${cut(next)}\nNext in line: ${cut(next)}` : `Antigravity is free: ${ended} ${i.ended.ok ? "done" : "failed"}.`,
    ...(next ? { open: i.asked ? ("asked" as const) : ("waiting" as const) } : {}),
  };
}

/** The inbox task whose text is the template of the standing "what to research next" task (on the inbox branch). */
export const STANDING_TEMPLATE_ID = "c-20261122-16";
/** A standing copy that ended less than this ago keeps the next one away (its report is still to be read). */
export const STANDING_QUIET_MS = 24 * 60 * 60_000;

/**
 * Standing tasks that come back on a schedule, whether or not Antigravity is busy (they wait in line for Run like any
 * task): the template id, how often, and a short tag for the copies' ids. "How to save tokens" (Roee, 22.11.2026).
 */
export const PERIODIC_STANDING: ReadonlyArray<{ template: string; everyDays: number; tag: string; note: string }> = [
  { template: "c-20261122-38", everyDays: 7, tag: "tokens", note: "Standing task: how to save tokens (weekly). Run starts it." },
];

/**
 * Whether a periodic standing task needs a new copy: none is open and the last one ended (or was made) at least
 * `everyDays` ago.
 *
 * @param copies - Its copies so far: ended or not, and when ended or made.
 * @param everyDays - The period.
 * @param now - Now (ms).
 */
export function periodicDue(copies: Array<{ ended: boolean; at?: number | undefined }>, everyDays: number, now: number): boolean {
  if (copies.some((c) => !c.ended)) return false;
  const last = Math.max(0, ...copies.map((c) => c.at ?? 0));
  return now - last >= everyDays * 24 * 60 * 60_000;
}

/** What the inbox looks at to decide about the standing task. */
export interface StandingInput {
  /** Real (not standing) Antigravity tasks that wait, run, wait for an approval, or are queued. */
  busy: boolean;
  /** The standing copies the inbox has: whether each has ended and when. */
  copies: Array<{ ended: boolean; endedAt?: number | undefined }>;
  /** The template task is known (it was fetched from the inbox branch). */
  hasTemplate: boolean;
  now: number;
}

/**
 * The standing "what to research next" task: shown (a fresh copy of the template, with Run) only while Antigravity
 * has nothing waiting, queued or running; at most one at a time; not again until the last copy's report has had a
 * day. It never runs by itself (Run is the user's own tap). When real work appears, an unstarted copy is withdrawn.
 *
 * @param i - The situation.
 * @returns `create` a fresh copy, `withdraw` the unstarted copy, or `none`.
 */
export function standingPlan(i: StandingInput): "create" | "withdraw" | "none" {
  if (i.busy) return i.copies.length ? "withdraw" : "none";
  if (!i.hasTemplate) return "none";
  if (i.copies.some((c) => !c.ended || (c.endedAt !== undefined && i.now - c.endedAt < STANDING_QUIET_MS))) return "none";
  return "create";
}

/**
 * The id of a standing copy.
 *
 * @param now - Now (ms).
 * @param n - The copy's number (1, 2, ...).
 */
export function standingId(now: number, n: number): string {
  return `c-${new Date(now).toISOString().slice(0, 10).replace(/-/g, "")}-next-${n}`;
}
