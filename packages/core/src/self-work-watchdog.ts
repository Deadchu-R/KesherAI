/**
 * Self-work watchdog (found on the PC, 28.11: a run failed at 00:30 and nothing restarted it, so four tasks handed to
 * the local model waited all night; the local line stayed blocked by them).
 *
 * While tasks wait for the local model and self-work is down, it restarts the run with a growing wait (5, 15, 60
 * minutes, at most a few times a day) and tells the phone once. When it stays down past that, or the user turned it
 * off, the waiting tasks are handed on to the next executor that is ready, so nothing waits forever.
 */

/** Minutes to wait before restart number 1, 2, 3 (counted from when the run ended or was last restarted). */
export const WATCHDOG_BACKOFF_MIN = [5, 15, 60] as const;
/** Restarts per day at most; then the waiting tasks are handed on. */
export const WATCHDOG_DAILY_CAP = 6;
/** A run the user stopped is left alone this long, then its waiting tasks are handed on. */
export const WATCHDOG_USER_GRACE_MIN = 10;
/** A restarted run that works this long counts as healthy: the backoff starts over. */
export const WATCHDOG_HEALTHY_MIN = 30;

/** What the watchdog remembers between looks. */
export interface WatchdogState {
  /** Restarts since the run was last healthy. */
  attempts: number;
  /** When the last restart was tried. */
  lastAt?: number;
  /** The day (local date) of `today`, and restarts made that day. */
  day?: string;
  today: number;
  /** Since when the run has been working without a break. */
  runningSince?: number;
}

/** What the watchdog sees. */
export interface WatchdogInput {
  now: number;
  /** Tasks handed to the local model that wait for self-work. */
  localQueued: number;
  /** The self-work run, if any. */
  run?: { status: "running" | "waiting" | "done" | "blocked" | "stopped" | "failed"; endedAt?: number; note?: string };
  /** A game or another heavy job holds the PC (the restart waits, and does not count). */
  busy: boolean;
  /** The local date, YYYY-MM-DD. */
  date: string;
}

/** What to do now. */
export type WatchdogAction = { type: "none" } | { type: "restart"; why: string } | { type: "handoff"; why: string };

/** The note a run the user stopped has (self-work.ts `stop`). */
const USER_STOP = /^Stopped by you/i;

/**
 * One look: restart, hand on, or nothing. Pure (the caller applies the action and stores the new state).
 *
 * @param s - The remembered state.
 * @param i - What it sees now.
 * @returns The new state and the action.
 */
export function watchdogStep(s: WatchdogState, i: WatchdogInput): { state: WatchdogState; action: WatchdogAction } {
  const state: WatchdogState = { ...s };
  if (state.day !== i.date) {
    state.day = i.date;
    state.today = 0;
  }
  const none = { state, action: { type: "none" } as WatchdogAction };
  const working = i.run?.status === "running" || i.run?.status === "waiting";
  if (working) {
    state.runningSince ??= i.now;
    if (i.now - state.runningSince >= WATCHDOG_HEALTHY_MIN * 60_000) state.attempts = 0;
    return none;
  }
  delete state.runningSince;
  if (i.localQueued <= 0) {
    state.attempts = 0;
    return none;
  }
  if (i.busy) return none;
  const endedAt = i.run?.endedAt ?? state.lastAt ?? i.now;
  const since = i.now - Math.max(endedAt, state.lastAt ?? 0);
  const why = i.run ? `${i.run.status}${i.run.note ? `: ${i.run.note.replace(/\s+/g, " ").slice(0, 160)}` : ""}` : "no run";
  // Turned off by the user: not restarted; the tasks are handed on after a short grace.
  if (i.run?.status === "stopped" && USER_STOP.test(i.run.note ?? "")) {
    return since >= WATCHDOG_USER_GRACE_MIN * 60_000 ? { state, action: { type: "handoff", why: `self-work was stopped by you and ${i.localQueued} task(s) wait for it` } } : none;
  }
  // A finished goal or no run cannot be resumed: wait the first backoff, then hand on.
  const canResume = !!i.run && i.run.status !== "done";
  if (!canResume || state.attempts >= WATCHDOG_BACKOFF_MIN.length || state.today >= WATCHDOG_DAILY_CAP) {
    const wait = (canResume ? WATCHDOG_BACKOFF_MIN[WATCHDOG_BACKOFF_MIN.length - 1]! : WATCHDOG_BACKOFF_MIN[0]!) * 60_000;
    return since >= wait ? { state, action: { type: "handoff", why: canResume ? `self-work stayed down (${why})` : `self-work is not running (${why})` } } : none;
  }
  if (since < WATCHDOG_BACKOFF_MIN[state.attempts]! * 60_000) return none;
  state.attempts++;
  state.today++;
  state.lastAt = i.now;
  return { state, action: { type: "restart", why } };
}

/** What the watchdog needs from KesherAI (injected, so it can be tested). */
export interface WatchdogDeps {
  now?: () => number;
  /** Tasks waiting for the local model. */
  localQueued: () => Promise<number>;
  run: () => Promise<WatchdogInput["run"]>;
  busy: () => Promise<boolean>;
  /** Resumes the last run (same branch and chat); throws when it cannot. */
  restart: (why: string) => Promise<void>;
  /** Hands the waiting local tasks to the next ready executor; returns how many moved. */
  handOff: (why: string) => Promise<number>;
  /** Tells the user (phone and PC). */
  notify: (title: string, body: string) => void;
}

/** Looks at self-work now and then (see the file's note). */
export class SelfWorkWatchdog {
  private s: WatchdogState = { attempts: 0, today: 0 };
  private timer?: ReturnType<typeof setInterval>;
  private busy_ = false;

  /** @param d - What the watchdog needs from KesherAI. */
  constructor(private readonly d: WatchdogDeps) {}

  /** Starts looking every minute. */
  start(everyMs = 60_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), everyMs);
    this.timer.unref?.();
  }

  /** Stops looking. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** The remembered state (tests). */
  get state(): WatchdogState {
    return this.s;
  }

  /** One look, applying what {@link watchdogStep} says. */
  async tick(): Promise<WatchdogAction> {
    if (this.busy_) return { type: "none" };
    this.busy_ = true;
    try {
      const now = this.d.now ? this.d.now() : Date.now();
      const [localQueued, run, busy] = await Promise.all([this.d.localQueued(), this.d.run(), this.d.busy()]);
      const date = new Date(now).toLocaleDateString("sv-SE");
      const r = watchdogStep(this.s, { now, localQueued, ...(run ? { run } : {}), busy, date });
      this.s = r.state;
      if (r.action.type === "restart") {
        try {
          await this.d.restart(r.action.why);
          this.d.notify("Self-work restarted", `Self-work restarted: ${r.action.why}`);
        } catch {
          // The restart itself failed: counted as an attempt, tried again after the next wait.
          r.action = { type: "none" };
        }
      } else if (r.action.type === "handoff") {
        const moved = await this.d.handOff(r.action.why);
        this.s.attempts = 0;
        delete this.s.lastAt;
        if (moved) this.d.notify("Tasks handed on", `${moved} task(s) moved to another executor: ${r.action.why}`);
        else r.action = { type: "none" };
      }
      return r.action;
    } finally {
      this.busy_ = false;
    }
  }
}
