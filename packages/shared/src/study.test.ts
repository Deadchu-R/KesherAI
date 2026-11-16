import { test } from "node:test";
import assert from "node:assert/strict";
import { calcCorrect, doseByWeight, dropRate, formatStats, infusionRate, jsonIn, mergeCourseData, examPlan, cardsToReview, findPassages, practiceProblem, pumpRate, tabletsToGive, volumeToGive, weakLectures, type CalcKind, type StudyReview } from "./study.js";

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

test("benefits for a student's fields come first", async () => {
  const { benefitsFor, STUDENT_BENEFITS } = await import("./study.js");
  assert.equal(benefitsFor(["engineering"])[0]!.fields?.includes("engineering"), true);
  assert.equal(benefitsFor(["nursing"]).length, STUDENT_BENEFITS.length);
  assert.ok(STUDENT_BENEFITS.every((b) => /^https:\/\//.test(b.url) && b.how.he.length && b.checked));
});

test("merging a course from the phone and the computer keeps both, minus deletions", () => {
  const card = (id: string, last?: string) => ({ id, front: id, back: "b", format: "text" as const, createdAt: 1, due: "2026-01-01", fsrs: last ? { last_review: last } : {} });
  const course = { id: "c1234567", name: "Anatomy", createdAt: 1 };
  const pc = { course, lectures: [{ id: "l1", title: "1", date: "2026-11-01", text: "short" }], cards: [card("k1", "2026-11-01T00:00:00Z"), card("k2")], reviews: [{ cardId: "k1", t: 5, rating: 3, format: "text" as const, elapsedDays: 0 }], quizzes: [], removed: ["k3"] };
  const phone = { course: { ...course, name: "Anat", field: "nursing", fieldChosen: true }, lectures: [{ id: "l1", title: "1", date: "2026-11-01", text: "short", summary: "S" }, { id: "l2", title: "2", date: "2026-11-02", text: "x" }], cards: [card("k1", "2026-11-03T00:00:00Z"), card("k3")], reviews: [{ cardId: "k1", t: 5, rating: 3, format: "text" as const, elapsedDays: 0 }, { cardId: "k1", t: 9, rating: 4, format: "text" as const, elapsedDays: 0 }], quizzes: [], removed: ["k2"] };
  const m = mergeCourseData(pc, phone);
  assert.equal(m.course.name, "Anatomy");
  assert.equal(m.course.field, "nursing");
  assert.deepEqual(m.lectures.map((l) => l.id), ["l1", "l2"]);
  assert.equal(m.lectures[0]!.summary, "S");
  assert.deepEqual(m.cards.map((c) => c.id), ["k1"]);
  assert.equal(String(m.cards[0]!.fsrs.last_review), "2026-11-03T00:00:00Z");
  assert.equal(m.reviews.length, 2);
  assert.deepEqual(m.removed?.sort(), ["k2", "k3"]);
});

test("the plan toward an exam brings forward cards scheduled after it", () => {
  const now = Date.parse("2026-11-16T12:00:00");
  const card = (id: string, due: string, last = "2026-11-01T10:00:00") => ({ id, front: id, back: "b", format: "text" as const, createdAt: 1, due, fsrs: { last_review: last }, lectureId: "l1" });
  const d = {
    course: { id: "c1234567", name: "Anatomy", createdAt: 1, examDate: "2026-11-21" },
    lectures: [{ id: "l1", title: "1", date: "2026-11-01", text: "t", summary: "s" }, { id: "l2", title: "2", date: "2026-11-02", text: "t" }],
    cards: [card("now", "2026-11-15T00:00:00"), card("mid", "2026-11-19T00:00:00"), card("late1", "2026-12-01T00:00:00"), card("late2", "2026-12-20T00:00:00"), card("fresh", "2026-12-25T00:00:00", "2026-11-16T09:00:00")],
    reviews: [],
    quizzes: [],
  };
  const p = examPlan(d, now)!;
  assert.equal(p.daysLeft, 5);
  assert.equal(p.dueNow, 1);
  assert.equal(p.beforeExam, 2);
  assert.equal(p.perDay, 1);
  assert.deepEqual(p.notReady.map((l) => l.id), ["l2"]);
  assert.equal(p.testWeek, true);
  assert.deepEqual(cardsToReview(d, now).map((c) => c.id), ["now"]);
  const twoDays = { ...d, course: { ...d.course, examDate: "2026-11-17" } };
  assert.deepEqual(cardsToReview(twoDays, now).map((c) => c.id), ["now", "mid", "late1", "late2"]);
  assert.equal(examPlan({ ...d, course: { ...d.course, examDate: "2026-11-01" } }, now), undefined);
});

test("finding the lecture passages for a question", () => {
  const lectures = [
    { id: "a", title: "תרופות לב", date: "2026-11-01", text: "דיגוקסין מגביר את כוח ההתכווצות. בודקים דופק אפיקלי דקה שלמה." },
    { id: "b", title: "אינסולין", date: "2026-11-02", text: "האינסולין מוריד סוכר בדם. Insulin lowers blood glucose." },
  ];
  assert.deepEqual(findPassages(lectures, "מה עושה הדיגוקסין?").map((p) => p.lectureId), ["a"]);
  assert.equal(findPassages(lectures, "insulin")[0]?.lectureId, "b");
  assert.deepEqual(findPassages(lectures, "מה זה?"), []);
});
