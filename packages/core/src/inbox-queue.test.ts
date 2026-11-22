import assert from "node:assert/strict";
import { test } from "node:test";
import { freedSlotNote, queueStep, standingId, standingPlan, TaskLines } from "./inbox-queue.js";

test("lines keep order, places and one line per task", () => {
  const l = new TaskLines();
  assert.equal(l.add("antigravity", "a"), 1);
  assert.equal(l.add("antigravity", "b"), 2);
  assert.equal(l.add("local", "c"), 1);
  assert.equal(l.place("b"), 2);
  // Re-adding moves it to the end of the line it is added to.
  assert.equal(l.add("local", "a"), 2);
  assert.deepEqual(l.ids("antigravity"), ["b"]);
  assert.equal(l.shift("local"), "c");
  assert.equal(l.remove("a"), true);
  assert.equal(l.remove("zz"), false);
  assert.deepEqual(l.clear("antigravity"), ["b"]);
  assert.equal(l.empty, true);
});

test("decision: idle, heavy wait, ask after an end, otherwise start", () => {
  const base = { queued: 2, slotFree: true, ask: false, afterEnd: true };
  assert.equal(queueStep({ ...base, queued: 0 }).kind, "idle");
  assert.equal(queueStep({ ...base, slotFree: false }).kind, "idle");
  assert.deepEqual(queueStep({ ...base, heavy: "Unreal build" }), { kind: "wait", job: "Unreal build" });
  assert.equal(queueStep({ ...base, ask: true }).kind, "ask");
  // The first tap on a free slot starts even when the setting asks.
  assert.equal(queueStep({ ...base, ask: true, afterEnd: false }).kind, "start");
  assert.equal(queueStep(base).kind, "start");
  // A heavy job holds back the ask too.
  assert.equal(queueStep({ ...base, ask: true, heavy: "x" }).kind, "wait");
});

test("freed-slot note: started, next in line, waiting, or just free; one text each", () => {
  const ended = { title: "Fix the menu", ok: true };
  const started = freedSlotNote({ ended, started: "Add tests" });
  assert.match(started.title, /Fix the menu הסתיימה ✓ · Add tests התחילה/);
  assert.equal(started.open, undefined);
  const asked = freedSlotNote({ ended: { title: "Fix the menu", ok: false }, asked: "Add tests" });
  assert.match(asked.title, /^🟢 אנטיגרוויטי פנוי — Fix the menu הסתיימה ✕$/);
  assert.match(asked.body, /הבאה בתור: Add tests/);
  assert.equal(asked.open, "asked");
  assert.equal(freedSlotNote({ ended, waiting: "Later" }).open, "waiting");
  const free = freedSlotNote({ ended });
  assert.equal(free.open, undefined);
  assert.match(free.body, /Antigravity is free/);
  // A long title is cut.
  assert.ok(freedSlotNote({ ended: { title: "x".repeat(200), ok: true } }).title.length < 120);
});

test("standing task: only when Antigravity is idle, one at a time, quiet for a day after its report", () => {
  const now = 10 * 24 * 3600_000;
  const base = { busy: false, copies: [], hasTemplate: true, now };
  assert.equal(standingPlan(base), "create");
  assert.equal(standingPlan({ ...base, hasTemplate: false }), "none");
  assert.equal(standingPlan({ ...base, copies: [{ ended: false }] }), "none", "one at a time");
  assert.equal(standingPlan({ ...base, copies: [{ ended: true, endedAt: now - 3600_000 }] }), "none", "its report is fresh");
  assert.equal(standingPlan({ ...base, copies: [{ ended: true, endedAt: now - 25 * 3600_000 }] }), "create");
  assert.equal(standingPlan({ ...base, busy: true, copies: [{ ended: false }] }), "withdraw", "real work comes first");
  assert.equal(standingPlan({ ...base, busy: true }), "none");
  assert.equal(standingId(Date.UTC(2026, 10, 22), 2), "c-20261122-next-2");
});
