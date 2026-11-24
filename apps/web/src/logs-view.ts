/**
 * Pure helpers of the Logs page (pages/LogsPage.tsx): the query strings it sends, the time ranges, and how a
 * pattern's trend is drawn. Kept apart from the page so they can be tested.
 */

/** The four levels the server maps every log to (core: log-parse.ts). */
export type LogLevel = "error" | "warning" | "info" | "debug";
export const LEVELS: readonly LogLevel[] = ["error", "warning", "info", "debug"];

/** The time ranges offered, and how far back each one goes (ms); "all" has no limit. */
export const RANGES = { all: 0, "15m": 15 * 60_000, "1h": 3_600_000, "24h": 24 * 3_600_000, "7d": 7 * 24 * 3_600_000 } as const;
export type LogRange = keyof typeof RANGES;

/** What the filters say. */
export interface LogFilters {
  q: string;
  regex: boolean;
  levels: readonly LogLevel[];
  cat: string;
  range: LogRange;
}

/**
 * The query string for GET /api/logs/search or /api/logs/patterns.
 *
 * @param source - The source's id.
 * @param f - The filters.
 * @param now - The time now (ms), for the range.
 * @param extra - More parameters (context, limit).
 */
export function logQuery(source: string, f: Partial<LogFilters>, now = Date.now(), extra: Record<string, string | number> = {}): string {
  const p = new URLSearchParams({ source });
  if (f.q?.trim()) p.set("q", f.q.trim());
  if (f.regex && f.q?.trim()) p.set("regex", "1");
  // All four levels is the same as none: no filter.
  if (f.levels && f.levels.length && f.levels.length < LEVELS.length) p.set("levels", f.levels.join(","));
  if (f.cat) p.set("cats", f.cat);
  if (f.range && f.range !== "all") p.set("since", String(now - RANGES[f.range]));
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  return p.toString();
}

/**
 * The bars of a small trend chart, as one SVG path (each bucket a bar from the bottom, scaled to the largest).
 *
 * @param trend - Counts per time slice, oldest first.
 * @param w - The chart's width.
 * @param h - Its height.
 * @returns The path's `d`, or "" when there is nothing to draw.
 */
export function trendPath(trend: readonly number[], w = 72, h = 18): string {
  const max = Math.max(0, ...trend);
  if (!trend.length || !max) return "";
  const bw = w / trend.length;
  return trend
    .map((n, i) => {
      if (!n) return "";
      const bh = Math.max(1.5, (n / max) * h);
      const x = +(i * bw + 0.5).toFixed(2);
      return `M${x} ${h}v${-+bh.toFixed(2)}h${+(bw - 1).toFixed(2)}v${+bh.toFixed(2)}z`;
    })
    .join("");
}

/**
 * A short "how long ago" for a time, in the page's language.
 *
 * @param t - The time (ms), or undefined.
 * @param he - Hebrew.
 * @param now - The time now.
 */
export function ago(t: number | undefined, he: boolean, now = Date.now()): string {
  if (t === undefined) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return he ? "עכשיו" : "just now";
  const m = Math.round(s / 60);
  if (m < 60) return he ? `לפני ${m} דק'` : `${m} min ago`;
  const hr = Math.round(m / 60);
  if (hr < 48) return he ? `לפני ${hr} שע'` : `${hr} h ago`;
  const d = Math.round(hr / 24);
  return he ? `לפני ${d} ימים` : `${d} days ago`;
}

/** A file size in short words (KB, MB). */
export function sizeText(bytes: number | undefined): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(bytes < 10 * 1024 ** 2 ? 1 : 0)} MB`;
}

/**
 * Which source a link to the page asks for: `#/logs?source=<id>` or `#/logs?unreal=<project name>` (the Unreal page
 * links by name; the source's id is a hash of the project's path, which the page does not know).
 *
 * @param hash - The address's hash.
 * @param sources - The sources listed.
 * @returns The source's id, if the link names one that is there.
 */
export function linkedSource(hash: string, sources: ReadonlyArray<{ id: string; name: string; group: string }>): string | undefined {
  const i = hash.indexOf("?");
  if (i < 0) return undefined;
  const p = new URLSearchParams(hash.slice(i + 1));
  const id = p.get("source");
  if (id && sources.some((s) => s.id === id)) return id;
  const ue = p.get("unreal");
  if (ue) return sources.find((s) => s.group === "unreal" && s.name === `Unreal · ${ue}`)?.id;
  return undefined;
}
