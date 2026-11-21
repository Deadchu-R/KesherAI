/**
 * Pure helpers for the downloads: a smoothed transfer rate and the time left from it, the free-space check before
 * a download starts, and the plain-words cause of a failed download. No disk or network access here, so each is
 * easy to test.
 */

/**
 * A transfer rate that does not jump: an exponential moving average over short windows. The first window sets the
 * rate; each later one moves it `alpha` of the way, so one slow second does not swing the time left.
 *
 * @example
 * ```ts
 * const m = new RateMeter();
 * m.add(5_000_000, 1000); // 5 MB in a second -> 5000000
 * ```
 */
export class RateMeter {
  private rate: number | undefined;

  /** @param alpha - How much a new window counts (0..1); 0.3 settles in about five windows. */
  constructor(private readonly alpha = 0.3) {}

  /**
   * Adds one measured window.
   *
   * @param bytes - Bytes moved in the window.
   * @param ms - How long the window was, in milliseconds.
   * @returns The smoothed rate in bytes per second.
   */
  add(bytes: number, ms: number): number {
    if (ms <= 0) return this.value;
    const sample = (bytes * 1000) / ms;
    this.rate = this.rate === undefined ? sample : this.rate + this.alpha * (sample - this.rate);
    return this.value;
  }

  /** @returns The smoothed rate in bytes per second (0 before the first window). */
  get value(): number {
    return Math.round(this.rate ?? 0);
  }

  /** Forgets everything, for a download that starts again. */
  reset(): void {
    this.rate = undefined;
  }
}

/**
 * Seconds left at a steady rate.
 *
 * @param remaining - Bytes still to go.
 * @param rate - Smoothed bytes per second.
 * @returns Whole seconds, or undefined when it cannot be told (no rate yet, or nothing left).
 */
export function secondsLeft(remaining: number, rate: number): number | undefined {
  if (!(rate > 0) || !(remaining > 0)) return undefined;
  return Math.ceil(remaining / rate);
}

const GIB = 1024 ** 3;

/**
 * The free space a download needs on its drive: the file, 10% more (temporary `.part` handling and a file that grew)
 * and 2 GB so the drive is not left full.
 *
 * @param sizeBytes - The file's size in bytes.
 * @returns Bytes.
 */
export function headroomBytes(sizeBytes: number): number {
  return Math.ceil(sizeBytes * 1.1 + 2 * GIB);
}

/**
 * Whether a file fits a drive with the headroom.
 *
 * @param freeBytes - Free bytes on the drive; undefined when it cannot be told (then it is let through).
 * @param sizeBytes - The file's size in bytes.
 */
export function hasHeadroom(freeBytes: number | undefined, sizeBytes: number): boolean {
  return freeBytes === undefined || freeBytes >= headroomBytes(sizeBytes);
}

/**
 * The other drive a file fits on, when the chosen one is too full.
 *
 * @param drives - The offered drives, free space in GB (undefined when unknown).
 * @param chosen - The id of the drive picked now.
 * @param sizeBytes - The file's size in bytes.
 * @returns The id of another drive with room (one whose free space is known), or undefined.
 */
export function driveWithRoom(drives: Array<{ id: string; freeGb?: number }>, chosen: string, sizeBytes: number): string | undefined {
  return drives.find((d) => d.id !== chosen && d.freeGb !== undefined && hasHeadroom(d.freeGb * GIB, sizeBytes))?.id;
}

/** What went wrong with a download, in the words the interface needs. */
export type DownloadErrorKind = "disk-full" | "auth" | "network" | "changed" | "other";

/**
 * Sorts a failure into a cause. The interface shows a plain sentence and one fix button for each:
 * `disk-full` -> choose another drive, `auth` -> a Hugging Face token is needed, `network` -> Retry (it resumes),
 * `changed` (the file changed on the hub) -> Restart; anything else -> Retry.
 *
 * @param message - The error text the download failed with (`HTTP 403 Forbidden`, `fetch failed: ETIMEDOUT`, ...).
 * @returns The cause.
 */
export function classifyDownloadError(message: string): DownloadErrorKind {
  if (/not enough disk space|ENOSPC|no space left/i.test(message)) return "disk-full";
  const http = /\bHTTP (\d{3})\b/.exec(message);
  const status = http ? Number(http[1]) : 0;
  if (status === 401 || status === 403) return "auth";
  if (status === 416 || status === 412 || /SHA-256 mismatch/i.test(message)) return "changed";
  if (status === 408 || status === 429 || status >= 500) return "network";
  if (/fetch failed|terminated|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR|timed? ?out|network/i.test(message)) return "network";
  return "other";
}
