/**
 * "Drain" before an update: while a downloaded update waits for a free moment (install-when-free.ts), KesherAI stops
 * STARTING new agent runs (the task inbox, its work loop, routines that start agents). Runs that already go on finish
 * (with the agent watch limits), so the install finds a free moment within one task instead of never, because the
 * inbox used to start the next task the moment one ended. After the restart the new process starts with no drain and
 * the runs go on as usual ("Continue what was running" brings back what the restart cut off).
 */
import { randomBytes } from "node:crypto";

/** A drain longer than this tells the phone once ("Update waiting for ..."). */
export const DRAIN_NOTIFY_MS = 90 * 60_000;
/** How long the "Install now" button's one-time code works. */
export const INSTALL_CODE_MS = 6 * 3_600_000;
/** The note a task shows while it waits for the update (the inbox's text, Hebrew and English). */
export const DRAIN_NOTE = "An update waits: new tasks start after it. / העדכון ממתין: משימות חדשות יתחילו אחריו.";

/** The shared flag the inbox, the work loop and the routines read, and the waiter sets. */
export class UpdateDrain {
  private since: number | undefined;
  private notified = false;
  private code: { value: string; expires: number } | undefined;

  /**
   * @param now - The clock (a fake one in tests).
   */
  constructor(private readonly now: () => number = Date.now) {}

  /** Whether an update waits and no new run may start. */
  get pending(): boolean {
    return this.since !== undefined;
  }

  /** How long the drain has lasted, in ms (0 when none). */
  get elapsedMs(): number {
    return this.since === undefined ? 0 : this.now() - this.since;
  }

  /** Starts draining (does nothing when it already does, so the clock keeps its start). */
  begin(): void {
    this.since ??= this.now();
  }

  /** Stops draining (the update was installed, failed, or the choice was turned off). */
  end(): void {
    this.since = undefined;
    this.notified = false;
    this.code = undefined;
  }

  /**
   * Whether the phone should be told now: the drain lasted over {@link DRAIN_NOTIFY_MS} and it was not told yet.
   * Returns true once per drain (it marks itself as told).
   */
  takeLongNotice(): boolean {
    if (this.since === undefined || this.notified || this.elapsedMs < DRAIN_NOTIFY_MS) return false;
    this.notified = true;
    return true;
  }

  /**
   * A one-time code for the notification's "Install now" button (32 URL-safe characters, like the other quick
   * buttons). It works once and for {@link INSTALL_CODE_MS} at most.
   */
  makeCode(): string {
    const value = randomBytes(24).toString("base64url");
    this.code = { value, expires: this.now() + INSTALL_CODE_MS };
    return value;
  }

  /**
   * Checks and uses the button's code.
   * @param code - What the button sent.
   * @returns True once for the right, fresh code while the drain lasts.
   */
  useCode(code: string): boolean {
    const c = this.code;
    this.code = undefined;
    return !!c && this.pending && c.expires > this.now() && c.value.length === code.length && c.value === code;
  }
}
