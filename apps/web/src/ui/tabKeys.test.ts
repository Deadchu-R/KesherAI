import assert from "node:assert/strict";
import { test } from "node:test";
import { nextTab, swipeKey } from "./tabKeys.js";

test("arrow keys move between tabs, mirrored right to left, and wrap", () => {
  assert.equal(nextTab(3, 0, "ArrowRight", false), 1);
  assert.equal(nextTab(3, 2, "ArrowRight", false), 0);
  assert.equal(nextTab(3, 0, "ArrowLeft", true), 1);
  assert.equal(nextTab(3, 0, "ArrowRight", true), 2);
  assert.equal(nextTab(3, 1, "End", false), 2);
  assert.equal(nextTab(3, 1, "Enter", false), -1);
  assert.equal(nextTab(1, 0, "ArrowRight", false), -1);
});

test("a sideways swipe stands for an arrow key; a scroll, a short or slow move does not", () => {
  assert.equal(swipeKey(-120, 10, 250, 390), "ArrowRight");
  assert.equal(swipeKey(120, -20, 250, 390), "ArrowLeft");
  assert.equal(swipeKey(-40, 0, 200, 390), "", "too short");
  assert.equal(swipeKey(-120, 90, 250, 390), "", "more up-down than sideways");
  assert.equal(swipeKey(-200, 0, 1200, 390), "", "too slow");
  // Right to left: the finger moving right brings the next tab (the one on the left).
  assert.equal(nextTab(4, 0, swipeKey(150, 0, 200, 390), true), 1);
});
