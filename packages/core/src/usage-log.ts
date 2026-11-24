/**
 * The usage log (Roee, 2026-11-24): one append-only JSONL file per day in KesherAI's data folder, kept 14 days, with what
 * every agent run used and every warning the run guard raised (agent-watch.ts): run start and end, quota readings,
 * anomalies, rescues, reviewer verdicts and stop reasons. Plus the code-based meter: a rolling baseline per executor and
 * task size (the median of the last runs) and the anomaly checks against it.
 *
 * Nothing here needs a model for the numbers. Entries hold no file contents or paths beyond a short `why`.
 */
import { appendFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

/** How serious an entry is. */
export type UsageLevel = "info" | "warning" | "error" | "suggestion";

/** What happened. */
export type UsageEvent = "saving" | "run-start" | "run-end" | "request" | "quota" | "anomaly" | "rescue" | "review" | "stop" | "cleanup";

/** One line of the log. */
export interface UsageEntry {
  /** Time (ms since epoch). */
  at: number;
  level: UsageLevel;
  /** The executor: opencode, antigravity, gemini, local, chat... */
  executor: string;
  /** The provider and model when known. */
  model?: string;
  /** The task id. */
  task?: string;
  /** The task size (S, M, L) for the baseline. */
  size?: string;
  event: UsageEvent;
  /** Counts: requests, tokens, minutes, files, and so on. */
  numbers?: Record<string, number>;
  /** A short reason in English (a watchdog's one-liner, a stop note). */
  why?: string;
}

/** A search over the log. */
export interface UsageQuery {
  level?: UsageLevel;
  executor?: string;
  task?: string;
  /** Only entries at or after this time (ms). */
  since?: number;
  /** Only entries whose text holds this (case-insensitive). */
  grep?: string;
  /** The most entries (newest last; default 500). */
  limit?: number;
}

/** One day's totals for one executor. */
export interface UsageDay {
  day: string;
  executor: string;
  runs: number;
  requests: number;
  tokens: number;
  minutes: number;
  warnings: number;
  errors: number;
  suggestions: number;
}

/** Days the log is kept. */
export const KEEP_DAYS = 14;
const LEVELS = new Set<UsageLevel>(["info", "warning", "error", "suggestion"]);

const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);
const fileOf = (day: string): string => `usage-${day}.jsonl`;

/** The median of numbers (0 for none). */
export function median(xs: readonly number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** The log's files in a folder: append, read, totals, and the 14-day rotation. */
export class UsageLog {
  private lastPrune = "";
  /** Appends run one after another, so the lines keep their order. */
  private chain: Promise<void> = Promise.resolve();

  /**
   * @param dir - The folder for the daily files (made when first written).
   * @param now - The clock.
   */
  constructor(private readonly dir: string, private readonly now: () => number = Date.now) {}

  /**
   * Appends one entry (never throws: a log must not stop a run) and drops files older than {@link KEEP_DAYS} once a day.
   *
   * @param e - The entry without a time (the clock adds it) or with one.
   */
  append(e: Omit<UsageEntry, "at"> & { at?: number }): Promise<void> {
    const entry = { ...e, at: e.at ?? this.now() };
    this.chain = this.chain.then(() => this.write(entry));
    return this.chain;
  }

  private async write(e: Omit<UsageEntry, "at"> & { at: number }): Promise<void> {
    try {
      const at = e.at;
      const entry: UsageEntry = { ...e, at, ...(e.why ? { why: e.why.replace(/\s+/g, " ").slice(0, 300) } : {}) };
      await mkdir(this.dir, { recursive: true });
      await appendFile(join(this.dir, fileOf(dayOf(at))), `${JSON.stringify(entry)}\n`, "utf8");
      const today = dayOf(this.now());
      if (this.lastPrune !== today) {
        this.lastPrune = today;
        await this.prune();
      }
    } catch {
      // The log is best effort.
    }
  }

  /** Removes the daily files older than {@link KEEP_DAYS}. */
  async prune(): Promise<void> {
    const oldest = dayOf(this.now() - KEEP_DAYS * 86_400_000);
    for (const f of await readdir(this.dir).catch(() => [] as string[])) {
      const m = /^usage-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
      if (m && m[1]! < oldest) await rm(join(this.dir, f), { force: true }).catch(() => undefined);
    }
  }

  /**
   * Reads entries, oldest first, newest last.
   *
   * @param q - The filters.
   */
  async read(q: UsageQuery = {}): Promise<UsageEntry[]> {
    const since = q.since ?? 0;
    const files = (await readdir(this.dir).catch(() => [] as string[])).filter((f) => /^usage-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(6, 16) >= dayOf(since)).sort();
    const grep = q.grep?.toLowerCase();
    const out: UsageEntry[] = [];
    for (const f of files) {
      for (const line of (await readFile(join(this.dir, f), "utf8").catch(() => "")).split("\n")) {
        if (!line.trim()) continue;
        let e: UsageEntry;
        try {
          e = JSON.parse(line) as UsageEntry;
        } catch {
          continue;
        }
        if (e.at < since || (q.level && e.level !== q.level) || (q.executor && e.executor !== q.executor) || (q.task && e.task !== q.task)) continue;
        if (grep && !line.toLowerCase().includes(grep)) continue;
        out.push(e);
      }
    }
    return out.slice(-Math.max(1, Math.min(q.limit ?? 500, 5000)));
  }

  /**
   * Daily totals per executor (the log page's totals row).
   *
   * @param since - From this time (ms; default the whole log).
   */
  async totals(since = 0): Promise<UsageDay[]> {
    const days = new Map<string, UsageDay>();
    for (const e of await this.read({ since, limit: 5000 })) {
      const key = `${dayOf(e.at)}|${e.executor}`;
      const d = days.get(key) ?? { day: dayOf(e.at), executor: e.executor, runs: 0, requests: 0, tokens: 0, minutes: 0, warnings: 0, errors: 0, suggestions: 0 };
      if (e.event === "run-end") {
        d.runs++;
        d.requests += e.numbers?.requests ?? 0;
        d.tokens += e.numbers?.tokens ?? 0;
        d.minutes += e.numbers?.minutes ?? 0;
      }
      if (e.level === "warning") d.warnings++;
      if (e.level === "error") d.errors++;
      if (e.level === "suggestion") d.suggestions++;
      days.set(key, d);
    }
    return [...days.values()].sort((a, b) => (a.day === b.day ? a.executor.localeCompare(b.executor) : a.day < b.day ? 1 : -1));
  }
}

/**
 * Parses the query string of GET /api/usage-log.
 *
 * @param q - The raw query values.
 */
export function usageQueryOf(q: Record<string, string | undefined>): UsageQuery {
  const since = q.since ? Number(q.since) : undefined;
  return {
    ...(q.level && LEVELS.has(q.level as UsageLevel) ? { level: q.level as UsageLevel } : {}),
    ...(q.executor ? { executor: q.executor.slice(0, 40) } : {}),
    ...(q.task ? { task: q.task.slice(0, 60) } : {}),
    ...(since !== undefined && Number.isFinite(since) ? { since } : {}),
    ...(q.grep ? { grep: q.grep.slice(0, 80) } : {}),
    ...(q.limit && Number.isFinite(Number(q.limit)) ? { limit: Number(q.limit) } : {}),
  };
}

/** How many runs the baseline looks at. */
export const BASELINE_RUNS = 20;
/** A run over this many times the baseline is an anomaly. */
export const OVER_BASELINE = 2;
/** One request whose input is longer than this many characters is a heavy step. */
export const HEAVY_STEP_CHARS = 20_000;

/**
 * The baseline for an executor and task size: the median requests and tokens of its last {@link BASELINE_RUNS} finished runs.
 *
 * @param entries - Log entries (any order).
 * @param executor - The executor.
 * @param size - The task size.
 * @returns The medians, or undefined with fewer than 3 runs (too little to judge by).
 */
export function baselineOf(entries: readonly UsageEntry[], executor: string, size: string): { requests: number; tokens: number; runs: number } | undefined {
  const runs = entries.filter((e) => e.event === "run-end" && e.executor === executor && e.size === size && e.numbers?.requests !== undefined).slice(-BASELINE_RUNS);
  if (runs.length < 3) return undefined;
  return { requests: median(runs.map((r) => r.numbers!.requests!)), tokens: median(runs.map((r) => r.numbers?.tokens ?? 0)), runs: runs.length };
}

/**
 * Whether a run's use is far above its baseline.
 *
 * @param use - The run's requests and tokens so far.
 * @param base - From {@link baselineOf}.
 * @returns What is over, in English, or undefined.
 */
export function overBaseline(use: { requests: number; tokens?: number }, base: { requests: number; tokens: number } | undefined): string | undefined {
  if (!base) return undefined;
  if (base.requests > 0 && use.requests > base.requests * OVER_BASELINE) return `${use.requests} requests, over ${OVER_BASELINE}x the usual ${base.requests} for this size`;
  if (base.tokens > 0 && (use.tokens ?? 0) > base.tokens * OVER_BASELINE) return `${use.tokens} tokens, over ${OVER_BASELINE}x the usual ${base.tokens} for this size`;
  return undefined;
}
