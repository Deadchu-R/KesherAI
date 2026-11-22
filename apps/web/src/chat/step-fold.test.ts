import assert from "node:assert/strict";
import { test } from "node:test";
import { actedOnShots, foldHeader, formatClock, overlayPercent, shotFrame, stepAction, turnDuration } from "./step-fold.js";

test("formatClock: m:ss and h:mm:ss", () => {
  assert.equal(formatClock(102_000), "1:42");
  assert.equal(formatClock(7_400), "0:07");
  assert.equal(formatClock(3_723_000), "1:02:03");
});

test("foldHeader: finished and running, in both languages", () => {
  assert.equal(foldHeader({ steps: 12, ms: 102_000, running: false }, false), "What the model did · 12 steps · 1:42");
  assert.equal(foldHeader({ steps: 1, running: false }, false), "What the model did · 1 step");
  assert.equal(foldHeader({ steps: 12, ms: 102_000, running: false }, true), "מה המודל עשה · 12 צעדים · 1:42");
  assert.equal(foldHeader({ steps: 5, running: true, current: "click 'Save'" }, false), "Working… step 5: click 'Save'");
  assert.equal(foldHeader({ steps: 5, running: true }, true), "עובד… צעד 5");
});

test("turnDuration: to the last result, or to now while a step runs", () => {
  const a = { call: { at: "2026-11-22T10:00:00Z" }, result: { at: "2026-11-22T10:00:30Z" } };
  const b = { call: { at: "2026-11-22T10:00:40Z" }, result: { at: "2026-11-22T10:01:42Z" } };
  assert.equal(turnDuration([a, b], 0), 102_000);
  const c = { call: { at: "2026-11-22T10:02:00Z" } };
  assert.equal(turnDuration([a, c], Date.parse("2026-11-22T10:02:10Z")), 130_000);
  assert.equal(turnDuration([{ call: {} }], 5), undefined);
});

test("stepAction reads clicks, typing and scrolls", () => {
  assert.deepEqual(stepAction("computer_click", { x: 10, y: 20 }), { kind: "click", x: 10, y: 20 });
  assert.deepEqual(stepAction("browser_click_at", { x: 1, y: 2 }), { kind: "click", x: 1, y: 2 });
  assert.equal(stepAction("computer_type", { text: "a".repeat(60) })?.text?.length, 40);
  assert.equal(stepAction("computer_scroll", { x: 5, y: 5, amount: -3 })?.dir, "up");
  assert.equal(stepAction("browser_scroll", { direction: "left" })?.dir, "left");
  assert.equal(stepAction("computer_screenshot", {}), undefined);
  assert.equal(stepAction("computer_click", {}), undefined);
});

test("overlayPercent scales to any display size and holds points inside", () => {
  assert.deepEqual(overlayPercent({ x: 640, y: 180 }, { w: 1280, h: 720 }), { left: 50, top: 25 });
  assert.deepEqual(overlayPercent({ x: 2000, y: -5 }, { w: 1280, h: 720 }), { left: 100, top: 0 });
  // Coordinates from a 2560 px screen shown on a 1280 px picture land at the same place.
  assert.deepEqual(overlayPercent({ x: 1280, y: 720 }, { w: 2560, h: 1440 }), { left: 50, top: 50 });
});

test("shotFrame reads the size from the screenshot text", () => {
  assert.deepEqual(shotFrame('Screenshot 1280×720. In front: Notepad "x" (app).'), { w: 1280, h: 720 });
  assert.equal(shotFrame("(the screenshot)"), undefined);
});

test("actedOnShots pairs an action with the screenshot before it", () => {
  const steps = [
    { call: { callId: "a", name: "computer_screenshot", input: {} }, result: { output: "Screenshot 1280×720.", assetIds: ["s1"] } },
    { call: { callId: "b", name: "computer_click", input: { x: 5, y: 6 } }, result: { output: "ok" } },
    { call: { callId: "c", name: "computer_type", input: { text: "hi" } }, result: { output: "ok" } },
  ];
  const m = actedOnShots(steps);
  assert.equal(m.get("b")?.assetId, "s1");
  assert.deepEqual(m.get("b")?.frame, { w: 1280, h: 720 });
  assert.equal(m.get("c")?.action.kind, "type");
  assert.equal(m.has("a"), false);
});
