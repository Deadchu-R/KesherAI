import { estimateTaskSteps, type InboxTaskView } from "@kesher/shared";

/**
 * The live progress notification of a running Antigravity task on the phone (Roee, 2026-11-22; board
 * PhoneInboxProgress). One notification per task (the same id, so each update replaces the last): a bar, the status,
 * the current step, steps done and left, and the time left. It goes through the phone app's own push path (live, or
 * UnifiedPush when the phone is away), so it works in remote too, and never to the notifications list, ntfy or the
 * PC (a note every 20 seconds there would bury everything else). When the task ends, the freed-slot notification takes
 * the same id and replaces it.
 *
 * The time left comes from the agent's plan when it has one (time per finished entry x entries left), else from the
 * step estimate (tool steps so far against estimateTaskSteps), else from past runs of the same kind, else from the
 * task's minute limit.
 */

/** The notification's id for a task (the freed-slot note at the end uses it too). */
export const progressRef = (taskId: string): string => `agy-${taskId}`;

/** Updates at most this often, unless the step changed. */
export const PROGRESS_EVERY_MS = 20_000;
/** Even a step change waits this long after the last update (a burst of tool calls is one update). */
const MIN_GAP_MS = 3_000;
/** Cells of the text bar. */
const CELLS = 5;

/** What the phone gets: the text (for every app version) and the native bar's numbers (for an app that can draw it). */
export interface ProgressNote {
  taskId: string;
  ref: string;
  title: string;
  body: string;
  /** 0..max; max 0 = going, length unknown. */
  progress: { v: number; max: number };
  /** What makes it a new step (an update is sent at once when this changes). */
  key: string;
}

/** The parts of a task the note reads (a running task, as the inbox keeps it). */
export type ProgressTask = Pick<InboxTaskView, "id" | "title" | "status" | "plan" | "steps" | "startedAt" | "maxMinutes" | "kind" | "acceptance" | "runBy" | "maxFiles" | "goal" | "check" | "label" | "modelUsed">;

/**
 * The median minutes of past runs of the same kind (Antigravity runs that ended done), or undefined with fewer than two.
 *
 * @param past - Earlier tasks of the inbox.
 * @param kind - The running task's kind.
 * @returns Minutes.
 */
export function pastMinutes(past: readonly Pick<InboxTaskView, "runBy" | "kind" | "status" | "startedAt" | "endedAt">[], kind: InboxTaskView["kind"]): number | undefined {
  const runs = past
    .filter((p) => p.runBy === "antigravity" && (p.kind ?? "code") === (kind ?? "code") && p.status === "done" && p.startedAt && p.endedAt && p.endedAt > p.startedAt)
    .map((p) => (p.endedAt! - p.startedAt!) / 60_000)
    .sort((a, b) => a - b)
    .slice(-20);
  if (runs.length < 2) return undefined;
  const mid = runs.length >> 1;
  return runs.length % 2 ? runs[mid]! : (runs[mid - 1]! + runs[mid]!) / 2;
}

/**
 * A text bar, e.g. "▓▓▓░░".
 *
 * @param part - 0..1.
 */
export function textBar(part: number): string {
  const full = Math.max(0, Math.min(CELLS, Math.round(part * CELLS)));
  return "▓".repeat(full) + "░".repeat(CELLS - full);
}

/**
 * The progress note of a running task.
 *
 * @param t - The task.
 * @param now - The time.
 * @param past - Earlier tasks (for the time of past runs of the same kind).
 * @returns The note.
 */
export function progressNote(t: ProgressTask, now: number, past: Parameters<typeof pastMinutes>[0] = []): ProgressNote {
  const elapsed = Math.max(0, (now - (t.startedAt ?? now)) / 60_000);
  const plan = t.plan ?? [];
  const planDone = plan.filter((e) => e.status === "completed").length;
  const current = plan.find((e) => e.status === "in_progress") ?? plan.find((e) => e.status !== "completed");
  let done: number;
  let total: number;
  let left: number | undefined;
  if (plan.length) {
    done = planDone;
    total = plan.length;
    const typical = pastMinutes(past, t.kind);
    left = done > 0 ? (elapsed / done) * (total - done) : typical !== undefined ? typical - elapsed : undefined;
  } else {
    done = t.steps ?? 0;
    total = Math.max(estimateTaskSteps(t), done + 1);
    const typical = pastMinutes(past, t.kind);
    left = typical !== undefined ? typical - elapsed : done > 0 ? (elapsed / done) * (total - done) : undefined;
  }
  // Never past the task's own limit, never below a minute while it still runs.
  if (left !== undefined) left = Math.max(1, Math.min(left, t.maxMinutes - elapsed));
  const waits = t.status === "needs-approval";
  const minutes = left !== undefined ? ` · ~${Math.round(left)} דק'` : "";
  const bar = `${textBar(total ? done / total : 0)} ${done}/${total}${minutes}`;
  const step = (current?.content ?? "").replace(/\s+/g, " ").trim().slice(0, 90);
  const name = (t.label?.name || t.title).replace(/\s+/g, " ").trim();
  const status = waits ? "⏸ מחכה לאישור שלך · Waits for your approval" : `▶ רץ · Running${t.modelUsed ? ` · ${t.modelUsed}` : ""}`;
  return {
    taskId: t.id,
    ref: progressRef(t.id),
    title: `✦ אנטיגרוויטי: ${name.length > 60 ? `${name.slice(0, 59).trimEnd()}…` : name}`,
    body: [bar, ...(step ? [`שלב: ${step}`] : []), status, `${done} בוצעו · ${Math.max(0, total - done)} נותרו`].join("\n"),
    progress: { v: Math.min(done, total), max: total },
    key: `${t.status}|${done}/${total}|${step}`,
  };
}

/**
 * Sends a task's progress note when its step changes (at most one per 3 s) or every {@link PROGRESS_EVERY_MS}, and
 * nothing more after {@link ProgressTicker.stop}.
 */
export class ProgressTicker {
  private last = 0;
  private lastKey = "";
  private lastBody = "";
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;

  /**
   * @param read - The task as it is now, and the earlier tasks.
   * @param send - Delivers a note to the phone.
   * @param now - The clock (tests).
   */
  constructor(
    private readonly read: () => { t: ProgressTask; past: Parameters<typeof pastMinutes>[0] },
    private readonly send: (n: ProgressNote) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /** Sends the first note and updates it every {@link PROGRESS_EVERY_MS} until {@link stop}. */
  start(): void {
    this.tick(true);
    this.timer = setInterval(() => this.tick(), PROGRESS_EVERY_MS);
    this.timer.unref?.();
  }

  /**
   * Called on each agent update (and by the timer): sends when the step changed or the interval passed.
   *
   * @param force - Send now (the first note).
   */
  tick(force = false): void {
    if (this.stopped) return;
    const { t, past } = this.read();
    if (t.status !== "running" && t.status !== "needs-approval") return;
    const now = this.now();
    const n = progressNote(t, now, past);
    const gap = now - this.last;
    const due = force || (n.key !== this.lastKey ? gap >= MIN_GAP_MS : gap >= PROGRESS_EVERY_MS - 500);
    if (!due || (!force && n.body === this.lastBody)) return;
    this.last = now;
    this.lastKey = n.key;
    this.lastBody = n.body;
    this.send(n);
  }

  /** No more notes (the run ended; the freed-slot note replaces the last one). */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }
}
