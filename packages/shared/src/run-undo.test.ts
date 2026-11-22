import { test } from "node:test";
import assert from "node:assert/strict";
import { RUN_ALL_KEY, RUN_UNDO_MS, RunUndo, undoSecondsLeft } from "./run-undo.js";

test("run undo: counts 5 to 1, and sends only when the 5 seconds are over", () => {
  const u = new RunUndo();
  const t0 = 1_000_000;
  u.arm("t1", t0);
  assert.equal(u.left("t1", t0), 5);
  assert.equal(u.left("t1", t0 + 1000), 4);
  assert.equal(u.left("t1", t0 + RUN_UNDO_MS - 1), 1, "never shows 0 while it still counts");
  assert.deepEqual(u.due(t0 + RUN_UNDO_MS - 1), [], "nothing is sent before the window ends");
  assert.equal(u.active, true);
  assert.deepEqual(u.due(t0 + RUN_UNDO_MS), ["t1"]);
  assert.deepEqual(u.due(t0 + RUN_UNDO_MS + 10), [], "it is sent once");
  assert.equal(u.active, false);
});

test("run undo: Undo cancels it and nothing is ever sent; a second tap does not restart the count", () => {
  const u = new RunUndo();
  u.arm("t1", 0);
  u.arm("t1", 3000);
  assert.equal(u.left("t1", 3000), 2, "the double tap kept the first window");
  assert.equal(u.cancel("t1"), true);
  assert.equal(u.cancel("t1"), false);
  assert.equal(u.left("t1", 3000), undefined);
  assert.deepEqual(u.due(60_000), []);
});

test("run undo: several windows (and Run all) are independent and come due oldest first", () => {
  const u = new RunUndo();
  u.arm("b", 100);
  u.arm("a", 0);
  u.arm(RUN_ALL_KEY, 200);
  u.cancel("b");
  assert.deepEqual(u.due(RUN_UNDO_MS + 150), ["a"]);
  assert.deepEqual(u.due(RUN_UNDO_MS + 200), [RUN_ALL_KEY]);
  assert.equal(undoSecondsLeft(0, RUN_UNDO_MS * 3), 0);
});
