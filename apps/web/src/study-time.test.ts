import { test } from "node:test";
import assert from "node:assert/strict";
import { stamp } from "./study-time";

test("minute marks in a lecture transcript", () => {
  assert.equal(stamp(0), "[00:00]");
  assert.equal(stamp(754.9), "[12:34]");
  assert.equal(stamp(3725), "[1:02:05]");
});
