/**
 * What the server is busy with that can make it slow to answer (reading an Unreal level in a headless editor, which
 * takes the processor for a minute or more), and a small queue that keeps such jobs from piling up.
 *
 * The app asks `/api/health` every few seconds; while a long job runs, that answer carries `busy`, so the app says
 * "reading the level in the background" instead of "the computer is not answering".
 */

/** A note about a running long job, in both languages. */
export interface BusyNote {
  en: string;
  he: string;
}

const notes = new Map<symbol, BusyNote>();

/**
 * Marks a long job as running for as long as `job` takes.
 *
 * @param note - What it is doing, in English and Hebrew.
 * @param job - The work; the note is removed when it settles.
 * @returns What `job` returns.
 */
export async function withBusy<T>(note: BusyNote, job: () => Promise<T>): Promise<T> {
  const key = Symbol("busy");
  notes.set(key, note);
  try {
    return await job();
  } finally {
    notes.delete(key);
  }
}

/** @returns The oldest running long job's note, or undefined when the server is not busy. */
export function currentBusy(): BusyNote | undefined {
  return notes.values().next().value;
}

/**
 * Runs async jobs at most `limit` at a time, the rest waiting in order (so a page asking for hundreds of meshes does
 * not start hundreds of reads at once), and gives the same answer to the same key asked while it is still running.
 */
export class JobQueue {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly running = new Map<string, Promise<unknown>>();

  /** @param limit - How many jobs run at once (at least 1). */
  constructor(private readonly limit: number) {}

  /**
   * @param key - Identifies the job: asking again while it runs shares its answer.
   * @param job - The work.
   * @returns The job's answer.
   */
  run<T>(key: string, job: () => Promise<T>): Promise<T> {
    const same = this.running.get(key);
    if (same) return same as Promise<T>;
    const p = this.slot().then(async () => {
      try {
        return await job();
      } finally {
        this.release();
      }
    });
    this.running.set(key, p);
    const done = () => void (this.running.get(key) === p && this.running.delete(key));
    p.then(done, done);
    return p;
  }

  private slot(): Promise<void> {
    if (this.active < Math.max(1, this.limit)) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((go) => this.waiting.push(go));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }
}
