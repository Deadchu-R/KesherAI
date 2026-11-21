import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardCommand, hubBoardSnapshot } from "./hub-board.js";
import { TaskBoard } from "./task-board.js";

async function board() {
  const dir = await mkdtemp(join(tmpdir(), "kesher-hubboard-"));
  const b = new TaskBoard(join(dir, "board.json"));
  await b.change("roee", [
    { op: "add", title: "[CoolDown] Fix the icon", details: "SECRET details", size: "small", priority: 3 },
    { op: "add", title: "Build the board", priority: 2 },
    { op: "add", title: "Old thing" },
  ]);
  await b.change("claude", [{ op: "claim", id: "t2" }, { op: "done", id: "t3", result: "Commit abc.\nSECOND line" }]);
  return { b, done: () => rm(dir, { recursive: true, force: true }) };
}

test("snapshot: metadata only (no details), the result's first line, the prefix gone, and listeners hear a change", async (t) => {
  const { b, done } = await board();
  t.after(done);
  let heard = 0;
  const off = b.onChange(() => void heard++);
  const snap = hubBoardSnapshot(await b.read());
  const text = JSON.stringify(snap);
  assert.ok(!text.includes("SECRET"), "details and later result lines stay on the PC");
  assert.equal(snap.items[0]!.id, "t2", "taken first");
  assert.equal(snap.items.find((i) => i.id === "t1")!.title, "Fix the icon");
  assert.equal(snap.items.find((i) => i.id === "t3")!.result, "Commit abc.");
  assert.equal(snap.doneTotal, 1);
  await b.change("roee", [{ op: "note", text: "hi" }]);
  assert.equal(heard, 1, "after every written change");
  off();
  await b.change("roee", [{ op: "note", text: "again" }]);
  assert.equal(heard, 1, "and not after it is stopped");
});

test("commands: reopen, a higher priority, for self-work and a note go through the board's own rules, as Roee", async (t) => {
  const { b, done } = await board();
  t.after(done);
  assert.deepEqual(await boardCommand(b, "t3", { op: "reopen" }), { ok: true, text: "Reopened." });
  let t3 = (await b.read()).tasks.find((x) => x.id === "t3")!;
  assert.equal(t3.status, "open");
  assert.equal(t3.updatedBy, "roee");
  assert.equal((await boardCommand(b, "t3", { op: "reopen" })).ok, false, "already open");
  assert.equal((await boardCommand(b, "t3", { op: "raise" })).text, "Priority p4.");
  assert.equal((await boardCommand(b, "t2", { op: "raise" })).text, "Priority p1.");
  assert.equal((await boardCommand(b, "t2", { op: "raise" })).ok, false, "p1 is the top");
  assert.equal((await boardCommand(b, "t3", { op: "for-kesher", on: true })).ok, true);
  t3 = (await b.read()).tasks.find((x) => x.id === "t3")!;
  assert.equal(t3.forKesher, true);
  await boardCommand(b, "t3", { op: "for-kesher", on: false });
  assert.equal((await b.read()).tasks.find((x) => x.id === "t3")!.forKesher, undefined);
  assert.equal((await boardCommand(b, "t1", { op: "note", text: "Please check on the phone" })).ok, true);
  assert.deepEqual((await b.read()).notes.at(-1), { at: (await b.read()).notes.at(-1)!.at, from: "roee", text: "Please check on the phone", task: "t1" });
  assert.equal((await boardCommand(b, "t99", { op: "reopen" })).ok, false, "an unknown task");
  await b.change("claude", [{ op: "done", id: "t1", result: "ok" }]);
  assert.equal((await boardCommand(b, "t1", { op: "raise" })).ok, false, "a done task cannot be raised");
});
