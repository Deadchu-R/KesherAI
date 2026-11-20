/**
 * Tasks sync through the owner's own Google Drive (docs/RESEARCH_LOG.md, "Tasks in Roee's Google Drive instead of
 * the hub", 2026-11-20).
 *
 * - {@link DriveRest}: the {@link DriveStore} over Drive v3 REST, only in the app's hidden `appDataFolder` (scope
 *   `drive.appdata`), with `fetch` only, so it runs in Node (core), a browser page and the phone's WebView. The access
 *   token comes from an injected getter and is never stored or logged here.
 * - {@link ensureAccountKey}: reads the account key K from its `key.<kid>` file, or creates it on the first device.
 * - {@link DriveSync}: the sync loop of one device: pull (full listing once, then the changes feed), write (sealed,
 *   create-only, through an outbox that survives being offline) and compaction.
 *
 * Merging is idempotent, so a replayed or overlapping page is harmless; a removed file in the feed is compaction, not
 * the deletion of a task (that is a tombstone revision).
 */
import { fromB64url, randomB64url, toB64url, type HubCryptoKey } from "./hub-crypto.js";
import {
  beats,
  importAccountKey,
  keyFileName,
  KEY_FILE_PREFIX,
  mergeRecord,
  newAccountKeyBytes,
  openRecord,
  parseKeyFileName,
  parseRecordFileName,
  RECORD_FILE_PREFIX,
  recordFileContent,
  recordFileName,
  recordFromFile,
  sealRecord,
  SINGLE_WRITER_KINDS,
  SYNC_LIMITS,
  type DriveChangesPage,
  type DriveFileInfo,
  type DriveListPage,
  type DriveStore,
  type OpenedRecord,
  type SyncBody,
  type SyncHead,
  type SyncKind,
} from "./hub-sync.js";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
/** Drive file ids, page tokens and generated ids are short and URL-safe; anything else is refused. */
const DRIVE_ID_RE = /^[\w-]{1,200}$/;
const TOKEN_RE = /^[\w.~-]{1,500}$/;
/** 403 reasons that mean "slow down" rather than "not allowed". */
const RATE_REASONS = new Set(["userRateLimitExceeded", "rateLimitExceeded"]);

// ---- REST ----

/** A Drive call that failed. `status` 0 means no answer (offline). The access token is never part of it. */
export class DriveError extends Error {
  /**
   * @param status - HTTP status, or 0 when the request did not get through.
   * @param reason - Drive's reason, or a short local one.
   */
  constructor(
    /** HTTP status, or 0 when the request did not get through. */
    readonly status: number,
    /** Drive's reason (`notFound`, `rateLimitExceeded`, ...) or a short local one. */
    readonly reason: string,
  ) {
    super(`Google Drive: ${status || "no connection"} ${reason}`.trim());
    this.name = "DriveError";
  }

  /** The request itself is wrong (retrying the same one cannot help). */
  get permanent(): boolean {
    return this.status === 400 || this.status === 413;
  }
}

/**
 * Gives a Google access token with the `drive.appdata` scope.
 *
 * @param opts - `refresh: true` after Drive refused the last token (401): get a fresh one.
 */
export type DriveTokenGetter = (opts: { refresh: boolean }) => Promise<string>;

/** Options of {@link DriveRest}. */
export interface DriveRestOptions {
  /** Where the access token comes from (core's Google sign-in, the Android plugin, or the page's token client). */
  token: DriveTokenGetter;
  /** The fetch to use (tests pass a fake). */
  fetch?: typeof fetch;
  /** Waits between retries (tests pass one that does not wait). */
  sleep?: (ms: number) => Promise<void>;
  /** 0..1 jitter source. */
  random?: () => number;
  /** Tries per call on 429, 5xx and rate-limit 403 (default 6). */
  tries?: number;
}

/** Reads Drive's error reason from a failed answer (short, never the body as a whole). */
async function errorReason(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: { errors?: { reason?: unknown }[]; status?: unknown } };
    const r = j.error?.errors?.[0]?.reason ?? j.error?.status;
    return typeof r === "string" ? r.slice(0, 60) : "";
  } catch {
    return "";
  }
}

/** A file from a Drive answer, or undefined when it does not look like one. */
function fileInfo(x: unknown): DriveFileInfo | undefined {
  if (!x || typeof x !== "object") return undefined;
  const f = x as Record<string, unknown>;
  if (typeof f.id !== "string" || !DRIVE_ID_RE.test(f.id) || typeof f.name !== "string") return undefined;
  const at = typeof f.createdTime === "string" ? Date.parse(f.createdTime) : NaN;
  return { id: f.id, name: f.name.slice(0, 300), createdAt: Number.isFinite(at) ? at : 0 };
}

const pageToken = (x: unknown): string | undefined => (typeof x === "string" && TOKEN_RE.test(x) ? x : undefined);

/**
 * The {@link DriveStore} over Google Drive v3 REST, kept to the app's hidden `appDataFolder`. Retries 429, 5xx and
 * rate-limit 403 with truncated exponential backoff (min(2^n s + jitter, 32 s)), and asks for a fresh token once on 401.
 */
export class DriveRest implements DriveStore {
  private readonly token: DriveTokenGetter;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly tries: number;

  /**
   * @param opts - The token getter and, for tests, fetch, sleep and jitter.
   */
  constructor(opts: DriveRestOptions) {
    this.token = opts.token;
    this.fetchFn = opts.fetch ?? ((...a) => globalThis.fetch(...a));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.tries = Math.max(1, opts.tries ?? 6);
  }

  /** One authorized call with backoff. Throws {@link DriveError}. */
  private async call(method: string, url: string, body?: string, contentType?: string): Promise<Response> {
    let refresh = false;
    let refreshed = false;
    for (let n = 0; ; n++) {
      const headers: Record<string, string> = { authorization: `Bearer ${await this.token({ refresh })}` };
      if (contentType) headers["content-type"] = contentType;
      refresh = false;
      let res: Response;
      try {
        res = await this.fetchFn(url, { method, headers, body });
      } catch {
        throw new DriveError(0, "offline");
      }
      if (res.ok) return res;
      const reason = await errorReason(res);
      if (res.status === 401 && !refreshed) {
        refresh = refreshed = true;
        n--;
        continue;
      }
      const retry = res.status === 429 || res.status >= 500 || (res.status === 403 && RATE_REASONS.has(reason));
      if (!retry || n + 1 >= this.tries) throw new DriveError(res.status, reason);
      await this.sleep(Math.min(2 ** n * 1000 + this.random() * 1000, 32_000));
    }
  }

  private async json(method: string, url: string): Promise<Record<string, unknown>> {
    const j = (await (await this.call(method, url)).json()) as unknown;
    if (!j || typeof j !== "object") throw new DriveError(502, "badAnswer");
    return j as Record<string, unknown>;
  }

  /** {@inheritDoc DriveStore.list} */
  async list(token?: string, prefix?: string): Promise<DriveListPage> {
    if (prefix !== undefined && !/^[\w.-]{0,40}$/.test(prefix)) throw new Error("Bad name prefix.");
    const q = new URLSearchParams({ spaces: "appDataFolder", pageSize: String(SYNC_LIMITS.driveListPage), fields: "nextPageToken,files(id,name,createdTime)" });
    if (token !== undefined) q.set("pageToken", checkToken(token));
    const j = await this.json("GET", `${API}/files?${q}`);
    const files = (Array.isArray(j.files) ? j.files : []).flatMap((f: unknown) => fileInfo(f) ?? []).filter((f) => !prefix || f.name.startsWith(prefix));
    const next = pageToken(j.nextPageToken);
    return next ? { files, nextPageToken: next } : { files };
  }

  /** {@inheritDoc DriveStore.startToken} */
  async startToken(): Promise<string> {
    const t = pageToken((await this.json("GET", `${API}/changes/startPageToken`)).startPageToken);
    if (!t) throw new DriveError(502, "badAnswer");
    return t;
  }

  /** {@inheritDoc DriveStore.changes} */
  async changes(token: string): Promise<DriveChangesPage> {
    const q = new URLSearchParams({
      pageToken: checkToken(token),
      spaces: "appDataFolder",
      pageSize: String(SYNC_LIMITS.driveListPage),
      includeRemoved: "true",
      fields: "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,name,createdTime))",
    });
    const j = await this.json("GET", `${API}/changes?${q}`);
    const changes = (Array.isArray(j.changes) ? j.changes : []).flatMap((c: unknown) => {
      if (!c || typeof c !== "object") return [];
      const r = c as Record<string, unknown>;
      if (typeof r.fileId !== "string" || !DRIVE_ID_RE.test(r.fileId)) return [];
      const file = r.removed === true ? undefined : fileInfo(r.file);
      return [{ fileId: r.fileId, removed: r.removed === true, ...(file ? { file } : {}) }];
    });
    const next = pageToken(j.nextPageToken);
    const start = pageToken(j.newStartPageToken);
    if (!next && !start) throw new DriveError(502, "badAnswer");
    return { changes, ...(next ? { nextPageToken: next } : {}), ...(start ? { newStartPageToken: start } : {}) };
  }

  /** {@inheritDoc DriveStore.newIds} */
  async newIds(count: number): Promise<string[]> {
    const n = Math.min(1000, Math.max(1, Math.floor(count)));
    const j = await this.json("GET", `${API}/files/generateIds?${new URLSearchParams({ count: String(n), space: "appDataFolder", type: "files" })}`);
    const ids = (Array.isArray(j.ids) ? j.ids : []).filter((x): x is string => typeof x === "string" && DRIVE_ID_RE.test(x));
    if (!ids.length) throw new DriveError(502, "badAnswer");
    return ids;
  }

  /** {@inheritDoc DriveStore.create} */
  async create(name: string, content: string, id?: string): Promise<DriveFileInfo> {
    if (id !== undefined) checkId(id);
    const boundary = `kesher-${randomB64url(18)}`;
    const meta = JSON.stringify({ name, parents: ["appDataFolder"], mimeType: "application/json", ...(id ? { id } : {}) });
    const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
    try {
      const res = await this.call("POST", `${UPLOAD}/files?uploadType=multipart&fields=id,name,createdTime`, body, `multipart/related; boundary=${boundary}`);
      const f = fileInfo(await res.json());
      if (!f) throw new DriveError(502, "badAnswer");
      return f;
    } catch (e) {
      // The same id again: an earlier try got through and only its answer was lost.
      if (!(id && e instanceof DriveError && e.status === 409)) throw e;
      const f = fileInfo(await this.json("GET", `${API}/files/${encodeURIComponent(id)}?fields=id,name,createdTime`));
      if (!f || f.name !== name) throw e;
      return f;
    }
  }

  /** {@inheritDoc DriveStore.read} */
  async read(id: string): Promise<string> {
    return (await this.call("GET", `${API}/files/${encodeURIComponent(checkId(id))}?alt=media`)).text();
  }

  /** {@inheritDoc DriveStore.delete} */
  async delete(id: string): Promise<void> {
    try {
      await this.call("DELETE", `${API}/files/${encodeURIComponent(checkId(id))}`);
    } catch (e) {
      if (!(e instanceof DriveError && e.status === 404)) throw e;
    }
  }
}

function checkId(id: string): string {
  if (!DRIVE_ID_RE.test(id)) throw new Error("Bad Drive file id.");
  return id;
}

function checkToken(t: string): string {
  if (!TOKEN_RE.test(t)) throw new Error("Bad Drive page token.");
  return t;
}

/** Every file of the folder whose name starts with `prefix`, all pages. */
async function listAll(drive: DriveStore, prefix: string): Promise<DriveFileInfo[]> {
  const out: DriveFileInfo[] = [];
  let token: string | undefined;
  do {
    const page = await drive.list(token, prefix);
    out.push(...page.files.filter((f) => f.name.startsWith(prefix)));
    token = page.nextPageToken;
  } while (token);
  return out;
}

// ---- the account key ----

/** The account keys found in Drive: the newest key id (used for new writes) and the bytes of each. */
export interface AccountKeys {
  kid: number;
  raw: Map<number, Uint8Array<ArrayBuffer>>;
}

/** The content of a `key.<kid>` file (option (a): K readable by the owner's signed-in devices; a recovery-code wrap comes later). */
function keyFileContent(kid: number, raw: Uint8Array): string {
  return JSON.stringify({ v: 1, kid, k: toB64url(raw) });
}

function parseKeyFile(kid: number, text: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    const j = JSON.parse(text) as { v?: unknown; kid?: unknown; k?: unknown };
    if (j.v !== 1 || j.kid !== kid || typeof j.k !== "string") return undefined;
    const raw = fromB64url(j.k);
    return raw.length === 32 ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Earliest created first, then the smaller id: every device picks the same file of one key id. */
const firstFile = (a: DriveFileInfo, b: DriveFileInfo): number => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Reads the account keys from the folder, or creates key 1 when there is none (the first device). When two devices
 * create key 1 at the same time, both keep the earliest file and the other one is deleted, so they agree on K before
 * either writes a record.
 *
 * @param drive - The store.
 * @returns The newest key id and every key's bytes; throws when no key file can be read.
 */
export async function ensureAccountKey(drive: DriveStore): Promise<AccountKeys> {
  let files = await listAll(drive, KEY_FILE_PREFIX);
  if (!files.some((f) => parseKeyFileName(f.name) !== undefined)) {
    const mine = await drive.create(keyFileName(1), keyFileContent(1, newAccountKeyBytes()));
    files = await listAll(drive, KEY_FILE_PREFIX);
    if (!files.some((f) => f.id === mine.id)) files.push(mine);
    const ones = files.filter((f) => f.name === keyFileName(1)).sort(firstFile);
    if (ones[0]!.id !== mine.id) await drive.delete(mine.id).catch(() => undefined);
  }
  const byKid = new Map<number, DriveFileInfo>();
  for (const f of files.sort(firstFile)) {
    const kid = parseKeyFileName(f.name);
    if (kid !== undefined && !byKid.has(kid)) byKid.set(kid, f);
  }
  const raw = new Map<number, Uint8Array<ArrayBuffer>>();
  for (const [kid, f] of byKid) {
    const k = parseKeyFile(kid, await drive.read(f.id));
    if (k) raw.set(kid, k);
  }
  if (!raw.size) throw new Error("The account key in Google Drive could not be read.");
  return { kid: Math.max(...raw.keys()), raw };
}

// ---- the sync loop ----

/** A record as this device keeps it, with the Drive file it came from (none yet while it waits in the outbox). */
export interface StoredRecord extends OpenedRecord {
  file?: string;
}

/** A write waiting to reach Drive. `fileId` is reserved before the first try, so a retry never makes a second file. */
export interface OutboxItem {
  name: string;
  content: string;
  fileId?: string;
}

/** Everything a device keeps between runs (plain JSON; the caller stores it in the device's own storage). */
export interface DriveSyncState {
  /** The changes-feed cursor (none: next pull lists the whole folder). */
  changeToken?: string;
  /** Record files known in Drive, by file id: their name (the head) and creation time. */
  files: Record<string, { name: string; at: number }>;
  /** The winning revision of each facet, by `kind:id`. */
  records: Record<string, StoredRecord>;
  /** Writes not yet in Drive, oldest first. */
  outbox: OutboxItem[];
}

/** Options of {@link DriveSync}. */
export interface DriveSyncOptions {
  drive: DriveStore;
  /** This device's writer id. */
  writer: string;
  /** The account keys (from {@link ensureAccountKey}). */
  keys: AccountKeys;
  /** What was saved last time (none: a new device). */
  state?: DriveSyncState;
  /** Stores the state after each change. */
  save?: (state: DriveSyncState) => void | Promise<void>;
  /** A facet changed (`rec` undefined: it was forgotten by compaction). */
  onChange?: (key: { id: string; kind: SyncKind }, rec: StoredRecord | undefined) => void;
  /** Something was skipped (a file that does not open, an unknown key id, a dropped write). Never holds secrets. */
  onWarn?: (message: string) => void;
  /** The clock (ms), for compaction. */
  now?: () => number;
}

/** What {@link DriveSync.flush} did. */
export interface FlushResult {
  sent: number;
  pending: number;
  /** Why it stopped early (offline, token, quota): show "Reconnect Drive" or retry later. */
  error?: DriveError;
}

const facetKey = (kind: SyncKind, id: string): string => `${kind}:${id}`;
const headOfName = (name: string): SyncHead | undefined => (name.startsWith(RECORD_FILE_PREFIX) ? parseRecordFileName(name) : undefined);

/**
 * One device's sync with the records in Drive. Call {@link DriveSync.pull} on start, every
 * {@link SYNC_LIMITS.pollMs} while the app is open, on focus and on a hub `sync` ping; {@link DriveSync.write} for each
 * change; {@link DriveSync.flush} when back online; {@link DriveSync.compact} now and then (any device, idempotent).
 */
export class DriveSync {
  private readonly drive: DriveStore;
  private readonly writer: string;
  private readonly opts: DriveSyncOptions;
  private keys = new Map<number, HubCryptoKey>();
  private readonly kid: number;
  /** The state (mutated in place, saved through `save`). */
  readonly state: DriveSyncState;
  private flushing: Promise<FlushResult> | undefined;

  private constructor(opts: DriveSyncOptions) {
    this.opts = opts;
    this.drive = opts.drive;
    this.writer = opts.writer;
    this.kid = opts.keys.kid;
    const s = opts.state;
    this.state = { files: { ...s?.files }, records: { ...s?.records }, outbox: [...(s?.outbox ?? [])], ...(s?.changeToken ? { changeToken: s.changeToken } : {}) };
  }

  /**
   * Makes a device's sync (imports its keys).
   *
   * @param opts - The store, writer id, keys, saved state and callbacks.
   * @returns The sync, not pulled yet.
   */
  static async create(opts: DriveSyncOptions): Promise<DriveSync> {
    const s = new DriveSync(opts);
    for (const [kid, raw] of opts.keys.raw) s.keys.set(kid, await importAccountKey(raw));
    if (!s.keys.has(s.kid)) throw new Error("The newest account key is missing.");
    return s;
  }

  /** Every record this device has (winning revisions, tombstones included). */
  records(): StoredRecord[] {
    return Object.values(this.state.records);
  }

  private async save(): Promise<void> {
    await this.opts.save?.(this.state);
  }

  private warn(message: string): void {
    this.opts.onWarn?.(message);
  }

  /**
   * Brings in what other devices wrote: the whole folder on the first run (or when the cursor was refused), then only
   * the changes feed. Downloads only each facet's winning revision, and only when it beats what this device has.
   *
   * @returns How many facets changed.
   */
  async pull(): Promise<number> {
    if (!this.state.changeToken) await this.fullScan();
    else {
      try {
        await this.readChanges(this.state.changeToken);
      } catch (e) {
        if (!(e instanceof DriveError && [400, 404, 410].includes(e.status))) throw e;
        this.warn("Drive refused the saved sync position; reading the whole folder again.");
        delete this.state.changeToken;
        await this.fullScan();
      }
    }
    const changed = await this.applyWinners();
    await this.save();
    return changed;
  }

  /** Lists the whole folder (the cursor is read first, so a file written meanwhile is not missed). */
  private async fullScan(): Promise<void> {
    const token = await this.drive.startToken();
    const files: DriveSyncState["files"] = {};
    for (const f of await listAll(this.drive, RECORD_FILE_PREFIX)) if (headOfName(f.name)) files[f.id] = { name: f.name, at: f.createdAt };
    this.state.files = files;
    this.state.changeToken = token;
  }

  /** Follows the changes feed to its end and saves the new cursor. */
  private async readChanges(start: string): Promise<void> {
    let token = start;
    for (;;) {
      const page = await this.drive.changes(token);
      for (const c of page.changes) {
        if (c.removed) delete this.state.files[c.fileId];
        else if (c.file && headOfName(c.file.name)) this.state.files[c.fileId] = { name: c.file.name, at: c.file.createdAt };
      }
      if (page.newStartPageToken) {
        this.state.changeToken = page.newStartPageToken;
        return;
      }
      token = page.nextPageToken!;
    }
  }

  /** The files of each facet, the winner first. */
  private facets(): Map<string, { id: string; head: SyncHead; at: number }[]> {
    const out = new Map<string, { id: string; head: SyncHead; at: number }[]>();
    for (const [id, f] of Object.entries(this.state.files)) {
      const head = headOfName(f.name);
      if (!head) continue;
      const k = facetKey(head.kind, head.id);
      const list = out.get(k) ?? [];
      list.push({ id, head, at: f.at });
      out.set(k, list);
    }
    for (const list of out.values()) list.sort((a, b) => (beats(a.head, b.head) ? 1 : beats(b.head, a.head) ? -1 : 0));
    return out;
  }

  /** Downloads and merges each facet's winning revision when it is new to this device. */
  private async applyWinners(): Promise<number> {
    let changed = 0;
    for (const [k, list] of this.facets()) {
      const win = list[0]!;
      const local = this.state.records[k];
      if (local && (local.file === win.id || local.head.deleted || !beats(local.head, win.head))) continue;
      let text: string;
      try {
        text = await this.drive.read(win.id);
      } catch (e) {
        if (e instanceof DriveError && e.status === 404) {
          delete this.state.files[win.id];
          continue;
        }
        throw e;
      }
      const rec = recordFromFile(win.head, text);
      const key = rec && this.keys.get(rec.kid);
      if (!rec || !key) {
        this.warn(`Skipped a synced record that does not fit or has an unknown key (${win.head.kind}).`);
        continue;
      }
      let body: SyncBody | null;
      try {
        body = await openRecord(rec, key);
      } catch {
        this.warn(`Skipped a synced record that could not be opened (${win.head.kind}).`);
        continue;
      }
      const merged = mergeRecord(local, { head: win.head, body });
      if (merged === local) continue;
      this.state.records[k] = { head: win.head, body, file: win.id };
      changed++;
      this.opts.onChange?.({ id: win.head.id, kind: win.head.kind }, this.state.records[k]);
    }
    return changed;
  }

  /**
   * The next revision this device writes for a facet: one above any it knows of (its own record and every file).
   *
   * @param kind - The facet.
   * @param id - The record id.
   */
  nextRev(kind: SyncKind, id: string): number {
    let rev = this.state.records[facetKey(kind, id)]?.head.rev ?? 0;
    for (const f of Object.values(this.state.files)) {
      const h = headOfName(f.name);
      if (h && h.kind === kind && h.id === id) rev = Math.max(rev, h.rev);
    }
    for (const o of this.state.outbox) {
      const h = headOfName(o.name);
      if (h && h.kind === kind && h.id === id) rev = Math.max(rev, h.rev);
    }
    return rev + 1;
  }

  /**
   * Writes a new revision of a facet: sealed, merged locally at once, then sent through the outbox (it stays there
   * while offline; {@link DriveSync.flush} sends it later).
   *
   * @param kind - The facet.
   * @param id - The record id (none: a new task with a random id).
   * @param body - The content (its type must be `kind`), or null to delete the facet (a tombstone).
   * @returns The written head and whether it reached Drive now.
   */
  async write(kind: SyncKind, id: string | undefined, body: SyncBody | null): Promise<{ head: SyncHead; sent: boolean }> {
    const local = id ? this.state.records[facetKey(kind, id)] : undefined;
    if (local?.head.deleted) throw new Error("This record was deleted.");
    if (local && body && SINGLE_WRITER_KINDS.has(kind) && local.head.writer !== this.writer) throw new Error(`Only the device that wrote this ${kind} may change it.`);
    const rec = await sealRecord({ ...(id ? { id } : {}), kind, rev: id ? this.nextRev(kind, id) : 1, writer: this.writer, kid: this.kid }, body, this.keys.get(this.kid)!);
    const head: SyncHead = { id: rec.id, kind, rev: rec.rev, writer: rec.writer, ...(rec.deleted ? { deleted: true } : {}), ...(rec.done ? { done: true } : {}) };
    const k = facetKey(kind, rec.id);
    const merged = mergeRecord(local, { head, body });
    if (merged !== local) {
      this.state.records[k] = { head, body };
      this.opts.onChange?.({ id: rec.id, kind }, this.state.records[k]);
    }
    this.state.outbox.push({ name: recordFileName(head), content: recordFileContent(rec) });
    await this.save();
    await this.flush();
    const name = recordFileName(head);
    return { head, sent: !this.state.outbox.some((o) => o.name === name) };
  }

  /**
   * Sends the outbox to Drive, oldest first. Stops at the first error that a later try may fix (offline, token,
   * quota); drops a write Drive refuses as malformed (and warns).
   *
   * @returns What was sent and what still waits.
   */
  flush(): Promise<FlushResult> {
    this.flushing ??= this.doFlush().finally(() => (this.flushing = undefined));
    return this.flushing;
  }

  private async doFlush(): Promise<FlushResult> {
    let sent = 0;
    const box = this.state.outbox;
    try {
      while (box.length) {
        const item = box[0]!;
        if (!item.fileId) {
          const need = box.filter((o) => !o.fileId);
          const ids = await this.drive.newIds(Math.min(need.length, 100));
          need.forEach((o, i) => ids[i] && (o.fileId = ids[i]));
          await this.save();
        }
        let info: DriveFileInfo;
        try {
          info = await this.drive.create(item.name, item.content, item.fileId);
        } catch (e) {
          if (!(e instanceof DriveError && e.permanent)) throw e;
          this.warn(`Google Drive refused a synced write (${e.status}); it was dropped.`);
          box.shift();
          await this.save();
          continue;
        }
        box.shift();
        sent++;
        this.state.files[info.id] = { name: item.name, at: info.createdAt };
        const head = headOfName(item.name);
        const local = head && this.state.records[facetKey(head.kind, head.id)];
        if (local && head && recordFileName(local.head) === item.name) local.file = info.id;
        await this.save();
      }
    } catch (e) {
      if (e instanceof DriveError) return { sent, pending: box.length, error: e };
      throw e;
    }
    return { sent, pending: 0 };
  }

  /**
   * Deletes files no device needs any more (any device may run it; a file already gone is fine): a revision once a
   * newer one of its facet has existed for {@link SYNC_LIMITS.compactAfterMs}; a whole task (every facet) once its
   * run has been done for {@link SYNC_LIMITS.doneKeepMs}; a tombstone after {@link SYNC_LIMITS.tombstoneKeepMs}; an
   * agent snapshot after {@link SYNC_LIMITS.agentKeepMs}. Forgotten facets also leave this device's records.
   *
   * @param maxDeletes - At most this many deletes in one call (quota: 50 units each).
   * @returns How many files were deleted.
   */
  async compact(maxDeletes = 200): Promise<number> {
    const now = (this.opts.now ?? Date.now)();
    const L = SYNC_LIMITS;
    const facets = this.facets();
    const drop = new Set<string>();
    const forget = new Set<string>();
    const doneIds = new Set<string>();
    for (const [k, list] of facets) {
      const win = list[0]!;
      const age = win.at ? now - win.at : 0;
      if (age >= L.compactAfterMs) for (const f of list.slice(1)) drop.add(f.id);
      if ((win.head.deleted && age >= L.tombstoneKeepMs) || (win.head.kind === "agent" && age >= L.agentKeepMs)) {
        for (const f of list) drop.add(f.id);
        forget.add(k);
      }
      if (win.head.kind === "run" && win.head.done && age >= L.doneKeepMs) doneIds.add(win.head.id);
    }
    for (const [k, list] of facets)
      if (doneIds.has(list[0]!.head.id)) {
        for (const f of list) drop.add(f.id);
        forget.add(k);
      }
    let deleted = 0;
    for (const id of drop) {
      if (deleted >= maxDeletes) break;
      await this.drive.delete(id);
      delete this.state.files[id];
      deleted++;
    }
    // A record whose files are all gone was compacted (here, or by another device: only compaction deletes a facet's
    // winning file). Records still waiting in the outbox, or never sent, stay.
    const left = new Set(Object.values(this.state.files).flatMap((f) => { const h = headOfName(f.name); return h ? [facetKey(h.kind, h.id)] : []; }));
    const waiting = new Set(this.state.outbox.flatMap((o) => { const h = headOfName(o.name); return h ? [facetKey(h.kind, h.id)] : []; }));
    for (const [k, rec] of Object.entries(this.state.records)) {
      if (left.has(k) || waiting.has(k) || !(forget.has(k) || rec.file)) continue;
      delete this.state.records[k];
      this.opts.onChange?.({ id: rec.head.id, kind: rec.head.kind }, undefined);
    }
    await this.save();
    return deleted;
  }
}
