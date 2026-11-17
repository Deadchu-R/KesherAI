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
    if (sys.includes("spoken review")) return { text: "## היום למדנו **אינסולין**." };
    if (sys.includes("tutor for a student")) return { text: req.messages.at(-1)!.content.includes("אינסולין") ? "מוריד סוכר [Lecture: אינסולין]" : "לא מכוסה" };
    if (sys.includes("photos of study material")) return { text: (req.messages[1] as { images?: unknown[] }).images?.length ? "לוח: לחץ דם 120/80" : "NO-IMAGE" };
    if (sys.includes("drug cards")) return { text: '[{"name":"Digoxin","drugClass":"Cardiac glycoside","nursing":"Apical pulse a full minute; hold under 60","sideEffects":"Nausea, visual changes"},{"name":""}]' };
    if (sys.includes("flashcards")) return { text: '```json\n[{"front":"מה עושה אינסולין?","back":"מוריד סוכר בדם","kind":"drug"},{"front":"Normal K+?","back":"3.5–5.0 mEq/L","kind":"concept"},{"front":"bad"}]\n```' };
    if (sys.includes("thinks a multiple-choice question")) return { text: '{"verdict":"fix","answer":1,"quote":"Insulin.","explain":"The lecture says a."}' };
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
    // "This question looks wrong": the model's check moves the key; her own call moves it back.
    const checked = await st.checkQuestion(c.id, quiz.id, 0);
    assert.equal(checked.check.verdict, "fix");
    assert.equal(checked.quiz.questions[0]!.answer, 0);
    assert.equal(checked.quiz.score, 0);
    assert.equal((await st.get(c.id)).quizzes[0]!.questions[0]!.fixed?.by, "model");
    const mine = await st.checkQuestion(c.id, quiz.id, 0, 2);
    assert.equal(mine.quiz.score, 1);
    assert.equal(mine.quiz.questions[0]!.fixed?.by, "her");
    await assert.rejects(st.checkQuestion(c.id, quiz.id, 0, 9), /No such option/);

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

test("the course tutor answers from the lectures and names them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "study-tutor-"));
  try {
    const st = new Study(dir, fake);
    const c = await st.addCourse("פרמקולוגיה");
    const l = await st.addLecture(c.id, { title: "אינסולין", text: "אינסולין מוריד סוכר בדם." });
    const r = await st.askCourse(c.id, "מה עושה אינסולין?");
    assert.match(r.answer, /אינסולין/);
    assert.deepEqual(r.sources, [{ lectureId: l.id, title: "אינסולין" }]);
    await assert.rejects(st.askCourse(c.id, "  "), /Ask a question/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an audio overview, and a course shared and opened by a classmate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "study-share-"));
  try {
    const st = new Study(dir, fake);
    const c = await st.addCourse("פרמקולוגיה");
    const l = await st.addLecture(c.id, { title: "אינסולין", text: "אינסולין מוריד סוכר בדם." });
    assert.equal((await st.audioOverview(c.id, l.id)).audio, "היום למדנו אינסולין.");
    await st.addCard(c.id, { front: "מה?", back: "כך", lectureId: l.id });
    const file = JSON.parse(JSON.stringify(await st.exportCourse(c.id)));
    const mine = await st.importCourse(file);
    assert.notEqual(mine.id, c.id);
    const d = await st.get(mine.id);
    assert.equal(d.lectures[0]!.audio, "היום למדנו אינסולין.");
    assert.equal(d.cards[0]!.lectureId, d.lectures[0]!.id);
    assert.equal(d.reviews.length, 0);
    await assert.rejects(st.importCourse({ hello: 1 }), /not a shared/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a lecture recorded on the phone is summarized on the computer by itself, then the phone is told", async () => {
  const dir = await mkdtemp(join(tmpdir(), "study-"));
  try {
    const st = new Study(dir, fake);
    const ready: string[] = [];
    st.onLectureReady = (c, l) => ready.push(`${c.name}/${l.title}`);
    const c = await st.addCourse("פרמקולוגיה");
    const d = await st.get(c.id);
    const text = "אינסולין מוריד סוכר בדם. ".repeat(20);
    await st.sync([{ ...d, lectures: [{ id: "phone-lec-1", title: "הרצאה 1", date: "2026-11-16", text }] }], []);
    await st.idle();
    assert.deepEqual(ready, ["פרמקולוגיה/הרצאה 1"]);
    assert.equal((await st.get(c.id)).lectures[0]?.summary, "סיכום");
    // Synced again: already summarized, nothing new.
    await st.sync([await st.get(c.id)], []);
    await st.idle();
    assert.equal(ready.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("kept recordings: saved, checked, and deleted when their time has come", async () => {
  const { Study } = await import("./study.js");
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const st = new Study(await mkdtemp(join(tmpdir(), "rec-")), () => undefined);
  const c = await st.addCourse("פיזיולוגיה");
  const l = await st.addLecture(c.id, { title: "הלב", text: "[00:00] שלום" });
  const saved = await st.saveRecording(c.id, l.id, Buffer.alloc(5000, 1), "audio/webm");
  assert.equal(saved.recording?.bytes, 5000);
  assert.ok((await st.recordingFile(c.id, l.id))?.path.endsWith(".audio"));
  await assert.rejects(st.saveRecording(c.id, l.id, Buffer.alloc(5000, 1), "text/html"));
  assert.equal((await st.recordingSettings()).deleteAfter, "never");
  assert.equal(await st.cleanRecordings(), 0);
  await st.setRecordingSettings({ deleteAfter: "30" });
  assert.equal(await st.cleanRecordings(Date.now() + 31 * 24 * 3600_000), 1);
  assert.equal(await st.recordingFile(c.id, l.id), undefined);
});

test("a web page saved to a course: a new lecture with its address, or added to a lecture", async () => {
  const dir = await mkdtemp(join(tmpdir(), "study-"));
  try {
    const st = new Study(dir, fake);
    const c = await st.addCourse("פרמקולוגיה");
    const l = await st.clipToCourse(c.id, { title: "Beta blocker", url: "https://en.wikipedia.org/wiki/Beta_blocker", text: "Beta blockers slow the heart." });
    assert.equal(l.web, "https://en.wikipedia.org/wiki/Beta_blocker");
    assert.equal(l.title, "Beta blocker");
    const again = await st.clipToCourse(c.id, { title: "More", url: "javascript:alert(1)", text: "Side effects: fatigue.", lectureId: l.id });
    assert.equal(again.id, l.id);
    assert.match(again.text, /slow the heart\.\n\n--- More ---\nSide effects/);
    const d = await new Study(dir, fake).get(c.id);
    assert.equal(d.lectures.length, 1);
    assert.equal(d.lectures[0]!.web, "https://en.wikipedia.org/wiki/Beta_blocker");
    await assert.rejects(st.clipToCourse(c.id, { text: "  " }), /no text/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the daily goal: off by default, counts lectures and quizzes, and reminds once (computer only unless the phone is on)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "study-"));
  try {
    const st = new Study(dir, fake);
    assert.equal((await st.goal()).on, false);
    await st.setGoal({ on: true, targets: { lectures: 1, minutes: 0 }, remind: "00:00" });
    const sent: Array<[string, boolean]> = [];
    const send = async (title: string, _b: string, _p: string, phone: boolean) => void sent.push([title, phone]);
    const c = await st.addCourse("פרמקולוגיה");
    assert.equal(await st.remindIfDue(send), true);
    assert.equal(await st.remindIfDue(send), false, "once a day");
    assert.equal(sent[0]![1], false);
    assert.match(sent[0]![0], /עוד 1 הרצאות/);
    await st.addLecture(c.id, { title: "x", text: "y" });
    await new Promise((r) => setTimeout(r, 50));
    const p = await st.progress();
    assert.equal(p.today.counts.lectures, 1);
    assert.equal(p.today.done, true);
    assert.equal(p.today.streak, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("timetable: only her courses' classes, and one reminder per class a day", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-tt-"));
  try {
    const st = new Study(dir, () => undefined);
    const c = await st.addCourse("פיזיולוגיה");
    const t = await st.setTimetable({ slots: [{ id: "a", courseId: c.id, day: 0, start: "10:00", end: "12:00", room: "101" }, { id: "b", courseId: "gone", day: 0, start: "08:00", end: "09:00" }], remind: true, lastReminded: "forged" });
    assert.deepEqual(t.slots.map((s) => s.id), ["a"]);
    assert.equal(t.lastReminded, undefined);
    const sent: string[][] = [];
    const send = async (title: string, body: string, path: string) => void sent.push([title, body, path]);
    const at = new Date(2026, 10, 15, 9, 57);
    assert.equal(await st.remindClassIfDue(send, at), true);
    assert.equal(await st.remindClassIfDue(send, new Date(2026, 10, 15, 9, 58)), false);
    assert.equal(sent.length, 1);
    assert.match(sent[0]![0]!, /פיזיולוגיה מתחיל ב-10:00 · חדר 101/);
    assert.equal(sent[0]![2], `#/study/${c.id}?record=1`);
    // Attendance: with a rule and tracking on, once, 5–15 minutes after the class ends.
    await st.setTimetable({ ...(await st.timetable()), trackSince: 1, limits: { [c.id]: { absences: 2 } } });
    const asked: string[] = [];
    const ask = async (title: string) => void asked.push(title);
    assert.equal(await st.askAttendanceIfDue(ask, new Date(2026, 10, 15, 12, 7)), true);
    assert.equal(await st.askAttendanceIfDue(ask, new Date(2026, 10, 15, 12, 9)), false);
    assert.deepEqual(asked, ["✋ היית בפיזיולוגיה?"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("highlights: saved checked, made into cards once, and the cloze filter", async () => {
  const dir = await mkdtemp(join(tmpdir(), "study-hl-"));
  try {
    const st = new Study(dir, fake);
    const c = await st.addCourse("פרמקולוגיה");
    const l = await st.addLecture(c.id, { title: "אינסולין", text: "— 1 —\nאינסולין מוריד סוכר בדם." });
    const hs = await st.setHighlights(c.id, l.id, [{ id: "h1", text: " אינסולין מוריד סוכר ", page: 1, note: "חשוב" }, { text: "" }, "x"]);
    assert.deepEqual(hs.map((h) => [h.id, h.text, h.page, h.note]), [["h1", "אינסולין מוריד סוכר", 1, "חשוב"]]);
    const made = await st.makeCards(c.id, l.id, { highlights: true });
    assert.ok(made.length > 0);
    assert.equal((await st.get(c.id)).lectures[0]!.highlights![0]!.carded, true);
    await assert.rejects(() => st.makeCards(c.id, l.id, { highlights: true }), /No new highlights/);
    // The fake model's cards have no blank: none is kept as a fill-in-the-blank card.
    await assert.rejects(() => st.makeCards(c.id, l.id, { cloze: true }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a question during a recording needs a transcript and answers from it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "study-live-"));
  try {
    const st = new Study(dir, fake);
    const c = await st.addCourse("פיזיולוגיה");
    await assert.rejects(() => st.askLive(c.id, "מה הוא אמר?", " "), /Nothing has been transcribed/);
    await assert.rejects(() => st.askLive(c.id, " ", "[00:30] לחץ דם"), /Ask a question/);
    assert.ok((await st.askLive(c.id, "מה הוא אמר על לחץ דם?", "[00:30] לחץ דם תקין הוא 120/80")).length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("slides: a PowerPoint lines up with the recording's minutes", async () => {
  const { zipSync, strToU8 } = await import("fflate");
  const { pptxFiles } = await import("@kesher/shared");
  const dir = await mkdtemp(join(tmpdir(), "study-slides-"));
  try {
    const st = new Study(dir, fake);
    const c = await st.addCourse("פרמקולוגיה");
    const l = await st.addLecture(c.id, { title: "לב", text: "[00:00] שלום, היום על הלב\n[05:00] חוסמי בטא חוסמים קולטני בטא ולכן הדופק יורד\n[12:00] משתנים מורידים נפח דם דרך הכליות" });
    const files = pptxFiles("לב", [{ title: "חוסמי בטא", bullets: ["קולטני בטא", "הדופק יורד"] }, { title: "משתנים", bullets: ["נפח דם", "כליות"] }]);
    const pptx = Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === "string" ? strToU8(v) : v]))));
    const slides = await st.addSlides(c.id, l.id, "לב.pptx", pptx);
    assert.equal(slides.length, 3);
    assert.deepEqual(slides.slice(1).map((s) => s.sec), [300, 720]);
    await assert.rejects(() => st.addSlides(c.id, l.id, "x.docx", pptx), /PowerPoint/);
    await st.removeSlides(c.id, l.id);
    assert.equal((await st.get(c.id)).lectures[0]!.slides, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("image occlusion: one picture kept, a card per box, boxes checked", async () => {
  const dir = await mkdtemp(join(tmpdir(), "study-occ-"));
  try {
    const st = new Study(dir, fake);
    const c = await st.addCourse("אנטומיה");
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const cards = await st.addOcclusion(c.id, { image: png.toString("base64"), mime: "image/png", title: "הלב", boxes: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.1, label: "אאורטה" }, { x: 0.5, y: 0.5, w: 0.9, h: 0.9 }, { x: 0, y: 0, w: 0, h: 0 }] });
    assert.equal(cards.length, 2);
    assert.equal(cards[0]!.back, "אאורטה");
    assert.equal(cards[1]!.occlusion!.boxes[1]!.w, 0.5);
    assert.equal(cards[0]!.occlusion!.image, cards[1]!.occlusion!.image);
    assert.equal((await st.image(c.id, cards[0]!.occlusion!.image)).data.length, png.length);
    await assert.rejects(() => st.image(c.id, "../x.png"), /No such picture/);
    await assert.rejects(() => st.addOcclusion(c.id, { image: png.toString("base64"), mime: "image/gif", boxes: [] }), /PNG/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the timetable syncs with the phone: the later copy wins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-tt-"));
  const st = new Study(dir, () => undefined);
  const c = await st.addCourse("Physiology");
  await st.setTimetable({ slots: [{ id: "a", courseId: c.id, day: 1, start: "10:00", end: "12:00" }] }, undefined, 1000);
  const older = await st.sync([], [], { slots: [{ id: "b", courseId: c.id, day: 2, start: "08:00", end: "09:00" }], t: 500 });
  assert.equal(older.timetable.slots[0]?.id, "a");
  const newer = await st.sync([], [], { slots: [{ id: "b", courseId: c.id, day: 2, start: "08:00", end: "09:00" }], t: 2000 });
  assert.deepEqual(newer.timetable.slots.map((s) => s.id), ["b"]);
  assert.equal((await st.timetable()).t, 2000);
  await rm(dir, { recursive: true, force: true });
});

test("grades sync with the phone: the later copy wins", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kesher-gr-"));
  const st = new Study(dir, () => undefined);
  await st.setGrades({ rows: [{ id: "a", name: "Physiology", credits: 4, parts: [], final: 90 }] }, 1000);
  assert.equal((await st.sync([], [], undefined, { rows: [{ id: "b", name: "Old", credits: 2, parts: [] }], t: 500 })).grades.rows[0]?.name, "Physiology");
  const r = await st.sync([], [], undefined, { rows: [{ id: "b", name: "From the phone", credits: 2, parts: [], final: 80 }], t: 2000 });
  assert.equal(r.grades.rows[0]?.name, "From the phone");
  assert.equal((await st.grades()).t, 2000);
  await rm(dir, { recursive: true, force: true });
});

test("a small model context: the material is cut down and the answer still comes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "study-"));
  try {
    const sizes: number[] = [];
    const small = () => ({
      id: "small",
      turn: (async (req: { messages: Array<{ role: string; content: string }> }) => {
        const user = req.messages[1]!.content;
        sizes.push(user.length);
        if (user.length > 9_000) throw new Error("Context size has been exceeded.");
        return { text: '{"summary":"קצר","terms":[]}' };
      }) as never,
    });
    const st = new Study(dir, small);
    const c = await st.addCourse("פרמקולוגיה");
    // Under the 12,000 characters a summary reads at once, but over the model's 9,000.
    const l = await st.addLecture(c.id, { title: "ארוכה", text: "משפט על תרופות. ".repeat(700) });
    const s = await st.summarize(c.id, l.id);
    assert.equal(s.summary, "קצר");
    assert.ok(sizes.length >= 2 && sizes.at(-1)! <= 9_000, String(sizes));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
