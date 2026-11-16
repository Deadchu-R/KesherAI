import assert from "node:assert/strict";
import { test } from "node:test";
import { moveKey } from "./pad-keyboard.js";

test("the controller keyboard's cursor wraps in a row and keeps its column between rows", () => {
  const rows = ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm."];
  assert.deepEqual(moveKey(rows, { r: 1, c: 9 }, "right"), { r: 1, c: 0 });
  assert.deepEqual(moveKey(rows, { r: 1, c: 0 }, "left"), { r: 1, c: 9 });
  assert.deepEqual(moveKey(rows, { r: 1, c: 9 }, "down"), { r: 2, c: 8 });
  assert.deepEqual(moveKey(rows, { r: 0, c: 3 }, "up"), { r: 3, c: 3 });
  // Hebrew letters count as one key each.
  assert.deepEqual(moveKey(["שדג"], { r: 0, c: 2 }, "right"), { r: 0, c: 0 });
});
