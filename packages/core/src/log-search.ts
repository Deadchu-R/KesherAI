/**
 * Searching parsed log entries (Roee, 2026-11-24): plain text or a regular expression, filtered by level, category
 * and time, with a few entries of context around each hit (like `grep -C`), and hard limits so a large log stays fast.
 */
import { carriedTimes, type LogEntry, type LogLevel } from "./log-parse.js";

/** What to look for. Every field is optional; an empty query returns the newest entries. */
export interface LogQuery {
  /** Plain text (case-insensitive), or a regular expression when {@link regex} is set. */
  q?: string;
  regex?: boolean;
  levels?: readonly LogLevel[];
  /** Categories to keep (Unreal's LogBlueprint…); empty keeps all. */
  cats?: readonly string[];
  /** Only entries at or after / before this time (ms). Entries without a time take the one before them. */
  since?: number;
  until?: number;
  /** Entries of context before and after each hit (0 to {@link MAX_CONTEXT}). */
  context?: number;
  /** The most hits returned (the newest), 1 to {@link MAX_HITS}. */
  limit?: number;
}

/** One hit and the entries around it. */
export interface LogHit {
  entry: LogEntry;
  before: LogEntry[];
  after: LogEntry[];
}

/** The answer: the newest hits (oldest first), how many matched in all, and whether that is more than returned. */
export interface LogSearchResult {
  hits: LogHit[];
  matched: number;
  truncated: boolean;
}

export const MAX_HITS = 500;
export const DEFAULT_HITS = 200;
export const MAX_CONTEXT = 5;
/** The longest pattern accepted. */
export const MAX_PATTERN_CHARS = 200;

/**
 * Turns the user's text into a test, refusing regular expressions that could take very long on a long line
 * (a repeated group that itself repeats, such as `(a+)+`), since JavaScript cannot stop a running match.
 *
 * @param q - The text or pattern.
 * @param regex - Whether it is a regular expression.
 * @returns The test.
 * @throws Error with a short reason when the pattern is too long, broken or risky.
 */
export function makeMatcher(q: string, regex = false): (text: string) => boolean {
  if (q.length > MAX_PATTERN_CHARS) throw new Error(`The search is longer than ${MAX_PATTERN_CHARS} characters.`);
  if (!regex) {
    const needle = q.toLowerCase();
    return (text) => text.toLowerCase().includes(needle);
  }
  if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(q) || /(?:\.\*){3,}/.test(q)) {
    throw new Error("This pattern repeats a repeated group (like (a+)+), which can freeze the search. Write it without the nested repeat.");
  }
  let re: RegExp;
  try {
    re = new RegExp(q, "i");
  } catch (err) {
    throw new Error(`Not a valid pattern: ${(err as Error).message}`);
  }
  return (text) => re.test(text.length > 8000 ? text.slice(0, 8000) : text);
}

/**
 * Searches entries.
 *
 * @param entries - Parsed entries, oldest first.
 * @param query - What to look for.
 * @returns The newest hits with context.
 * @throws Error when the pattern is refused ({@link makeMatcher}).
 */
export function searchEntries(entries: readonly LogEntry[], query: LogQuery): LogSearchResult {
  const test = query.q?.trim() ? makeMatcher(query.q.trim(), query.regex) : undefined;
  const levels = query.levels?.length ? new Set(query.levels) : undefined;
  const cats = query.cats?.length ? new Set(query.cats) : undefined;
  const times = query.since !== undefined || query.until !== undefined ? carriedTimes(entries) : undefined;
  const limit = Math.min(MAX_HITS, Math.max(1, Math.floor(Number(query.limit) || DEFAULT_HITS)));
  const context = Math.min(MAX_CONTEXT, Math.max(0, Math.floor(Number(query.context) || 0)));
  const found: number[] = [];
  let matched = 0;
  // From the newest back, so the limit keeps the newest hits; matched still counts every hit.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (levels && !levels.has(e.level)) continue;
    if (cats && !cats.has(e.cat ?? "")) continue;
    if (times) {
      const t = times[i];
      if (query.since !== undefined && (t === undefined || t < query.since)) continue;
      if (query.until !== undefined && (t === undefined || t > query.until)) continue;
    }
    if (test && !test(e.extra?.length ? `${e.msg}\n${e.extra.join("\n")}` : e.msg) && !(e.cat && test(e.cat))) continue;
    matched++;
    if (found.length < limit) found.push(i);
  }
  found.reverse();
  return {
    hits: found.map((i) => ({ entry: entries[i]!, before: context ? entries.slice(Math.max(0, i - context), i) : [], after: context ? entries.slice(i + 1, i + 1 + context) : [] })),
    matched,
    truncated: matched > found.length,
  };
}
