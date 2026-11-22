import assert from "node:assert/strict";
import { test } from "node:test";
import { arrangePoints, checkLevel, describeLevel, footprint, groundHeight, largestFreeRect, seededRandom, type LevelObject } from "./level-design.js";

const obj = (name: string, x: number, z: number, o: Partial<LevelObject> = {}): LevelObject => ({ id: name, name, type: "Cube", pos: [x, 0.5, z], size: [1, 1, 1], yaw: 0, solid: true, movable: true, ...o });
const floor = (): LevelObject => obj("Floor", 0, 0, { size: [40, 0.2, 40], pos: [0, -0.1, 0], ground: true });

test("a line spreads evenly between its ends, or steps by the spacing", () => {
  const even = arrangePoints({ pattern: "line", count: 5, size: [1, 1], from: [0, 0], to: [8, 0] });
  assert.deepEqual(even.placements.map((p) => p.pos[0]), [0, 2, 4, 6, 8]);
  const stepped = arrangePoints({ pattern: "line", count: 10, size: [1, 1], from: [0, 0], to: [4, 0], spacing: 2 });
  assert.equal(stepped.placements.length, 3);
  assert.match(stepped.notes[0]!, /Only 3 fit/);
});

test("a grid is centred, and tightened to fit its bounds but never closer than touching", () => {
  const g = arrangePoints({ pattern: "grid", count: 6, size: [1, 1], columns: 3, spacing: 3, center: [0, 0] });
  assert.deepEqual(g.placements.map((p) => [p.pos[0], p.pos[2]]), [[-3, -1.5], [0, -1.5], [3, -1.5], [-3, 1.5], [0, 1.5], [3, 1.5]]);
  const tight = arrangePoints({ pattern: "grid", count: 9, size: [1, 1], spacing: 5, bounds: { min: [0, 0], max: [8, 8] } });
  assert.equal(tight.placements.length, 9);
  assert.ok(tight.placements.every((p) => p.pos[0] >= 0.5 && p.pos[0] <= 7.5 && p.pos[2] >= 0.5 && p.pos[2] <= 7.5));
  const crowded = arrangePoints({ pattern: "grid", count: 100, size: [2, 2], bounds: { min: [0, 0], max: [6, 6] } });
  assert.ok(crowded.dropped > 0 && crowded.placements.length < 100);
});

test("a circle keeps its radius inside the bounds", () => {
  const c = arrangePoints({ pattern: "circle", count: 4, size: [1, 1], radius: 50, bounds: { min: [-10, -10], max: [10, 10] }, center: [0, 0] });
  assert.equal(c.placements.length, 4);
  assert.ok(c.placements.every((p) => Math.hypot(p.pos[0], p.pos[2]) <= 9.51));
  assert.match(c.notes[0]!, /radius was reduced/);
  const four = arrangePoints({ pattern: "circle", count: 4, size: [1, 1], radius: 5, center: [0, 0] });
  assert.deepEqual(four.placements.map((p) => [p.pos[0], p.pos[2]]), [[5, 0], [0, 5], [-5, 0], [0, -5]]);
});

test("scatter respects spacing, bounds and what is already there, and repeats for a seed", () => {
  const o = { pattern: "scatter" as const, count: 12, size: [1, 1] as [number, number], spacing: 3, bounds: { min: [0, 0] as [number, number], max: [30, 30] as [number, number] }, avoid: [{ min: [10, 10] as [number, number], max: [20, 20] as [number, number] }], seed: 7 };
  const a = arrangePoints(o), b = arrangePoints(o);
  assert.deepEqual(a, b);
  assert.equal(a.placements.length, 12);
  for (const p of a.placements) {
    assert.ok(p.pos[0] >= 0.5 && p.pos[0] <= 29.5 && p.pos[2] >= 0.5 && p.pos[2] <= 29.5);
    assert.ok(!(p.pos[0] > 9.5 && p.pos[0] < 20.5 && p.pos[2] > 9.5 && p.pos[2] < 20.5));
  }
  for (let i = 0; i < a.placements.length; i++) for (let j = i + 1; j < a.placements.length; j++) assert.ok(Math.hypot(a.placements[i]!.pos[0] - a.placements[j]!.pos[0], a.placements[i]!.pos[2] - a.placements[j]!.pos[2]) >= 3 - 0.02);
  const full = arrangePoints({ ...o, count: 500, spacing: 10 });
  assert.ok(full.placements.length < 500 && full.notes.length > 0);
});

test("jitter stays within its limits; ground height lifts the copies", () => {
  const rnd = seededRandom(3);
  assert.ok(rnd() < 1 && seededRandom(3)() === seededRandom(3)());
  const ground = groundHeight([obj("Floor", 0, 0, { size: [20, 0.2, 20], pos: [0, 1, 0], ground: true })]);
  assert.equal(ground(0, 0), 1.1);
  assert.equal(ground(50, 0), undefined);
  const a = arrangePoints({ pattern: "grid", count: 9, size: [1, 1], spacing: 2, center: [0, 0], yaw: 10, yawJitter: 5, posJitter: 0.3, scaleJitter: 0.2, ground, lift: 0.5 });
  for (const p of a.placements) {
    assert.ok(p.yaw >= 5 && p.yaw <= 15 && p.scale >= 0.8 && p.scale <= 1.2);
    assert.equal(p.pos[1], 1.6);
  }
});

test("checks find overlaps, objects outside the bounds and floating ones, but not floors or touching", () => {
  const r = checkLevel([floor(), obj("A", 0, 0), obj("B", 0.5, 0), obj("C", 1, 5), obj("D", 2.02, 5), obj("Edge", 21, 0), obj("Fly", -5, -5, { pos: [-5, 4, -5] }), obj("Light", 3, 3, { solid: false })]);
  assert.deepEqual(r.overlaps.map((o) => [o.a, o.b, o.depth]), [["A", "B", 0.5]]);
  assert.deepEqual(r.outside, [{ name: "Edge", by: 1.5 }]);
  assert.deepEqual(r.floating.map((f) => f.name), ["Fly"]);
  assert.equal(r.checked, 6);
  // A middle-pivot object resting on the floor is not floating; a parent and its child never overlap.
  const rest = checkLevel([floor(), obj("Rest", 0, 0, { pos: [0, 0.5, 0] }), obj("Kid", 0, 0, { parent: "Rest" })]);
  assert.deepEqual([rest.overlaps, rest.floating], [[], []]);
});

test("a turned object covers a bigger box", () => {
  const f = footprint({ pos: [0, 0, 0], size: [2, 1, 2], yaw: 45 });
  assert.ok(Math.abs(f.max[0] - Math.SQRT2) < 1e-9 && Math.abs(f.min[1] + Math.SQRT2) < 1e-9);
});

test("the free space is the biggest empty rectangle", () => {
  const objs = [obj("A", 0.5, 0.5), obj("B", 9.5, 0.5)];
  const free = largestFreeRect(objs, { min: [0, 0], max: [10, 10] }, 1)!;
  assert.equal(free.width * free.depth, 90);
  assert.equal(largestFreeRect([obj("Big", 5, 5, { size: [10, 1, 10] })], { min: [0, 0], max: [10, 10] }, 1), undefined);
});

test("the text map has counts, bounds, areas and free space", () => {
  const text = describeLevel([floor(), ...Array.from({ length: 4 }, (_, i) => obj(`Tree (${i})`, -10 + i, 10, { type: "Tree" })), obj("Crate", 15, -15)], { title: "Unity scene Assets/A.unity" });
  assert.match(text, /^Unity scene Assets\/A.unity: 6 objects/);
  assert.match(text, /By type: Tree ×4, Cube ×2/);
  assert.match(text, /Tree ×4/);
  assert.match(text, /Free space: the biggest empty rectangle/);
  assert.ok(text.split("\n").length < 20);
});
