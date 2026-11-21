import { test } from "node:test";
import assert from "node:assert/strict";
import { CLICK_WINDOW, SlideGesture } from "./slideGesture";

const btn = { id: "plus" };

test("a tap toggles once: the browser's click after the lift is swallowed, whatever it lands on", () => {
  const g = new SlideGesture();
  g.press();
  g.down({ x: 20, y: 750 }, btn, 0);
  assert.equal(g.active, true);
  assert.deepEqual(g.lift(120), { slid: false });
  assert.equal(g.active, false);
  // The phone's click for the tap (on the button, or on the sheet that opened under the finger).
  assert.equal(g.swallowClick(true, 125), true);
  // Only one click per gesture.
  assert.equal(g.swallowClick(true, 130), false);
});

test("the click that opens the menu (made by code) is never swallowed", () => {
  const g = new SlideGesture();
  g.down({ x: 0, y: 0 }, btn, 0);
  assert.equal(g.swallowClick(false, 1), false);
  g.lift(50);
  assert.equal(g.swallowClick(true, 55), true);
});

test("small finger jitter stays a tap; a real move is a slide", () => {
  const g = new SlideGesture();
  g.down({ x: 100, y: 100 }, btn, 0);
  assert.equal(g.move({ x: 104, y: 103 }), false);
  assert.equal(g.isSliding, false);
  assert.equal(g.move({ x: 100, y: 130 }), true);
  // Once sliding, it keeps sliding even back near the start.
  assert.equal(g.move({ x: 101, y: 101 }), true);
  assert.deepEqual(g.lift(300), { slid: true });
});

test("moves without a press are ignored", () => {
  const g = new SlideGesture();
  assert.equal(g.move({ x: 500, y: 500 }), false);
});

test("keyboard clicks (no gesture) are never swallowed", () => {
  const g = new SlideGesture();
  assert.equal(g.swallowClick(true, 10), false);
});

test("a click long after the lift is not the gesture's", () => {
  const g = new SlideGesture();
  g.down({ x: 0, y: 0 }, btn, 0);
  g.lift(100);
  assert.equal(g.swallowClick(true, 100 + CLICK_WINDOW + 1), false);
});

test("a finger that slid gets no click; the next tap elsewhere is not swallowed", () => {
  const g = new SlideGesture();
  g.press();
  g.down({ x: 0, y: 0 }, btn, 0);
  g.move({ x: 0, y: 80 });
  g.lift(200);
  // The next press (on an item, on another button) starts a new gesture before its own click.
  g.press();
  assert.equal(g.swallowClick(true, 260), false);
});

test("a cancelled press (pointercancel) still owns its late click", () => {
  const g = new SlideGesture();
  g.down({ x: 0, y: 0 }, btn, 0);
  g.lift(40);
  assert.equal(g.swallowClick(true, 45), true);
});
