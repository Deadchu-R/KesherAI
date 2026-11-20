import { test } from "node:test";
import assert from "node:assert/strict";
import { parkChatFor, vramShort } from "./slot-park.js";

const GiB = 1024 ** 3;

test("vramShort: the card with the most free memory decides; unknown cards never stop the chat model", () => {
  assert.equal(vramShort([{ memUsed: 20 * GiB, memTotal: 24 * GiB }]), true);
  assert.equal(vramShort([{ memUsed: 20 * GiB, memTotal: 24 * GiB }, { memUsed: 1 * GiB, memTotal: 16 * GiB }]), false);
  assert.equal(vramShort([]), false);
  assert.equal(vramShort([{ memUsed: 0, memTotal: 0 }]), false);
});

test("parkChatFor: saves the slot, then stops the engine, only when the card is short and nothing else runs", async () => {
  const calls: string[] = [];
  const deps = (o: { running?: boolean; busy?: boolean; short?: boolean } = {}) => ({
    running: () => o.running ?? true,
    busy: () => o.busy ?? false,
    short: () => o.short ?? true,
    park: async () => (calls.push("park"), true),
    stop: async () => void calls.push("stop"),
  });
  assert.equal(await parkChatFor(deps()), true);
  assert.deepEqual(calls, ["park", "stop"]);
  calls.length = 0;
  assert.equal(await parkChatFor(deps({ busy: true })), false, "another chat is answering");
  assert.equal(await parkChatFor(deps({ short: false })), false);
  assert.equal(await parkChatFor(deps({ running: false })), false);
  assert.deepEqual(calls, []);
  // A failed save still frees the card (the chat then reads its conversation again, as before).
  assert.equal(await parkChatFor({ ...deps(), park: async () => { throw new Error("no slots"); } }), true);
});
