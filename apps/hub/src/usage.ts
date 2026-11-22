/**
 * The hub's storage budget, counted in memory: rows read and written per kind of store call (a {@link HubStore}
 * method name), per UTC day, as Cloudflare's SQLite cursor reports them (`rowsRead`, `rowsWritten`; index entries
 * included). Shown in `GET /api/diag` so the owner sees where the free plan's daily quota goes. Nothing here is
 * written to storage: the counts start again when the Durable Object wakes after sleeping (`since` says when).
 */

/** Workers Free limits per day (Cloudflare's Durable Objects pricing page, 2026-11). */
export const FREE_DAILY = { rowsRead: 5_000_000, rowsWritten: 100_000 } as const;

/** One kind's counts. */
export interface UsageCount {
  /** Store calls. */
  calls: number;
  read: number;
  written: number;
  /** Calls that storage refused (the quota, or another failure). */
  refused: number;
}

/** What `GET /api/diag` shows. */
export interface UsageSnapshot {
  /** The UTC day counted (YYYY-MM-DD). */
  day: string;
  /** When counting began (the day's start, or the hub's wake-up if later), ISO time. */
  since: string;
  read: number;
  written: number;
  refused: number;
  free: typeof FREE_DAILY;
  /** Per kind, the biggest readers and writers first. */
  byKind: Record<string, UsageCount>;
}

/** The UTC day of a time, as YYYY-MM-DD. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Per-day counters of rows read and written, by kind. */
export class UsageMeter {
  private day: string;
  private since: number;
  private kinds = new Map<string, UsageCount>();

  /** @param now - The clock (tests pass their own). */
  constructor(private readonly now: () => number = Date.now) {
    this.since = this.now();
    this.day = utcDay(this.since);
  }

  /** Starts a new day when the UTC date changed. */
  private rollDay(): void {
    const t = this.now();
    const day = utcDay(t);
    if (day === this.day) return;
    this.day = day;
    this.since = t;
    this.kinds.clear();
  }

  /** The counts of a kind (today's). */
  private kind(name: string): UsageCount {
    this.rollDay();
    let c = this.kinds.get(name);
    if (!c) this.kinds.set(name, (c = { calls: 0, read: 0, written: 0, refused: 0 }));
    return c;
  }

  /**
   * Adds one store call.
   *
   * @param kind - The store method (e.g. `putDevice`).
   * @param read - Rows it read.
   * @param written - Rows it wrote.
   */
  add(kind: string, read: number, written: number): void {
    const c = this.kind(kind);
    c.calls++;
    c.read += Number.isFinite(read) ? read : 0;
    c.written += Number.isFinite(written) ? written : 0;
  }

  /**
   * Counts one call that storage refused.
   *
   * @param kind - The store method.
   */
  refused(kind: string): void {
    this.kind(kind).refused++;
  }

  /** @returns Today's counts (totals, and per kind sorted by rows written, then read). */
  snapshot(): UsageSnapshot {
    this.rollDay();
    const list = [...this.kinds.entries()].sort((a, b) => b[1].written - a[1].written || b[1].read - a[1].read);
    const sum = (k: keyof UsageCount) => list.reduce((n, [, c]) => n + c[k], 0);
    return { day: this.day, since: new Date(this.since).toISOString(), read: sum("read"), written: sum("written"), refused: sum("refused"), free: FREE_DAILY, byKind: Object.fromEntries(list.map(([k, c]) => [k, { ...c }])) };
  }
}
