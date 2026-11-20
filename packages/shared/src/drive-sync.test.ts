import { test } from "node:test";
import assert from "node:assert/strict";
import { DriveError, DriveRest, DriveSync, ensureAccountKey, type DriveSyncState } from "./drive-sync.js";
import { parseRecordFileName, SYNC_LIMITS, type SyncBody } from "./hub-sync.js";

const DAY = 24 * 3600 * 1000;

/** An in-memory Google Drive appDataFolder answering the REST calls DriveRest makes (no network). */
class FakeDrive {
  files = new Map<string, { name: string; content: string; created: number }>();
  log: { fileId: string; removed: boolean }[] = [];
  now = Date.parse("2026-11-20T10:00:00Z");
  page = 2;
  offline = false;
  /** Status codes to answer the next calls with, before working normally. */
  fail: { status: number; reason?: string }[] = [];
  /** Only calls with this method meet `fail` (none: every call). */
  failMethod: string | undefined;
  calls: string[] = [];
  tokens: string[] = [];
  private nextId = 1;

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (this.offline) throw new TypeError("fetch failed");
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    this.calls.push(`${method} ${url.pathname}`);
    this.tokens.push(String((init?.headers as Record<string, string>).authorization));
    const f = !this.failMethod || this.failMethod === method ? this.fail.shift() : undefined;
    if (f) return json({ error: { errors: [{ reason: f.reason ?? "x" }] } }, f.status);
    const p = url.pathname;
    const q = url.searchParams;
    if (p.startsWith("/drive/v3/") || p.startsWith("/upload/drive/v3/")) {
      if (method === "GET" && p === "/drive/v3/changes/startPageToken") return json({ startPageToken: String(this.log.length) });
      if (method === "GET" && p === "/drive/v3/changes") {
        assert.equal(q.get("spaces"), "appDataFolder");
        assert.equal(q.get("pageSize"), String(SYNC_LIMITS.driveListPage));
        const from = Number(q.get("pageToken"));
        if (!Number.isInteger(from) || from > this.log.length) return json({ error: { errors: [{ reason: "invalid" }] } }, 400);
        const part = this.log.slice(from, from + this.page);
        const changes = part.map((c) => (c.removed ? c : { ...c, file: this.info(c.fileId) }));
        const end = from + part.length;
        return json(end < this.log.length ? { changes, nextPageToken: String(end) } : { changes, newStartPageToken: String(end) });
      }
      if (method === "GET" && p === "/drive/v3/files") {
        assert.equal(q.get("spaces"), "appDataFolder");
        const all = [...this.files.keys()].sort();
        const from = Number(q.get("pageToken") ?? 0);
        const files = all.slice(from, from + this.page).map((id) => this.info(id));
        return json(from + this.page < all.length ? { files, nextPageToken: String(from + this.page) } : { files });
      }
      if (method === "GET" && p === "/drive/v3/files/generateIds") {
        assert.equal(q.get("space"), "appDataFolder");
        return json({ ids: Array.from({ length: Number(q.get("count")) }, () => `gen${this.nextId++}`) });
      }
      if (method === "POST" && p === "/upload/drive/v3/files") {
        assert.equal(q.get("uploadType"), "multipart");
        const boundary = /boundary=(.+)$/.exec(String((init?.headers as Record<string, string>)["content-type"]))![1]!;
        const parts = String(init?.body).split(`--${boundary}`).slice(1, 3).map((s) => s.split("\r\n\r\n")[1]!.replace(/\r\n$/, ""));
        const meta = JSON.parse(parts[0]!) as { name: string; parents: string[]; id?: string };
        assert.deepEqual(meta.parents, ["appDataFolder"]);
        const id = meta.id ?? `auto${this.nextId++}`;
        if (this.files.has(id)) return json({ error: { errors: [{ reason: "duplicate" }] } }, 409);
        this.files.set(id, { name: meta.name, content: parts[1]!, created: this.now });
        this.log.push({ fileId: id, removed: false });
        return json(this.info(id));
      }
      const m = /^\/drive\/v3\/files\/([\w-]+)$/.exec(p);
      if (m) {
        const f = this.files.get(m[1]!);
        if (!f) return json({ error: { errors: [{ reason: "notFound" }] } }, 404);
        if (method === "DELETE") {
          this.files.delete(m[1]!);
          this.log.push({ fileId: m[1]!, removed: true });
          return new Response(null, { status: 204 });
        }
        return q.get("alt") === "media" ? new Response(f.content) : json(this.info(m[1]!));
      }
    }
    return json({ error: { errors: [{ reason: "unknown" }] } }, 400);
  };

  info(id: string) {
    const f = this.files.get(id)!;
    return { id, name: f.name, createdTime: new Date(f.created).toISOString() };
  }

  names(): string[] {
    return [...this.files.values()].map((f) => f.name).sort();
  }
}

function json(x: unknown, status = 200): Response {
  return new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json" } });
}

function rest(fake: FakeDrive, sleeps: number[] = []): DriveRest {
  let n = 0;
  return new DriveRest({ token: async ({ refresh }) => `tok${refresh ? ++n : n}`, fetch: fake.fetch, sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 });
}

async function device(fake: FakeDrive, writer: string, state?: DriveSyncState, warns: string[] = []): Promise<DriveSync> {
  const drive = rest(fake);
  return DriveSync.create({ drive, writer, keys: await ensureAccountKey(drive), ...(state ? { state } : {}), onWarn: (m) => warns.push(m), now: () => fake.now });
}

const task: SyncBody = { type: "task", title: "בדוק את הבדיקות", spec: "Run the tests", origin: "phone", executor: "auto", createdAt: "2026-11-20T10:00:00.000Z" };

test("REST: lists all pages, creates multipart in appDataFolder, reads, deletes (404 is fine)", async () => {
  const fake = new FakeDrive();
  const d = rest(fake);
  const ids = await d.newIds(3);
  for (const [i, id] of ids.entries()) await d.create(`r1.task.task-000${i}.1.pc1.l`, `{"n":${i}}`, id);
  const a = await d.list();
  assert.equal(a.files.length, 2);
  const b = await d.list(a.nextPageToken);
  assert.equal(b.files.length, 1);
  assert.equal(b.nextPageToken, undefined);
  assert.equal(await d.read(ids[1]!), '{"n":1}');
  assert.equal((await d.list(undefined, "key.")).files.length, 0, "prefix filter");
  await d.delete(ids[0]!);
  await d.delete(ids[0]!);
  assert.equal(fake.files.size, 2);
  // A retried create with the same id (the first answer was lost) returns the file, not a second one.
  const again = await d.create("r1.task.task-0001.1.pc1.l", "{}", ids[1]);
  assert.equal(again.id, ids[1]);
  assert.equal(fake.files.size, 2);
  await assert.rejects(d.read("../etc"), /Bad Drive file id/);
});

test("REST: backoff on 429, 5xx and rate-limit 403; one token refresh on 401; offline and other errors throw", async () => {
  const fake = new FakeDrive();
  const sleeps: number[] = [];
  const d = rest(fake, sleeps);
  fake.fail = [{ status: 429 }, { status: 503 }, { status: 403, reason: "userRateLimitExceeded" }];
  assert.equal(await d.startToken(), "0");
  assert.deepEqual(sleeps, [1500, 2500, 4500], "2^n s + jitter");
  fake.fail = [{ status: 401 }];
  await d.startToken();
  assert.equal(fake.tokens.at(-1), "Bearer tok1", "a fresh token after 401");
  fake.fail = [{ status: 401 }, { status: 401 }];
  await assert.rejects(d.startToken(), (e: unknown) => e instanceof DriveError && e.status === 401);
  fake.fail = [{ status: 403, reason: "insufficientPermissions" }];
  await assert.rejects(d.startToken(), (e: unknown) => e instanceof DriveError && e.status === 403 && e.reason === "insufficientPermissions");
  fake.fail = Array.from({ length: 6 }, () => ({ status: 500 }));
  await assert.rejects(d.startToken(), (e: unknown) => e instanceof DriveError && e.status === 500);
  assert.ok(sleeps.every((ms) => ms <= 32_000), "capped");
  fake.offline = true;
  await assert.rejects(d.startToken(), (e: unknown) => e instanceof DriveError && e.status === 0 && !String(e.message).includes("tok"));
});

test("account key: the first device creates it, the next reads the same one", async () => {
  const fake = new FakeDrive();
  const a = await ensureAccountKey(rest(fake));
  const b = await ensureAccountKey(rest(fake));
  assert.equal(a.kid, 1);
  assert.deepEqual(b.raw.get(1), a.raw.get(1));
  assert.deepEqual(fake.names(), ["key.1"]);
  // Two devices at once: both end up with the earliest file.
  const race = new FakeDrive();
  race.files.set("aaa", { name: "key.1", content: JSON.stringify({ v: 1, kid: 1, k: "A".repeat(43) }), created: race.now - 1000 });
  race.files.set("zzz", { name: "key.1", content: JSON.stringify({ v: 1, kid: 1, k: "B".repeat(43) }), created: race.now });
  const c = await ensureAccountKey(rest(race));
  assert.equal(c.raw.get(1)![0], 0, "the earliest file (AAAA...) wins");
  await assert.rejects(ensureAccountKey(rest(Object.assign(new FakeDrive(), { files: new Map([["k", { name: "key.1", content: "junk", created: 0 }]]) }))), /could not be read/);
});

test("sync: a task from the phone reaches the PC, the PC's run reaches the phone; only winners are downloaded", async () => {
  const fake = new FakeDrive();
  const phone = await device(fake, "phone1");
  const pc = await device(fake, "pc1");
  const { head } = await phone.write("task", undefined, task);
  assert.equal(phone.state.outbox.length, 0);
  assert.equal(await pc.pull(), 1);
  assert.deepEqual(pc.state.records[`task:${head.id}`]!.body, task);
  await pc.write("run", head.id, { type: "run", state: "running" });
  await pc.write("run", head.id, { type: "run", state: "done", result: "ok" });
  const reads = fake.calls.length;
  assert.equal(await phone.pull(), 1);
  const run = phone.state.records[`run:${head.id}`]!;
  assert.equal(run.head.rev, 2);
  assert.equal(run.head.done, true);
  assert.equal(fake.calls.slice(reads).filter((c) => c.startsWith("GET /drive/v3/files/")).length, 1, "the superseded revision is not downloaded");
  assert.equal(await phone.pull(), 0, "nothing new");
  await assert.rejects(phone.write("run", head.id, { type: "run", state: "cancelled" }), /Only the device/);
  // Meta is shared: equal revisions tie-break on the writer, both devices agree.
  await phone.write("meta", head.id, { type: "meta", pinned: true });
  await pc.pull();
  assert.equal(pc.nextRev("meta", head.id), 2);
});

test("sync: offline writes wait in the outbox with a reserved id and go out once; state survives a restart", async () => {
  const fake = new FakeDrive();
  let saved: DriveSyncState | undefined;
  const drive = rest(fake);
  const keys = await ensureAccountKey(drive);
  const phone = await DriveSync.create({ drive, writer: "phone1", keys, save: (s) => void (saved = JSON.parse(JSON.stringify(s)) as DriveSyncState) });
  fake.offline = true;
  const { head, sent } = await phone.write("task", undefined, task);
  assert.equal(sent, false);
  assert.equal(phone.records().length, 1, "merged locally at once");
  fake.offline = false;
  fake.failMethod = "POST";
  fake.fail = [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }];
  const r = await phone.flush();
  assert.equal(r.pending, 1);
  assert.equal(r.error?.status, 500);
  // Restart from the saved state: the reserved id makes the retry land once.
  const again = await DriveSync.create({ drive, writer: "phone1", keys, state: saved! });
  assert.ok(again.state.outbox[0]!.fileId);
  assert.deepEqual(await again.flush(), { sent: 1, pending: 0 });
  assert.equal(fake.names().filter((n) => n.startsWith("r1.")).length, 1);
  assert.equal(again.state.records[`task:${head.id}`]!.file, Object.keys(again.state.files)[0]);
  // A malformed write is dropped with a warning instead of blocking the queue.
  const warns: string[] = [];
  const pc = await device(fake, "pc1", undefined, warns);
  fake.fail = [{ status: 400 }];
  await pc.write("meta", head.id, { type: "meta", archived: true });
  assert.equal(pc.state.outbox.length, 0);
  assert.match(warns[0]!, /dropped/);
});

test("sync: a renamed or foreign file is skipped; a refused cursor falls back to a full listing", async () => {
  const fake = new FakeDrive();
  const warns: string[] = [];
  const phone = await device(fake, "phone1");
  const pc = await device(fake, "pc1", undefined, warns);
  await pc.pull();
  const { head } = await phone.write("task", undefined, task);
  const [id, f] = [...fake.files].find(([, v]) => v.name.startsWith("r1."))!;
  fake.files.set("forged", { name: f.name.replace(".1.phone1.", ".2.phone1."), content: f.content, created: fake.now });
  fake.log.push({ fileId: "forged", removed: false });
  fake.files.set("other", { name: "notes.txt", content: "x", created: fake.now });
  fake.log.push({ fileId: "other", removed: false });
  assert.equal(await pc.pull(), 0);
  assert.match(warns.join(), /could not be opened/);
  assert.equal(pc.state.files.other, undefined, "foreign names are ignored");
  fake.files.delete("forged");
  fake.log.push({ fileId: "forged", removed: true });
  assert.equal(await pc.pull(), 1, "the real revision wins once the forged one is gone");
  assert.equal(pc.state.records[`task:${head.id}`]!.file, id);
  pc.state.changeToken = "999999";
  await pc.pull();
  assert.match(warns.join(), /whole folder/);
  assert.ok(Object.keys(pc.state.files).includes(id));
  assert.ok(parseRecordFileName(f.name));
});

test("compaction: old revisions after 24 h, done tasks after 90 days, tombstones after 30; other devices forget too", async () => {
  const fake = new FakeDrive();
  const phone = await device(fake, "phone1");
  const pc = await device(fake, "pc1");
  const { head } = await phone.write("task", undefined, task);
  await pc.pull();
  await pc.write("run", head.id, { type: "run", state: "running" });
  fake.now += 1000;
  await pc.write("run", head.id, { type: "run", state: "done" });
  const other = (await phone.write("task", undefined, { ...task, title: "other" })).head;
  await phone.write("task", other.id, null);
  const count = () => fake.names().filter((n) => n.startsWith("r1.")).length;
  assert.equal(count(), 5);
  assert.equal(await pc.compact(), 0, "nothing is old enough yet");
  fake.now += DAY;
  await pc.pull();
  assert.equal(await pc.compact(), 2, "the running revision and the live revision of the deleted task");
  fake.now += 30 * DAY;
  assert.equal(await pc.compact(), 1, "the tombstone");
  fake.now += 60 * DAY;
  assert.equal(await pc.compact(), 2, "the done task: its task and run files");
  assert.equal(count(), 0);
  assert.deepEqual(pc.records(), []);
  const gone: string[] = [];
  const phone2 = await DriveSync.create({ drive: rest(fake), writer: "phone1", keys: await ensureAccountKey(rest(fake)), state: phone.state, onChange: (k, r) => r || gone.push(k.kind) });
  await phone2.pull();
  await phone2.compact();
  assert.deepEqual(phone2.records(), [], "the phone forgets what was compacted elsewhere");
  assert.ok(gone.length >= 1);
  assert.deepEqual(fake.names(), ["key.1"], "the key file stays");
});
