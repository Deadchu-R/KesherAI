import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beats,
  cleanSyncBody,
  importAccountKey,
  keyFileName,
  mergeRecord,
  newAccountKeyBytes,
  openRecord,
  parseKeyFileName,
  parseRecordFileName,
  parseSyncRecord,
  recordFileContent,
  recordFileName,
  recordFromFile,
  RevGuard,
  sealRecord,
  SYNC_LIMITS,
  type OpenedRecord,
  type SyncBody,
  type SyncRecord,
} from "./hub-sync.js";
import { fromB64url, toB64url } from "./hub-crypto.js";

const task: SyncBody = { type: "task", title: "בדוק את הבדיקה שנכשלה", spec: "Run pnpm test", origin: "phone", executor: "auto", createdAt: "2026-11-20T10:00:00.000Z" };
const run = (state: "running" | "done", rev: number, writer = "pc1"): OpenedRecord => ({ head: { id: "task-0001", kind: "run", rev, writer }, body: { type: "run", state } });

test("seal and open a record under the account key; padded, no plain text", async () => {
  const k = await importAccountKey(newAccountKeyBytes());
  const rec = await sealRecord({ kind: "task", rev: 1, writer: "phone1", kid: 1 }, task, k);
  assert.deepEqual(parseSyncRecord(JSON.parse(JSON.stringify(rec))), rec, "passes the hub's shape check");
  assert.ok(!rec.ct.includes("pnpm") && rec.id.length === 22);
  assert.equal(fromB64url(rec.ct).length % SYNC_LIMITS.padBytes, 16, "padded to 256-byte steps (+16 tag)");
  assert.deepEqual(await openRecord(rec, k), task);
  // Another key cannot open it.
  await assert.rejects(openRecord(rec, await importAccountKey(newAccountKeyBytes())), /could not be opened/);
  // A body must fit its kind.
  await assert.rejects(sealRecord({ kind: "run", rev: 1, writer: "pc1", kid: 1 }, task, k), /cannot hold/);
});

test("the head is bound: no swap to another id, kind, rev, writer, kid, tombstone or done flag", async () => {
  const k = await importAccountKey(newAccountKeyBytes());
  const rec = await sealRecord({ id: "task-0001", kind: "run", rev: 3, writer: "pc1", kid: 1 }, { type: "run", state: "running" }, k);
  const changes: Partial<SyncRecord>[] = [{ id: "task-0002" }, { kind: "meta" }, { rev: 2 }, { writer: "pc2" }, { kid: 2 }, { deleted: true }, { done: true }];
  for (const c of changes) await assert.rejects(openRecord({ ...rec, ...c }, k), /could not be opened/, JSON.stringify(c));
  const ct = fromB64url(rec.ct);
  ct[0] = ct[0]! ^ 1;
  await assert.rejects(openRecord({ ...rec, ct: toB64url(ct) }, k), /could not be opened/, "tampered ciphertext");
  // A finished run is marked done in its head, and a tombstone is sealed too (the hub cannot forge one).
  const done = await sealRecord({ id: "task-0001", kind: "run", rev: 4, writer: "pc1", kid: 1 }, { type: "run", state: "done", result: "ok" }, k);
  assert.equal(done.done, true);
  const tomb = await sealRecord({ id: "task-0001", kind: "task", rev: 2, writer: "phone1", kid: 1 }, null, k);
  assert.equal(tomb.deleted, true);
  assert.equal(await openRecord(tomb, k), null);
  await assert.rejects(openRecord({ ...tomb, deleted: undefined }, k), /could not be opened/);
});

test("shape checks refuse bad records and clean bodies", () => {
  const good = { v: 1, id: "task-0001", kind: "meta", rev: 1, writer: "pc1", kid: 1, salt: "a".repeat(22), iv: "b".repeat(16), ct: "c" };
  assert.ok(parseSyncRecord(good));
  for (const bad of [{ kind: "other" }, { rev: 0 }, { rev: 1.5 }, { id: "x" }, { writer: "a b" }, { kid: 0 }, { ct: "+/=" }, { ct: "c".repeat(SYNC_LIMITS.recordChars + 1) }, { iv: "short" }, { deleted: "yes" }, { v: 2 }])
    assert.equal(parseSyncRecord({ ...good, ...bad }), undefined, JSON.stringify(bad));
  assert.equal(cleanSyncBody({ type: "task", title: "t", origin: "nowhere" }, "task"), undefined);
  assert.equal(cleanSyncBody({ type: "run", state: "done" }, "meta"), undefined);
  const r = cleanSyncBody({ type: "run", state: "running", extra: 1, timeline: Array.from({ length: 40 }, (_, i) => ({ at: "t", line: `l${i}` })), tokens: -1 }, "run");
  assert.ok(r && !("extra" in r) && !("tokens" in r) && r.timeline?.length === 30 && r.timeline[0]!.line === "l10");
});

test("merge: rev then writer; terminal runs stay terminal; tombstones are final", () => {
  assert.ok(beats(undefined, { rev: 1, writer: "a" }));
  assert.ok(beats({ rev: 1, writer: "z" }, { rev: 2, writer: "a" }));
  assert.ok(beats({ rev: 2, writer: "a" }, { rev: 2, writer: "b" }) && !beats({ rev: 2, writer: "b" }, { rev: 2, writer: "a" }));
  assert.ok(!beats({ rev: 2, writer: "a" }, { rev: 2, writer: "a" }), "the same revision again changes nothing");
  assert.equal(mergeRecord(run("running", 2), run("running", 1)).head.rev, 2, "older revision ignored");
  assert.equal((mergeRecord(run("running", 2), run("done", 3)).body as { state: string }).state, "done");
  assert.equal((mergeRecord(run("done", 3), run("running", 4)).body as { state: string }).state, "done", "a late running never hides done");
  const tomb: OpenedRecord = { head: { id: "task-0001", kind: "run", rev: 5, writer: "a", deleted: true }, body: null };
  assert.equal(mergeRecord(tomb, run("running", 5, "z")).body, null, "tombstone holds at equal rev");
  assert.equal(mergeRecord(tomb, run("running", 6)).body, null, "and against a higher one");
  assert.equal(mergeRecord(run("running", 2), tomb).body, null, "a tombstone replaces a live revision");
  assert.throws(() => mergeRecord(run("done", 1), { ...run("done", 2), head: { ...run("done", 2).head, id: "task-0002" } }));
});

test("rev guard: notices rollbacks, keeps the Drive cursor, gives the next revision", () => {
  const g = new RevGuard();
  assert.equal(g.changeToken, undefined, "a new device starts with a full listing");
  assert.equal(g.see({ id: "task-0001", kind: "run", rev: 3 }), "ok");
  assert.equal(g.see({ id: "task-0001", kind: "run", rev: 2 }), "rollback");
  assert.equal(g.see({ id: "task-0001", kind: "meta", rev: 1 }), "ok", "facets are separate");
  g.changeToken = "1234";
  assert.equal(g.changeToken, "1234");
  assert.equal(g.nextRev("run", "task-0001"), 4);
  assert.equal(g.nextRev("task", "new-task-01"), 1);
});

test("file names: head <-> name round trip, strict parsing", () => {
  const heads = [
    { id: "task-0001", kind: "task" as const, rev: 1, writer: "phone1" },
    { id: "task_0001", kind: "run" as const, rev: 12, writer: "pc-1", done: true },
    { id: "task-0001", kind: "meta" as const, rev: 3, writer: "pc1", deleted: true },
  ];
  assert.equal(recordFileName(heads[0]!), "r1.task.task-0001.1.phone1.l");
  assert.equal(recordFileName(heads[1]!), "r1.run.task_0001.12.pc-1.f");
  assert.equal(recordFileName(heads[2]!), "r1.meta.task-0001.3.pc1.d");
  for (const h of heads) assert.deepEqual(parseRecordFileName(recordFileName(h)), h);
  for (const bad of ["r1.task.task-0001.1.phone1", "r2.task.task-0001.1.phone1.l", "r1.other.task-0001.1.p.l", "r1.task.x.1.p.l", "r1.task.task-0001.0.p.l", "r1.task.task-0001.01.p.l", "r1.task.task-0001.1.5.p.l", "r1.task.task-0001.1.a b.l", "r1.task.task-0001.1.p.x", "r1.task.task-0001.1.p.f", "key.1", ""])
    assert.equal(parseRecordFileName(bad), undefined, bad);
  assert.throws(() => recordFileName({ id: "a.b.c.d.e", kind: "task", rev: 1, writer: "p" }));
  assert.equal(keyFileName(3), "key.3");
  assert.equal(parseKeyFileName("key.3"), 3);
  for (const bad of ["key.0", "key.x", "key.1.2", "r1.key.1"]) assert.equal(parseKeyFileName(bad), undefined, bad);
});

test("a record file opens back; a renamed file (swap, replay under another id, tie) fails to open", async () => {
  const k = await importAccountKey(newAccountKeyBytes());
  const rec = await sealRecord({ id: "task-0001", kind: "run", rev: 2, writer: "pc1", kid: 1 }, { type: "run", state: "running" }, k);
  const name = recordFileName(rec);
  const content = recordFileContent(rec);
  assert.ok(!content.includes("task-0001"), "the head lives in the name only");
  const back = recordFromFile(parseRecordFileName(name)!, content);
  assert.deepEqual(back, rec);
  assert.deepEqual(await openRecord(back!, k), { type: "run", state: "running" });
  for (const renamed of ["r1.run.task-0002.2.pc1.l", "r1.run.task-0001.3.pc1.l", "r1.run.task-0001.2.pc2.l", "r1.run.task-0001.2.pc1.f", "r1.run.task-0001.2.pc1.d", "r1.meta.task-0001.2.pc1.l"]) {
    const r = recordFromFile(parseRecordFileName(renamed)!, content);
    assert.ok(r, renamed);
    await assert.rejects(openRecord(r, k), /could not be opened/, renamed);
  }
  assert.equal(recordFromFile(parseRecordFileName(name)!, "not json"), undefined);
  assert.equal(recordFromFile(parseRecordFileName(name)!, JSON.stringify({ kid: 1, salt: "x", iv: "y", ct: "z" })), undefined);
});
