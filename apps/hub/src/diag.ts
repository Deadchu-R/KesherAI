/**
 * The hub's diagnostics: a small ring of recent problems kept in the Durable Object's memory only (no storage
 * writes, so it works on a day the daily write quota is used up, and it is gone when the object sleeps). The PC reads
 * it through `GET /api/diag` (device token) and keeps a copy in its logs folder, so a "the hub answered 500" can be
 * traced to its step and reason.
 *
 * Privacy: an entry never holds a token, ticket, body, e-mail address or IP. Paths are cut to their route (no query,
 * ids replaced), and every message goes through {@link scrub}.
 */

/** How many entries the ring keeps. */
export const DIAG_MAX = 200;

/** What an entry is about. */
export type DiagKind = "http" | "error" | "storage";

/** One recorded problem. */
export interface DiagEntry {
  /** When it happened (ISO time). */
  at: string;
  kind: DiagKind;
  /** Where: `http`, `socket-message`, `socket-close`, `cleanup`, `open`, `bookkeeping`, … */
  where: string;
  method?: string;
  /** The route, without query or ids. */
  path?: string;
  status?: number;
  /** The `error` code the answer carried (`hub-storage-limit`, `Unknown device.`, …). */
  code?: string;
  message?: string;
  /** The first lines of a thrown error's stack. */
  stack?: string[];
  /** How long the call took, in ms. */
  ms?: number;
  /** The same entry again and again: how many times (the time is the last one). */
  count?: number;
}

/** What `GET /api/diag` answers. */
export interface DiagSnapshot {
  /** The hub's clock now, and when this object woke up (the ring starts empty then). */
  now: string;
  startedAt: string;
  /** How many problems were recorded since it woke up (the ring keeps the last {@link DIAG_MAX}). */
  total: number;
  entries: DiagEntry[];
}

/** Longest message kept. */
const MESSAGE_MAX = 200;

/**
 * Hides what must never be kept: hub tokens (`kh_…`, `kh2_…`), tickets (`kt1.…`), JWT-like strings, e-mail addresses, IPv4 and
 * IPv6 addresses, and any long token-like run of letters and digits. Cuts the result to {@link MESSAGE_MAX}.
 *
 * @param text - A message.
 * @returns The same message, safe to keep.
 */
export function scrub(text: string): string {
  return text
    .replace(/\bkh2?_[\w.-]+/g, "<token>")
    .replace(/\bkt1\.[\w.-]+/g, "<ticket>")
    .replace(/\beyJ[\w-]+\.[\w-]+(\.[\w-]*)?/g, "<jwt>")
    .replace(/[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+/g, "<email>")
    .replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, "<ip>")
    .replace(/(?<![\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?)(?![\w:])/gi, "<ip>")
    .replace(/[\w-]{32,}/g, "<redacted>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MESSAGE_MAX);
}

/**
 * A route for the log: no query string, and every id-like segment (long, or with digits) replaced by `:id`.
 *
 * @param pathname - A URL path.
 * @returns The route.
 */
export function diagPath(pathname: string): string {
  return pathname
    .split("/")
    .map((s) => (s.length > 20 || /\d.*\d/.test(s) ? ":id" : s))
    .join("/")
    .slice(0, 80);
}

/**
 * The first lines of an error's stack, scrubbed.
 *
 * @param e - What was thrown.
 * @param lines - How many lines (5).
 * @returns The lines (empty when there is no stack).
 */
export function stackHead(e: unknown, lines = 5): string[] {
  if (!(e instanceof Error) || !e.stack) return [];
  return e.stack
    .split("\n")
    .slice(1, 1 + lines)
    .map((l) => scrub(l));
}

/** The ring. */
export class DiagRing {
  private entries: DiagEntry[] = [];
  private total = 0;
  private readonly startedAt: number;

  /**
   * @param now - The clock in ms (tests pass their own).
   * @param max - How many entries to keep.
   */
  constructor(private readonly now: () => number = Date.now, private readonly max = DIAG_MAX) {
    this.startedAt = now();
  }

  /**
   * Records one entry. The same problem again right after itself (same kind, place, route, status, code and message)
   * only raises the last entry's count, so a scanner's flood cannot push the useful entries out.
   *
   * @param e - The entry without its time; text fields are scrubbed here.
   */
  add(e: Omit<DiagEntry, "at">): void {
    this.total++;
    const clean: DiagEntry = { ...e, at: new Date(this.now()).toISOString(), ...(e.message !== undefined ? { message: scrub(e.message) } : {}), ...(e.code !== undefined ? { code: scrub(e.code) } : {}) };
    const last = this.entries[this.entries.length - 1];
    const same = (k: keyof DiagEntry) => last?.[k] === clean[k];
    if (last && same("kind") && same("where") && same("method") && same("path") && same("status") && same("code") && same("message")) {
      last.count = (last.count ?? 1) + 1;
      last.at = clean.at;
      if (clean.ms !== undefined) last.ms = clean.ms;
      return;
    }
    this.entries.push(clean);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
  }

  /**
   * Records a thrown error: its message, the first 5 stack lines and where it happened.
   *
   * @param where - The place (`socket-message`, `http`, …).
   * @param e - What was thrown.
   * @param extra - The route, when it is an HTTP call.
   */
  error(where: string, e: unknown, extra: Pick<DiagEntry, "method" | "path" | "ms"> = {}): void {
    this.add({ kind: "error", where, ...extra, message: e instanceof Error ? `${e.name}: ${e.message}` : String(e), stack: stackHead(e) });
  }

  /** @returns A copy of the ring for `/api/diag`, oldest first. */
  snapshot(): DiagSnapshot {
    return { now: new Date(this.now()).toISOString(), startedAt: new Date(this.startedAt).toISOString(), total: this.total, entries: this.entries.map((e) => ({ ...e })) };
  }
}
