import { test } from "node:test";
import assert from "node:assert/strict";
import { editQueued, sendNowQueued, stopStage, takeSteers } from "./chat-queue.js";

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

test("stopStage: the first Stop clears waiting messages, the next one stops", () => {
  assert.equal(stopStage(2), "clear");
  assert.equal(stopStage(0), "stop");
  assert.equal(stopStage(2, true), "stop", "a paused queue does not need a clear first");
});
