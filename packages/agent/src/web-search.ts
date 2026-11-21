import type { WebPrefs } from "@kesher/shared";
import { htmlToText, parseSearchResults } from "./system-tools.js";

/**
 * Web search with fallbacks. First the optional keyed APIs (Tavily, Brave Search; only when the user entered a free
 * key in Settings > Web), then the pages that need no key: DuckDuckGo's HTML page, DuckDuckGo Lite, Yahoo, Startpage,
 * Mojeek, Ecosia and Bing. Engines often answer a bot-check page, an empty list, or (Bing) unrelated pages to a
 * program, so each backend that errors, is rate-limited, answers a bot check, finds nothing or answers results that
 * do not match the query (see {@link relevantHits}) is skipped for the next, and the one that worked last is tried
 * first for {@link REMEMBER_MS}. One small parser per backend; they read the pages' known structure.
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
  name: "tavily" | "brave" | "duckduckgo" | "duckduckgo-lite" | "yahoo" | "startpage" | "mojeek" | "ecosia" | "bing";
  /** Keyed backends only: whether the user's key is set (a backend without it is not tried). */
  enabled?: () => boolean;
  /** Gets the results page (or the API's JSON); throws on a network error or a failed status. */
  fetchPage: (ask: SearchAsk) => Promise<string>;
  /** Reads the page into results (empty when it has none). */
  parse: (html: string) => SearchHit[];
}

/** The user's own free keys for the keyed backends (Settings > Web). Never logged, never sent anywhere else. */
export interface SearchKeys {
  tavily?: string;
  brave?: string;
}

/** Where the keys come from (the server's config); none until {@link setSearchKeys}. */
let keysOf: () => SearchKeys | undefined = () => undefined;

/**
 * Tells the search where to read the user's keys (called once by the server; read on every search, so a changed key applies at once).
 *
 * @param fn - Returns the current keys.
 */
export function setSearchKeys(fn: () => SearchKeys | undefined): void {
  keysOf = fn;
}

/** Which engine Settings > Web chose: "auto" (best that works) or one backend's name. */
export type SearchEngineChoice = "auto" | SearchBackend["name"];

/** Where the chosen engine comes from (the server's config); "auto" until {@link setSearchEngine}. */
let engineOf: () => SearchEngineChoice | undefined = () => "auto";

/**
 * Tells the search where to read the user's engine choice (called once by the server; read on every search).
 *
 * @param fn - Returns the current choice.
 */
export function setSearchEngine(fn: () => SearchEngineChoice | undefined): void {
  engineOf = fn;
}

/** @returns The key for a keyed backend, or "" when none is set. */
const keyFor = (name: "tavily" | "brave"): string => keysOf()?.[name]?.trim() ?? "";

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

/**
 * Generic reader for pages whose results are an anchor followed by a snippet: every anchor that matches `anchorRe`
 * is a result, its snippet is the first `snippetRe` match before the next anchor.
 */
function parseByAnchors(html: string, anchorRe: RegExp, snippetRe: RegExp, hrefOf: (raw: string) => string): SearchHit[] {
  const out: SearchHit[] = [];
  const anchors = [...html.matchAll(anchorRe)];
  anchors.forEach((m, i) => {
    const url = hrefOf(attr(/^<a\b[^>]*>/i.exec(m[0])?.[0] ?? m[0], "href"));
    if (!isPage(url)) return;
    const heading = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(m[0])?.[1];
    const rest = html.slice(m.index! + m[0].length, anchors[i + 1]?.index ?? html.length);
    const snippet = snippetRe.exec(rest)?.[1] ?? "";
    out.push({ title: htmlToText(heading ?? m[0]), url, snippet: htmlToText(snippet) });
  });
  return out;
}

/** Yahoo wraps result links as `r.search.yahoo.com/…/RU=<encoded page>/RK=…`; this unwraps them. */
function yahooHref(raw: string): string {
  const href = cleanHref(raw);
  const ru = /\/RU=([^/]+)\/R[KS]=/.exec(href)?.[1];
  if (!ru || !/^https?:\/\/r\.search\.yahoo\.com\//i.test(href)) return href;
  try {
    return decodeURIComponent(ru);
  } catch {
    return href;
  }
}

/**
 * Reads Yahoo's results page (`compTitle` blocks: the link with an `<h3>`, then a `compText` block with the snippet).
 *
 * @param html - The page.
 * @returns The results.
 */
export function parseYahoo(html: string): SearchHit[] {
  return parseByAnchors(html, /<div\b[^>]*class=["'][^"']*\bcompTitle\b[^"']*["'][^>]*>\s*(<a\b[^>]*>[\s\S]*?<\/a>)/gi, /class=["'][^"']*\bcompText\b[^"']*["'][\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i, yahooHref);
}

/**
 * Reads Startpage's results page (anchors with the `result-link` class around an `<h2>`, then a `description` paragraph).
 *
 * @param html - The page.
 * @returns The results.
 */
export function parseStartpage(html: string): SearchHit[] {
  return parseByAnchors(html, /<a\b[^>]*class=["'][^"']*\bresult-link\b[^"']*["'][^>]*>[\s\S]*?<\/a>/gi, /<p\b[^>]*class=["'][^"']*\bdescription\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i, cleanHref);
}

/**
 * Reads Ecosia's results page (anchors marked `result__link` or `data-test-id="result-link"`, then a description or snippet paragraph).
 *
 * @param html - The page.
 * @returns The results.
 */
export function parseEcosia(html: string): SearchHit[] {
  return parseByAnchors(
    html,
    /<a\b(?=[^>]*(?:result__link|data-test-id=["']result-link["']))[^>]*>[\s\S]*?<\/a>/gi,
    /<(?:p|div)\b[^>]*(?:result__description|web-result__description|data-test-id=["']result-snippet["'])[^>]*>([\s\S]*?)<\/(?:p|div)>/i,
    cleanHref,
  );
}

/** Tavily's API answer: `{ results: [{ title, url, content }] }`. Unreadable JSON is no results. */
export function parseTavily(json: string): SearchHit[] {
  try {
    const rows = (JSON.parse(json) as { results?: Array<{ title?: string; url?: string; content?: string }> }).results ?? [];
    return rows.filter((r) => typeof r.url === "string" && isPage(r.url)).map((r) => ({ title: String(r.title ?? ""), url: r.url!, snippet: String(r.content ?? "") }));
  } catch {
    return [];
  }
}

/** Brave Search API's answer: `{ web: { results: [{ title, url, description }] } }` (the description may hold `<strong>`). */
export function parseBrave(json: string): SearchHit[] {
  try {
    const rows = (JSON.parse(json) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } }).web?.results ?? [];
    return rows.filter((r) => typeof r.url === "string" && isPage(r.url)).map((r) => ({ title: htmlToText(String(r.title ?? "")), url: r.url!, snippet: htmlToText(String(r.description ?? "")) }));
  } catch {
    return [];
  }
}

/** Words too common to show that a page is about the query (English and Hebrew). */
const STOP_WORDS = new Set(
  ("a an and are as at be by for from how in is it of on or that the this to was what when where which who why with " +
    "about can do does into not your you site www http https com " +
    "של את על עם מה איך הוא היא זה זאת או גם לא כל אל מן כי יש אני הם אם לי לך עד כמו").split(" "),
);

/** @returns The meaningful lower-case words of a text (letters and digits, at least 2 long, no stop words). */
function meaningfulWords(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

/** @returns A page address as readable words (percent-escapes decoded when they can be). */
function urlText(url: string): string {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

/**
 * Keeps the hits that are about the query: a hit counts when its title, snippet and address together hold at least a
 * third of the query's meaningful words (at least one; words match whole, or by prefix from 4 letters, so "plugins"
 * matches "plugin"). Search words like `site:x` and `OR` that the search adds are ignored.
 *
 * @param query - The query as sent.
 * @param hits - The hits of one page.
 * @returns The hits that match, and whether the page as a whole is irrelevant (more than half of its hits fail, which is
 *   what a bot page of random results looks like). A query with no meaningful words (or no hits) is never irrelevant.
 */
export function relevantHits(query: string, hits: SearchHit[]): { kept: SearchHit[]; irrelevant: boolean } {
  const words = [...new Set(meaningfulWords(query.replace(/\bsite:\S+|\bOR\b/g, " ")))];
  if (!words.length || !hits.length) return { kept: hits, irrelevant: false };
  const need = Math.max(1, Math.ceil(words.length / 3));
  const kept = hits.filter((h) => {
    const tokens = meaningfulWords(`${h.title} ${h.snippet} ${urlText(h.url)}`);
    const found = words.filter((w) => tokens.some((t) => t === w || (w.length >= 4 && t.startsWith(w)) || (t.length >= 4 && w.startsWith(t))));
    return found.length >= need;
  });
  return { kept, irrelevant: kept.length * 2 < hits.length };
}

/** Gets a page; a bot check's or rate limit's status (202, 403, 429) is an error with a plain reason. */
async function getPage(url: string, signal: AbortSignal, init: RequestInit = {}): Promise<string> {
  const res = await fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(BACKEND_TIMEOUT_MS)]), headers: { ...BROWSER_HEADERS, ...(init.headers ?? {}) } });
  if (res.status === 202 || res.status === 403 || res.status === 429) throw new Error(`Search answered ${res.status} (a bot check or rate limit).`);
  if (!res.ok) throw new Error(`Search answered ${res.status}.`);
  return res.text();
}

/** The backends, in the order they are tried when none has worked lately (keyed ones only when a key is set). */
export const BACKENDS: readonly SearchBackend[] = [
  {
    name: "tavily",
    enabled: () => !!keyFor("tavily"),
    fetchPage: ({ query, signal }) =>
      getPage("https://api.tavily.com/search", signal, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${keyFor("tavily")}` },
        body: JSON.stringify({ query, max_results: 20, search_depth: "basic" }),
      }),
    parse: parseTavily,
  },
  {
    name: "brave",
    enabled: () => !!keyFor("brave"),
    fetchPage: ({ query, kp, signal }) =>
      getPage(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=20&safesearch=${kp === "1" ? "strict" : kp === "-2" ? "off" : "moderate"}`, signal, {
        headers: { accept: "application/json", "x-subscription-token": keyFor("brave") },
      }),
    parse: parseBrave,
  },
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
    name: "yahoo",
    fetchPage: ({ query, signal }) => getPage(`https://search.yahoo.com/search?p=${encodeURIComponent(query)}`, signal),
    parse: parseYahoo,
  },
  {
    name: "startpage",
    fetchPage: ({ query, signal }) => getPage(`https://www.startpage.com/sp/search?query=${encodeURIComponent(query)}`, signal),
    parse: parseStartpage,
  },
  {
    name: "mojeek",
    fetchPage: ({ query, kp, signal }) => getPage(`https://www.mojeek.com/search?q=${encodeURIComponent(query)}${kp === "1" ? "&safe=1" : ""}`, signal),
    parse: (html) => parseMojeek(html),
  },
  {
    name: "ecosia",
    fetchPage: ({ query, signal }) => getPage(`https://www.ecosia.org/search?q=${encodeURIComponent(query)}`, signal),
    parse: parseEcosia,
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

/**
 * @returns The backends in the order to try. The engine the user chose (Settings > Web) goes first, when it can be
 *   used (a keyed one needs its key). Then, "automatic": the keyed ones that have a key, the one that worked in the
 *   last 30 minutes, and the rest. Keyed backends without a key are left out.
 */
export function backendOrder(now = Date.now()): SearchBackend[] {
  const usable = BACKENDS.filter((b) => !b.enabled || b.enabled());
  const keyed = usable.filter((b) => b.enabled);
  const first = lastGood && now - lastGood.at < REMEMBER_MS ? usable.find((b) => b.name === lastGood!.name && !b.enabled) : undefined;
  const auto = [...keyed, ...(first ? [first] : []), ...usable.filter((b) => !b.enabled && b !== first)];
  const chosen = engineOf();
  const pick = chosen && chosen !== "auto" ? usable.find((b) => b.name === chosen) : undefined;
  return pick ? [pick, ...auto.filter((b) => b !== pick)] : auto;
}

/** What one backend gave: every hit on the page, the ones about the query, and whether the page is irrelevant. */
interface BackendRead {
  all: SearchHit[];
  kept: SearchHit[];
  irrelevant: boolean;
}

/**
 * Gets and reads one backend's page and checks it against the query.
 *
 * @throws With the reason when the backend errors, answers a bot check, or finds nothing.
 */
async function readBackend(b: SearchBackend, ask: SearchAsk): Promise<BackendRead> {
  const html = await b.fetchPage(ask);
  const all = b.parse(html);
  if (!all.length) throw new Error(looksBlocked(html) ? "Answered a bot-check page." : "No results on the page.");
  return { all, ...relevantHits(ask.query, all) };
}

/**
 * Runs one query on one backend.
 *
 * @returns The results that match the query.
 * @throws With the reason when the backend errors, answers a bot check, finds nothing, or answers unrelated results.
 */
async function runBackend(b: SearchBackend, ask: SearchAsk): Promise<SearchHit[]> {
  const r = await readBackend(b, ask);
  if (r.irrelevant) throw new Error(`Irrelevant results (${r.kept.length} of ${r.all.length} match the query), likely a bot page.`);
  return r.kept;
}

/**
 * Searches with the first backend that gives results, and remembers which it was.
 *
 * @param ask - The query (already with any site: words) and the safe-search value.
 * @param deep - Whether to read the next page of results too (when the backend has one).
 * @param onEngine - Told which backend answered.
 * @returns The results; empty when every backend found nothing.
 * @throws When every backend errored (the message lists why).
 */
export async function searchBackends(ask: Omit<SearchAsk, "page">, deep: boolean, onEngine?: (name: SearchBackend["name"]) => void): Promise<SearchHit[]> {
  const failures: string[] = [];
  let empty = false;
  for (const b of backendOrder()) {
    ask.signal.throwIfAborted();
    try {
      let hits = await runBackend(b, { ...ask, page: 1 });
      lastGood = { name: b.name, at: Date.now() };
      onEngine?.(b.name);
      if (deep && b.name === "duckduckgo" && hits.length >= 8) hits = [...hits, ...(await runBackend(b, { ...ask, page: 2 }).catch(() => []))];
      return hits;
    } catch (e) {
      if (ask.signal.aborted) throw e;
      const why = (e as Error).message;
      if (/^(No results|Answered a bot|Irrelevant)/.test(why)) empty = true;
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
  /** How many of the results match the query (a bot page gives results that do not). */
  relevant?: number;
  ms: number;
  error?: string;
  /** The first results (title — address), to see that they match the query. */
  sample?: string[];
}

/** The last diagnostic (kept in memory, so a phone can read it): when, and one entry per backend. */
let lastCheck: { at: number; query: string; results: BackendCheck[] } | undefined;

/** @returns The last diagnostic, or undefined when none ran since the server started. */
export function lastBackendCheck(): { at: number; query: string; results: BackendCheck[] } | undefined {
  return lastCheck;
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
  for (const b of BACKENDS.filter((x) => !x.enabled || x.enabled())) {
    const t = Date.now();
    try {
      const r = await readBackend(b, { query, kp: "-1", signal, page: 1 });
      const shown = r.irrelevant ? r.all : r.kept;
      out.push({
        backend: b.name,
        ok: !r.irrelevant,
        count: r.all.length,
        relevant: r.kept.length,
        ms: Date.now() - t,
        ...(r.irrelevant ? { error: "Irrelevant results, likely a bot page." } : {}),
        sample: shown.slice(0, 3).map((h) => `${h.title.slice(0, 80)} — ${h.url.slice(0, 120)}`),
      });
    } catch (e) {
      out.push({ backend: b.name, ok: false, count: 0, relevant: 0, ms: Date.now() - t, error: (e as Error).message });
    }
  }
  lastCheck = { at: Date.now(), query, results: out };
  return out;
}

/** Safe-search value for a chat's setting. */
export function safeValue(prefs: WebPrefs | undefined): string {
  return prefs?.safeSearch === "strict" ? "1" : prefs?.safeSearch === "off" ? "-2" : "-1";
}
