import { test } from "node:test";
import assert from "node:assert/strict";
import { calcCorrect, doseByWeight, dropRate, formatStats, infusionRate, jsonIn, practiceProblem, pumpRate, tabletsToGive, volumeToGive, weakLectures, type CalcKind, type StudyReview } from "./study.js";

test("medication calculations: the textbook answers", () => {
  assert.equal(volumeToGive(500, 250, 5).value, 10);
  assert.equal(tabletsToGive(25, 12.5).value, 2);
  assert.equal(doseByWeight(15, 20).value, 300);
  assert.equal(doseByWeight(15, 70, 1000).value, 1000);
  assert.equal(pumpRate(1000, 8).value, 125);
  assert.equal(dropRate(1000, 480, 20).value, 42);
  // 5 mcg/kg/min, 70 kg, 400 mg in 250 mL → 21 mg/h ÷ 1.6 mg/mL = 13.1 mL/h
  assert.equal(infusionRate(5, 70, 400, 250).value, 13.1);
  assert.throws(() => pumpRate(0, 8));
});

test("answers are checked by code", () => {
  const r = pumpRate(1000, 8);
  assert.ok(calcCorrect(125, r));
  assert.ok(calcCorrect(125.5, r));
  assert.ok(!calcCorrect(130, r));
  assert.ok(calcCorrect(42, dropRate(1000, 480, 20)));
  assert.ok(!calcCorrect(40, dropRate(1000, 480, 20)));
});

test("practice problems carry their computed answer", () => {
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (const k of ["volume", "tablets", "weight", "rate", "drops", "infusion"] as CalcKind[]) {
    const p = practiceProblem(k, rnd);
    assert.ok(p.result.value > 0, k);
    assert.ok(p.result.steps.length >= 1, k);
  }
});

test("recall per format counts only reviews after a day", () => {
  const r = (format: StudyReview["format"], rating: number, elapsedDays: number): StudyReview => ({ cardId: "c", t: 0, rating, format, elapsedDays });
  const stats = formatStats([r("text", 1, 2), r("text", 3, 2), r("diagram", 3, 3), r("diagram", 1, 0)], 2);
  assert.deepEqual(stats, [
    { format: "text", n: 2, recall: 0.5, enough: true },
    { format: "diagram", n: 1, recall: 1, enough: false },
  ]);
});

test("weak lectures come first", () => {
  const q = (lectureId: string) => ({ q: "", options: ["a", "b"], answer: 0, explain: "", lectureId });
  const w = weakLectures([{ id: "z", t: 0, questions: [q("a"), q("a"), q("b"), q("b")], answers: [0, 0, 1, 0] }]);
  assert.deepEqual(w.map((x) => x.lectureId), ["b", "a"]);
});

test("JSON is found inside a model's answer", () => {
  assert.deepEqual(jsonIn('Here:\n```json\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.deepEqual(jsonIn('Sure! {"x": [1,2]} done'), { x: [1, 2] });
  assert.equal(jsonIn("no json"), undefined);
});

test("a course's field is recognised from its name and lectures", async () => {
  const { detectField } = await import("./study.js");
  assert.equal(detectField("פרמקולוגיה", "תרופות לב. מתן תרופה למטופל"), "nursing");
  assert.equal(detectField("דיני חוזים", "סעיף 12 לחוק החוזים. פסק דין"), "law");
  assert.equal(detectField("Data Structures", "algorithm complexity, python"), "cs");
  assert.equal(detectField("חדו\"א 1", "נגזרת ואינטגרל"), "math");
  assert.equal(detectField("קורס", "שלום"), undefined);
  assert.equal(detectField("מבוא", "לפי החוק והסעיף, ובפסק הדין"), "law");
});
