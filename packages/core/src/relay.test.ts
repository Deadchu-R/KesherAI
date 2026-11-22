import { test } from "node:test";
import assert from "node:assert/strict";
import { pickRelay, relayList } from "./relay.js";

test("relays: the hub today, in priority order; the next one after a failure, the first again when all failed", () => {
  assert.deepEqual(relayList({}), []);
  const one = relayList({ url: "https://hub.example.com" });
  assert.deepEqual(one, [{ id: "hub:https://hub.example.com", kind: "kesher-hub", url: "https://hub.example.com" }]);
  assert.equal(pickRelay(one, new Set())?.url, "https://hub.example.com");
  const two = [...one, { id: "b", kind: "kesher-hub" as const, url: "https://b.example.com" }];
  assert.equal(pickRelay(two, new Set([one[0]!.id]))?.url, "https://b.example.com");
  assert.equal(pickRelay(two, new Set([one[0]!.id, "b"]))?.url, "https://hub.example.com");
  assert.equal(pickRelay([], new Set()), undefined);
});
