import assert from "node:assert/strict";
import { test } from "node:test";
import { blockingChats, InstallWhenFree, WAITING_GRACE_MS, type FreeState } from "./install-when-free.js";
import { DRAIN_NOTIFY_MS, UpdateDrain } from "./update-drain.js";
import { startsAgent, type Routine } from "./routines.js";

const free: FreeState = { chats: 0, selfWork: false, downloads: 0, updating: false };

test("a chat waiting for the user over 6 hours does not block; running always does", () => {
  const now = 100 * 3_600_000;
  const ids = blockingChats(
    { a: { status: "waiting", since: now - WAITING_GRACE_MS - 1 }, b: { status: "waiting", since: now - 1000 }, c: { status: "running", since: now - 20 * 3_600_000 } },
    now,
  );
  assert.deepEqual(ids.sort(), ["b", "c"]);
});

test("the drain starts and ends, tells the phone once after 90 minutes, and its code works once", () => {
  let t = 0;
  const d = new UpdateDrain(() => t);
  assert.equal(d.pending, false);
  d.begin();
  t = 1000;
  d.begin(); // keeps the first start
  assert.equal(d.elapsedMs, 1000);
  assert.equal(d.takeLongNotice(), false);
  t = DRAIN_NOTIFY_MS + 1;
  assert.equal(d.takeLongNotice(), true);
  assert.equal(d.takeLongNotice(), false);
  const code = d.makeCode();
  assert.equal(d.useCode("x".repeat(code.length)), false);
  const again = d.makeCode();
  assert.equal(d.useCode(again), true);
  assert.equal(d.useCode(again), false);
  d.end();
  assert.equal(d.pending, false);
});

test("install-when-free drains while a version waits, notifies once when long, installs when free", async () => {
  let t = 0;
  const drain = new UpdateDrain(() => t);
  let state: FreeState = { ...free, chats: 1 };
  let applied = 0;
  let notices = 0;
  const w = new InstallWhenFree({ state: async () => state, available: async () => true, apply: async () => void applied++, drain, onLongDrain: () => void notices++, everyMs: 3_600_000 });
  w.set(true);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(drain.pending, true);
  t = DRAIN_NOTIFY_MS + 1;
  await w.tick();
  await w.tick();
  assert.equal(notices, 1);
  assert.equal(applied, 0);
  state = free;
  assert.equal(await w.tick(), true);
  assert.equal(applied, 1);
  assert.equal(drain.pending, true, "stays on until the restart");
  w.stop();
  assert.equal(drain.pending, false);
});

test("turning install-when-free off ends the drain", async () => {
  const drain = new UpdateDrain();
  const w = new InstallWhenFree({ state: async () => ({ ...free, chats: 1 }), available: async () => true, apply: async () => undefined, drain, everyMs: 3_600_000 });
  w.set(true);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(drain.pending, true);
  w.set(false);
  assert.equal(drain.pending, false);
});

test("routines that start agents are told apart", () => {
  const mk = (action: Routine["action"]) => ({ action }) as Routine;
  assert.equal(startsAgent(mk({ type: "self-work", hours: 1 })), true);
  assert.equal(startsAgent(mk({ type: "inbox-run", taskId: "x" })), true);
  assert.equal(startsAgent(mk({ type: "digest" })), false);
});
