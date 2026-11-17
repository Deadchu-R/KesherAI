import { test } from "node:test";
import assert from "node:assert/strict";
import { averageNeeded, cleanGrades, neededFor, rowGrade, weightedAverage, type GradeRow } from "./grades.js";

const pharm: GradeRow = { id: "a", name: "פרמקולוגיה", credits: 4, parts: [{ name: "מבחן", weight: 70 }, { name: "עבודות", weight: 30, score: 92 }], minExam: 56 };
const physio: GradeRow = { id: "b", name: "פיזיולוגיה", credits: 5, parts: [{ name: "מבחן", weight: 80, score: 88 }, { name: "תרגילים", weight: 20, score: 95 }] };
const stats: GradeRow = { id: "c", name: "סטטיסטיקה", credits: 3, parts: [], final: 78 };

test("a course's grade, from its parts or typed", () => {
  assert.deepEqual(rowGrade(physio), { grade: 89.4, sofar: 89.4, left: 0 });
  assert.deepEqual(rowGrade(pharm), { sofar: 92, left: 70 });
  assert.deepEqual(rowGrade(stats), { grade: 78, left: 0 });
  // Weights that do not add up to 100 count relative to their sum.
  assert.equal(rowGrade({ id: "d", name: "x", credits: 1, parts: [{ name: "", weight: 1, score: 80 }, { name: "", weight: 1, score: 60 }] }).grade, 70);
});

test("what she needs in the exam, at least the passing exam score", () => {
  // (85 × 100 − 92 × 30) / 70 = 82
  assert.equal(neededFor(pharm, 85), 82);
  assert.equal(neededFor(pharm, 40), 56);
  assert.equal(neededFor(pharm, 100), 104); // out of reach
  assert.equal(neededFor(physio, 90), undefined);
  assert.equal(neededFor(stats, 90), undefined);
});

test("the weighted average and the average needed in the credits to come", () => {
  // (89.4 × 5 + 78 × 3) / 8
  assert.deepEqual(weightedAverage([pharm, physio, stats]), { average: 85.13, credits: 8 });
  assert.equal(averageNeeded([physio, stats], 88, 12), 89.9);
  assert.equal(averageNeeded([physio], 88, 0), undefined);
});

test("cleanGrades keeps numbers in range and drops what is not a course", () => {
  const g = cleanGrades({ rows: [{ name: " קורס ", credits: "4", parts: [{ name: "מבחן", weight: 140, score: -5 }, { weight: "x" }], final: "" }, { name: "" }, null], target: 88, remaining: -3 });
  assert.equal(g.rows.length, 1);
  assert.equal(g.rows[0]!.name, "קורס");
  assert.equal(g.rows[0]!.credits, 4);
  assert.deepEqual(g.rows[0]!.parts, [{ name: "מבחן", weight: 100, score: 0 }]);
  assert.equal(g.rows[0]!.final, undefined);
  assert.equal(g.target, 88);
  assert.equal(g.remaining, 0);
});
