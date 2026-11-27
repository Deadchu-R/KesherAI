import { readFile, writeFile } from "node:fs/promises";
import { arr, obj, str, type HttpFetch } from "./types.js";

/**
 * Prices in shekels from the Bank of Israel's official daily representative exchange rates
 * (https://boi.org.il/PublicApi/GetExchangeRates?asJson=true, free, no key). The table is kept for 24 hours (in memory
 * and in a small file, so a restart does not ask again); when the bank cannot be reached an older table is still used,
 * marked stale, and without any table the price is shown in its own currency only.
 */

/** The bank's public endpoint. */
export const BOI_URL = "https://boi.org.il/PublicApi/GetExchangeRates?asJson=true";
/** How long a table is fresh (ms). */
export const RATES_TTL_MS = 24 * 3600_000;

/** Shekels per one unit of each currency, as of a date. */
export interface RateTable {
  /** Day of the bank's table ("2026-11-28"). */
  date: string;
  /** When it was fetched (ms). */
  fetchedAt: number;
  rates: Record<string, number>;
}

/**
 * Reads the bank's JSON (`{exchangeRates:[{key:"USD", currentExchangeRate:3.58, unit:1, lastUpdate:"…"}]}`).
 *
 * @param json - The parsed response.
 * @param now - The time, ms.
 * @returns The table, or undefined when it holds no rate.
 */
export function parseBoi(json: unknown, now: number): RateTable | undefined {
  const rates: Record<string, number> = {};
  let date = "";
  for (const r of arr(obj(json).exchangeRates)) {
    const o = obj(r);
    const key = str(o.key).toUpperCase();
    const v = Number(o.currentExchangeRate);
    const unit = Number(o.unit) || 1;
    if (!/^[A-Z]{3}$/.test(key) || !(v > 0)) continue;
    rates[key] = v / unit;
    const d = str(o.lastUpdate).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d) && d > date) date = d;
  }
  return Object.keys(rates).length ? { date: date || new Date(now).toISOString().slice(0, 10), fetchedAt: now, rates } : undefined;
}

/** Converts prices to shekels, with the 24 h cache. */
export class IlsRates {
  private table: RateTable | undefined;
  private loaded = false;
  private inflight: Promise<RateTable | undefined> | undefined;

  /**
   * @param http - `fetch` (a fake in tests).
   * @param file - Where to keep the table between runs (none: memory only).
   * @param now - The clock, ms (tests).
   */
  constructor(
    private readonly http: HttpFetch,
    private readonly file?: string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * The current table: the cached one while it is under 24 h old, else a fresh one from the bank.
   *
   * @returns The table (possibly stale when the bank is unreachable), or undefined when there is none at all.
   */
  async current(): Promise<{ table: RateTable; stale: boolean } | undefined> {
    if (!this.loaded) {
      this.loaded = true;
      if (this.file) this.table = await readFile(this.file, "utf8").then((t) => JSON.parse(t) as RateTable, () => undefined);
      if (this.table && !(this.table.rates && typeof this.table.fetchedAt === "number")) this.table = undefined;
    }
    if (this.table && this.now() - this.table.fetchedAt < RATES_TTL_MS) return { table: this.table, stale: false };
    this.inflight ??= this.fetchTable().finally(() => (this.inflight = undefined));
    const fresh = await this.inflight;
    if (fresh) return { table: fresh, stale: false };
    return this.table ? { table: this.table, stale: true } : undefined;
  }

  private async fetchTable(): Promise<RateTable | undefined> {
    try {
      const res = await this.http(BOI_URL, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return undefined;
      const t = parseBoi(await res.json(), this.now());
      if (t) {
        this.table = t;
        if (this.file) await writeFile(this.file, JSON.stringify(t), { mode: 0o600 }).catch(() => undefined);
      }
      return t;
    } catch {
      return undefined;
    }
  }

  /**
   * An amount in shekels.
   *
   * @param amount - In `currency`.
   * @param currency - ISO code ("EUR"); "ILS" is returned as it is.
   * @returns The shekels (rounded), the rate's day and whether it is stale; undefined when no rate is known.
   */
  async toIls(amount: number, currency: string): Promise<{ ils: number; date: string; stale: boolean } | undefined> {
    const c = currency.toUpperCase();
    if (c === "ILS" || c === "NIS") return { ils: Math.round(amount), date: "", stale: false };
    const t = await this.current();
    const rate = t?.table.rates[c];
    return t && rate ? { ils: Math.round(amount * rate), date: t.table.date, stale: t.stale } : undefined;
  }
}
