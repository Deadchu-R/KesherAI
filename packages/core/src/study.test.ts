import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pieces, Study } from "./study.js";

/** A model that answers by what the system prompt asks for. */
const fake = () => ({
  id: "fake",
  turn: (async (req: { messages: Array<{ role: string; content: string }> }) => {
    const sys = req.messages[0]!.content;
    if (sys.includes("photos of study material")) return { text: (req.messages[1] as { images?: unknown[] }).images?.length ? "לוח: לחץ דם 120/80" : "NO-IMAGE" };
    if (sys.includes("drug cards")) return { text: '[{"name":"Digoxin","drugClass":"Cardiac glycoside","nursing":"Apical pulse a full minute; hold under 60","sideEffects":"Nausea, visual changes"},{"name":""}]' };
    if (sys.includes("flashcards")) return { text: '```json\n[{"front":"מה עושה אינסולין?","back":"מוריד סוכר בדם","kind":"drug"},{"front":"Normal K+?","back":"3.5–5.0 mEq/L","kind":"concept"},{"front":"bad"}]\n```' };
    if (sys.includes("multiple-choice")) return { text: 'Here: [{"q":"Q1","options":["a","b","c","d"],"answer":2,"explain":"because","lecture":1},{"q":"broken","options":["a"],"answer":0}]' };
    return { text: '{"summary":"סיכום","terms":[{"term":"אינסולין","en":"Insulin","explain":"הורמון"}],"diagram":"flowchart LR\\nA-->B"}' };
  }) as never,
});

test("a course: lecture, summary, cards, review and quiz", async () => {
  const dir = await mkdtemp(join(tmpdir(), "study-"));
  try {
    const st = new Study(dir, fake);
    const c = await st.addCourse("פרמקולוגיה");
    const l = await st.addLecture(c.id, { title: "אינסולין", text: "אינסולין מוריד סוכר בדם. Insulin." });
    const s = await st.summarize(c.id, l.id);
    assert.equal(s.summary, "סיכום");
    assert.equal(s.terms?.[0]?.en, "Insulin");
    assert.equal(s.diagram, "flowchart LR\nA-->B");

    const cards = await st.makeCards(c.id, l.id, { format: "diagram", count: 5 });
    assert.equal(cards.length, 2);
    assert.equal(cards[0]!.format, "diagram");
    assert.equal((await st.due(c.id)).length, 2);
    const after = await st.review(c.id, cards[0]!.id, 3);
    assert.ok(Date.parse(after.due) > Date.now());
    assert.equal((await st.get(c.id)).reviews.length, 1);
    await assert.rejects(st.review(c.id, cards[0]!.id, 7));

    const quiz = await st.makeQuiz(c.id, {});
    assert.equal(quiz.questions.length, 1);
    assert.equal(quiz.questions[0]!.lectureId, l.id);
    const graded = await st.answerQuiz(c.id, quiz.id, [2]);
    assert.equal(graded.score, 1);

    const drugs = await st.makeDrugs(c.id, l.id);
    assert.equal(drugs.length, 1);
    assert.equal(drugs[0]!.nursing, "Apical pulse a full minute; hold under 60");
    assert.equal((await st.get(c.id)).cards.filter((x) => x.kind === "drug" && x.front.startsWith("Digoxin")).length, 3);
    // The same drug again updates it (no new cards).
    await st.makeDrugs(c.id, l.id);
    assert.equal((await st.get(c.id)).drugs?.length, 1);

    // Kept on disk.
    const again = new Study(dir, fake);
    assert.equal((await again.list())[0]?.cards, 5);
    await assert.rejects(again.get("../etc"), /No such course/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("long lectures are cut into pieces at line ends", () => {
  const text = Array.from({ length: 400 }, (_, i) => `line ${i} `.repeat(8)).join("\n");
  const ps = pieces(text, 5000);
  assert.ok(ps.length > 1);
  assert.ok(ps.every((p) => p.length <= 5000));
  assert.equal(ps.join("\n").replace(/\s+/g, ""), text.replace(/\s+/g, ""));
});

test("sync with the phone merges courses and keeps deletions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-study-sync-"));
  try {
    const st = new Study(dir, () => undefined);
    const pc = await st.addCourse("Pharmacology");
    const lec = await st.addLecture(pc.id, { text: "on the computer" });
    const phoneCourse = { course: { id: pc.id, name: "Pharma", createdAt: 1 }, lectures: [{ id: "phone-lec-1", title: "p", date: "2026-11-10", text: "on the phone" }], cards: [], reviews: [], quizzes: [] };
    const fresh = { course: { id: "abcdef12-3456", name: "Anatomy", createdAt: 2 }, lectures: [], cards: [], reviews: [], quizzes: [] };
    const bad = { course: { id: "../../etc", name: "x", createdAt: 1 }, lectures: [], cards: [], reviews: [], quizzes: [] };
    const out = await st.sync([phoneCourse, fresh, bad], []);
    assert.equal(out.courses.length, 2);
    const merged = out.courses.find((c) => c.course.id === pc.id)!;
    assert.deepEqual(merged.lectures.map((l) => l.id).sort(), [lec.id, "phone-lec-1"].sort());
    assert.equal(merged.course.name, "Pharmacology");
    await st.removeCourse(fresh.course.id);
    const again = await st.sync([fresh], []);
    assert.equal(again.courses.length, 1);
    assert.ok(again.removedCourses.includes(fresh.course.id));
    await st.sync([], [pc.id]);
    assert.equal((await st.list()).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a lecture from a file: text, a photo, and kinds that cannot be read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "study-file-"));
  try {
    const st = new Study(dir, fake);
    assert.deepEqual(await st.extract("הרצאה 3.txt", Buffer.from("שלום עולם")), { title: "הרצאה 3", text: "שלום עולם" });
    assert.equal((await st.extract("board.jpg", Buffer.from([0xff, 0xd8, 0xff]))).text, "לוח: לחץ דם 120/80");
    await assert.rejects(st.extract("virus.exe", Buffer.from("MZ")), /cannot be read/);
    await assert.rejects(new Study(dir, () => undefined).extract("a.png", Buffer.from([1])), /chat model/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
