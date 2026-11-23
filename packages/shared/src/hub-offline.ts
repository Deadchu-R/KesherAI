/**
 * The hub page when Cloudflare is down (offline-first). Pure helpers, no I/O, shared by the page (apps/hub/page) and
 * its service worker (apps/hub/public/sw.js, which imports the compiled copy from /js/):
 *
 * - The app shell: which same-origin files the service worker keeps (an allowlist, never an API answer), the files it
 *   keeps at install (the entry points plus every module `app.js` imports, read from the code itself), and when an
 *   answer counts as "the hub is down" so the kept copy is served instead (no answer, or a 5xx from Cloudflare).
 * - The start: how the page reads the hub's first answer (down: the backup relays at once; paused: nothing).
 * - The last known device list: the paired PCs' public data kept in IndexedDB (kv `pcKeys`), shown while the hub cannot
 *   be reached, so a paired phone can still route and seal a task and send it through Ably or Supabase.
 *
 * Only public data is kept here (names, public keys, opt-ins). The device's private key stays a non-exportable
 * CryptoKey in IndexedDB, as pairing stores it; the relays' keys stay in kv `relays`, as the PC sent them sealed.
 */
import { DEFAULT_OPT_IN, type HubOptIn, type HubPresence } from "./hub-protocol.js";

/** The service worker's cache of the page shell (a new name drops the old copy at activate). */
export const SHELL_CACHE = "kesher-hub-shell-v1";

/** How long the service worker waits for the hub before it serves the kept copy (a hung connection, not an answer). */
export const SHELL_TIMEOUT_MS = 5000;

/** The page's module entry point; the service worker follows its imports to keep every module at install. */
export const SHELL_ENTRY = "/js/apps/hub/page/app.js";

/** The files kept at install besides the modules: the page, its style, boot script, manifest and icons. */
export const SHELL_CORE: readonly string[] = ["/", "/connect.html", "/app.css", "/boot.js", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/icon-maskable-192.png", SHELL_ENTRY];

/** Same-origin static files that belong to the shell (anything else, e.g. /api/ and /ws/, always goes to the network). */
const SHELL_FILE = /^\/(?:app\.css|boot\.js|manifest\.webmanifest|icon(?:-maskable)?-\d+\.png|js\/[\w./-]+\.js)$/;

/**
 * The cache key of a request that belongs to the page shell, or undefined when it must never be cached.
 * The page itself (`/`, `/index.html`, with any query such as `?app=`) is kept as `/`; the query of a static file is
 * dropped. Only same-origin GETs; `..` never passes.
 *
 * @param url - The request's full URL.
 * @param origin - The hub's origin (the service worker's `location.origin`).
 * @param method - The request's method.
 * @returns The path to keep it under, or undefined.
 */
export function shellKey(url: string, origin: string, method = "GET"): string | undefined {
  if (method !== "GET") return undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.origin !== origin || u.pathname.includes("..")) return undefined;
  if (u.pathname === "/" || u.pathname === "/index.html") return "/";
  if (u.pathname === "/connect.html") return "/connect.html";
  return SHELL_FILE.test(u.pathname) ? u.pathname : undefined;
}

/**
 * The relative modules one compiled module imports (static `import … from`, `export … from`, bare `import "…"` and
 * `import("…")` with a literal), as absolute paths. Bare package names are skipped (the page has none).
 *
 * @param source - The module's code.
 * @param fromPath - The module's own path (e.g. `/js/apps/hub/page/app.js`).
 * @returns The imported paths, each once.
 */
export function moduleImports(source: string, fromPath: string): string[] {
  const out = new Set<string>();
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*)(["'])(\.{1,2}\/[^"'\n]+?\.js)\1/g;
  for (const m of source.matchAll(re)) {
    const path = new URL(m[2]!, `https://x${fromPath}`).pathname;
    if (path.startsWith("/js/")) out.add(path);
  }
  return [...out];
}

/**
 * Every module of the page, following imports from the entry point (breadth first, each fetched once).
 *
 * @param read - Reads one module's code (the service worker's fetch); undefined when it cannot.
 * @param entry - The entry module.
 * @param max - A ceiling, so a broken graph cannot run away.
 * @returns The module paths found (the entry first).
 */
export async function shellModules(read: (path: string) => Promise<string | undefined>, entry = SHELL_ENTRY, max = 400): Promise<string[]> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length && seen.size <= max) {
    const path = queue.shift()!;
    const code = await read(path);
    if (code === undefined) continue;
    for (const dep of moduleImports(code, path)) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      queue.push(dep);
    }
  }
  return [...seen];
}

/**
 * Whether an answer to a shell file means "the hub is down": no answer, or a 5xx (Cloudflare's own error pages, 52x,
 * and a Worker that threw). Then the kept copy is served; a 4xx is the hub's real answer and passes through.
 *
 * @param status - The answer's status, or undefined when there was none (network error, timeout).
 * @returns True when the kept copy should be served.
 */
export function shellDown(status: number | undefined): boolean {
  return status === undefined || status === 0 || status >= 500;
}

/** What the hub's first answer (`POST /api/ticket`) says about the hub. */
export type HubStart = "ok" | "revoked" | "paused" | "storage" | "down" | "retry";

/**
 * Reads the hub's answer to the page's ticket request: down (no answer at a page start, or a 5xx that is not one of
 * the hub's own answers) means the backup relays take over at once instead of after 20 seconds without a socket;
 * paused is the owner's kill switch (or the hub switched off), so nothing fails over.
 *
 * @param status - The status, or undefined when there was no answer.
 * @param error - The answer's `error` field (the hub's JSON answers have one; Cloudflare's error pages do not).
 * @param everOpen - Whether the hub's socket has been open on this page (a network blip later waits the normal 20 s).
 * @returns What it means.
 */
export function hubStart(status: number | undefined, error: unknown, everOpen: boolean): HubStart {
  if (status === undefined) return everOpen ? "retry" : "down";
  if (status === 200) return "ok";
  if (status === 401) return "revoked";
  if (status === 503 && error === "hub-storage-limit") return "storage";
  // The owner's kill switch (`/api/kill` pause) or the Worker switched off (HUB_DISABLED): on purpose, no failover.
  if (status === 503 && typeof error === "string" && /^The hub is (?:paused|switched off)/.test(error)) return "paused";
  return status >= 500 ? "down" : "retry";
}

/** A paired PC as this browser keeps it (kv `pcKeys`): public data only. */
export interface KeptPc {
  publicKey: string;
  name: string;
  /** What it accepts (kept since -08; older entries have none). */
  optIn?: HubOptIn;
}

/**
 * The PCs to keep from the hub's live presence (public data only).
 *
 * @param presence - The hub's presence.
 * @returns The PCs by id.
 */
export function keepPcs(presence: readonly HubPresence[]): Record<string, KeptPc> {
  return Object.fromEntries(presence.filter((d) => d.kind === "pc").map((d) => [d.id, { publicKey: d.publicKey, name: d.name, optIn: d.optIn }]));
}

/** For an entry kept before -08 (no opt-in): the PC accepts tasks; it checks and refuses what it does not take itself. */
const KEPT_OPT_IN: HubOptIn = { ...DEFAULT_OPT_IN, appear: true, acceptTasks: true, acceptLocal: true, acceptAntigravity: true };

/**
 * The last known device list, shown while the hub cannot be reached. Whether a PC is on is not known: with a healthy
 * backup relay it counts as on (a task goes through the relay; a PC that is off does not get it, a relay holds
 * nothing), without one as off (a task waits in this browser's outbox).
 *
 * @param kept - The kept PCs (kv `pcKeys`).
 * @param relayReady - Whether a backup relay can carry a message now.
 * @returns Presence entries marked `remembered`.
 */
export function rememberedPresence(kept: Readonly<Record<string, KeptPc>>, relayReady: boolean): Array<HubPresence & { remembered: true }> {
  return Object.entries(kept)
    .filter(([, k]) => typeof k?.publicKey === "string" && k.publicKey)
    .map(([id, k]) => ({ id, name: k.name || "PC", kind: "pc" as const, publicKey: k.publicKey, online: relayReady, busy: false, optIn: k.optIn ?? KEPT_OPT_IN, agents: [], remembered: true as const }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Whether the page should show the last known device list instead of the hub's: the hub's link is not open and either
 * the hub never answered on this page or it has failed over (so a short reconnect does not swap the list).
 *
 * @param hubConnected - The hub's live link is open.
 * @param livePresence - How many devices the hub showed on this page.
 * @param hubDown - The failover says the hub is down.
 * @returns True for the remembered list.
 */
export function useRemembered(hubConnected: boolean, livePresence: number, hubDown: boolean): boolean {
  return !hubConnected && (livePresence === 0 || hubDown);
}
