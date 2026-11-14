import { test } from "node:test";
import assert from "node:assert/strict";
import { nearest } from "./gamepad.js";

test("the controller moves to the nearest control in a direction", () => {
  const at = { x: 100, y: 100, w: 100, h: 40 };
  const boxes = [
    { x: 100, y: 200, w: 100, h: 40 }, // 0: straight below
    { x: 400, y: 160, w: 100, h: 40 }, // 1: below, far right
    { x: 260, y: 100, w: 100, h: 40 }, // 2: right, same row
    { x: 100, y: 20, w: 100, h: 40 }, // 3: above
    { x: -150, y: 100, w: 100, h: 40 }, // 4: left
  ];
  assert.equal(nearest(at, boxes, "down"), 0);
  assert.equal(nearest(at, boxes, "right"), 2);
  assert.equal(nearest(at, boxes, "up"), 3);
  assert.equal(nearest(at, boxes, "left"), 4);
  assert.equal(nearest(at, [], "down"), -1);
});
