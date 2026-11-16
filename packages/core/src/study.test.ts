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

    // Kept on disk.
    const again = new Study(dir, fake);
    assert.equal((await again.list())[0]?.cards, 2);
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
