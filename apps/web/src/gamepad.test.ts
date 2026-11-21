import { test } from "node:test";
import assert from "node:assert/strict";
import { insideClosedDetails, nearest } from "./gamepad.js";

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

test("the controller skips what a closed <details> folds away, but not its summary", () => {
  type Fake = { tagName: string; parentElement: Fake | null; children: Fake[]; attrs: string[]; hasAttribute(n: string): boolean };
  const make = (tagName: string, parent: Fake | null, attrs: string[] = []): Fake => {
    const n: Fake = { tagName, parentElement: parent, children: [], attrs, hasAttribute: (a) => n.attrs.includes(a) };
    parent?.children.push(n);
    return n;
  };
  const main = make("MAIN", null);
  const details = make("DETAILS", main);
  const summary = make("SUMMARY", details);
  const inSummary = make("STRONG", summary);
  const body = make("DIV", details);
  const button = make("BUTTON", body);
  const outside = make("BUTTON", main);
  // A nested closed <details> inside an open one: its summary shows, its body does not.
  const open = make("DETAILS", main, ["open"]);
  make("SUMMARY", open);
  const inner = make("DETAILS", open);
  const innerSummary = make("SUMMARY", inner);
  const innerBody = make("A", inner);

  assert.equal(insideClosedDetails(button), true);
  assert.equal(insideClosedDetails(summary), false);
  assert.equal(insideClosedDetails(inSummary), false);
  assert.equal(insideClosedDetails(outside), false);
  assert.equal(insideClosedDetails(innerSummary), false);
  assert.equal(insideClosedDetails(innerBody), true);
  details.attrs.push("open");
  assert.equal(insideClosedDetails(button), false);
});
