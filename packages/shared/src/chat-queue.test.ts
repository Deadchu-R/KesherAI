import { test } from "node:test";
import assert from "node:assert/strict";
import { editQueued, moveQueued, sendNowQueued, stopAsks, takeSteers, wantsSteer } from "./chat-queue.js";

const q = [
  { id: "a", text: "one" },
  { id: "b", text: "two" },
  { id: "c", text: "three" },
];

test("editQueued changes only the named message, refuses empty text and unknown ids", () => {
  assert.deepEqual(editQueued(q, "b", "  two!  ")?.map((x) => x.text), ["one", "two!", "three"]);
  assert.equal(editQueued(q, "b", "   "), undefined);
  assert.equal(editQueued(q, "z", "x"), undefined);
  assert.equal(q[1]!.text, "two", "the old list is not changed");
});

test("sendNowQueued moves the message first and marks it to steer", () => {
  const next = sendNowQueued(q, "c")!;
  assert.deepEqual(next.map((x) => x.id), ["c", "a", "b"]);
  assert.equal(next[0]!.steer, true);
  assert.equal(next[1]!.steer, undefined);
  assert.equal(sendNowQueued(q, "z"), undefined);
});

test("takeSteers splits steering messages from waiting ones, keeping the order", () => {
  const { steer, rest } = takeSteers([{ id: "a", text: "1", steer: true }, { id: "b", text: "2" }, { id: "c", text: "3", steer: true }]);
  assert.deepEqual(steer.map((x) => x.id), ["a", "c"]);
  assert.deepEqual(rest.map((x) => x.id), ["b"]);
});

test("moveQueued moves one message to a new index, clamped, and refuses no-op or unknown moves", () => {
  assert.deepEqual(moveQueued(q, "c", 0)?.map((x) => x.id), ["c", "a", "b"]);
  assert.deepEqual(moveQueued(q, "a", 1)?.map((x) => x.id), ["b", "a", "c"]);
  assert.deepEqual(moveQueued(q, "a", 99)?.map((x) => x.id), ["b", "c", "a"], "past the end goes last");
  assert.deepEqual(moveQueued(q, "c", -5)?.map((x) => x.id), ["c", "a", "b"], "before the start goes first");
  assert.equal(moveQueued(q, "b", 1), undefined, "already there");
  assert.equal(moveQueued(q, "z", 0), undefined);
  assert.equal(moveQueued(q, "a", Number.NaN), undefined);
  assert.deepEqual(q.map((x) => x.id), ["a", "b", "c"], "the old list is not changed");
});

test("wantsSteer: only while busy, with Alt+Enter or the Steer mode, and only if the turn can take it", () => {
  assert.equal(wantsSteer({ busy: true, mode: "queue" }), false);
  assert.equal(wantsSteer({ busy: true, mode: "queue", alt: true }), true);
  assert.equal(wantsSteer({ busy: true, mode: "steer" }), true);
  assert.equal(wantsSteer({ busy: false, mode: "steer", alt: true }), false, "a free chat just sends");
  assert.equal(wantsSteer({ busy: true, mode: "steer", alt: true, canSteer: false }), false, "an outside agent: falls back to the queue");
});

test("stopAsks: Stop asks about the queue only when messages wait and it is not paused", () => {
  assert.equal(stopAsks(2), true);
  assert.equal(stopAsks(0), false);
  assert.equal(stopAsks(2, true), false, "a paused queue: Stop stops at once");
});
