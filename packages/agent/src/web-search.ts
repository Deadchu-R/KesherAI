import type { WebPrefs } from "@kesher/shared";
import { htmlToText, parseSearchResults } from "./system-tools.js";

/**
 * Web search with fallbacks (no API key): DuckDuckGo's HTML page, DuckDuckGo Lite, Mojeek, then Bing's HTML page.
 * DuckDuckGo often answers a bot-check page or an empty list to a program, so each backend that errors, is
 * rate-limited, answers a bot check or finds nothing is skipped for the next, and the one that worked last is
 * tried first for {@link REMEMBER_MS}. One small parser per backend; they read the pages' known structure.
 */

/** One search result. */
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** What a backend is asked for. */
export interface SearchAsk {
  query: string;
  /** DuckDuckGo's safe-search value: "1" strict, "-1" moderate, "-2" off. */
  kp: string;
  signal: AbortSignal;
  /** 1, or 2 for the next page of results (only DuckDuckGo's HTML page has one). */
  page: number;
}

/** One search backend. */
export interface SearchBackend {
  name: "duckduckgo" | "duckduckgo-lite" | "mojeek" | "bing";
  /** Gets the results page; throws on a network error or a failed status. */
  fetchPage: (ask: SearchAsk) => Promise<string>;
  /** Reads the page into results (empty when it has none). */
  parse: (html: string) => SearchHit[];
}

/** How long the backend that worked last is tried first. */
export const REMEMBER_MS = 30 * 60_000;
/** Each backend gets this long. */
const BACKEND_TIMEOUT_MS = 12_000;

/** A normal desktop browser's headers: programs' own user-agents are the ones sent to bot checks. */
const BROWSER_HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9,he;q=0.8",
} as const;

/** @returns Whether the page is a bot check (a challenge or "unusual traffic" page) and not results. */
export function looksBlocked(html: string): boolean {
  return /anomaly-modal|anomaly\.js|challenge-form|bots use DuckDuckGo|g-recaptcha|h-captcha|unusual traffic|are you a (?:robot|human)|detected unusual|verify you are/i.test(html);
}

/** An address from a results page: DuckDuckGo's redirect (`uddg=`) is unwrapped, `//host` gets https. */
function cleanHref(raw: string): string {
  let href = raw.replace(/&amp;/g, "&").trim();
  const uddg = /[?&]uddg=([^&]+)/.exec(href);
  if (uddg) {
    try {
      href = decodeURIComponent(uddg[1]!);
    } catch {
      /* keep the redirect address */
    }
  }
  return href.startsWith("//") ? `https:${href}` : href;
}

/** @returns The value of an attribute in a tag's text, or "". */
function attr(tag: string, name: string): string {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m?.[1] ?? m?.[2] ?? "";
}

/** @returns Whether the address is an http(s) page outside the search engine's own redirects. */
const isPage = (url: string): boolean => /^https?:\/\/[^\s/]+\.[^\s]+/i.test(url);

/**
 * Reads DuckDuckGo Lite's results page (a table: a `result-link` anchor, then a `result-snippet` cell).
 *
 * @param html - The page.
 * @returns The results.
 */
export function parseDuckLite(html: string): SearchHit[] {
  const out: SearchHit[] = [];
  const links = [...html.matchAll(/<a\b[^>]*class=["']result-link["'][^>]*>([\s\S]*?)<\/a>/gi)];
  links.forEach((m, i) => {
    const url = cleanHref(attr(m[0], "href"));
    if (!isPage(url)) return;
    const rest = html.slice(m.index! + m[0].length, links[i + 1]?.index ?? html.length);
    const snippet = /class=["']result-snippet["'][^>]*>([\s\S]*?)<\/td>/i.exec(rest)?.[1] ?? "";
    out.push({ title: htmlToText(m[1] ?? ""), url, snippet: htmlToText(snippet) });
  });
  return out;
}

/**
 * Reads Mojeek's results page (`<li>` entries of the results list: a `title` anchor and a `<p class="s">` snippet).
 *
 * @param html - The page.
 * @returns The results.
 */
export function parseMojeek(html: string): SearchHit[] {
  const out: SearchHit[] = [];
  for (const li of html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
    const a = /<a\b[^>]*class=["'][^"']*\btitle\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(li[1]!);
    if (!a) continue;
    const url = cleanHref(attr(a[0], "href"));
    if (!isPage(url)) continue;
    const snippet = /<p\b[^>]*class=["'][^"']*\bs\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(li[1]!)?.[1] ?? "";
    out.push({ title: htmlToText(a[1] ?? ""), url, snippet: htmlToText(snippet) });
  }
  return out;
}

/** Bing wraps result links as `bing.com/ck/a?…&u=a1<base64url of the page>`; this unwraps them. */
function bingHref(raw: string): string {
  const href = cleanHref(raw);
  const u = /[?&]u=a1([A-Za-z0-9_-]+)/.exec(href)?.[1];
  if (!u || !/^https?:\/\/(?:www\.)?bing\.com\/ck\//i.test(href)) return href;
  try {
    return Buffer.from(u, "base64url").toString("utf8");
  } catch {
    return href;
  }
}

/**
 * Reads Bing's results page (`<li class="b_algo">` entries: the `<h2>` link, and the `b_caption` paragraph).
 *
 * @param html - The page.
 * @returns The results.
 */
export function parseBing(html: string): SearchHit[] {
  const out: SearchHit[] = [];
  for (const li of html.matchAll(/<li\b[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>([\s\S]*?)(?=<li\b[^>]*class=["'][^"']*\bb_algo\b|<\/ol>|$)/gi)) {
    const a = /<h2\b[^>]*>\s*(<a\b[^>]*>[\s\S]*?<\/a>)/i.exec(li[1]!);
    if (!a) continue;
    const url = bingHref(attr(a[1]!, "href"));
    if (!isPage(url)) continue;
    const snippet = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(/class=["'][^"']*b_caption[^"']*["'][\s\S]*$/i.exec(li[1]!)?.[0] ?? li[1]!)?.[1] ?? "";
    out.push({ title: htmlToText(a[1]!.replace(/^<a\b[^>]*>/i, "")), url, snippet: htmlToText(snippet) });
  }
  return out;
}

/** Gets a page; a bot check's or rate limit's status (202, 403, 429) is an error with a plain reason. */
async function getPage(url: string, signal: AbortSignal, init: RequestInit = {}): Promise<string> {
  const res = await fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(BACKEND_TIMEOUT_MS)]), headers: { ...BROWSER_HEADERS, ...(init.headers ?? {}) } });
  if (res.status === 202 || res.status === 403 || res.status === 429) throw new Error(`Search answered ${res.status} (a bot check or rate limit).`);
  if (!res.ok) throw new Error(`Search answered ${res.status}.`);
  return res.text();
}

/** The backends, in the order they are tried when none has worked lately. */
export const BACKENDS: readonly SearchBackend[] = [
  {
    name: "duckduckgo",
    fetchPage: ({ query, kp, signal, page }) =>
      getPage(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kp=${kp}${page > 1 ? "&s=30&dc=31" : ""}`, signal),
    parse: (html) => parseSearchResults(html),
  },
  {
    name: "duckduckgo-lite",
    fetchPage: ({ query, kp, signal }) =>
      getPage("https://lite.duckduckgo.com/lite/", signal, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ q: query, kp }).toString(),
      }),
    parse: (html) => parseDuckLite(html),
  },
  {
    name: "mojeek",
    fetchPage: ({ query, kp, signal }) => getPage(`https://www.mojeek.com/search?q=${encodeURIComponent(query)}${kp === "1" ? "&safe=1" : ""}`, signal),
    parse: (html) => parseMojeek(html),
  },
  {
    name: "bing",
    fetchPage: ({ query, kp, signal }) =>
      getPage(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=en${kp === "1" ? "&adlt=strict" : kp === "-2" ? "&adlt=off" : ""}`, signal),
    parse: (html) => parseBing(html),
  },
];

/** The backend that worked last, and when. */
let lastGood: { name: SearchBackend["name"]; at: number } | undefined;

/** Forgets the backend that worked last (for tests). */
export function resetSearchMemory(): void {
  lastGood = undefined;
}

/** @returns The backends in the order to try: the one that worked in the last 30 minutes first. */
export function backendOrder(now = Date.now()): SearchBackend[] {
  const first = lastGood && now - lastGood.at < REMEMBER_MS ? BACKENDS.find((b) => b.name === lastGood!.name) : undefined;
  return first ? [first, ...BACKENDS.filter((b) => b !== first)] : [...BACKENDS];
}

/**
 * Runs one query on one backend.
 *
 * @returns The results.
 * @throws With the reason when the backend errors, answers a bot check, or finds nothing.
 */
async function runBackend(b: SearchBackend, ask: SearchAsk): Promise<SearchHit[]> {
  const html = await b.fetchPage(ask);
  const hits = b.parse(html);
  if (!hits.length) throw new Error(looksBlocked(html) ? "Answered a bot-check page." : "No results on the page.");
  return hits;
}

/**
 * Searches with the first backend that gives results, and remembers which it was.
 *
 * @param ask - The query (already with any site: words) and the safe-search value.
 * @param deep - Whether to read the next page of results too (when the backend has one).
 * @returns The results; empty when every backend found nothing.
 * @throws When every backend errored (the message lists why).
 */
export async function searchBackends(ask: Omit<SearchAsk, "page">, deep: boolean): Promise<SearchHit[]> {
  const failures: string[] = [];
  let empty = false;
  for (const b of backendOrder()) {
    ask.signal.throwIfAborted();
    try {
      let hits = await runBackend(b, { ...ask, page: 1 });
      lastGood = { name: b.name, at: Date.now() };
      if (deep && b.name === "duckduckgo" && hits.length >= 8) hits = [...hits, ...(await runBackend(b, { ...ask, page: 2 }).catch(() => []))];
      return hits;
    } catch (e) {
      if (ask.signal.aborted) throw e;
      const why = (e as Error).message;
      if (/^(No results|Answered a bot)/.test(why)) empty = true;
      failures.push(`${b.name}: ${why}`);
    }
  }
  if (empty && failures.length) return [];
  throw new Error(`Web search failed on every backend. ${failures.join(" ")}`);
}

/** The result of one backend in the diagnostic. */
export interface BackendCheck {
  backend: string;
  ok: boolean;
  count: number;
  ms: number;
  error?: string;
}

/**
 * The diagnostic: one query on every backend, one after the other, without touching which backend is remembered.
 *
 * @param query - The query.
 * @param signal - Stops it.
 * @returns One entry per backend.
 */
export async function checkBackends(query: string, signal: AbortSignal): Promise<BackendCheck[]> {
  const out: BackendCheck[] = [];
  for (const b of BACKENDS) {
    const t = Date.now();
    try {
      const hits = await runBackend(b, { query, kp: "-1", signal, page: 1 });
      out.push({ backend: b.name, ok: true, count: hits.length, ms: Date.now() - t });
    } catch (e) {
      out.push({ backend: b.name, ok: false, count: 0, ms: Date.now() - t, error: (e as Error).message });
    }
  }
  return out;
}

/** Safe-search value for a chat's setting. */
export function safeValue(prefs: WebPrefs | undefined): string {
  return prefs?.safeSearch === "strict" ? "1" : prefs?.safeSearch === "off" ? "-2" : "-1";
}
