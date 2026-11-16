import { test } from "node:test";
import assert from "node:assert/strict";
import { stamp, stampSeconds } from "./study-time";

test("minute marks in a lecture transcript", () => {
  assert.equal(stamp(0), "[00:00]");
  assert.equal(stamp(754.9), "[12:34]");
  assert.equal(stamp(3725), "[1:02:05]");
});

test("transcript lines go back into time order by their marks (slides read later)", () => {
  assert.equal(stampSeconds(`${stamp(75)} hi`), 75);
  assert.equal(stampSeconds(`${stamp(3725)} x`), 3725);
  assert.equal(stampSeconds("no mark"), 0);
  const lines = [`${stamp(30)} a`, `${stamp(90)} b`, `${stamp(45)} 📸 slide`];
  assert.deepEqual([...lines].sort((x, y) => stampSeconds(x) - stampSeconds(y)).map((l) => l.slice(-1)), ["a", "e", "b"]);
});
