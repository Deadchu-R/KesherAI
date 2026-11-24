import { test } from "node:test";
import assert from "node:assert/strict";
import { InstallWhenFree, isFree, type FreeState } from "./install-when-free.js";

const idle: FreeState = { chats: 0, selfWork: false, downloads: 0, updating: false };

test("free only when nothing is busy", () => {
  assert.equal(isFree(idle), true);
  assert.equal(isFree({ ...idle, chats: 1 }), false);
  assert.equal(isFree({ ...idle, study: 1 }), false);
  assert.equal(isFree({ ...idle, selfWork: true }), false);
  assert.equal(isFree({ ...idle, downloads: 2 }), false);
  assert.equal(isFree({ ...idle, updating: true }), false);
});

test("waits while busy, installs once free, then stops", async () => {
  let state = { ...idle, chats: 1 };
  let applied = 0;
  const w = new InstallWhenFree({ state: async () => state, available: async () => true, apply: async () => void applied++, everyMs: 60_000 });
  w.set(true);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(applied, 0);
  assert.equal(w.on, true);
  state = idle;
  assert.equal(await w.tick(), true);
  assert.equal(applied, 1);
  assert.equal(w.on, false);
});

test("does nothing without a ready version, or when off", async () => {
  let applied = 0;
  const w = new InstallWhenFree({ state: async () => idle, available: async () => false, apply: async () => void applied++, everyMs: 60_000 });
  assert.equal(await w.tick(), false);
  w.set(true);
  assert.equal(await w.tick(), false);
  w.stop();
  assert.equal(applied, 0);
});

test("writes the resume record before it installs, and installs even if writing fails", async () => {
  const order: string[] = [];
  const w = new InstallWhenFree({ state: async () => idle, available: async () => true, beforeApply: async () => { order.push("save"); throw new Error("disk full"); }, apply: async () => void order.push("apply"), everyMs: 60_000 });
  w.set(true);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(order, ["save", "apply"]);
});

test("a check that never answers does not stop later looks", async () => {
  let applied = 0;
  let calls = 0;
  const w = new InstallWhenFree({
    state: async () => ({ chats: 0, selfWork: false, downloads: 0, updating: false, study: 0 }),
    available: () => (++calls === 1 ? new Promise<boolean>(() => undefined) : Promise.resolve(true)),
    apply: async () => void applied++,
    everyMs: 3_600_000,
    checkEveryMs: 0,
    lookMs: 30,
  });
  w.set(true); // the first look hangs on `available`, then gives up after 30 ms
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(await w.tick(), true);
  assert.equal(applied, 1);
  w.stop();
});
