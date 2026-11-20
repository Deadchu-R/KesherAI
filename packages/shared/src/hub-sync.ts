/**
 * Kesher Cloud: sealed records, so every device of the account sees every task and agent (docs/RESEARCH_LOG.md,
 * "Hub: every task and agent on every device" and "Tasks in Roee's Google Drive instead of the hub", 2026-11-20).
 *
 * The records live in the owner's own Google Drive (its hidden appDataFolder), one immutable file per revision, named
 * after the record's head ({@link recordFileName}); files are only created and deleted, never updated, so two devices
 * cannot overwrite each other. Each device keeps its own Drive `changeToken` as the sync cursor.
 *
 * The owner's devices share one random **account key** K. A record is sealed with AES-GCM-256 under
 * HKDF-SHA-256(K, salt = random per write, info = "kesher-sync v1"), so each write has its own key and no GCM nonce
 * budget is shared. The authenticated data binds `v|kid|id|kind|rev|deleted|done|writer`, so whoever stores the
 * files cannot move a ciphertext to another record (or rename its file), change its revision or writer, or flip a
 * tombstone. The plain text is padded to 256-byte steps, so the store sees sizes only roughly.
 *
 * One id names one task; its kinds are facets with their own writer: `task` (the origin device, once), `run` (the
 * device that runs it), `meta` (any device: the owner's marks), and `agent` (a finished agent run's snapshot).
 * WebCrypto only: the same code runs in Node, the Cloudflare Worker and the phone's WebView.
 */
import { fromB64url, randomB64url, toB64url, type HubCryptoKey } from "./hub-crypto.js";

/** The record format version (part of the authenticated data). */
export const SYNC_VERSION = 1;

/** Sizes, counts and times for synced records (every device keeps to them). */
export const SYNC_LIMITS = {
  /** Largest ciphertext of one record, in base64url characters (64 KB). */
  recordChars: 64 * 1024,
  /** Plain text is padded up to a multiple of this many bytes. */
  padBytes: 256,
  /** Entries in a run's timeline, and characters of its fields. */
  timeline: 30,
  summaryChars: 500,
  noteChars: 2000,
  /** How long a finished task (its run is done), a tombstone and an agent snapshot are kept before compaction. */
  doneKeepMs: 90 * 24 * 3600 * 1000,
  tombstoneKeepMs: 30 * 24 * 3600 * 1000,
  agentKeepMs: 30 * 24 * 3600 * 1000,
  /** How often an open app pulls the Drive changes feed. */
  pollMs: 60_000,
  /** A revision's file is deleted once a newer revision of its facet has existed this long. */
  compactAfterMs: 24 * 3600 * 1000,
  /** Files in one Drive `files.list` / `changes.list` page (Drive's largest). */
  driveListPage: 1000,
} as const;

/** The facets of one synced id. */
export type SyncKind = "task" | "run" | "meta" | "agent";
export const SYNC_KINDS: readonly SyncKind[] = ["task", "run", "meta", "agent"];

/** Kinds only their first writer may change (anyone may still delete them). `meta` is shared. */
export const SINGLE_WRITER_KINDS: ReadonlySet<SyncKind> = new Set(["task", "run", "agent"]);

/** A run's state. The last five are terminal: once there, a run never goes back. */
export type SyncRunState = "outbox" | "waiting" | "waiting-run" | "running" | "done" | "partial" | "failed" | "blocked" | "cancelled";
const RUN_STATES: readonly SyncRunState[] = ["outbox", "waiting", "waiting-run", "running", "done", "partial", "failed", "blocked", "cancelled"];
/** States a run stays in for good. */
export const TERMINAL_RUN_STATES: ReadonlySet<SyncRunState> = new Set(["done", "partial", "failed", "blocked", "cancelled"]);

/** Where a task came from. */
export type SyncOrigin = "phone" | "pc" | "page" | "inbox-claude" | "inbox-roee" | "self-work";
const ORIGINS: readonly SyncOrigin[] = ["phone", "pc", "page", "inbox-claude", "inbox-roee", "self-work"];

/** What an agent snapshot came from. */
export type SyncAgentSource = "chat-helper" | "inbox" | "antigravity" | "claude-cloud";
const AGENT_SOURCES: readonly SyncAgentSource[] = ["chat-helper", "inbox", "antigravity", "claude-cloud"];

/** A task, written once by the device it came from. */
export interface SyncTaskBody {
  type: "task";
  title: string;
  spec: string;
  origin: SyncOrigin;
  /** Who runs it (`HubExecutor`, or an inbox executor such as `local`, `antigravity`, `claude`). */
  executor: string;
  /** The device meant to run it, if one was picked. */
  target?: string;
  createdAt: string;
  risk?: string;
}

/** One line of a run's timeline. */
export interface SyncTimelineEntry {
  at: string;
  line: string;
}

/** A task's run, written only by the device that runs it. */
export interface SyncRunBody {
  type: "run";
  state: SyncRunState;
  /** One line: what it does now. */
  status?: string;
  timeline?: SyncTimelineEntry[];
  result?: string;
  link?: string;
  branch?: string;
  model?: string;
  tokens?: number;
  startedAt?: string;
  endedAt?: string;
}

/** The owner's own marks on a task (any device; last revision wins). */
export interface SyncMetaBody {
  type: "meta";
  archived?: boolean;
  pinned?: boolean;
  note?: string;
}

/** A finished agent run's snapshot (live steps keep using `agent_event`). */
export interface SyncAgentBody {
  type: "agent";
  title: string;
  source: SyncAgentSource;
  state: string;
  steps?: number;
  startedAt?: string;
  endedAt?: string;
  summary?: string;
}

/** The plain content of a record. */
export type SyncBody = SyncTaskBody | SyncRunBody | SyncMetaBody | SyncAgentBody;

/** What a record's kind holds. */
type BodyOf<K extends SyncKind> = Extract<SyncBody, { type: K }>;

/** A sealed record. Everything but `ct` is visible to the store (its head is the file name). */
export interface SyncRecord {
  v: typeof SYNC_VERSION;
  /** Random, opaque (the same for a task's facets). */
  id: string;
  kind: SyncKind;
  /** Grows by one with each write of this facet. */
  rev: number;
  /** The device that wrote this revision. */
  writer: string;
  /** A tombstone: the facet was deleted (it still carries a sealed, empty body, so the store cannot forge one). */
  deleted?: boolean;
  /** A finished run (terminal state): tells compaction when the task may be forgotten. */
  done?: boolean;
  /** Which account key sealed it (keys are replaced when a device is removed). */
  kid: number;
  salt: string;
  iv: string;
  ct: string;
}

/** The head of a record: what merging and compaction look at (and what its file name holds). */
export type SyncHead = Pick<SyncRecord, "id" | "kind" | "rev" | "writer"> & Partial<Pick<SyncRecord, "deleted" | "done">>;

const enc = new TextEncoder();
const dec = new TextDecoder();
const subtle = () => globalThis.crypto.subtle;
const INFO = enc.encode(`kesher-sync v${SYNC_VERSION}`);
const ID_RE = /^[\w-]{8,64}$/;
const WRITER_RE = /^[\w-]{1,64}$/;
const B64_RE = /^[\w-]+$/;

// ---- the account key ----

/**
 * Makes the bytes of a new account key K (256 random bits). The caller stores them protected (the PC's encrypted
 * config) or imports them at once with {@link importAccountKey}.
 *
 * @returns 32 random bytes.
 */
export function newAccountKeyBytes(): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

/**
 * Reads K for sealing and opening records. The key is not extractable.
 *
 * @param raw - The 32 key bytes.
 * @returns An HKDF key (each record's AES key is derived from it).
 */
export async function importAccountKey(raw: Uint8Array<ArrayBuffer>): Promise<HubCryptoKey> {
  if (raw.length !== 32) throw new Error("An account key is 32 bytes.");
  return subtle().importKey("raw", raw, "HKDF", false, ["deriveKey"]);
}

// ---- shape checks ----

const str = (v: unknown, max: number): string => (typeof v === "string" ? v : "").slice(0, max);
const optStr = (v: unknown, max: number): string | undefined => (typeof v === "string" && v ? v.slice(0, max) : undefined);
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | undefined => (list.includes(v as T) ? (v as T) : undefined);
const posInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/**
 * Checks a record's shape from untrusted input (a file read from Drive). Does not open it.
 *
 * @param x - The value.
 * @returns The record with only its known fields, or undefined when it does not fit.
 */
export function parseSyncRecord(x: unknown): SyncRecord | undefined {
  if (!x || typeof x !== "object") return undefined;
  const r = x as Record<string, unknown>;
  if (r.v !== SYNC_VERSION || typeof r.id !== "string" || !ID_RE.test(r.id) || !oneOf(r.kind, SYNC_KINDS)) return undefined;
  if (!posInt(r.rev) || r.rev < 1 || typeof r.writer !== "string" || !WRITER_RE.test(r.writer) || !posInt(r.kid) || r.kid < 1) return undefined;
  for (const k of ["salt", "iv", "ct"] as const) if (typeof r[k] !== "string" || !B64_RE.test(r[k] as string)) return undefined;
  if ((r.salt as string).length !== 22 || (r.iv as string).length !== 16 || (r.ct as string).length > SYNC_LIMITS.recordChars) return undefined;
  if ((r.deleted !== undefined && typeof r.deleted !== "boolean") || (r.done !== undefined && typeof r.done !== "boolean")) return undefined;
  const rec: SyncRecord = { v: SYNC_VERSION, id: r.id, kind: r.kind as SyncKind, rev: r.rev, writer: r.writer, kid: r.kid, salt: r.salt as string, iv: r.iv as string, ct: r.ct as string };
  if (r.deleted) rec.deleted = true;
  if (r.done) rec.done = true;
  return rec;
}

/**
 * Cleans an opened body: unknown fields go, texts are cut to their limits, and it must fit the record's kind.
 *
 * @param x - The parsed plain text.
 * @param kind - The record's kind.
 * @returns The body, or undefined when it does not fit.
 */
export function cleanSyncBody<K extends SyncKind>(x: unknown, kind: K): BodyOf<K> | undefined {
  if (!x || typeof x !== "object") return undefined;
  const b = x as Record<string, unknown>;
  if (b.type !== kind) return undefined;
  const out = ((): SyncBody | undefined => {
    switch (kind) {
      case "task": {
        const origin = oneOf(b.origin, ORIGINS);
        if (!origin || typeof b.title !== "string") return undefined;
        return { type: "task", title: str(b.title, 200), spec: str(b.spec, 8000), origin, executor: str(b.executor, 40), createdAt: str(b.createdAt, 40), ...opt("target", optStr(b.target, 64)), ...opt("risk", optStr(b.risk, 20)) };
      }
      case "run": {
        const state = oneOf(b.state, RUN_STATES);
        if (!state) return undefined;
        const timeline = Array.isArray(b.timeline)
          ? b.timeline.slice(-SYNC_LIMITS.timeline).flatMap((e: unknown) => (e && typeof e === "object" ? [{ at: str((e as SyncTimelineEntry).at, 40), line: str((e as SyncTimelineEntry).line, 300) }] : []))
          : undefined;
        return {
          type: "run",
          state,
          ...opt("status", optStr(b.status, 200)),
          ...opt("timeline", timeline),
          ...opt("result", optStr(b.result, 4000)),
          ...opt("link", optStr(b.link, 500)),
          ...opt("branch", optStr(b.branch, 200)),
          ...opt("model", optStr(b.model, 100)),
          ...opt("tokens", posInt(b.tokens) ? b.tokens : undefined),
          ...opt("startedAt", optStr(b.startedAt, 40)),
          ...opt("endedAt", optStr(b.endedAt, 40)),
        };
      }
      case "meta":
        return { type: "meta", ...opt("archived", typeof b.archived === "boolean" ? b.archived : undefined), ...opt("pinned", typeof b.pinned === "boolean" ? b.pinned : undefined), ...opt("note", optStr(b.note, SYNC_LIMITS.noteChars)) };
      case "agent": {
        const source = oneOf(b.source, AGENT_SOURCES);
        if (!source || typeof b.title !== "string") return undefined;
        return {
          type: "agent",
          title: str(b.title, 200),
          source,
          state: str(b.state, 20),
          ...opt("steps", posInt(b.steps) ? b.steps : undefined),
          ...opt("startedAt", optStr(b.startedAt, 40)),
          ...opt("endedAt", optStr(b.endedAt, 40)),
          ...opt("summary", optStr(b.summary, SYNC_LIMITS.summaryChars)),
        };
      }
      default:
        return undefined;
    }
  })();
  return out as BodyOf<K> | undefined;
}

/** `{ [k]: v }` when v is set, else `{}` (keeps optional fields absent rather than undefined). */
function opt<K extends string, V>(k: K, v: V | undefined): { [P in K]?: V } {
  return (v === undefined ? {} : { [k]: v }) as { [P in K]?: V };
}

// ---- sealing ----

/** The authenticated data: every field the store sees and could otherwise change. */
function aad(r: Pick<SyncRecord, "kid" | "id" | "kind" | "rev" | "writer"> & { deleted?: boolean; done?: boolean }): Uint8Array<ArrayBuffer> {
  return enc.encode(`kesher-sync v${SYNC_VERSION}|${r.kid}|${r.id}|${r.kind}|${r.rev}|${r.deleted ? 1 : 0}|${r.done ? 1 : 0}|${r.writer}`);
}

/** The AES key of one record write. */
async function recordKey(accountKey: HubCryptoKey, salt: Uint8Array<ArrayBuffer>, use: "encrypt" | "decrypt"): Promise<HubCryptoKey> {
  return subtle().deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: INFO }, accountKey, { name: "AES-GCM", length: 256 }, false, [use]);
}

/** Plain text padded with spaces to the next {@link SYNC_LIMITS.padBytes} (JSON ignores trailing spaces). */
function padded(text: string): Uint8Array<ArrayBuffer> {
  const bytes = enc.encode(text);
  const size = Math.ceil((bytes.length + 1) / SYNC_LIMITS.padBytes) * SYNC_LIMITS.padBytes;
  const out = new Uint8Array(size).fill(0x20);
  out.set(bytes);
  return out;
}

/** What to seal: the head and key id. `id` is a new random one when left out. */
export interface SyncSealHead {
  id?: string;
  kind: SyncKind;
  rev: number;
  writer: string;
  kid: number;
}

/**
 * Seals one revision of a record under the account key.
 *
 * @param head - Id, kind, revision, writer and key id.
 * @param body - The content (its type must be the kind), or null for a tombstone.
 * @param accountKey - K, from {@link importAccountKey}.
 * @returns The sealed record (store it with {@link recordFileName} and {@link recordFileContent}).
 */
export async function sealRecord(head: SyncSealHead, body: SyncBody | null, accountKey: HubCryptoKey): Promise<SyncRecord> {
  if (body && body.type !== head.kind) throw new Error(`A ${head.kind} record cannot hold a ${body.type}.`);
  if (!Number.isSafeInteger(head.rev) || head.rev < 1 || !Number.isSafeInteger(head.kid) || head.kid < 1) throw new Error("rev and kid start at 1.");
  const id = head.id ?? randomB64url(16);
  if (!ID_RE.test(id) || !WRITER_RE.test(head.writer)) throw new Error("Bad record id or writer.");
  const deleted = body === null;
  const done = body?.type === "run" && TERMINAL_RUN_STATES.has(body.state);
  const meta = { id, kind: head.kind, rev: head.rev, writer: head.writer, kid: head.kid, ...(deleted ? { deleted } : {}), ...(done ? { done } : {}) };
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await recordKey(accountKey, salt, "encrypt");
  const ct = await subtle().encrypt({ name: "AES-GCM", iv, additionalData: aad(meta) }, key, padded(JSON.stringify(body ?? {})));
  const rec: SyncRecord = { v: SYNC_VERSION, ...meta, salt: toB64url(salt), iv: toB64url(iv), ct: toB64url(ct) };
  if (rec.ct.length > SYNC_LIMITS.recordChars) throw new Error("The record is too big to sync.");
  return rec;
}

/**
 * Opens a record with the account key.
 *
 * @param rec - The record (checked with {@link parseSyncRecord} first).
 * @param accountKey - K for the record's `kid`.
 * @returns The body, or null for a tombstone; throws when it was changed, sealed with another key, or does not fit.
 */
export async function openRecord(rec: SyncRecord, accountKey: HubCryptoKey): Promise<SyncBody | null> {
  let plain: ArrayBuffer;
  try {
    const key = await recordKey(accountKey, fromB64url(rec.salt), "decrypt");
    plain = await subtle().decrypt({ name: "AES-GCM", iv: fromB64url(rec.iv), additionalData: aad(rec) }, key, fromB64url(rec.ct));
  } catch {
    throw new Error("The record could not be opened (changed, or sealed with another key).");
  }
  const parsed = JSON.parse(dec.decode(plain)) as unknown;
  if (rec.deleted) return null;
  const body = cleanSyncBody(parsed, rec.kind);
  if (!body) throw new Error("The record does not fit its kind.");
  if (rec.kind === "run" && !!rec.done !== TERMINAL_RUN_STATES.has((body as SyncRunBody).state)) throw new Error("The record's done flag does not match its state.");
  return body;
}

// ---- merging ----

/**
 * Whether revision `b` of a facet beats `a`: a higher `rev` wins; at equal `rev` the larger writer id wins, so every
 * device picks the same one without clocks.
 *
 * @param a - The revision kept now (undefined: none yet).
 * @param b - The one that came in.
 * @returns True when `b` should replace `a`.
 */
export function beats(a: Pick<SyncHead, "rev" | "writer"> | undefined, b: Pick<SyncHead, "rev" | "writer">): boolean {
  if (!a) return true;
  return b.rev > a.rev || (b.rev === a.rev && b.writer > a.writer);
}

/** A record as a device keeps it: the head and its opened body (null for a tombstone). */
export interface OpenedRecord {
  head: SyncHead;
  body: SyncBody | null;
}

/**
 * Picks what a device keeps for one facet when another revision comes in (from Drive or its own outbox).
 * Rules: a tombstone is final (so a stale device cannot bring a task back); a terminal run never goes back to a
 * going state, whatever its revision (a late `running` from a stale device must not hide a `done`); otherwise
 * {@link beats} decides.
 *
 * @param local - What the device has (undefined: nothing yet).
 * @param incoming - What came in (same id and kind).
 * @returns The one to keep.
 */
export function mergeRecord(local: OpenedRecord | undefined, incoming: OpenedRecord): OpenedRecord {
  if (!local) return incoming;
  if (local.head.id !== incoming.head.id || local.head.kind !== incoming.head.kind) throw new Error("Not the same record.");
  if (local.head.deleted || !beats(local.head, incoming.head)) return local;
  const was = local.body?.type === "run" ? local.body : undefined;
  const now = incoming.body?.type === "run" ? incoming.body : undefined;
  if (was && now && TERMINAL_RUN_STATES.has(was.state) && !TERMINAL_RUN_STATES.has(now.state)) return local;
  return incoming;
}

/**
 * Remembers the highest revision seen per facet and this device's Drive changes cursor, so a device notices when an
 * older revision shows up again (restored from Drive history, or a stale device) and knows where to pull from next.
 * Kept by the device next to its records.
 */
export class RevGuard {
  private revs = new Map<string, number>();
  /** This device's Drive `changes.list` page token (undefined: not synced yet, start with a full list). */
  changeToken: string | undefined;

  /**
   * Records one revision seen in Drive.
   *
   * @param rec - Its head.
   * @returns `ok`, or `rollback` when its revision is lower than one already seen (keep the local copy and warn).
   */
  see(rec: Pick<SyncHead, "id" | "kind" | "rev">): "ok" | "rollback" {
    const k = `${rec.kind}:${rec.id}`;
    const had = this.revs.get(k) ?? 0;
    if (rec.rev < had) return "rollback";
    this.revs.set(k, rec.rev);
    return "ok";
  }

  /**
   * The next revision this device writes for a facet.
   *
   * @param kind - The facet.
   * @param id - The record id.
   * @returns One above the highest seen.
   */
  nextRev(kind: SyncKind, id: string): number {
    return (this.revs.get(`${kind}:${id}`) ?? 0) + 1;
  }
}

// ---- Drive file names ----

/** The file-name prefix of record files (`r` + the format version). */
export const RECORD_FILE_PREFIX = `r${SYNC_VERSION}.`;
/** The file-name prefix of account-key files. */
export const KEY_FILE_PREFIX = "key.";
/** The flag letter at the end of a record file name: live, deleted (tombstone) or finished (a done run). */
const FLAG = { live: "l", deleted: "d", done: "f" } as const;

/**
 * Names the Drive file of one record revision: `r1.<kind>.<id>.<rev>.<writer>.<l|d|f>` (`d` a tombstone, `f` a
 * finished run). Ids and writers hold no dots, so the name splits back exactly. The name is the record's head; the
 * sealed content binds the same head, so a renamed file fails to open.
 *
 * @param head - The record's head.
 * @returns The file name; throws on a bad head.
 */
export function recordFileName(head: SyncHead): string {
  if (!SYNC_KINDS.includes(head.kind) || !ID_RE.test(head.id) || !WRITER_RE.test(head.writer) || !Number.isSafeInteger(head.rev) || head.rev < 1) throw new Error("Bad record head.");
  if (head.deleted && head.done) throw new Error("A tombstone is not a finished run.");
  const flag = head.deleted ? FLAG.deleted : head.done ? FLAG.done : FLAG.live;
  return `${RECORD_FILE_PREFIX}${head.kind}.${head.id}.${head.rev}.${head.writer}.${flag}`;
}

/**
 * Reads a record file name back into its head (untrusted: any file in the folder).
 *
 * @param name - The Drive file name.
 * @returns The head, or undefined when the name is not a valid record file name.
 */
export function parseRecordFileName(name: string): SyncHead | undefined {
  if (typeof name !== "string" || name.length > 220 || !name.startsWith(RECORD_FILE_PREFIX)) return undefined;
  const parts = name.slice(RECORD_FILE_PREFIX.length).split(".");
  if (parts.length !== 5) return undefined;
  const [kind, id, revText, writer, flag] = parts as [string, string, string, string, string];
  if (!oneOf(kind, SYNC_KINDS) || !ID_RE.test(id) || !WRITER_RE.test(writer) || !/^[1-9]\d{0,14}$/.test(revText)) return undefined;
  if (flag !== FLAG.live && flag !== FLAG.deleted && flag !== FLAG.done) return undefined;
  if (flag === FLAG.done && kind !== "run") return undefined;
  const head: SyncHead = { id, kind: kind as SyncKind, rev: Number(revText), writer };
  if (flag === FLAG.deleted) head.deleted = true;
  if (flag === FLAG.done) head.done = true;
  return head;
}

/**
 * The content of a record's file: the sealed part only (the head is the file name).
 *
 * @param rec - The sealed record.
 * @returns JSON text `{kid, salt, iv, ct}`.
 */
export function recordFileContent(rec: SyncRecord): string {
  return JSON.stringify({ kid: rec.kid, salt: rec.salt, iv: rec.iv, ct: rec.ct });
}

/**
 * Puts a record back together from its file name's head and its file content, with the shape checks of
 * {@link parseSyncRecord}. Open it with {@link openRecord} (which fails when the name was changed).
 *
 * @param head - From {@link parseRecordFileName}.
 * @param content - The file's text.
 * @returns The record, or undefined when the content does not fit.
 */
export function recordFromFile(head: SyncHead, content: string): SyncRecord | undefined {
  if (typeof content !== "string" || content.length > SYNC_LIMITS.recordChars + 256) return undefined;
  let x: unknown;
  try {
    x = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (!x || typeof x !== "object") return undefined;
  const { kid, salt, iv, ct } = x as Record<string, unknown>;
  return parseSyncRecord({ v: SYNC_VERSION, ...head, kid, salt, iv, ct });
}

/**
 * Names the Drive file that holds account key `kid`.
 *
 * @param kid - The key id (1 and up).
 * @returns `key.<kid>`.
 */
export function keyFileName(kid: number): string {
  if (!Number.isSafeInteger(kid) || kid < 1) throw new Error("kid starts at 1.");
  return `${KEY_FILE_PREFIX}${kid}`;
}

/**
 * Reads the key id from an account-key file name.
 *
 * @param name - The Drive file name.
 * @returns The key id, or undefined when it is not a key file name.
 */
export function parseKeyFileName(name: string): number | undefined {
  const m = typeof name === "string" ? /^key\.([1-9]\d{0,8})$/.exec(name) : null;
  return m ? Number(m[1]) : undefined;
}

// ---- the store ----

/** A file in the store, as listed: its Drive id, name and when it was created (ms since 1970; 0 when unknown). */
export interface DriveFileInfo {
  id: string;
  name: string;
  createdAt: number;
}

/** One page of a full listing. */
export interface DriveListPage {
  files: DriveFileInfo[];
  /** Pass to the next {@link DriveStore.list} call; absent on the last page. */
  nextPageToken?: string;
}

/** One entry of the changes feed: a file created (with its info) or removed (only its id). */
export interface DriveChange {
  fileId: string;
  removed: boolean;
  file?: DriveFileInfo;
}

/** One page of the changes feed. */
export interface DriveChangesPage {
  changes: DriveChange[];
  /** More pages follow: pass it to the next {@link DriveStore.changes} call. */
  nextPageToken?: string;
  /** The last page: save it as the device's `changeToken` for the next pull. */
  newStartPageToken?: string;
}

/**
 * Where records are kept: the app's hidden folder in the owner's Google Drive, or a fake in tests. Files are only
 * created, read and deleted, never updated. Implemented over REST in `drive-sync.ts`.
 */
export interface DriveStore {
  /**
   * Lists the folder's files, one page at a time.
   *
   * @param pageToken - From the previous page (none: the first page).
   * @param prefix - Only names starting with this (letters, digits, dots, `_` and `-`).
   */
  list(pageToken?: string, prefix?: string): Promise<DriveListPage>;
  /** The changes-feed position of now (read it before a full listing, so nothing written meanwhile is missed). */
  startToken(): Promise<string>;
  /**
   * Reads one page of the changes feed.
   *
   * @param pageToken - The saved `changeToken`, or a `nextPageToken`.
   */
  changes(pageToken: string): Promise<DriveChangesPage>;
  /**
   * Makes ids for files not created yet, so a retried create cannot make a second file.
   *
   * @param count - How many.
   */
  newIds(count: number): Promise<string[]>;
  /**
   * Creates a file (a retry with the same id after a lost answer is not an error).
   *
   * @param name - Its name.
   * @param content - Its text.
   * @param id - An id from {@link DriveStore.newIds}.
   */
  create(name: string, content: string, id?: string): Promise<DriveFileInfo>;
  /**
   * Reads a file's text.
   *
   * @param id - The file id.
   */
  read(id: string): Promise<string>;
  /**
   * Deletes a file for good (a file already gone is not an error).
   *
   * @param id - The file id.
   */
  delete(id: string): Promise<void>;
}
