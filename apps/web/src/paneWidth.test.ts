import { test } from "node:test";
import assert from "node:assert/strict";
import { clampPaneWidth, expandedPaneWidth, initialPaneWidth } from "./paneWidth";

test("the browser pane starts at 45% of a wide window, the other panes at 360 px", () => {
  assert.equal(initialPaneWidth(null, 3840, true), 1728);
  assert.equal(initialPaneWidth(undefined, 1000, true), 400);
  assert.equal(initialPaneWidth(null, 3840, false), 360);
});

test("a remembered width wins, inside the limits (720 px for small panes, 80% of the window for the browser)", () => {
  assert.equal(initialPaneWidth("900", 3840, true), 900);
  assert.equal(initialPaneWidth("900", 3840, false), 720);
  assert.equal(initialPaneWidth("50", 1920, true), 260);
  assert.equal(initialPaneWidth("garbage", 1920, true), 864);
  assert.equal(clampPaneWidth(5000, 1920, true), 1536);
});

test("expanded gives the browser most of the window", () => {
  assert.equal(expandedPaneWidth(1920), 1498);
  assert.ok(expandedPaneWidth(3840) <= 3840 * 0.8);
});
