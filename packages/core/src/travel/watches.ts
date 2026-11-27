import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FlightQuery, StayQuery } from "./types.js";

/**
 * Price watches: a saved route (or stay) with dates and a highest price; KesherAI looks again every few hours
 * (within a budget), keeps the last 60 prices and tells the phone when the price drops. Stored in `travel-watches.json`.
 * Search only: nothing here books or pays.
 */

/** Most watches at once. */
export const MAX_WATCHES = 10;
/** Most polls of one watch in a day. */
export const MAX_POLLS_PER_DAY = 4;
/** Price points kept per watch. */
export const MAX_HISTORY = 60;
/** Default hours between polls. */
export const DEFAULT_EVERY_HOURS = 6;
/** Default alert thresholds: a drop of 8 % or of 150 shekels. */
export const DEFAULT_DROP = { percent: 8, shekel: 150 } as const;

/** One price seen. */
export interface PricePoint {
  /** When (ms). */
  at: number;
  /** The cheapest price then, in shekels. */
  ils: number;
  /** Who offers it ("Israir 6H", a hotel's name). */
  who?: string;
}

/** A saved watch. */
export interface Watch {
  id: string;
  kind: "flight" | "stay";
  query: FlightQuery | StayQuery;
  /** Tell me when the price is at or under this (shekels); none = only drops. */
  maxIls?: number;
  paused: boolean;
  createdAt: number;
  lastPollAt?: number;
  /** The local day of `pollsToday` ("2026-11-28"). */
  pollDay?: string;
  pollsToday: number;
  history: PricePoint[];
  /** The day an alert last went out (one a day per watch). */
  lastAlertDay?: string;
  /** The last problem (no key, search failed), cleared by the next good poll. */
  lastError?: string;
  /** The trip is over: the watch stopped by itself. */
  expired?: boolean;
}

/** Alert thresholds. */
export interface DropRule {
  percent: number;
  shekel: number;
}

/** @returns The local day "YYYY-MM-DD" of a time. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** @returns The date the trip starts ("YYYY-MM-DD"). */
function startOf(w: Watch): string {
  return w.kind === "flight" ? (w.query as FlightQuery).depart : (w.query as StayQuery).checkin;
}

/**
 * Whether a watch may be polled now: not paused or over, under today's budget, and the wait since the last poll is up.
 *
 * @param w - The watch.
 * @param now - The time, ms.
 * @param everyHours - Hours between polls.
 * @returns True when it is due.
 */
export function isDue(w: Watch, now: number, everyHours: number): boolean {
  if (w.paused || w.expired) return false;
  if (startOf(w) < dayKey(now)) return false;
  const today = dayKey(now);
  if (w.pollDay === today && w.pollsToday >= MAX_POLLS_PER_DAY) return false;
  const wait = Math.max(1, everyHours) * 3600_000;
  return w.lastPollAt === undefined || now - w.lastPollAt >= wait;
}

/**
 * Whether a new price is worth an alert: it fell from the last one by the share or the shekels of the rule, or it
 * just went under the highest price the user set. Never twice the same day, never for a rise.
 *
 * @param w - The watch (its history is the earlier prices).
 * @param ils - The new cheapest price.
 * @param rule - The thresholds.
 * @param now - The time, ms.
 * @returns The alert's reason, or undefined for none.
 */
export function detectDrop(w: Watch, ils: number, rule: DropRule, now: number): { reason: "drop" | "target"; from: number; drop: number } | undefined {
  const prev = w.history[w.history.length - 1];
  if (!prev || ils >= prev.ils) return undefined;
  if (w.lastAlertDay === dayKey(now)) return undefined;
  const drop = prev.ils - ils;
  if (drop >= rule.shekel || (drop / prev.ils) * 100 >= rule.percent) return { reason: "drop", from: prev.ils, drop };
  if (w.maxIls !== undefined && ils <= w.maxIls && prev.ils > w.maxIls) return { reason: "target", from: prev.ils, drop };
  return undefined;
}

/** What the store needs from outside. */
export interface WatchDeps {
  /** Looks the price up: the cheapest offer in shekels, or why not. */
  price(w: Watch): Promise<{ ils: number; who: string } | { error: string }>;
  /** Tells the phone. */
  notify(title: string, body: string): Promise<void>;
  /** Thresholds and wait (read on every poll). */
  rule(): DropRule & { everyHours: number };
  now?: () => number;
}

/** The watches, on disk. */
export class TravelWatches {
  private list: Watch[] = [];
  private ready: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  /**
   * @param file - `travel-watches.json`.
   * @param deps - Price lookup, notifier, thresholds.
   */
  constructor(
    private readonly file: string,
    private readonly deps: WatchDeps,
  ) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private load(): Promise<void> {
    this.ready ??= readFile(this.file, "utf8").then(
      (t) => {
        const j = JSON.parse(t) as { watches?: Watch[] };
        this.list = Array.isArray(j.watches) ? j.watches.filter((w) => w && typeof w.id === "string" && Array.isArray(w.history)) : [];
      },
      () => undefined,
    );
    return this.ready;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify({ watches: this.list }, null, 1), { mode: 0o600 });
    await rename(tmp, this.file);
  }

  /** @returns All watches (a copy). */
  async all(): Promise<Watch[]> {
    await this.load();
    return this.list.map((w) => ({ ...w, history: [...w.history] }));
  }

  /**
   * Saves a new watch.
   *
   * @param kind - Flight or stay.
   * @param query - The checked query.
   * @param maxIls - The highest price to be told about (shekels), if any.
   * @returns The watch, or a sentence saying why not (too many).
   */
  async add(kind: Watch["kind"], query: FlightQuery | StayQuery, maxIls?: number): Promise<Watch | string> {
    await this.load();
    if (this.list.filter((w) => !w.expired).length >= MAX_WATCHES) return `Up to ${MAX_WATCHES} price watches at once: delete one in Settings › Travel first.`;
    const w: Watch = { id: randomUUID().slice(0, 8), kind, query, ...(maxIls && maxIls > 0 ? { maxIls: Math.round(maxIls) } : {}), paused: false, createdAt: this.now(), pollsToday: 0, history: [] };
    this.list.push(w);
    await this.save();
    return w;
  }

  /** @returns Whether the watch existed (paused or resumed). */
  async setPaused(id: string, paused: boolean): Promise<boolean> {
    await this.load();
    const w = this.list.find((x) => x.id === id);
    if (!w) return false;
    w.paused = paused;
    await this.save();
    return true;
  }

  /** @returns Whether the watch existed (deleted). */
  async remove(id: string): Promise<boolean> {
    await this.load();
    const n = this.list.length;
    this.list = this.list.filter((x) => x.id !== id);
    if (this.list.length === n) return false;
    await this.save();
    return true;
  }

  /**
   * Looks at every watch that is due (one at a time, so the providers are not hit in a burst), records the price and
   * alerts the phone on a drop.
   *
   * @returns How many watches were polled.
   */
  async pollDue(): Promise<number> {
    await this.load();
    if (this.busy) return 0;
    this.busy = true;
    let polled = 0;
    try {
      for (const w of this.list) {
        const now = this.now();
        const rule = this.deps.rule();
        if (!w.expired && startOf(w) < dayKey(now)) {
          w.expired = true;
          continue;
        }
        if (!isDue(w, now, rule.everyHours)) continue;
        polled++;
        // The poll counts against the budget even when it fails, so a broken key is not retried in a loop.
        const day = dayKey(now);
        w.pollsToday = w.pollDay === day ? w.pollsToday + 1 : 1;
        w.pollDay = day;
        w.lastPollAt = now;
        const r = await this.deps.price(w).catch((e: unknown) => ({ error: e instanceof Error ? e.message : "search failed" }));
        if ("error" in r) {
          w.lastError = r.error.slice(0, 200);
          continue;
        }
        delete w.lastError;
        const hit = detectDrop(w, r.ils, rule, now);
        w.history.push({ at: now, ils: r.ils, who: r.who });
        if (w.history.length > MAX_HISTORY) w.history.splice(0, w.history.length - MAX_HISTORY);
        if (hit) {
          w.lastAlertDay = day;
          await this.deps.notify(`${watchLabel(w)}: ₪${r.ils.toLocaleString("en-US")}`, `${hit.reason === "target" ? "Now under your limit" : `Down ₪${hit.drop.toLocaleString("en-US")}`} (was ₪${hit.from.toLocaleString("en-US")}) · ${r.who}`).catch(() => undefined);
        }
      }
      await this.save();
    } finally {
      this.busy = false;
    }
    return polled;
  }

  /** Starts looking every 10 minutes for watches that are due (the budget decides which are). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pollDue().catch(() => undefined), 10 * 60_000);
    this.timer.unref();
  }

  /** Stops the timer. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** @returns A short name for a watch: "TLV → FCO · 2027-03-12". */
export function watchLabel(w: Pick<Watch, "kind" | "query">): string {
  if (w.kind === "flight") {
    const q = w.query as FlightQuery;
    return `${q.from} → ${q.to} · ${q.depart}${q.return ? ` – ${q.return}` : ""}`;
  }
  const q = w.query as StayQuery;
  return `${q.city} · ${q.checkin} – ${q.checkout}`;
}
