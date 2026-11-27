import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OVERLAY_DEFAULT_MOVE_MS,
  OVERLAY_INITIAL_STATE,
  cursorPosAt,
  overlayReduce,
  type OverlayState,
} from "./overlay-state.js";

const init = (): OverlayState => ({ ...OVERLAY_INITIAL_STATE });

test("initial state is frozen and has the documented shape", () => {
  assert.ok(Object.isFrozen(OVERLAY_INITIAL_STATE));
  assert.equal(OVERLAY_INITIAL_STATE.frameVisible, false);
  assert.equal(OVERLAY_INITIAL_STATE.takenOver, false);
  assert.equal(OVERLAY_INITIAL_STATE.cursor, undefined);
  assert.equal(OVERLAY_INITIAL_STATE.caption, undefined);
});

test("step-start turns the frame on, sets caption and target, and plans a smooth move when the target changes", () => {
  const s1 = overlayReduce(init(), { type: "step-start", caption: "Open menu", target: { x: 10, y: 20 }, now: 1000 });
  assert.equal(s1.frameVisible, true);
  assert.equal(s1.caption, "Open menu");
  assert.deepEqual(s1.cursor?.target, { x: 10, y: 20 });
  assert.equal(s1.cursor?.move, undefined, "first target has no move plan");

  const s2 = overlayReduce(s1, {
    type: "step-start",
    caption: "Click item",
    target: { x: 110, y: 70 },
    moveDurationMs: 200,
    now: 2000,
  });
  assert.equal(s2.caption, "Click item");
  assert.deepEqual(s2.cursor?.target, { x: 110, y: 70 });
  assert.ok(s2.cursor?.move);
  assert.deepEqual(s2.cursor!.move!.start, { x: 10, y: 20 });
  assert.deepEqual(s2.cursor!.move!.end, { x: 110, y: 70 });
  assert.equal(s2.cursor!.move!.startedAt, 2000);
  assert.equal(s2.cursor!.move!.durationMs, 200);
});

test("step-start without a target keeps the previous cursor and still shows the frame", () => {
  const withCursor = overlayReduce(init(), { type: "step-start", caption: "A", target: { x: 5, y: 5 }, now: 0 });
  const next = overlayReduce(withCursor, { type: "step-start", caption: "B", now: 100 });
  assert.equal(next.caption, "B");
  assert.deepEqual(next.cursor?.target, { x: 5, y: 5 });
  assert.equal(next.cursor?.move, undefined, "same target must not create a move plan");
  assert.equal(next.frameVisible, true);
});

test("step-start clamps non-finite coordinates to zero and uses the default move duration", () => {
  const s = overlayReduce(init(), {
    type: "step-start",
    caption: "NaN guard",
    target: { x: Number.NaN, y: Infinity },
    now: 0,
  });
  assert.deepEqual(s.cursor?.target, { x: 0, y: 0 });
  const moved = overlayReduce(s, {
    type: "step-start",
    caption: "move",
    target: { x: 10, y: 10 },
    now: 100,
  });
  assert.equal(moved.cursor?.move?.durationMs, OVERLAY_DEFAULT_MOVE_MS);
});

test("step-end clears the caption and leaves the cursor where it was", () => {
  const withStep = overlayReduce(init(), { type: "step-start", caption: "Working", target: { x: 1, y: 2 }, now: 0 });
  const ended = overlayReduce(withStep, { type: "step-end" });
  assert.equal(ended.caption, undefined);
  assert.deepEqual(ended.cursor?.target, { x: 1, y: 2 });
  assert.equal(ended.frameVisible, true, "frame stays on between steps");
});

test("step-end is a no-op when there is no caption", () => {
  const s = init();
  assert.equal(overlayReduce(s, { type: "step-end" }), s, "must return the same reference");
});

test("take-over sets the flag and is idempotent", () => {
  const taken = overlayReduce(init(), { type: "take-over" });
  assert.equal(taken.takenOver, true);
  assert.equal(overlayReduce(taken, { type: "take-over" }), taken);
});

test("release clears take-over and is a no-op when not taken over", () => {
  const taken = overlayReduce(init(), { type: "take-over" });
  const released = overlayReduce(taken, { type: "release" });
  assert.equal(released.takenOver, false);
  assert.equal(overlayReduce(released, { type: "release" }), released);
});

test("done resets the whole state to the initial shape", () => {
  const busy = overlayReduce(init(), { type: "step-start", caption: "X", target: { x: 9, y: 9 }, now: 0 });
  const taken = overlayReduce(busy, { type: "take-over" });
  const finished = overlayReduce(taken, { type: "done" });
  assert.equal(finished.frameVisible, false);
  assert.equal(finished.caption, undefined);
  assert.equal(finished.cursor, undefined);
  assert.equal(finished.takenOver, false);
});

test("done is a no-op on an already-idle state", () => {
  const s = init();
  assert.equal(overlayReduce(s, { type: "done" }), s);
});

test("unknown event types leave the state unchanged", () => {
  const s = overlayReduce(init(), { type: "step-start", caption: "ok", now: 0 });
  const unknown = { type: "future-thing" } as unknown as Parameters<typeof overlayReduce>[1];
  assert.equal(overlayReduce(s, unknown), s);
});

test("cursorPosAt interpolates linearly and clamps outside the move window", () => {
  const cursor = {
    target: { x: 100, y: 0 },
    move: { start: { x: 0, y: 0 }, end: { x: 100, y: 0 }, startedAt: 1000, durationMs: 100 },
  };
  assert.deepEqual(cursorPosAt(cursor, 900), { x: 0, y: 0 }, "before start");
  assert.deepEqual(cursorPosAt(cursor, 1000), { x: 0, y: 0 }, "at start");
  assert.deepEqual(cursorPosAt(cursor, 1050), { x: 50, y: 0 }, "midpoint");
  assert.deepEqual(cursorPosAt(cursor, 1100), { x: 100, y: 0 }, "at end");
  assert.deepEqual(cursorPosAt(cursor, 9999), { x: 100, y: 0 }, "after end");
});

test("cursorPosAt returns the target when there is no active move or duration is zero", () => {
  const idle = { target: { x: 7, y: 8 } };
  assert.deepEqual(cursorPosAt(idle, 0), { x: 7, y: 8 });
  const instant = { target: { x: 7, y: 8 }, move: { start: { x: 0, y: 0 }, end: { x: 7, y: 8 }, startedAt: 0, durationMs: 0 } };
  assert.deepEqual(cursorPosAt(instant, 0), { x: 7, y: 8 });
});