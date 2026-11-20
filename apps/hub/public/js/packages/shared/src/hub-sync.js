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
import { fromB64url, randomB64url, toB64url } from "./hub-crypto.js";
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
};
export const SYNC_KINDS = ["task", "run", "meta", "agent"];
/** Kinds only their first writer may change (anyone may still delete them). `meta` is shared. */
export const SINGLE_WRITER_KINDS = new Set(["task", "run", "agent"]);
const RUN_STATES = ["outbox", "waiting", "waiting-run", "running", "done", "partial", "failed", "blocked", "cancelled"];
/** States a run stays in for good. */
export const TERMINAL_RUN_STATES = new Set(["done", "partial", "failed", "blocked", "cancelled"]);
const ORIGINS = ["phone", "pc", "page", "inbox-claude", "inbox-roee", "self-work"];
const AGENT_SOURCES = ["chat-helper", "inbox", "antigravity", "claude-cloud"];
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
export function newAccountKeyBytes() {
    return globalThis.crypto.getRandomValues(new Uint8Array(32));
}
/**
 * Reads K for sealing and opening records. The key is not extractable.
 *
 * @param raw - The 32 key bytes.
 * @returns An HKDF key (each record's AES key is derived from it).
 */
export async function importAccountKey(raw) {
    if (raw.length !== 32)
        throw new Error("An account key is 32 bytes.");
    return subtle().importKey("raw", raw, "HKDF", false, ["deriveKey"]);
}
// ---- shape checks ----
const str = (v, max) => (typeof v === "string" ? v : "").slice(0, max);
const optStr = (v, max) => (typeof v === "string" && v ? v.slice(0, max) : undefined);
const oneOf = (v, list) => (list.includes(v) ? v : undefined);
const posInt = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
/**
 * Checks a record's shape from untrusted input (a file read from Drive). Does not open it.
 *
 * @param x - The value.
 * @returns The record with only its known fields, or undefined when it does not fit.
 */
export function parseSyncRecord(x) {
    if (!x || typeof x !== "object")
        return undefined;
    const r = x;
    if (r.v !== SYNC_VERSION || typeof r.id !== "string" || !ID_RE.test(r.id) || !oneOf(r.kind, SYNC_KINDS))
        return undefined;
    if (!posInt(r.rev) || r.rev < 1 || typeof r.writer !== "string" || !WRITER_RE.test(r.writer) || !posInt(r.kid) || r.kid < 1)
        return undefined;
    for (const k of ["salt", "iv", "ct"])
        if (typeof r[k] !== "string" || !B64_RE.test(r[k]))
            return undefined;
    if (r.salt.length !== 22 || r.iv.length !== 16 || r.ct.length > SYNC_LIMITS.recordChars)
        return undefined;
    if ((r.deleted !== undefined && typeof r.deleted !== "boolean") || (r.done !== undefined && typeof r.done !== "boolean"))
        return undefined;
    const rec = { v: SYNC_VERSION, id: r.id, kind: r.kind, rev: r.rev, writer: r.writer, kid: r.kid, salt: r.salt, iv: r.iv, ct: r.ct };
    if (r.deleted)
        rec.deleted = true;
    if (r.done)
        rec.done = true;
    return rec;
}
/**
 * Cleans an opened body: unknown fields go, texts are cut to their limits, and it must fit the record's kind.
 *
 * @param x - The parsed plain text.
 * @param kind - The record's kind.
 * @returns The body, or undefined when it does not fit.
 */
export function cleanSyncBody(x, kind) {
    if (!x || typeof x !== "object")
        return undefined;
    const b = x;
    if (b.type !== kind)
        return undefined;
    const out = (() => {
        switch (kind) {
            case "task": {
                const origin = oneOf(b.origin, ORIGINS);
                if (!origin || typeof b.title !== "string")
                    return undefined;
                return { type: "task", title: str(b.title, 200), spec: str(b.spec, 8000), origin, executor: str(b.executor, 40), createdAt: str(b.createdAt, 40), ...opt("target", optStr(b.target, 64)), ...opt("risk", optStr(b.risk, 20)) };
            }
            case "run": {
                const state = oneOf(b.state, RUN_STATES);
                if (!state)
                    return undefined;
                const timeline = Array.isArray(b.timeline)
                    ? b.timeline.slice(-SYNC_LIMITS.timeline).flatMap((e) => (e && typeof e === "object" ? [{ at: str(e.at, 40), line: str(e.line, 300) }] : []))
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
                if (!source || typeof b.title !== "string")
                    return undefined;
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
    return out;
}
/** `{ [k]: v }` when v is set, else `{}` (keeps optional fields absent rather than undefined). */
function opt(k, v) {
    return (v === undefined ? {} : { [k]: v });
}
// ---- sealing ----
/** The authenticated data: every field the store sees and could otherwise change. */
function aad(r) {
    return enc.encode(`kesher-sync v${SYNC_VERSION}|${r.kid}|${r.id}|${r.kind}|${r.rev}|${r.deleted ? 1 : 0}|${r.done ? 1 : 0}|${r.writer}`);
}
/** The AES key of one record write. */
async function recordKey(accountKey, salt, use) {
    return subtle().deriveKey({ name: "HKDF", hash: "SHA-256", salt, info: INFO }, accountKey, { name: "AES-GCM", length: 256 }, false, [use]);
}
/** Plain text padded with spaces to the next {@link SYNC_LIMITS.padBytes} (JSON ignores trailing spaces). */
function padded(text) {
    const bytes = enc.encode(text);
    const size = Math.ceil((bytes.length + 1) / SYNC_LIMITS.padBytes) * SYNC_LIMITS.padBytes;
    const out = new Uint8Array(size).fill(0x20);
    out.set(bytes);
    return out;
}
/**
 * Seals one revision of a record under the account key.
 *
 * @param head - Id, kind, revision, writer and key id.
 * @param body - The content (its type must be the kind), or null for a tombstone.
 * @param accountKey - K, from {@link importAccountKey}.
 * @returns The sealed record (store it with {@link recordFileName} and {@link recordFileContent}).
 */
export async function sealRecord(head, body, accountKey) {
    if (body && body.type !== head.kind)
        throw new Error(`A ${head.kind} record cannot hold a ${body.type}.`);
    if (!Number.isSafeInteger(head.rev) || head.rev < 1 || !Number.isSafeInteger(head.kid) || head.kid < 1)
        throw new Error("rev and kid start at 1.");
    const id = head.id ?? randomB64url(16);
    if (!ID_RE.test(id) || !WRITER_RE.test(head.writer))
        throw new Error("Bad record id or writer.");
    const deleted = body === null;
    const done = body?.type === "run" && TERMINAL_RUN_STATES.has(body.state);
    const meta = { id, kind: head.kind, rev: head.rev, writer: head.writer, kid: head.kid, ...(deleted ? { deleted } : {}), ...(done ? { done } : {}) };
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const key = await recordKey(accountKey, salt, "encrypt");
    const ct = await subtle().encrypt({ name: "AES-GCM", iv, additionalData: aad(meta) }, key, padded(JSON.stringify(body ?? {})));
    const rec = { v: SYNC_VERSION, ...meta, salt: toB64url(salt), iv: toB64url(iv), ct: toB64url(ct) };
    if (rec.ct.length > SYNC_LIMITS.recordChars)
        throw new Error("The record is too big to sync.");
    return rec;
}
/**
 * Opens a record with the account key.
 *
 * @param rec - The record (checked with {@link parseSyncRecord} first).
 * @param accountKey - K for the record's `kid`.
 * @returns The body, or null for a tombstone; throws when it was changed, sealed with another key, or does not fit.
 */
export async function openRecord(rec, accountKey) {
    let plain;
    try {
        const key = await recordKey(accountKey, fromB64url(rec.salt), "decrypt");
        plain = await subtle().decrypt({ name: "AES-GCM", iv: fromB64url(rec.iv), additionalData: aad(rec) }, key, fromB64url(rec.ct));
    }
    catch {
        throw new Error("The record could not be opened (changed, or sealed with another key).");
    }
    const parsed = JSON.parse(dec.decode(plain));
    if (rec.deleted)
        return null;
    const body = cleanSyncBody(parsed, rec.kind);
    if (!body)
        throw new Error("The record does not fit its kind.");
    if (rec.kind === "run" && !!rec.done !== TERMINAL_RUN_STATES.has(body.state))
        throw new Error("The record's done flag does not match its state.");
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
export function beats(a, b) {
    if (!a)
        return true;
    return b.rev > a.rev || (b.rev === a.rev && b.writer > a.writer);
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
export function mergeRecord(local, incoming) {
    if (!local)
        return incoming;
    if (local.head.id !== incoming.head.id || local.head.kind !== incoming.head.kind)
        throw new Error("Not the same record.");
    if (local.head.deleted || !beats(local.head, incoming.head))
        return local;
    const was = local.body?.type === "run" ? local.body : undefined;
    const now = incoming.body?.type === "run" ? incoming.body : undefined;
    if (was && now && TERMINAL_RUN_STATES.has(was.state) && !TERMINAL_RUN_STATES.has(now.state))
        return local;
    return incoming;
}
/**
 * Remembers the highest revision seen per facet and this device's Drive changes cursor, so a device notices when an
 * older revision shows up again (restored from Drive history, or a stale device) and knows where to pull from next.
 * Kept by the device next to its records.
 */
export class RevGuard {
    revs = new Map();
    /** This device's Drive `changes.list` page token (undefined: not synced yet, start with a full list). */
    changeToken;
    /**
     * Records one revision seen in Drive.
     *
     * @param rec - Its head.
     * @returns `ok`, or `rollback` when its revision is lower than one already seen (keep the local copy and warn).
     */
    see(rec) {
        const k = `${rec.kind}:${rec.id}`;
        const had = this.revs.get(k) ?? 0;
        if (rec.rev < had)
            return "rollback";
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
    nextRev(kind, id) {
        return (this.revs.get(`${kind}:${id}`) ?? 0) + 1;
    }
}
// ---- Drive file names ----
/** The file-name prefix of record files (`r` + the format version). */
export const RECORD_FILE_PREFIX = `r${SYNC_VERSION}.`;
/** The file-name prefix of account-key files. */
export const KEY_FILE_PREFIX = "key.";
/** The flag letter at the end of a record file name: live, deleted (tombstone) or finished (a done run). */
const FLAG = { live: "l", deleted: "d", done: "f" };
/**
 * Names the Drive file of one record revision: `r1.<kind>.<id>.<rev>.<writer>.<l|d|f>` (`d` a tombstone, `f` a
 * finished run). Ids and writers hold no dots, so the name splits back exactly. The name is the record's head; the
 * sealed content binds the same head, so a renamed file fails to open.
 *
 * @param head - The record's head.
 * @returns The file name; throws on a bad head.
 */
export function recordFileName(head) {
    if (!SYNC_KINDS.includes(head.kind) || !ID_RE.test(head.id) || !WRITER_RE.test(head.writer) || !Number.isSafeInteger(head.rev) || head.rev < 1)
        throw new Error("Bad record head.");
    if (head.deleted && head.done)
        throw new Error("A tombstone is not a finished run.");
    const flag = head.deleted ? FLAG.deleted : head.done ? FLAG.done : FLAG.live;
    return `${RECORD_FILE_PREFIX}${head.kind}.${head.id}.${head.rev}.${head.writer}.${flag}`;
}
/**
 * Reads a record file name back into its head (untrusted: any file in the folder).
 *
 * @param name - The Drive file name.
 * @returns The head, or undefined when the name is not a valid record file name.
 */
export function parseRecordFileName(name) {
    if (typeof name !== "string" || name.length > 220 || !name.startsWith(RECORD_FILE_PREFIX))
        return undefined;
    const parts = name.slice(RECORD_FILE_PREFIX.length).split(".");
    if (parts.length !== 5)
        return undefined;
    const [kind, id, revText, writer, flag] = parts;
    if (!oneOf(kind, SYNC_KINDS) || !ID_RE.test(id) || !WRITER_RE.test(writer) || !/^[1-9]\d{0,14}$/.test(revText))
        return undefined;
    if (flag !== FLAG.live && flag !== FLAG.deleted && flag !== FLAG.done)
        return undefined;
    if (flag === FLAG.done && kind !== "run")
        return undefined;
    const head = { id, kind: kind, rev: Number(revText), writer };
    if (flag === FLAG.deleted)
        head.deleted = true;
    if (flag === FLAG.done)
        head.done = true;
    return head;
}
/**
 * The content of a record's file: the sealed part only (the head is the file name).
 *
 * @param rec - The sealed record.
 * @returns JSON text `{kid, salt, iv, ct}`.
 */
export function recordFileContent(rec) {
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
export function recordFromFile(head, content) {
    if (typeof content !== "string" || content.length > SYNC_LIMITS.recordChars + 256)
        return undefined;
    let x;
    try {
        x = JSON.parse(content);
    }
    catch {
        return undefined;
    }
    if (!x || typeof x !== "object")
        return undefined;
    const { kid, salt, iv, ct } = x;
    return parseSyncRecord({ v: SYNC_VERSION, ...head, kid, salt, iv, ct });
}
/**
 * Names the Drive file that holds account key `kid`.
 *
 * @param kid - The key id (1 and up).
 * @returns `key.<kid>`.
 */
export function keyFileName(kid) {
    if (!Number.isSafeInteger(kid) || kid < 1)
        throw new Error("kid starts at 1.");
    return `${KEY_FILE_PREFIX}${kid}`;
}
/**
 * Reads the key id from an account-key file name.
 *
 * @param name - The Drive file name.
 * @returns The key id, or undefined when it is not a key file name.
 */
export function parseKeyFileName(name) {
    const m = typeof name === "string" ? /^key\.([1-9]\d{0,8})$/.exec(name) : null;
    return m ? Number(m[1]) : undefined;
}
