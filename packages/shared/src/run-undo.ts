/**
 * The 5-second undo window of a Run tap (hub page and the PC's task inbox page). A tap on Run does not send anything:
 * the button turns into "Starting in 5… Undo", and the command is sent only when the window ends (Undo cancels it and
 * nothing is sent). One pure helper with explicit times, so both pages share it and it is tested without a browser.
 */

/** How long a tapped Run waits for Undo (ms). */
export const RUN_UNDO_MS = 5000;

/** The key of the one "Run all" window (a task id never starts with a space). */
export const RUN_ALL_KEY = " all";

/**
 * The whole seconds a window still shows ("5", "4", … "1"), counting down; 0 once it is over.
 *
 * @param armedAt - When Run was tapped (ms).
 * @param now - Now (ms).
 */
export function undoSecondsLeft(armedAt: number, now: number): number {
  return Math.max(0, Math.ceil((armedAt + RUN_UNDO_MS - now) / 1000));
}

/** Pending Run taps by key (a task id, or {@link RUN_ALL_KEY}), each with the time it was tapped. */
export class RunUndo {
  private readonly armed = new Map<string, number>();

  /**
   * A Run tap: starts the window (a second tap while it counts changes nothing, so a double tap never restarts it).
   *
   * @param key - The task, or {@link RUN_ALL_KEY}.
   * @param now - Now (ms).
   */
  arm(key: string, now: number): void {
    if (!this.armed.has(key)) this.armed.set(key, now);
  }

  /**
   * Undo: drops the window, so nothing is sent.
   *
   * @param key - The task, or {@link RUN_ALL_KEY}.
   * @returns Whether a window was open.
   */
  cancel(key: string): boolean {
    return this.armed.delete(key);
  }

  /** The seconds to show for a key, or undefined when no window is open for it. */
  left(key: string, now: number): number | undefined {
    const at = this.armed.get(key);
    return at === undefined ? undefined : Math.max(1, undoSecondsLeft(at, now));
  }

  /** Whether any window is open (the page redraws every second while so). */
  get active(): boolean {
    return this.armed.size > 0;
  }

  /**
   * Takes the keys whose window is over: they leave the set, and the caller sends each command now.
   *
   * @param now - Now (ms).
   * @returns The keys that are due, oldest tap first.
   */
  due(now: number): string[] {
    const out = [...this.armed].filter(([, at]) => now - at >= RUN_UNDO_MS).sort((a, b) => a[1] - b[1]).map(([k]) => k);
    for (const k of out) this.armed.delete(k);
    return out;
  }
}
