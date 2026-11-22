/**
 * The heavy-job gate: one heavy job at a time on this computer (an Unreal or Unity build, a plugin install, loading a
 * big model, a self-work run's `pnpm install`, picture and video generation). Two of them together used up the
 * memory and the computer powered off (found on the PC), so the others wait in a queue, in order, and the app shows
 * "waiting for <job>" instead of failing them.
 *
 * Two more rules:
 * - **Low memory:** while the memory watchdog ({@link ./memory-watchdog.ts}) says the computer is low on memory, a
 *   new heavy job is refused (it fails at once with {@link LowMemoryError}), because waiting would not help.
 * - **Re-entrant:** a heavy job that starts another heavy job (a generation that loads its model) runs the inner one
 *   straight away, so it cannot wait for itself.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** A name in both languages, for what the app shows. */
export interface HeavyLabel {
  en: string;
  he: string;
}

/** What the gate shows (part of `/api/health`). */
export interface HeavyStatus {
  /** The job that runs now. */
  running?: HeavyLabel & { since: number };
  /** The jobs in the queue, first in line first. */
  waiting: HeavyLabel[];
  /** Set while new heavy jobs are refused. */
  lowMemory?: HeavyLabel;
}

/** A heavy job was refused because the computer is low on memory. */
export class LowMemoryError extends Error {
  /** HTTP status for a route that lets it through. */
  readonly statusCode = 503;
  /** The same text in Hebrew. */
  readonly he: string;

  /** @param why - The reason, in both languages. */
  constructor(why: HeavyLabel) {
    super(why.en);
    this.name = "LowMemoryError";
    this.he = why.he;
  }
}

/** The text the gate gives while the computer is low on memory. */
export const LOW_MEMORY: HeavyLabel = { en: "The computer is low on memory", he: "המחשב עמוס בזיכרון" };

interface Waiter {
  label: HeavyLabel;
  go: () => void;
}

/**
 * Lets one heavy job run at a time; the rest wait in order.
 */
export class HeavyGate {
  private current?: { id: symbol; label: HeavyLabel; since: number };
  private readonly queue: Waiter[] = [];
  private pressure?: HeavyLabel;
  private readonly inside = new AsyncLocalStorage<symbol>();

  /**
   * Sets or clears the "low on memory" state (the memory watchdog calls this).
   *
   * @param why - Why new heavy jobs are refused, or undefined when memory is fine again.
   */
  setPressure(why: HeavyLabel | undefined): void {
    this.pressure = why;
  }

  /** @returns What runs and what waits now. */
  status(): HeavyStatus {
    return {
      ...(this.current ? { running: { ...this.current.label, since: this.current.since } } : {}),
      waiting: this.queue.map((w) => w.label),
      ...(this.pressure ? { lowMemory: this.pressure } : {}),
    };
  }

  /**
   * Runs a heavy job when it is its turn.
   *
   * @param label - What the job is, in both languages (shown to the others waiting for it).
   * @param job - The work; the next job in the queue starts when it settles.
   * @param signal - Cancels the wait in the queue (a job already running is not touched).
   * @returns What `job` returns.
   * @throws {LowMemoryError} When the computer is low on memory, now or when its turn comes.
   */
  async run<T>(label: HeavyLabel, job: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    // Called from inside the running heavy job: it already holds the turn.
    const held = this.inside.getStore();
    if (held && held === this.current?.id) return job();
    if (this.pressure) throw new LowMemoryError(this.pressure);
    if (this.current) await this.wait(label, signal);
    // The turn came, but the computer may have run short while this waited.
    if (this.pressure) {
      this.current = undefined;
      this.pass();
      throw new LowMemoryError(this.pressure);
    }
    const id = Symbol("heavy");
    this.current = { id, label, since: Date.now() };
    try {
      return await this.inside.run(id, async () => job());
    } finally {
      this.current = undefined;
      this.pass();
    }
  }

  /**
   * @returns The running job's label (what the others are waiting for), or undefined when the gate is free.
   */
  runningLabel(): HeavyLabel | undefined {
    return this.current?.label;
  }

  /** Waits in the queue; the slot is marked taken by the caller when this resolves. */
  private wait(label: HeavyLabel, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("Cancelled while waiting for another heavy job."));
      const waiter: Waiter = {
        label,
        go: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        const i = this.queue.indexOf(waiter);
        if (i >= 0) this.queue.splice(i, 1);
        reject(new Error("Cancelled while waiting for another heavy job."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(waiter);
    });
  }

  /** Hands the turn to the next waiting job. */
  private pass(): void {
    const next = this.queue.shift();
    if (!next) return;
    // The next job takes the slot in its own continuation; hold it now so nobody slips in between.
    this.current = { id: Symbol("handover"), label: next.label, since: Date.now() };
    next.go();
  }
}

/** The one gate of this server. */
export const heavyGate = new HeavyGate();

/**
 * "Waiting for <job>" in the given language, for a screen's status line.
 *
 * @param running - The job that holds the gate.
 * @param he - Hebrew when true.
 * @returns The sentence.
 */
export function waitingFor(running: HeavyLabel, he: boolean): string {
  return he ? `ממתין ל: ${running.he}` : `Waiting for: ${running.en}`;
}
