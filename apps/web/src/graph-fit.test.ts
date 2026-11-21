import { test } from "node:test";
import assert from "node:assert/strict";
import { resizeAction, SETTLE_MS } from "./graph-fit";

test("a hidden frame does nothing", () => {
  assert.equal(resizeAction({ width: 800, height: 600 }, { width: 0, height: 0 }, 99_999), null);
});

test("a frame that had no size, or settles just after opening, fits again", () => {
  assert.equal(resizeAction({ width: 0, height: 0 }, { width: 800, height: 600 }, 99_999), "fit");
  assert.equal(resizeAction({ width: 800, height: 900 }, { width: 800, height: 520 }, 200), "fit");
});

test("later the middle stays in the middle, with the same zoom", () => {
  assert.deepEqual(resizeAction({ width: 800, height: 600 }, { width: 600, height: 700 }, SETTLE_MS + 1), { dx: -100, dy: 50 });
  assert.equal(resizeAction({ width: 800, height: 600 }, { width: 800, height: 600 }, SETTLE_MS + 1), null);
});
