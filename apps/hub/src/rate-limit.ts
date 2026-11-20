/**
 * Token-bucket rate limits, kept in the Durable Object's memory (they reset if the object is evicted, which only makes
 * them looser for a moment; Cloudflare's own rate-limit rule on `/api/*` is the outer guard). Limits from the research
 * entry, section 6.
 */

/** One limit: `burst` tries, refilled evenly over `perMs`. */
export interface Limit {
  burst: number;
  perMs: number;
}

/** The hub's limits. */
export const LIMITS = {
  signIn: { burst: 10, perMs: 60_000 },
  pairStart: { burst: 5, perMs: 60_000 },
  pairPoll: { burst: 40, perMs: 60_000 },
  pairApprove: { burst: 10, perMs: 60_000 },
  ticket: { burst: 10, perMs: 60_000 },
  /** Tasks (to a PC or the cloud) per sending device: matches the scheduled task's 30 fires an hour. */
  task: { burst: 30, perMs: 3_600_000 },
  /** Any socket frame per device. */
  message: { burst: 120, perMs: 60_000 },
  /** `sync` pings per device: one per 5 seconds on average (a burst of 2 allows for network jitter). */
  syncPing: { burst: 2, perMs: 10_000 },
  /** Answers and commands from the owner's phones and the hub page to a PC (approve, Run, Cancel): 30 a minute. */
  command: { burst: 30, perMs: 60_000 },
} as const satisfies Record<string, Limit>;

/** Buckets by key ("signIn:<ip hash>", "task:<device id>"). */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  /** @param now - The clock (tests pass their own). */
  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Takes one try from a bucket.
   *
   * @param key - The bucket.
   * @param limit - Its limit.
   * @returns True when allowed, false when over the limit (answer 429).
   */
  take(key: string, limit: Limit): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: limit.burst, at: t };
    b.tokens = Math.min(limit.burst, b.tokens + ((t - b.at) * limit.burst) / limit.perMs);
    b.at = t;
    const ok = b.tokens >= 1;
    if (ok) b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 5000) this.sweep(t);
    return ok;
  }

  /** Forgets full buckets, so the map stays small. */
  private sweep(t: number): void {
    for (const [k, b] of this.buckets) if (t - b.at > 3_600_000) this.buckets.delete(k);
  }
}
