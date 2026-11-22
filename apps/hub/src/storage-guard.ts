/**
 * Storage failures, told apart from bugs. The Durable Object's SQLite throws when the account's daily free quota of
 * rows written is used up (Workers Free: 100,000 a day, reset at 00:00 UTC). {@link guardStore} wraps the store so
 * every such throw becomes a {@link HubStorageError}; the Durable Object answers it with 503 and a clear code instead
 * of a bare 500, and the PC waits for the reset instead of retrying every few minutes.
 */

/** The code the hub answers with: the daily quota is used up, or storage failed some other way. */
export type HubStorageCode = "hub-storage-limit" | "hub-storage-error";

/** A storage call that threw (the original error is the `cause`). */
export class HubStorageError extends Error {
  /** @param code - Which kind of failure. @param cause - What the storage threw. */
  constructor(readonly code: HubStorageCode, cause: unknown) {
    super(code === "hub-storage-limit" ? "The hub reached Cloudflare's daily storage limit; it comes back at midnight UTC." : "The hub's storage failed.", { cause });
    this.name = "HubStorageError";
  }
}

/** Words Cloudflare uses when a quota or limit stops a write (matched loosely: the exact text is not documented). */
const LIMIT_WORDS = /limit|quota|exceed|rows written|SQLITE_FULL|too many/i;

/**
 * Whether an error is a storage error, and of which kind.
 *
 * @param e - What was thrown.
 * @returns The code, or undefined when it is not a {@link HubStorageError}.
 */
export function storageCode(e: unknown): HubStorageCode | undefined {
  return e instanceof HubStorageError ? e.code : undefined;
}

/**
 * Wraps a store so each method that throws throws a {@link HubStorageError} instead (a limit error when its message
 * says so). Return values and everything else pass through unchanged.
 *
 * @param store - The store (an object whose methods call storage).
 * @returns The same store, guarded.
 */
export function guardStore<T extends object>(store: T): T {
  return new Proxy(store, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        try {
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        } catch (e) {
          if (e instanceof HubStorageError) throw e;
          throw new HubStorageError(LIMIT_WORDS.test(e instanceof Error ? e.message : String(e)) ? "hub-storage-limit" : "hub-storage-error", e);
        }
      };
    },
  });
}

/**
 * Seconds until the next 00:00 UTC (when Cloudflare resets the daily quotas).
 *
 * @param now - The time in ms.
 * @returns At least 60.
 */
export function secondsToUtcMidnight(now: number): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(60, Math.ceil((next.getTime() - now) / 1000));
}
