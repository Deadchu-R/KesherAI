import assert from "node:assert/strict";
import { test } from "node:test";
import { nextTab } from "./tabKeys.js";

test("arrow keys move between tabs, mirrored right to left, and wrap", () => {
  assert.equal(nextTab(3, 0, "ArrowRight", false), 1);
  assert.equal(nextTab(3, 2, "ArrowRight", false), 0);
  assert.equal(nextTab(3, 0, "ArrowLeft", true), 1);
  assert.equal(nextTab(3, 0, "ArrowRight", true), 2);
  assert.equal(nextTab(3, 1, "End", false), 2);
  assert.equal(nextTab(3, 1, "Enter", false), -1);
  assert.equal(nextTab(1, 0, "ArrowRight", false), -1);
});
