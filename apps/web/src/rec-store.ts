/**
 * Keeps long recordings safe while they are made: every few seconds the recorder's newest piece of sound goes into the
 * browser's own storage (IndexedDB), with the session's state (recording, paused, how long so far). Leaving the app, a
 * crash, a reload or a lost connection keeps everything up to that moment, and the page can offer "Resume" or
 * "Finish" for a session that did not end. Each start or resume of a recorder is one "part" (a WebM file on its own);
 * the parts are joined when the recording is sent.
 *
 * The storage is behind {@link RecBackend}, so the logic is tested with {@link memoryBackend} in Node.
 */

/** Which page the recording belongs to. */
export type RecKind = "ideas" | "study";

/** A pause in the recording: where it is (ms of sound before it), how long it was, whether the system caused it. */
export interface RecGap {
  at: number;
  ms: number;
  system?: boolean;
}

/** One recording session as it is kept. */
export interface RecSession {
  id: string;
  kind: RecKind;
  /** When it first started (ms since 1970). */
  startedAt: number;
  /** "recording" and "paused" while it runs; a session left in those states after its page closed is interrupted. */
  state: "recording" | "paused" | "stopped";
  /** Sound recorded before {@link resumedAt} (ms). */
  recordedMs: number;
  /** When the clock last started counting (while "recording"). */
  resumedAt: number;
  /** Last time the page said it was alive (ms); a heartbeat while it runs. */
  updatedAt: number;
  /** The number of parts started (each start or resume of a recorder). */
  parts: number;
  mime: string;
  /** Recorded natively by the phone app (the sound is in the app, not here). */
  native?: boolean;
  gaps: RecGap[];
  /** The page's own data (Study: the transcript lines so far). */
  meta?: Record<string, unknown>;
}

/** One piece of sound: which session, which part, its order in the part. */
export interface RecChunk {
  session: string;
  part: number;
  seq: number;
  blob: Blob;
}

/** Where sessions and chunks are kept. */
export interface RecBackend {
  putSession(s: RecSession): Promise<void>;
  getSession(id: string): Promise<RecSession | undefined>;
  listSessions(): Promise<RecSession[]>;
  /** Removes the session and all its chunks. */
  deleteSession(id: string): Promise<void>;
  putChunk(c: RecChunk): Promise<void>;
  chunks(session: string): Promise<RecChunk[]>;
}

/** A page that has not said it is alive for this long has stopped (closed, reloaded, frozen in the background). */
export const ALIVE_MS = 15_000;

/**
 * The sound recorded so far, counting the running clock.
 * @param s - The session.
 * @param now - The time now (ms).
 */
export function elapsedMs(s: Pick<RecSession, "state" | "recordedMs" | "resumedAt">, now: number): number {
  return s.recordedMs + (s.state === "recording" ? Math.max(0, now - s.resumedAt) : 0);
}

/**
 * Whether a session did not end and its page is gone, so it can be resumed or finished.
 * @param s - The session.
 * @param now - The time now (ms).
 */
export function isInterrupted(s: RecSession, now: number): boolean {
  return s.state !== "stopped" && now - s.updatedAt > ALIVE_MS;
}

/**
 * Puts the chunks back in order and joins each part's chunks into one file (a part is one recorder run, so its chunks
 * make one valid WebM/Ogg file together; different parts do not).
 * @param chunks - The session's chunks, in any order.
 * @param mime - The type to give the files.
 * @returns One Blob per part, in order; empty parts are left out.
 */
export function groupParts(chunks: RecChunk[], mime: string): Blob[] {
  const byPart = new Map<number, RecChunk[]>();
  for (const c of chunks) byPart.set(c.part, [...(byPart.get(c.part) ?? []), c]);
  return [...byPart.keys()]
    .sort((a, b) => a - b)
    .map((p) => byPart.get(p)!.sort((a, b) => a.seq - b.seq).map((c) => c.blob))
    .filter((bs) => bs.some((b) => b.size > 0))
    .map((bs) => new Blob(bs, { type: mime }));
}

/**
 * Joins WAV files of the same format (16-bit PCM, as the phone app writes them) into one: the first header, all the
 * sound, the lengths fixed. Files that are not WAV are skipped.
 * @param wavs - The files, in order.
 * @returns One WAV file.
 */
export function joinWavs(wavs: Uint8Array[]): Uint8Array {
  const ok = wavs.filter((w) => w.length > 44 && String.fromCharCode(...w.subarray(0, 4)) === "RIFF");
  if (!ok.length) return new Uint8Array(0);
  const dataLen = ok.reduce((n, w) => n + (w.length - 44), 0);
  const out = new Uint8Array(44 + dataLen);
  out.set(ok[0]!.subarray(0, 44), 0);
  let at = 44;
  for (const w of ok) {
    out.set(w.subarray(44), at);
    at += w.length - 44;
  }
  const v = new DataView(out.buffer);
  v.setUint32(4, 36 + dataLen, true);
  v.setUint32(40, dataLen, true);
  return out;
}

/**
 * The session store: start, add sound, pause and resume, find interrupted sessions, read the parts back.
 * Every write also refreshes the session's heartbeat.
 */
export class RecStore {
  /** @param db - Where it keeps things ({@link idbBackend} in the browser, {@link memoryBackend} in tests). */
  constructor(private readonly db: RecBackend, private readonly clock: () => number = Date.now) {}

  /**
   * Starts a new session (part 0 starts with it).
   * @param kind - The page it belongs to.
   * @param mime - The recorder's type ("" for a native recording).
   * @param native - Whether the phone app records it.
   */
  async begin(kind: RecKind, mime: string, native = false): Promise<RecSession> {
    const now = this.clock();
    const s: RecSession = { id: `${kind}-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`, kind, startedAt: now, state: "recording", recordedMs: 0, resumedAt: now, updatedAt: now, parts: 1, mime, gaps: [], ...(native ? { native } : {}) };
    await this.db.putSession(s);
    return s;
  }

  /**
   * Continues an interrupted session: a new part, the clock counting from what was recorded. The time it was away is
   * kept as a gap.
   * @param id - The session.
   * @returns The session, and the number of the new part.
   */
  async resume(id: string): Promise<{ session: RecSession; part: number }> {
    const s = await this.must(id);
    const now = this.clock();
    // The clock stopped when the page last said it was alive.
    const recorded = elapsedMs(s, Math.max(s.resumedAt, s.updatedAt));
    const part = s.parts;
    const next: RecSession = { ...s, state: "recording", recordedMs: recorded, resumedAt: now, updatedAt: now, parts: s.parts + 1, gaps: [...s.gaps, { at: recorded, ms: Math.max(0, now - s.updatedAt), system: true }] };
    await this.db.putSession(next);
    return { session: next, part };
  }

  /**
   * Keeps a piece of sound.
   * @param id - The session.
   * @param part - Its part.
   * @param seq - Its order in the part.
   * @param blob - The sound.
   */
  async addChunk(id: string, part: number, seq: number, blob: Blob): Promise<void> {
    await this.db.putChunk({ session: id, part, seq, blob });
    await this.touch(id);
  }

  /** Says the page is alive (call every few seconds while recording). @param id - The session. */
  async touch(id: string): Promise<void> {
    const s = await this.db.getSession(id);
    if (s) await this.db.putSession({ ...s, updatedAt: this.clock() });
  }

  /**
   * Pauses or resumes the clock.
   * @param id - The session.
   * @param on - True to pause.
   * @param gap - A pause the system caused ends a gap; kept when given (on resume).
   */
  async pause(id: string, on: boolean, gap?: RecGap): Promise<RecSession> {
    const s = await this.must(id);
    const now = this.clock();
    const next: RecSession = on
      ? { ...s, state: "paused", recordedMs: elapsedMs(s, now), updatedAt: now }
      : { ...s, state: "recording", resumedAt: now, updatedAt: now, gaps: gap ? [...s.gaps, gap] : s.gaps };
    await this.db.putSession(next);
    return next;
  }

  /** Keeps the page's own data with the session. @param id - The session. @param meta - Its data (replaces the old). */
  async setMeta(id: string, meta: Record<string, unknown>): Promise<void> {
    const s = await this.db.getSession(id);
    if (s) await this.db.putSession({ ...s, meta, updatedAt: this.clock() });
  }

  /** Marks the session ended (it stays until removed, so a failed send can be tried again). @param id - The session. */
  async stop(id: string): Promise<RecSession> {
    const s = await this.must(id);
    const now = this.clock();
    const next: RecSession = { ...s, state: "stopped", recordedMs: elapsedMs(s, now), updatedAt: now };
    await this.db.putSession(next);
    return next;
  }

  /** The session. @param id - Its id. */
  get(id: string): Promise<RecSession | undefined> {
    return this.db.getSession(id);
  }

  /**
   * The newest session of this page that did not end (interrupted, or stopped but not yet sent and removed).
   * @param kind - The page.
   */
  async unfinished(kind: RecKind): Promise<RecSession | undefined> {
    const now = this.clock();
    return (await this.db.listSessions()).filter((s) => s.kind === kind && (s.state === "stopped" || isInterrupted(s, now))).sort((a, b) => b.startedAt - a.startedAt)[0];
  }

  /** The session's sound, one file per part. @param id - The session. */
  async parts(id: string): Promise<Blob[]> {
    const s = await this.must(id);
    return groupParts(await this.db.chunks(id), s.mime);
  }

  /** Removes the session and its sound (after it was sent, or when discarded). @param id - The session. */
  remove(id: string): Promise<void> {
    return this.db.deleteSession(id);
  }

  private async must(id: string): Promise<RecSession> {
    const s = await this.db.getSession(id);
    if (!s) throw new Error(`No recording ${id}`);
    return s;
  }
}

/** A store in memory (tests, and a browser without IndexedDB, where it at least keeps the sound until a reload). */
export function memoryBackend(): RecBackend {
  const sessions = new Map<string, RecSession>();
  const chunks: RecChunk[] = [];
  return {
    putSession: async (s) => void sessions.set(s.id, structuredClone(s)),
    getSession: async (id) => (sessions.has(id) ? structuredClone(sessions.get(id)!) : undefined),
    listSessions: async () => [...sessions.values()].map((s) => structuredClone(s)),
    deleteSession: async (id) => {
      sessions.delete(id);
      for (let i = chunks.length - 1; i >= 0; i--) if (chunks[i]!.session === id) chunks.splice(i, 1);
    },
    putChunk: async (c) => void chunks.push(c),
    chunks: async (id) => chunks.filter((c) => c.session === id),
  };
}

/** The browser's IndexedDB ("kesher-rec": "sessions" by id, "chunks" by [session, part, seq]). */
export function idbBackend(): RecBackend {
  let opened: Promise<IDBDatabase> | undefined;
  const open = () =>
    (opened ??= new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open("kesher-rec", 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore("sessions", { keyPath: "id" });
        r.result.createObjectStore("chunks", { keyPath: ["session", "part", "seq"] });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }));
  const run = async <T>(stores: string[], mode: IDBTransactionMode, fn: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T> => {
    const t = (await open()).transaction(stores, mode);
    const req = fn(t);
    return new Promise<T>((res, rej) => {
      t.oncomplete = () => res(req ? req.result : (undefined as T));
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  };
  const range = (id: string) => IDBKeyRange.bound([id, -Infinity, -Infinity], [id, Infinity, Infinity]);
  return {
    putSession: (s) => run(["sessions"], "readwrite", (t) => void t.objectStore("sessions").put(s)),
    getSession: (id) => run<RecSession | undefined>(["sessions"], "readonly", (t) => t.objectStore("sessions").get(id) as IDBRequest<RecSession | undefined>),
    listSessions: () => run<RecSession[]>(["sessions"], "readonly", (t) => t.objectStore("sessions").getAll() as IDBRequest<RecSession[]>),
    deleteSession: (id) => run(["sessions", "chunks"], "readwrite", (t) => {
      t.objectStore("sessions").delete(id);
      t.objectStore("chunks").delete(range(id));
    }),
    putChunk: (c) => run(["chunks"], "readwrite", (t) => void t.objectStore("chunks").put(c)),
    chunks: (id) => run<RecChunk[]>(["chunks"], "readonly", (t) => t.objectStore("chunks").getAll(range(id)) as IDBRequest<RecChunk[]>),
  };
}

let shared: RecStore | undefined;
/** The page's store (IndexedDB, or memory where the browser has none). */
export function recStore(): RecStore {
  return (shared ??= new RecStore(typeof indexedDB === "undefined" ? memoryBackend() : idbBackend()));
}
