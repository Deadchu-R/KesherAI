import { open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";

/** Files this big or bigger are split into parallel range parts (when the server allows ranges). */
export const PARALLEL_MIN_BYTES = 1024 ** 3;

/** One slice of the file: bytes `start` to `end` (both included), `done` of them already on disk. */
export interface PartState {
  start: number;
  end: number;
  done: number;
}

/** What is saved next to the `.part` file so every part resumes on its own after a stop, a crash or a restart. */
export interface PartsFile {
  /** The whole file's size; a saved state for another size is thrown away. */
  size: number;
  parts: PartState[];
}

/** The server (or the redirect target) answered a range request with the whole file: ranges do not work here. */
export class RangesRefused extends Error {
  /** Creates the refusal. */
  constructor() {
    super("The server does not support ranges.");
    this.name = "RangesRefused";
  }
}

/** Where the parts' progress is saved for a given `.part` file. */
export const partsFilePath = (part: string): string => `${part}.json`;

/**
 * Splits a file into `n` slices of nearly equal size.
 *
 * @param size - File size in bytes.
 * @param n - How many parts (at least 1; never more than there are bytes).
 * @returns The parts, in order, none done yet.
 */
export function planParts(size: number, n: number): PartState[] {
  const count = Math.max(1, Math.min(Math.floor(n), size));
  const base = Math.floor(size / count);
  return Array.from({ length: count }, (_, i) => ({
    start: i * base,
    end: i === count - 1 ? size - 1 : (i + 1) * base - 1,
    done: 0,
  }));
}

/**
 * Checks that a saved state is usable: right size, parts that tile the file exactly, sane progress.
 *
 * @param s - The parsed JSON (untrusted: it is a file on disk).
 * @param size - The size the file must have.
 */
export function validParts(s: unknown, size: number): s is PartsFile {
  const f = s as PartsFile | undefined;
  if (!f || f.size !== size || !Array.isArray(f.parts) || f.parts.length < 1 || f.parts.length > 16) return false;
  let next = 0;
  for (const p of f.parts) {
    if (!Number.isInteger(p?.start) || !Number.isInteger(p.end) || !Number.isInteger(p.done)) return false;
    if (p.start !== next || p.end < p.start || p.done < 0 || p.done > p.end - p.start + 1) return false;
    next = p.end + 1;
  }
  return next === size;
}

/**
 * Loads the saved parts of a `.part` file, if they match the file on disk.
 *
 * @param part - The `.part` path.
 * @param size - The expected size of the whole file.
 * @returns The state, or `undefined` when there is none or it does not fit (then the download starts over).
 */
export async function loadParts(part: string, size: number): Promise<PartsFile | undefined> {
  try {
    const state: unknown = JSON.parse(await readFile(partsFilePath(part), "utf8"));
    if (!validParts(state, size)) return undefined;
    // The preallocated file must still be there at full length, or the saved offsets mean nothing.
    return (await stat(part)).size === size ? state : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Saves the parts' progress. Written to a temporary file and renamed, so a crash never leaves half a JSON file.
 *
 * @param part - The `.part` path.
 * @param state - What to save.
 */
export async function saveParts(part: string, state: PartsFile): Promise<void> {
  const file = partsFilePath(part);
  await writeFile(`${file}.tmp`, JSON.stringify(state));
  await rename(`${file}.tmp`, file);
}

/**
 * Deletes the `.part` file and its saved parts (a finished, failed-for-good or restarted download).
 *
 * @param part - The `.part` path.
 */
export async function removeParts(part: string): Promise<void> {
  await Promise.all([part, partsFilePath(part), `${partsFilePath(part)}.tmp`].map((f) => unlink(f).catch(() => undefined)));
}

/**
 * Asks the server whether it can send a file in ranges, and how big the file is: a one-byte range request.
 * Redirects are followed, so the answer is the real file server's (Hugging Face sends big files to a CDN).
 *
 * @param url - The file.
 * @param init - Headers (a Hugging Face token) and an abort signal.
 * @param fetchImpl - `fetch`, replaceable for tests; it may retry on a briefly unwell server.
 * @returns The size when ranges work (a `206` with a `Content-Range` total), otherwise `undefined`.
 */
export async function probeRanges(
  url: string,
  init: { headers?: Record<string, string> | undefined; signal?: AbortSignal | undefined },
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<number | undefined> {
  try {
    const res = await fetchImpl(url, { headers: { ...init.headers, range: "bytes=0-0" }, ...(init.signal ? { signal: init.signal } : {}), redirect: "follow" });
    await res.body?.cancel().catch(() => undefined);
    if (res.status !== 206) return undefined;
    const total = Number(/\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "")?.[1]);
    return Number.isSafeInteger(total) && total > 0 ? total : undefined;
  } catch {
    if (init.signal?.aborted) throw new Error("Stopped.");
    return undefined;
  }
}

/**
 * The speed limit, shared by everything that downloads for one job (one stream or all its parts): it tells how long
 * to wait before taking more, so the bytes of all parts together stay at the limit.
 */
export class Pacer {
  private t0 = Date.now();
  private bytes = 0;

  /**
   * @param n - Bytes just received.
   * @param limit - Bytes per second allowed (0: no limit).
   * @returns Milliseconds to wait before taking more (0 when not ahead of the limit).
   */
  delay(n: number, limit: number): number {
    if (!limit) return 0;
    this.bytes += n;
    const ahead = (this.bytes / limit) * 1000 - (Date.now() - this.t0);
    // A new window every 10 s, so a long pause (or a changed limit) is not "paid back" later.
    if (Date.now() - this.t0 > 10_000) {
      this.t0 = Date.now();
      this.bytes = 0;
    }
    return ahead > 5 ? Math.min(ahead, 5000) : 0;
  }
}

/** Waits `ms`, ending early (without an error) when `signal` aborts. */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });

/** What {@link downloadParts} needs. */
export interface PartsOptions {
  url: string;
  /** Extra request headers (the Hugging Face token goes on every part's request). */
  headers?: Record<string, string> | undefined;
  /** The preallocated `.part` file (already at full size). */
  file: string;
  /** The parts and how far each one is; updated in place as bytes land. */
  state: PartsFile;
  /** Stops everything (pause, cancel); the progress so far is saved. */
  signal: AbortSignal;
  /** Called with the bytes of every chunk written, from any part. */
  onBytes: (n: number) => void;
  /** Gives the speed limit now (bytes per second, 0: none); read for every chunk, so a change applies at once. */
  limit: () => number;
  /** How many times one part is tried before the whole download fails (default 5). */
  tries?: number;
  /** The first wait before a part's retry; it doubles each time (default 1000). */
  backoffMs?: number;
  /** How often the progress is saved (default 1000). */
  saveEveryMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Downloads the unfinished parts of a file at the same time, each into its own place in one preallocated file.
 * A part that fails is tried again after a growing wait, resuming at its own offset, while the others go on.
 * When a pause or cancel stops it, the progress is saved so the next run continues part by part.
 *
 * @throws {@link RangesRefused} when a server answers a range with the whole file (the caller then downloads in one stream).
 * @throws The last error of a part that failed all its tries.
 */
export async function downloadParts(o: PartsOptions): Promise<void> {
  const f = o.fetchImpl ?? fetch;
  const tries = o.tries ?? 5;
  const backoff = o.backoffMs ?? 1000;
  const pacer = new Pacer();
  // One shared signal: the first part that fails for good (or a refusal) stops the others quickly.
  const inner = new AbortController();
  const stop = () => inner.abort();
  if (o.signal.aborted) inner.abort();
  o.signal.addEventListener("abort", stop);
  const fh = await open(o.file, "r+");
  let saving: Promise<void> = Promise.resolve();
  const save = () => (saving = saving.then(() => saveParts(o.file, o.state)).catch(() => undefined));
  const timer = setInterval(() => void save(), o.saveEveryMs ?? 1000);
  let failure: unknown;

  const runPart = async (p: PartState) => {
    for (let attempt = 1; p.done < p.end - p.start + 1 && !inner.signal.aborted; attempt++) {
      try {
        const from = p.start + p.done;
        const res = await f(o.url, { headers: { ...o.headers, range: `bytes=${from}-${p.end}` }, signal: inner.signal, redirect: "follow" });
        if (res.status === 200) throw new RangesRefused();
        if (res.status !== 206 || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        const reader = res.body.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          // Never take more than the part's own bytes, even from a server that sends too much.
          const room = p.end - p.start + 1 - p.done;
          const chunk = value.length > room ? value.subarray(0, room) : value;
          if (chunk.length === 0) break;
          await fh.write(chunk, 0, chunk.length, p.start + p.done);
          p.done += chunk.length;
          o.onBytes(chunk.length);
          const wait = pacer.delay(chunk.length, o.limit());
          if (wait > 0) await sleep(wait, inner.signal);
          if (inner.signal.aborted) {
            await reader.cancel().catch(() => undefined);
            return;
          }
        }
        // A stream that ended early counts as a drop: the loop asks again for the rest.
        if (p.done < p.end - p.start + 1) throw new Error("The connection closed early.");
      } catch (err) {
        if (inner.signal.aborted) return;
        if (err instanceof RangesRefused || attempt >= tries) throw err;
        await sleep(backoff * 2 ** (attempt - 1), inner.signal);
      }
    }
  };

  try {
    await Promise.all(
      o.state.parts.map((p) =>
        runPart(p).catch((err) => {
          failure ??= err;
          inner.abort();
        }),
      ),
    );
  } finally {
    clearInterval(timer);
    o.signal.removeEventListener("abort", stop);
    await fh.close().catch(() => undefined);
    await save();
  }
  if (failure) throw failure;
  if (o.signal.aborted) return;
  if (o.state.parts.some((p) => p.done < p.end - p.start + 1)) throw new Error("A part did not finish.");
}
