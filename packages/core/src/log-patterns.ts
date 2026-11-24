/**
 * Groups log entries into patterns (Roee, 2026-11-24), the way Datadog's Log Patterns and Grafana's Patterns tab
 * (Drain) do: the parts that change from line to line (numbers, ids, paths, hex, quoted values, addresses) are
 * masked, lines with the same shape are counted together, and templates that differ in a few words are merged with
 * `<*>` where they differ. Each pattern keeps its count, first and last seen, a small trend, and an example.
 */
import { createHash } from "node:crypto";
import type { LogEntry, LogLevel } from "./log-parse.js";

/** What a user can call a pattern; kept and applied the next time the pattern is seen. */
export type PatternLabel = "bug" | "known" | "ignore";

/** Labels a user can set. */
export const PATTERN_LABELS: readonly PatternLabel[] = ["bug", "known", "ignore"];

/** One group of lines with the same shape. */
export interface LogPattern {
  /** Stable id: a hash of the source, level, category and template. */
  id: string;
  template: string;
  level: LogLevel;
  cat?: string;
  count: number;
  /** First and last time seen (ms), when the lines have times. */
  first?: number;
  last?: number;
  /** Counts in {@link TREND_BUCKETS} equal slices of the time read, oldest first (empty without times). */
  trend: number[];
  /** True when the last quarter of the trend has more than twice its share of the lines. */
  rising: boolean;
  /** An example line (the newest) and its line number. */
  sample: string;
  sampleLine: number;
  /** Line numbers of up to {@link LINES_KEPT} of the newest lines (to show "this pattern's lines"). */
  lines: number[];
  label?: PatternLabel;
  /** Not in the patterns seen at the last look. */
  isNew?: boolean;
}

/** Slices in a pattern's trend. */
export const TREND_BUCKETS = 12;
/** Line numbers kept per pattern. */
export const LINES_KEPT = 200;
/** How alike two templates of the same length must be (share of equal words) to be merged (Drain's threshold). */
export const MERGE_SIMILARITY = 0.6;
/** The most patterns kept (the rest are counted in the last one, "other lines"). */
export const MAX_PATTERNS = 2000;

const WILD = "<*>";

/** Masks, in order: the earlier ones keep later ones from cutting them into pieces. */
const MASKS: Array<[RegExp, string]> = [
  [/"(?:[^"\\]|\\.)*"/g, "<str>"],
  [/'(?:[^'\\\s]|\\.)(?:[^'\\]|\\.)*'/g, "<str>"],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "<url>"],
  [/\b[A-Za-z]:[\\/][^\s"'<>|]*/g, "<path>"],
  [/(?:~|\.{1,2})?(?:\/[\w.@+-]+){2,}\/?/g, "<path>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>"],
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "<ip>"],
  [/\b0x[0-9a-f]+\b/gi, "<hex>"],
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, "<hex>"],
  [/\b(?:[a-z]+[-_])+\d[\w-]*\b/gi, "<id>"],
  [/[-+]?\b\d+(?:[.,:]\d+)*(?:[a-z%]{1,3})?\b/gi, "<num>"],
];

/**
 * A message with its changing parts masked (`took 12 ms for "a.png"` → `took <num> ms for <str>`).
 *
 * @param msg - A log message.
 * @returns Its shape, with spaces collapsed.
 */
export function maskMessage(msg: string): string {
  let s = msg.slice(0, 600);
  for (const [re, to] of MASKS) s = s.replace(re, to);
  return s.replace(/\s+/g, " ").trim();
}

/** Share of the positions where two templates of the same length have the same word (`<*>` counts as equal). */
export function similarity(a: readonly string[], b: readonly string[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let same = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i] || a[i] === WILD || b[i] === WILD) same++;
  return same / a.length;
}

/** Whether a saved template still describes a pattern (same length, the same words where neither is `<*>`). */
export function templateMatches(saved: string, template: string): boolean {
  if (saved === template) return true;
  const a = saved.split(" ");
  const b = template.split(" ");
  return a.length === b.length && a.every((w, i) => w === b[i] || w === WILD || b[i] === WILD) && similarity(a, b) >= MERGE_SIMILARITY;
}

/**
 * The stable id of a pattern.
 *
 * @param source - The log source's id.
 * @param level - Its level.
 * @param cat - Its category, if any.
 * @param template - Its template.
 */
export function patternId(source: string, level: LogLevel, cat: string | undefined, template: string): string {
  return createHash("sha1").update(`${source}\0${level}\0${cat ?? ""}\0${template}`).digest("hex").slice(0, 16);
}

interface Cluster {
  words: string[];
  level: LogLevel;
  cat?: string;
  count: number;
  first?: number;
  last?: number;
  times: number[];
  sample: string;
  sampleLine: number;
  lines: number[];
}

/**
 * Groups entries into patterns (Drain-like: same level, category and word count, then merged when alike).
 *
 * @param source - The source's id (part of each pattern's id).
 * @param entries - Parsed entries, oldest first.
 * @param times - Each entry's time for the trend (log-parse.ts carriedTimes), same order.
 * @returns The patterns, most lines first (errors before warnings when counts tie).
 */
export function groupPatterns(source: string, entries: readonly LogEntry[], times: ReadonlyArray<number | undefined> = entries.map((e) => e.t)): LogPattern[] {
  const groups = new Map<string, Cluster[]>();
  let total = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const words = maskMessage(e.msg).split(" ");
    const key = `${e.level}\0${e.cat ?? ""}\0${words.length}`;
    const list = groups.get(key) ?? [];
    if (!list.length) groups.set(key, list);
    // Short lines (one or two words) must match exactly: a merge there would join unrelated messages.
    let best: Cluster | undefined;
    let bestSim = 0;
    for (const c of list) {
      const sim = similarity(c.words, words);
      if (sim > bestSim) [best, bestSim] = [c, sim];
    }
    const need = words.length <= 2 ? 1 : MERGE_SIMILARITY;
    let c = best && bestSim >= need ? best : undefined;
    if (!c) {
      if (total >= MAX_PATTERNS) continue;
      c = { words, level: e.level, ...(e.cat ? { cat: e.cat } : {}), count: 0, times: [], sample: e.msg, sampleLine: e.n, lines: [] };
      list.push(c);
      total++;
    } else {
      for (let w = 0; w < words.length; w++) if (c.words[w] !== words[w]) c.words[w] = WILD;
    }
    c.count++;
    const t = times[i];
    if (t !== undefined) {
      c.times.push(t);
      c.first = c.first === undefined ? t : Math.min(c.first, t);
      c.last = c.last === undefined ? t : Math.max(c.last, t);
    }
    c.sample = e.msg;
    c.sampleLine = e.n;
    c.lines.push(e.n);
    if (c.lines.length > LINES_KEPT * 2) c.lines.splice(0, c.lines.length - LINES_KEPT);
  }
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of times) {
    if (t === undefined) continue;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  const span = Math.max(1, hi - lo);
  const rank: Record<LogLevel, number> = { error: 0, warning: 1, info: 2, debug: 3 };
  const out: LogPattern[] = [];
  for (const list of groups.values()) {
    for (const c of list) {
      const template = c.words.join(" ");
      const trend = c.times.length ? new Array<number>(TREND_BUCKETS).fill(0) : [];
      for (const t of c.times) trend[Math.min(TREND_BUCKETS - 1, Math.max(0, Math.floor(((t - lo) / span) * TREND_BUCKETS)))]!++;
      const tail = trend.slice(-3).reduce((a, b) => a + b, 0);
      out.push({
        id: patternId(source, c.level, c.cat, template),
        template,
        level: c.level,
        ...(c.cat ? { cat: c.cat } : {}),
        count: c.count,
        ...(c.first !== undefined ? { first: c.first, last: c.last } : {}),
        trend,
        rising: trend.length > 0 && c.count >= 4 && tail > (c.count * 3) / TREND_BUCKETS * 2,
        sample: c.sample,
        sampleLine: c.sampleLine,
        lines: c.lines.slice(-LINES_KEPT),
      });
    }
  }
  return out.sort((a, b) => b.count - a.count || rank[a.level] - rank[b.level]);
}
