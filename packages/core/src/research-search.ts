/**
 * The search that automatic research uses (the task inbox's free-Gemini and GhostCLI routes; deep-research.ts
 * `researchReport`): the normal web search first (web-search.ts, its backends with their block cooldowns), and when
 * every backend failed, Google Search grounding through the user's free Gemini key (gemini-grounding.ts), when the
 * caller passes it. Every failure keeps its reason ("backend: why"), so a research that found nothing says why.
 *
 * Grounding stays inside the free tier: at most {@link GROUNDED_DAILY_CAP} searches a day (UTC) from this PC, and a
 * free-limit or billing answer stops it for {@link GROUNDED_COOLDOWN_MS} (each request then fails at once, with the
 * reason). Queries are research sub-questions (safe-for-relay text); they still pass the leak guard (`redact`).
 */

/** The start of the note of a research whose searches returned nothing (the inbox's search-retry rule looks for it). */
export const NO_SEARCH_START = "Web search returned nothing";

/** One search result. */
export interface ResearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** A search function: the query and a signal, the hits. */
export type ResearchSearchFn = (query: string, signal: AbortSignal) => Promise<ResearchHit[]>;

/** The most grounded searches a day: far under Google's free grounding allowance, and research needs a few per task. */
export const GROUNDED_DAILY_CAP = 60;
/** How long grounding rests after a free-limit or billing answer. */
export const GROUNDED_COOLDOWN_MS = 60 * 60_000;

/** What {@link researchSearch} needs. */
export interface ResearchSearchDeps {
  /** The web search; throws (with `failures`, one "backend: why" line each) when every backend failed or found nothing. */
  web: ResearchSearchFn;
  /** Gemini's Google Search grounding (the free key's provider): read on each search, undefined while there is none. */
  grounded?: () => ResearchSearchFn | undefined;
  /** Removes anything private from a query before it leaves for the grounded search (the leak guard). */
  redact?: (query: string) => string;
  now?: () => number;
}

/** The error of a search that found nothing anywhere: one "backend: why" line per backend. */
export class ResearchSearchError extends Error {
  /**
   * @param failures - One "backend: why" line per backend tried.
   */
  constructor(readonly failures: string[]) {
    super(`Web search failed on every backend. ${failures.join(" ")}`);
    this.name = "ResearchSearchError";
  }
}

/** @returns The "backend: why" lines of a search error (its `failures`, or its message as one line). */
export function failuresOf(e: unknown): string[] {
  const f = (e as { failures?: unknown } | undefined)?.failures;
  if (Array.isArray(f) && f.every((x) => typeof x === "string")) return f as string[];
  return [String((e as Error | undefined)?.message ?? e)];
}

/**
 * Makes research's search: the web first, then the grounded search when the web found nothing.
 *
 * @param d - The searches and the clock.
 * @returns The search function; it throws {@link ResearchSearchError} with every reason when both failed.
 */
export function researchSearch(d: ResearchSearchDeps): ResearchSearchFn {
  const now = d.now ?? Date.now;
  let restUntil = 0;
  let day = { date: "", used: 0 };
  return async (query, signal) => {
    let failures: string[];
    try {
      const hits = await d.web(query, signal);
      if (hits.length) return hits;
      failures = ["web: No results."];
    } catch (e) {
      if (signal.aborted) throw e;
      failures = failuresOf(e);
    }
    const grounded = d.grounded?.();
    if (!grounded) throw new ResearchSearchError(failures);
    const t = now();
    const date = new Date(t).toISOString().slice(0, 10);
    if (day.date !== date) day = { date, used: 0 };
    if (restUntil > t) failures.push(`gemini-search: Resting after a limit answer (until ${new Date(restUntil).toISOString().slice(11, 16)} UTC).`);
    else if (day.used >= GROUNDED_DAILY_CAP) failures.push(`gemini-search: Today's ${GROUNDED_DAILY_CAP} searches are used.`);
    else {
      day.used++;
      try {
        const hits = await grounded(d.redact ? d.redact(query) : query, signal);
        if (hits.length) return hits;
        failures.push("gemini-search: Google Search found nothing.");
      } catch (e) {
        if (signal.aborted) throw e;
        const why = (e as Error).message || String(e);
        if (/\b429\b|free limit|billing|RESOURCE_EXHAUSTED/i.test(why)) restUntil = t + GROUNDED_COOLDOWN_MS;
        failures.push(`gemini-search: ${why.replace(/^Gemini search:?\s*/i, "")}`);
      }
    }
    throw new ResearchSearchError(failures);
  };
}
