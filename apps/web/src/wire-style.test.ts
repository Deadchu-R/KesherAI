import { test } from "node:test";
import assert from "node:assert/strict";
import { LEAD, manhattanPoints, ribbonOffset, roundedPath, subwayPoints, wireLook, wirePath } from "./wire-style";

test("right-angle wires: straight out, across in the middle, straight in; behind goes around", () => {
  assert.deepEqual(manhattanPoints({ x: 0, y: 0 }, { x: 200, y: 100 }), [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 100 }]);
  // Ribbon moves the vertical part, never past the leads.
  assert.equal(manhattanPoints({ x: 0, y: 0 }, { x: 200, y: 100 }, 14)[1]!.x, 114);
  assert.equal(manhattanPoints({ x: 0, y: 0 }, { x: 60, y: 100 }, 50)[1]!.x, 60 - LEAD);
  // Same height: one straight line.
  assert.deepEqual(manhattanPoints({ x: 0, y: 40 }, { x: 300, y: 40 }), [{ x: 0, y: 40 }, { x: 300, y: 40 }]);
  // The input is to the left: out, across, back, in from its left side.
  const back = manhattanPoints({ x: 300, y: 0 }, { x: 0, y: 200 });
  assert.deepEqual(back.map((p) => [p.x, p.y]), [[300, 0], [300 + LEAD, 0], [300 + LEAD, 100], [-LEAD, 100], [-LEAD, 200], [0, 200]]);
});

test("45° wires: the diagonal covers the height difference exactly; no room means right angles", () => {
  const p = subwayPoints({ x: 0, y: 0 }, { x: 300, y: 80 });
  assert.equal(p.length, 4);
  assert.equal(p[2]!.x - p[1]!.x, 80, "45°: as wide as it is tall");
  assert.equal(p[1]!.y, 0);
  assert.equal(p[2]!.y, 80);
  assert.equal(subwayPoints({ x: 0, y: 0 }, { x: 100, y: 300 }).length, manhattanPoints({ x: 0, y: 0 }, { x: 100, y: 300 }).length);
});

test("rounded corners stay inside short segments; 0 is sharp; curves stay the engines' own", () => {
  assert.equal(roundedPath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 0), "M0,0 L100,0 L100,100");
  assert.equal(roundedPath([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 10), "M0,0 L90,0 Q100,0 100,10 L100,100");
  // A 6-unit segment allows only a 3-unit corner.
  assert.match(roundedPath([{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 6, y: 50 }], 10), /L3,0 Q6,0 6,3/);
  assert.match(wirePath({ x: 0, y: 0 }, { x: 200, y: 50 }, "curve", 10), /^M0,0 C100,0 100,50 200,50$/);
});

test("ribbon spreads a node's wired outputs around the middle; defaults keep curves until chosen", () => {
  assert.equal(ribbonOffset(0, 1), 0);
  assert.deepEqual([0, 1, 2].map((i) => ribbonOffset(i, 3)), [-7, 0, 7]);
  assert.deepEqual(wireLook(undefined), { style: "curve", exec: "curve", radius: 10, ribbon: true, bubbles: true });
  assert.equal(wireLook({ style: "manhattan" }).exec, "manhattan", "exec follows the style unless set");
  assert.equal(wireLook({ style: "manhattan", exec: "subway" }).exec, "subway");
});
