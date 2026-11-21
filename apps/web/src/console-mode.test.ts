import { test } from "node:test";
import assert from "node:assert/strict";
import { COMBO_HOLD_MS, COMBO_IDLE, comboStep, consoleOn, gamePrompt, gridCols, gridMove, markConsoleOffered, setConsoleOn, shouldOfferConsole } from "./console-mode";

/** A Storage-like map for the tests. */
function memory(): Pick<Storage, "getItem" | "setItem"> {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

test("gridCols: four on a handheld or TV, three on a small window, two on a phone", () => {
  assert.equal(gridCols(1280), 4);
  assert.equal(gridCols(800), 3);
  assert.equal(gridCols(390), 2);
});

test("gridMove: left and right stay in the row, no wrap", () => {
  // 7 tiles in 4 columns: row 0 = 0..3, row 1 = 4..6.
  assert.equal(gridMove(0, 7, 4, "right"), 1);
  assert.equal(gridMove(3, 7, 4, "right"), 3);
  assert.equal(gridMove(4, 7, 4, "left"), 4);
  assert.equal(gridMove(6, 7, 4, "right"), 6);
});

test("gridMove: up and down by a row; a short last row takes the last tile", () => {
  assert.equal(gridMove(1, 7, 4, "down"), 5);
  assert.equal(gridMove(3, 7, 4, "down"), 6);
  assert.equal(gridMove(5, 7, 4, "up"), 1);
  assert.equal(gridMove(5, 7, 4, "down"), 5);
  assert.equal(gridMove(1, 7, 4, "up"), 1);
});

test("gridMove: the continue card above the grid", () => {
  assert.equal(gridMove(2, 7, 4, "up", { header: true }), -1);
  assert.equal(gridMove(-1, 7, 4, "down", { header: true }), 0);
  assert.equal(gridMove(-1, 7, 4, "left", { header: true }), -1);
  assert.equal(gridMove(-1, 0, 4, "down", { header: true }), -1);
});

test("gridMove: right to left swaps the sides", () => {
  assert.equal(gridMove(0, 7, 4, "left", { rtl: true }), 1);
  assert.equal(gridMove(1, 7, 4, "right", { rtl: true }), 0);
  assert.equal(gridMove(0, 7, 4, "right", { rtl: true }), 0);
});

test("console on/off is kept per device, off by default", () => {
  const s = memory();
  assert.equal(consoleOn(s), false);
  setConsoleOn(true, s);
  assert.equal(consoleOn(s), true);
  setConsoleOn(false, s);
  assert.equal(consoleOn(s), false);
});

test("the offer shows once per handheld and never while the mode is on", () => {
  const s = memory();
  assert.equal(shouldOfferConsole("", s), false);
  assert.equal(shouldOfferConsole("ROG Xbox Ally X", s), true);
  markConsoleOffered("ROG Xbox Ally X", s);
  assert.equal(shouldOfferConsole("ROG Xbox Ally X", s), false);
  assert.equal(shouldOfferConsole("Steam Deck", s), true);
  setConsoleOn(true, s);
  assert.equal(shouldOfferConsole("Steam Deck", s), false);
});

test("View+Menu: switches once after the hold, and marks the press used", () => {
  let s = comboStep(COMBO_IDLE, true, true, 1000);
  assert.equal(s.toggle, false);
  assert.equal(s.used, true);
  s = comboStep(s, true, true, 1000 + COMBO_HOLD_MS - 1);
  assert.equal(s.toggle, false);
  s = comboStep(s, true, true, 1000 + COMBO_HOLD_MS);
  assert.equal(s.toggle, true);
  s = comboStep(s, true, true, 1000 + COMBO_HOLD_MS + 500);
  assert.equal(s.toggle, false, "fires once per hold");
  s = comboStep(s, true, false, 3000);
  assert.equal(s.used, true, "still used until both are up");
  s = comboStep(s, false, false, 3100);
  assert.deepEqual({ ...s }, { fired: false, used: false, toggle: false });
});

test("View+Menu: a short tap of both does not switch", () => {
  let s = comboStep(COMBO_IDLE, true, true, 0);
  s = comboStep(s, false, false, 200);
  assert.equal(s.toggle, false);
  s = comboStep(s, true, true, 300);
  assert.equal(s.since, 300);
});

test("gamePrompt: tips are short and local, the guide searches and hides spoilers", () => {
  const tip = gamePrompt("tip", "ELDEN RING", false);
  assert.equal(tip.web, false);
  assert.match(tip.text, /ELDEN RING/);
  assert.match(tip.text, /no spoilers/);
  const guide = gamePrompt("guide", "ELDEN RING", true);
  assert.equal(guide.web, true);
  assert.match(guide.text, /\|\|כך\|\|/);
  assert.doesNotMatch(gamePrompt("shot", "", false).text, /playing/);
});
