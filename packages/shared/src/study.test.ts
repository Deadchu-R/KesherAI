import { test } from "node:test";
import assert from "node:assert/strict";
import { SIMILAR_MARK, detectField, STUDY_FIELDS, STUDY_FIELD_HINTS, pictureQuery, pictureQueries, commonsSearchUrl, parseCommonsPictures, pageAt, passageLabel, toolsFor, toolMaterial, STUDY_TOOLS, searchStudy, parseOpenQuestions, openMark, openGradeMessages, weakLectures as weakL, courseSummaryInput, parseCourseSummary, type StudyLecture, type StudyCourseData, tutorMessages, cardsToTsv, cardsFromTsv, studyNext, checkCalcQuestion, parseSyllabus, syllabusNow, pastExamStyle, explainMessages, studyStreak, studyDays, focusWeek, dayKey, gradeLine, gradeMessages, cleanScript, calcCorrect, doseByWeight, dropRate, formatStats, infusionRate, jsonIn, mergeCourseData, examPlan, cardsToReview, findPassages, shareCourse, openSharedCourse, practiceProblem, pumpRate, tabletsToGive, volumeToGive, weakLectures, type CalcKind, type StudyReview } from "./study.js";

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

test("a course shared with a classmate keeps its material, not her history, and opens as a new course", () => {
  const d = {
    course: { id: "c1234567", name: "פרמקולוגיה", createdAt: 1, field: "nursing" },
    lectures: [{ id: "l1", title: "לב", date: "2026-11-01", text: "דיגוקסין", summary: "ס", audio: "שמע" }],
    cards: [{ id: "k1", front: "מה?", back: "כך", format: "text" as const, lectureId: "l1", createdAt: 1, due: "2027-01-01", fsrs: { reps: 9 } }],
    reviews: [{ cardId: "k1", t: 5, rating: 3, format: "text" as const, elapsedDays: 2 }],
    quizzes: [{ id: "q1", t: 1, questions: [], answers: [1], score: 1 }],
  };
  const f = shareCourse(d);
  assert.equal(JSON.stringify(f).includes("reps"), false);
  assert.equal(JSON.stringify(f).includes("q1"), false);
  assert.equal(f.cards[0]!.lecture, 0);
  let n = 0;
  const o = openSharedCourse(JSON.parse(JSON.stringify(f)), () => `new-id-${++n}`, () => ({ fresh: true }), Date.parse("2026-11-16T10:00:00Z"))!;
  assert.equal(o.course.name, "פרמקולוגיה");
  assert.equal(o.course.field, "nursing");
  assert.notEqual(o.course.id, "c1234567");
  assert.equal(o.cards[0]!.lectureId, o.lectures[0]!.id);
  assert.deepEqual(o.cards[0]!.fsrs, { fresh: true });
  assert.equal(o.reviews.length, 0);
  assert.equal(o.lectures[0]!.audio, "שמע");
  assert.equal(openSharedCourse({ kind: "other" }, () => "x", () => ({})), undefined);
});

test("tutorMessages: answers from her lectures, and study mode asks her first", () => {
  const lectures = [{ id: "l1", title: "לב", date: "2026-11-01", text: "דיגוקסין מגביר את כוח ההתכווצות של הלב ומאט את הדופק. ".repeat(10) }];
  const ask = tutorMessages({ lectures, question: "מה עושה דיגוקסין?", history: [{ role: "system", content: "x" }, { role: "user", content: "a" }] });
  assert.equal(ask.messages[0]!.content.startsWith("You are a tutor for"), true);
  assert.equal(ask.messages.filter((m) => m.role === "system").length, 1);
  assert.equal(ask.passages[0]!.title, "לב");
  const start = tutorMessages({ lectures, question: "", mode: "study", pick: () => 0 });
  assert.match(start.messages.at(-1)!.content, /ask her the first question/);
  assert.match(start.messages.at(-1)!.content, /\[Lecture: לב\]/);
  assert.match(start.messages[0]!.content, /Ask ONE short question/);
  const answer = tutorMessages({ lectures, question: "מאט דופק", mode: "study", history: [{ role: "assistant", content: "מה עושה דיגוקסין לדופק?" }] });
  assert.match(answer.messages.at(-1)!.content, /Her answer: מאט דופק/);
});

test("gradeLine writes the verdict itself, and cleanScript drops other scripts", () => {
  assert.equal(gradeLine('{"verdict":"wrong","answer":"מערכת החיסון הורסת את תאי הבטא好不好"}', true), "✗ לא בדיוק. לפי ההרצאה: מערכת החיסון הורסת את תאי הבטא");
  assert.equal(gradeLine('```json\n{"verdict":"right"}\n```', true), "✓ נכון.");
  assert.equal(gradeLine("Correct!", true), undefined);
  assert.equal(cleanScript("נכון – ההרצאה של Digoxin هرس אומרת", true), "נכון – ההרצאה של Digoxin אומרת");
  assert.equal(cleanScript("כך [Lecture: לב, 12:30] וגם [ lecture:ריאות]", true), "כך [הרצאה: לב, 12:30] וגם [הרצאה: ריאות]");
  const g = gradeMessages({ lectures: [{ id: "l", title: "לב", date: "", text: "מערכת החיסון הורסת את תאי הבטא בלבלב" }], tutorQuestion: "מה הורס את תאי הבטא?", answer: "וירוס" });
  assert.match(g.messages[0]!.content, /ONLY the lecture passages/);
  assert.match(g.messages[1]!.content, /Her answer: וירוס/);
});

test("study streak: days in a row, one missed day a week kept by a shield; focus minutes per day", () => {
  const DAY = 86_400_000;
  const now = new Date(2026, 10, 16, 18, 0).getTime();
  const at = (i: number) => dayKey(now - i * DAY);
  assert.deepEqual(studyStreak(new Set([at(0), at(1), at(2)]), now), { days: 3, today: true, shield: false });
  // Today not done yet: the streak runs to yesterday.
  assert.deepEqual(studyStreak(new Set([at(1), at(2)]), now), { days: 2, today: false, shield: false });
  // One missed day (2 days ago) is covered; a second one in the same week is not.
  assert.deepEqual(studyStreak(new Set([at(0), at(1), at(3), at(4)]), now), { days: 4, today: true, shield: true });
  assert.equal(studyStreak(new Set([at(0), at(2), at(4)]), now).days, 2);
  assert.equal(studyStreak(new Set(), now).days, 0);
  const course = { course: { id: "c", name: "x", createdAt: 0 }, lectures: [], cards: [], reviews: [{ cardId: "k", t: now - 3 * DAY, rating: 3, format: "text" as const, elapsedDays: 0 }], quizzes: [], focus: [{ t: now, minutes: 25 }, { t: now - DAY, minutes: 50 }] };
  assert.deepEqual([...studyDays([course])].sort(), [at(3), at(1), at(0)].sort());
  const w = focusWeek([course], now);
  assert.equal(w.length, 7);
  assert.equal(w[6]!.minutes, 25);
  assert.equal(w[5]!.minutes, 50);
  const merged = mergeCourseData({ ...course, focus: [{ t: 1, minutes: 5 }] }, { ...course, focus: [{ t: 1, minutes: 5 }, { t: 2, minutes: 9 }] });
  assert.deepEqual(merged.focus, [{ t: 1, minutes: 5 }, { t: 2, minutes: 9 }]);
});

test("tutorMessages homework: the problem stays in view; steps and hints follow it", () => {
  const lectures = [{ id: "l1", title: "חישובי תרופות", date: "", text: "קצב טפטוף = נפח כפול פקטור טפטוף חלקי זמן בדקות." }];
  const first = tutorMessages({ lectures, question: "1000 מ״ל ב-8 שעות, פקטור 20. מה קצב הטפטוף?", mode: "homework" });
  assert.match(first.messages[0]!.content, /step by step/);
  assert.match(first.messages.at(-1)!.content, /The problem: 1000/);
  const later = tutorMessages({ lectures, question: "רמז", mode: "homework", history: [{ role: "user", content: "1000 מ״ל ב-8 שעות, פקטור 20. מה קצב הטפטוף?" }, { role: "assistant", content: "מה כבר ניסית?" }] });
  assert.match(later.messages.at(-1)!.content, /The problem: 1000[\s\S]*Her message: רמז/);
  // After "a similar problem", her steps are checked against the problem the tutor wrote.
  const history = [{ role: "user" as const, content: "1000 מ״ל ב-8 שעות, פקטור 20. מה קצב הטפטוף?" }, { role: "assistant" as const, content: "41.7" }, { role: "user" as const, content: `${SIMILAR_MARK} תרגיל דומה` }, { role: "assistant" as const, content: "500 מ״ל ב-4 שעות, פקטור 15. מה הקצב?" }];
  const similar = tutorMessages({ lectures, question: "500 כפול 15", mode: "homework", history });
  assert.match(similar.messages.at(-1)!.content, /The problem: 500 מ״ל ב-4 שעות[\s\S]*Her message: 500 כפול 15/);
  assert.match(similar.messages[0]!.content, /similar problem/);
});

test("explainMessages: the selection with the lecture as context, by kind", () => {
  const lecture = { id: "l", title: "לב", date: "", text: "דיגוקסין מגביר את כוח ההתכווצות.", summary: "סיכום קצר" };
  const m = explainMessages({ selection: "  מגביר את כוח ההתכווצות  ", lecture, kind: "simple" });
  assert.match(m[0]!.content, /very simple words/);
  assert.match(m[1]!.content, /Context from the lecture:\nסיכום קצר/);
  assert.match(m[1]!.content, /The passage she selected:\nמגביר את כוח ההתכווצות\n\n\(Answer in Hebrew.\)$/);
});

test("past exams: a style note from each, merged by id and removed ones stay removed", () => {
  const e = (id: string, text: string) => ({ id, title: `מבחן ${id}`, text, t: 1 });
  assert.equal(pastExamStyle([]), "");
  const note = pastExamStyle([e("a", "שאלה 1: ".repeat(2000)), e("b", "שאלה פתוחה")], 1000);
  assert.match(note, /same kinds of questions/);
  assert.match(note, /--- Past exam: מבחן b\nשאלה פתוחה/);
  assert.ok(note.length < 1400);
  const base = { course: { id: "c", name: "x", createdAt: 0 }, lectures: [], cards: [], reviews: [], quizzes: [] };
  const m = mergeCourseData({ ...base, pastExams: [e("a", "1")], removed: ["b"] }, { ...base, pastExams: [e("a", "1"), e("b", "2"), e("c", "3")] });
  assert.deepEqual(m.pastExams?.map((x) => x.id), ["a", "c"]);
});

test("syllabus: real dates only, sorted; what is next and this week's topic", () => {
  const raw = '```json\n{"exams":[{"title":"מועד א","date":"2027-01-20"},{"title":"בוחן","date":"2026-12-01"},{"title":"x","date":"2026-13-40"}],"assignments":[{"title":"עבודה 1","date":"2026-11-25"},{"title":"","date":"2026-11-26"}],"weeks":[{"week":1,"topic":"מבוא","date":"2026-11-02"},{"week":3,"topic":"לב","date":"2026-11-16"},{"week":4,"topic":"ריאות"}]}\n```';
  const s = parseSyllabus(raw, 5)!;
  assert.deepEqual(s.exams.map((e) => e.title), ["בוחן", "מועד א"]);
  assert.equal(s.assignments.length, 1);
  assert.equal(s.weeks.length, 3);
  assert.equal(s.t, 5);
  const now = syllabusNow(s, new Date(2026, 10, 18, 12).getTime());
  assert.deepEqual(now.week, { week: 3, topic: "לב" });
  assert.equal(now.nextExam?.title, "בוחן");
  assert.equal(now.nextExam?.daysLeft, 13);
  assert.deepEqual(now.due.map((a) => [a.title, a.daysLeft]), [["עבודה 1", 7]]);
  assert.equal(parseSyllabus('{"exams":[]}'), undefined);
});

test("checkCalcQuestion: the option must equal the explanation's own result", () => {
  const q = (options: string[], answer: number, explain: string) => ({ q: "?", options, answer, explain });
  assert.equal(checkCalcQuestion(q(["60", "70", "80", "90"], 2, "(600 × 20) / 180 = 12,000 / 180 = 66.67")), undefined);
  assert.equal(checkCalcQuestion(q(["20 טיפות", "25", "30 טיפות לדקה", "35"], 2, "= 10,800 / 360 = 30 טיפות לדקה"))?.answer, 2);
  assert.equal(checkCalcQuestion(q(["41.7", "50", "30", "20"], 1, "1000 × 20 ÷ 480 = 41.67"))?.answer, 0);
  const words = q(["כן", "לא"], 0, "כי כך כתוב");
  assert.equal(checkCalcQuestion(words), words);
});

test("studyNext: the most urgent step first", () => {
  const now = new Date(2026, 10, 16, 12).getTime();
  const course = (id: string, extra: Partial<Parameters<typeof studyNext>[0][number]> = {}) => ({ course: { id, name: id, createdAt: 0 }, lectures: [], cards: [], reviews: [], quizzes: [], ...extra });
  assert.equal(studyNext([]), undefined);
  assert.equal(studyNext([course("a")], now)?.kind, "focus");
  const lec = { id: "l1", title: "לב", date: "2026-11-01", text: "x".repeat(300) };
  assert.deepEqual(studyNext([course("a", { lectures: [lec] })], now), { kind: "summarize", courseId: "a", course: "a", what: "לב", lectureId: "l1" });
  const card = { id: "k", front: "?", back: "!", format: "text" as const, createdAt: 0, due: "2026-11-01T00:00:00Z", fsrs: {} };
  assert.equal(studyNext([course("a", { lectures: [lec] }), course("b", { cards: [card] })], now)?.kind, "review");
  const syl = { exams: [], assignments: [{ title: "עבודה", date: "2026-11-17" }], weeks: [], t: 0 };
  assert.deepEqual(studyNext([course("b", { cards: [card] }), course("c", { syllabus: syl })], now), { kind: "due-soon", courseId: "c", course: "c", what: "עבודה", days: 1 });
});

test("Anki / Quizlet: cards out as tab-separated lines and back in", () => {
  const tsv = cardsToTsv([{ front: "מה?\nשתי שורות", back: "כך\tבדיוק" }, { front: "b", back: "c" }]);
  assert.equal(tsv, "מה?<br>שתי שורות\tכך בדיוק\nb\tc");
  assert.deepEqual(cardsFromTsv(`#separator:tab\n${tsv}\n\n`), [{ front: "מה?\nשתי שורות", back: "כך בדיוק" }, { front: "b", back: "c" }]);
  assert.deepEqual(cardsFromTsv('"דיגוקסין";"<b>מגביר</b> כוח"\nרק צד אחד'), [{ front: "דיגוקסין", back: "מגביר כוח" }]);
});

test("the course summary grows only with lectures not yet in it, and merges by the newest", () => {
  const lec = (id: string, summary?: string) => ({ id, title: `הרצאה ${id}`, text: "x", t: 1, ...(summary ? { summary } : {}) }) as StudyLecture;
  const d = { lectures: [lec("1", "תאים"), lec("2"), lec("3", "חלבונים")], courseSummary: { text: "## תאים\n- **תא** [הרצאה 1]", lectureIds: ["1"], t: 5 } };
  const inp = courseSummaryInput(d)!;
  assert.deepEqual(inp.ids, ["3"]);
  assert.match(inp.user, /חלבונים/);
  assert.doesNotMatch(inp.user, /### הרצאה 1/);
  assert.equal(courseSummaryInput({ ...d, lectures: [lec("1", "תאים")] }), null);
  const s = parseCourseSummary("```markdown\n## תאים\n- **תא** הוא יחידת החיים [הרצאה 1]\n## חלבונים\n- שרשרת חומצות אמינו [הרצאה 3]\n```", d.courseSummary, inp.ids, 9)!;
  assert.deepEqual(s.lectureIds, ["1", "3"]);
  assert.doesNotMatch(s.text, /```/);
  assert.equal(parseCourseSummary("קצר", undefined, ["1"]), null);
  const base = { course: { id: "c", name: "c", t: 1 }, lectures: [], cards: [], reviews: [], quizzes: [] } as unknown as StudyCourseData;
  assert.equal(mergeCourseData({ ...base, courseSummary: d.courseSummary }, { ...base, courseSummary: s }).courseSummary?.t, 9);
});

test("search across courses finds terms, notes, summaries and cards, with Hebrew prefixes; newer notes survive a sync", () => {
  const lec = { id: "l1", title: "הרצאה 1: לב", date: "2026-11-01", text: "מערכת הדם", summary: "הלב שואב דם", terms: [{ term: "סיסטולה", explain: "כיווץ הלב" }], notes: "המרצה אמר שזה במבחן", notesT: 5 } as StudyLecture;
  const d = { course: { id: "c1", name: "פיזיולוגיה", t: 1 }, lectures: [lec], cards: [{ id: "k1", front: "מה זה סיסטולה?", back: "כיווץ", format: "text", createdAt: 1, due: "", fsrs: {} }] } as unknown as StudyCourseData;
  const hits = searchStudy([d], "סיסטולה");
  assert.equal(hits[0]?.kind, "term");
  assert.ok(hits.some((h) => h.kind === "card"));
  assert.ok(searchStudy([d], "במבחן").some((h) => h.kind === "notes"));
  assert.ok(searchStudy([d], "לב").some((h) => h.kind === "summary"));
  assert.deepEqual(searchStudy([d], "x"), []);
  const base = { course: d.course, cards: [], reviews: [], quizzes: [] };
  const older = { ...lec, notes: "ישן", notesT: 1, summary: "סיכום ארוך יותר עם עוד פרטים", diagram: "graph" };
  const m = mergeCourseData({ ...base, lectures: [older] } as unknown as StudyCourseData, { ...base, lectures: [lec] } as unknown as StudyCourseData);
  assert.equal(m.lectures[0]?.notes, "המרצה אמר שזה במבחן");
  assert.equal(m.lectures[0]?.diagram, "graph");
});

test("open and case quizzes: questions with a model answer, marks from the grader, weak lectures from marks", () => {
  const qs = parseOpenQuestions('```json\n[{"q":"הסבירי את מחזור הלב","answer":"סיסטולה ודיאסטולה","lecture":2},{"q":"קצר","answer":"x"},{"q":"מה תעשי במקרה של לחץ דם נמוך?","answer":"להשכיב ולהרים רגליים"}]\n```', ["a", "b"], 5);
  assert.equal(qs.length, 2);
  assert.equal(qs[0]?.lectureId, "b");
  assert.equal(qs[0]?.answer, -1);
  assert.deepEqual(qs[0]?.options, []);
  assert.deepEqual(openMark('{"verdict":"partly","answer":"חסרה הדיאסטולה"}', true), { mark: 0.5, line: "◐ נכון בחלקו. חסרה הדיאסטולה" });
  assert.equal(openMark('{"verdict":"right","answer":"x"}', true)?.line, "✓ נכון.");
  assert.equal(openMark("לא JSON", true), undefined);
  const msgs = openGradeMessages({ lectures: [{ id: "b", title: "לב", date: "", text: "מחזור הלב כולל סיסטולה ודיאסטולה" }], question: qs[0]!, text: "סיסטולה" });
  assert.match(msgs[1]!.content, /Model answer: סיסטולה ודיאסטולה/);
  const w = weakL([{ id: "z", t: 1, kind: "open", questions: [qs[0]!, { ...qs[0]! }], answers: [-1, -1], marks: [0.5, 0] }]);
  assert.equal(w[0]?.correct, 0.25);
});

test("field tools: each field gets its own tools, unknown fields get all, course material fits the budget", () => {
  assert.ok(toolsFor("law").some((t) => t.id === "brief"));
  assert.ok(!toolsFor("law").some((t) => t.id === "trace"));
  assert.ok(toolsFor("cs").some((t) => t.id === "trace") && toolsFor("cs").some((t) => t.id === "formulas"));
  assert.equal(toolsFor(undefined).length, STUDY_TOOLS.length);
  for (const f of ["nursing", "medicine", "law", "engineering", "cs", "math", "psychology", "economics", "biology", "education", "humanities", "gamedev"]) assert.ok(toolsFor(f).length > 0, f);
  const m = toolMaterial([{ id: "a", title: "א", date: "", text: "x".repeat(90_000) }, { id: "b", title: "ב", date: "", text: "t", summary: "סיכום" }], 10_000);
  assert.ok(m.length <= 10_000 && m.includes("### ב\nסיכום"));
});

test("passages keep the page of a file's lecture, and the model sees it to cite", () => {
  const text = `— 1 —\nמבוא לתאים\n\n— 2 —\n${"מילוי ".repeat(300)}\n\n— 3 —\nהמיטוכונדריה מייצרת אנרגיה`;
  assert.equal(pageAt(text, 0), 1);
  assert.equal(pageAt(text, text.length), 3);
  const lec = { id: "l", title: "תאים", date: "", text };
  const found = findPassages([lec], "מיטוכונדריה", 9000);
  assert.ok(found.some((p) => p.page === 3 || (p.page !== undefined && p.text.includes("— 3 —"))));
  assert.equal(passageLabel({ lectureId: "l", title: "תאים", text: "", page: 3 }), "[Lecture: תאים, p. 3]");
  assert.equal(findPassages([{ ...lec, text: "המיטוכונדריה מייצרת אנרגיה ".repeat(5) }], "מיטוכונדריה")[0]?.page, undefined);
});

test("Commons pictures: English terms make the search, only upload.wikimedia.org copies are kept", () => {
  assert.equal(pictureQuery({ title: "הרצאה על הלב", terms: [{ term: "חדר", en: "Ventricle", explain: "" }, { term: "עלייה", en: "Atrium", explain: "" }] }), "Ventricle Atrium");
  // The summary's own picture words first; a lone term last (it found portraits of people named Chambers).
  assert.deepEqual(pictureQueries({ title: "הלב", picture: "heart anatomy", terms: [{ term: "מדורים", en: "chambers", explain: "" }, { term: "סיסטולה", en: "systole", explain: "" }] }), ["heart anatomy", "chambers systole", "chambers diagram", "chambers"]);
  assert.deepEqual(pictureQueries({ title: "הלב", picture: "לב", terms: [] }), ["הלב"]);
  assert.equal(pictureQuery({ title: "הלב \"שלי\"" }), "הלב שלי");
  assert.match(commonsSearchUrl("heart"), /^https:\/\/commons\.wikimedia\.org\/w\/api\.php\?.*origin=\*/);
  const json = { query: { pages: {
    "1": { index: 2, imageinfo: [{ mime: "image/svg+xml", thumburl: "https://upload.wikimedia.org/a/heart.svg.png", descriptionurl: "https://commons.wikimedia.org/wiki/File:Heart.svg", extmetadata: { LicenseShortName: { value: "CC BY-SA 4.0" }, Artist: { value: "<a href='x'>Someone</a>" } } }] },
    "2": { index: 1, imageinfo: [{ mime: "image/jpeg", thumburl: "https://evil.example/x.jpg" }] },
    "3": { index: 3, imageinfo: [{ mime: "video/webm", thumburl: "https://upload.wikimedia.org/v.jpg" }] },
  } } };
  const got = parseCommonsPictures(json);
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], { src: "https://upload.wikimedia.org/a/heart.svg.png", page: "https://commons.wikimedia.org/wiki/File:Heart.svg", license: "CC BY-SA 4.0", artist: "Someone" });
});

test("open questions: a wrapped list and other field names are read too", () => {
  const qs = parseOpenQuestions('{"questions":[{"question":"מטופל עם לחץ דם 80/50. מה תעשי?","model_answer":"להשכיב ולהרים רגליים"}]}', ["a"], 3);
  assert.equal(qs.length, 1);
  assert.equal(qs[0]?.explain, "להשכיב ולהרים רגליים");
});

test("JSON from a model with Hebrew abbreviations (a plain quote inside a word) is still read", () => {
  const raw = '[{"q": "לחץ דם 135/85 מ"מ כספית. תקין?", "answer": "לפי צה"ל ועוד", "lecture": 2}]';
  const j = jsonIn(raw) as Array<{ q: string; answer: string }>;
  assert.equal(j[0]?.q, "לחץ דם 135/85 מ״מ כספית. תקין?");
  assert.equal(j[0]?.answer, "לפי צה״ל ועוד");
  assert.deepEqual(jsonIn('{"a": "ok"}'), { a: "ok" });
});

test("Commons animations and videos: GIFs keep moving, videos come with their file on Commons", () => {
  assert.match(decodeURIComponent(commonsSearchUrl("heart", 360, "video")), /filetype:video/);
  assert.match(decodeURIComponent(commonsSearchUrl("heart", 360, "gif")), /filemime:gif/);
  const json = { query: { pages: {
    "1": { index: 1, imageinfo: [{ mime: "video/webm", thumburl: "https://upload.wikimedia.org/x/heart.webm.jpg", url: "https://upload.wikimedia.org/x/heart.webm", descriptionurl: "https://commons.wikimedia.org/wiki/File:Heart.webm" }] },
    "2": { index: 2, imageinfo: [{ mime: "video/webm", thumburl: "https://upload.wikimedia.org/y.jpg", url: "https://evil.example/y.webm" }] },
    "3": { index: 3, imageinfo: [{ mime: "image/gif", thumburl: "https://upload.wikimedia.org/z/beat.gif" }] },
  } } };
  const v = parseCommonsPictures(json, 8, "video");
  assert.equal(v.length, 1);
  assert.equal(v[0]?.video, "https://upload.wikimedia.org/x/heart.webm");
  const g = parseCommonsPictures(json, 8, "gif");
  assert.deepEqual(g.map((x) => x.src), ["https://upload.wikimedia.org/z/beat.gif"]);
  assert.equal(parseCommonsPictures(json, 8, "image").length, 0);
});

test("game development is a field of study: found from the course, with its own tools and hint", () => {
  assert.equal(detectField("פיתוח משחקים ב-Unity", "GameObject Prefab C# blueprint"), "gamedev");
  assert.ok(toolsFor("gamedev").some((t) => t.id === "gdd") && toolsFor("gamedev").some((t) => t.id === "trace"));
  assert.match(STUDY_FIELD_HINTS.gamedev ?? "", /Unity/);
  for (const f of STUDY_FIELDS) assert.ok(STUDY_FIELD_HINTS[f.id], `hint for ${f.id}`);
});

test("recordings: the semester's end and when a kept recording is due", async () => {
  const { semesterEnd, recordingExpired } = await import("./study.js");
  assert.equal(semesterEnd({ course: { examDate: "2027-01-20" }, syllabus: { exams: [{ date: "2027-02-12" }, { date: "2027-01-05" }] } }), "2027-02-12");
  assert.equal(semesterEnd({ course: { examDate: "2027-01-20", semesterEnd: "2027-03-01" } }), "2027-03-01");
  assert.equal(semesterEnd({ course: {} }), undefined);
  const t = Date.parse("2026-11-01T10:00:00");
  assert.equal(recordingExpired({ t }, { deleteAfter: "never" }, undefined, t + 400 * 864e5), false);
  assert.equal(recordingExpired({ t }, { deleteAfter: "30" }, undefined, t + 31 * 864e5), true);
  assert.equal(recordingExpired({ t }, { deleteAfter: "semester" }, undefined, t + 400 * 864e5), false);
  assert.equal(recordingExpired({ t }, { deleteAfter: "semester" }, "2027-02-12", Date.parse("2027-02-14T12:00:00")), true);
});

test("recordings: a sync from the phone keeps the computer's recording", () => {
  const base = { course: { id: "c", name: "x", createdAt: 1 }, lectures: [], cards: [], reviews: [], quizzes: [] } as unknown as StudyCourseData;
  const pc = { ...base, lectures: [{ id: "l", title: "a", date: "2026-11-16", text: "abc", recording: { t: 5, bytes: 9000, mime: "audio/webm" } }] } as StudyCourseData;
  const phone = { ...base, lectures: [{ id: "l", title: "a", date: "2026-11-16", text: "abcdef", summary: "s" }] } as StudyCourseData;
  assert.equal(mergeCourseData(pc, phone).lectures[0]?.recording?.bytes, 9000);
});

test("pictures: only files whose name has a word of the search are kept", async () => {
  const { relevantPictures } = await import("./study.js");
  const pics = [{ page: "https://commons.wikimedia.org/wiki/File:Mitsui_%26_Co._Logo.gif" }, { page: "https://commons.wikimedia.org/wiki/File:Cardiac_Output_Animation.gif" }];
  assert.deepEqual(relevantPictures(pics, "Cardiac output").map((p) => p.page.slice(-24)), ["iac_Output_Animation.gif"]);
  assert.equal(relevantPictures(pics, "a b").length, 2);
});

test("a video overview's slides are checked", async () => {
  const { parseVideoSlides } = await import("./study.js");
  const s = parseVideoSlides({ slides: [{ title: "## חוסמי בטא", bullets: ["β1", "", 3], say: "חוסמי בטא מורידים דופק.", picture: true }, { title: "no say" }] });
  assert.deepEqual(s, [{ title: "חוסמי בטא", bullets: ["β1"], say: "חוסמי בטא מורידים דופק.", picture: true }]);
});

test("a teach-back check is parsed and trimmed", async () => {
  const { parseTeachBack } = await import("./study.js");
  const r = parseTeachBack({ score: 140, covered: ["β1"], missing: [{ point: "תפוקת לב", card: { front: "מה קורה לתפוקת הלב?", back: "יורדת" } }, { point: "" }], wrong: [{ said: "מרחיבים כלי דם", right: "לא ישירות" }], tip: "טוב" });
  assert.equal(r?.score, 100);
  assert.equal(r?.missing.length, 1);
  assert.equal(parseTeachBack({ score: 50 }), undefined);
});

test("a video's chapters are checked: in order, inside the video, questions only when whole", async () => {
  const { parseChapters, lastStamp } = await import("./study.js");
  assert.equal(lastStamp("[0:01] a\n[52:30] b\n[1:02:03] c"), 3723);
  const c = parseChapters({ chapters: [{ start: 5, title: "מבוא", summary: "s", question: { q: "?", options: ["a", "b", "c"], answer: 1, explain: "e" } }, { start: 3, title: "back in time" }, { start: 400, title: "חוסמי בטא", question: { q: "?", options: ["a"], answer: 0 } }, { start: 9999, title: "after the end" }] }, 1000);
  assert.deepEqual(c.map((x) => [x.start, x.end, x.title, !!x.question]), [[0, 400, "מבוא", true], [400, 1000, "חוסמי בטא", false]]);
});

test("time notes keep a note's moment and find the line heard then", async () => {
  const { cleanHighlights, lineAt } = await import("./study.js");
  assert.deepEqual(cleanHighlights([{ id: "a", text: "x", at: 75.6, t: 1 }, { id: "b", text: "y", at: null, t: 1 }, { id: "c", text: "z", at: -3, t: 1 }]).map((h) => h.at), [75, undefined, undefined]);
  const text = "[0:00] פתיחה\n[1:10] חוסמי בטא\nבלי סימן\n[1:01:05] סוף";
  assert.equal(lineAt(text, 75), "חוסמי בטא");
  assert.equal(lineAt(text, 3700), "סוף");
  assert.equal(lineAt("no marks", 5), "");
});

test("whereTerm: every lecture that mentions a term, with its page and minute", async () => {
  const { whereTerm } = await import("./study.js");
  const lectures = [
    { id: "a", title: "לב", text: "— 3 —\n[0:10] בהיפרקלמיה רואים גלי T מחודדים.\n" + "x ".repeat(200) + "\n[12:05] ההיפרקלמיה מסוכנת. Hyperkalemia is dangerous." },
    { id: "b", title: "כליה", text: "[1:00] כשל כלייתי גורם להיפרקלמיה." },
    { id: "c", title: "ריאות", text: "אין כאן" },
  ];
  const w = whereTerm(lectures, "היפרקלמיה", "Hyperkalemia");
  assert.deepEqual(w.map((p) => [p.lectureId, p.count]), [["a", 3], ["b", 1]]);
  assert.equal(w[0]!.spots[0]!.page, 3);
  assert.equal(w[0]!.spots[0]!.at, 10);
  assert.equal(w[0]!.spots[1]!.at, 725);
  assert.equal(w[1]!.spots[0]!.at, 60);
  assert.deepEqual(whereTerm(lectures, "x"), []);
});

test("memory palace: checked, and kept through a sync by the newer one", async () => {
  const { cleanPalace, mergeCourseData } = await import("./study.js");
  assert.equal(cleanPalace({ items: [{ spot: "דלת", term: "", scene: "x" }] }), undefined);
  const p = cleanPalace({ place: " הבית ", items: [{ spot: "דלת", term: "היפרקלמיה", explain: "אשלגן", scene: "בננות" }], t: 5 });
  assert.deepEqual(p, { place: "הבית", items: [{ spot: "דלת", term: "היפרקלמיה", explain: "אשלגן", scene: "בננות" }], t: 5 });
  const base = { course: { id: "c", name: "c", createdAt: 1 }, lectures: [], cards: [], reviews: [], quizzes: [] };
  assert.equal(mergeCourseData({ ...base, palace: { ...p!, t: 1 } }, { ...base, palace: { ...p!, place: "new", t: 9 } }).palace?.place, "new");
});

test("parsePodcast: two hosts' lines, by letter or name", async () => {
  const { parsePodcast } = await import("./study.js");
  assert.deepEqual(parsePodcast("**A:** שלום, היום על הלב.\nB: מה זה דופק?\nוגם למה הוא משתנה?\n\nנועה: שאלה טובה.\nאיתי: הבנתי!"), [
    { host: 0, text: "שלום, היום על הלב." },
    { host: 1, text: "מה זה דופק? וגם למה הוא משתנה?" },
    { host: 0, text: "שאלה טובה." },
    { host: 1, text: "הבנתי!" },
  ]);
});

test("leechCards: cards forgotten three times or more, most first; occlusion cards left out", async () => {
  const { leechCards } = await import("./study.js");
  const card = (id: string, extra = {}) => ({ id, front: id, back: "b", format: "text" as const, createdAt: 0, due: "", fsrs: {}, ...extra });
  const rev = (cardId: string, rating: number) => ({ cardId, rating, t: 0, format: "text" as const, elapsedDays: 0 });
  const cards = [card("a"), card("b"), card("c", { occlusion: { image: "x.png", boxes: [], i: 0 } })];
  const reviews = [rev("a", 1), rev("a", 1), rev("a", 1), rev("b", 1), rev("b", 1), rev("b", 1), rev("b", 1), rev("b", 3), rev("c", 1), rev("c", 1), rev("c", 1)];
  assert.deepEqual(leechCards(cards, reviews).map((x) => [x.card.id, x.lapses]), [["b", 4], ["a", 3]]);
});

test("noteCards: \"term :: meaning\" lines in her notes", async () => {
  const { noteCards } = await import("./study.js");
  assert.deepEqual(noteCards("סתם שורה\n- ברדיקרדיה :: דופק מתחת ל-60\n• Tachycardia::over 100 \nריק ::\n:: בלי מונח"), [
    { front: "ברדיקרדיה", back: "דופק מתחת ל-60" },
    { front: "Tachycardia", back: "over 100" },
  ]);
});

test("readingPortion: portions end at paragraphs, the place is kept, the last one stays", async () => {
  const { readingPortion } = await import("./study.js");
  const para = (n: number) => `${"מילה ".repeat(n).trim()}.`;
  const text = [para(400), para(400), para(400), para(100)].join("\n\n");
  const a = readingPortion(text, 0, 3000);
  assert.equal(a.part, 1);
  assert.ok(text.slice(a.to - 2, a.to) === "\n\n");
  const b = readingPortion(text, a.to, 3000);
  assert.equal(b.from, a.to);
  assert.equal(b.part, 2);
  const last = readingPortion(text, text.length, 3000);
  assert.equal(last.part, last.parts);
  assert.equal(last.to, text.length);
  assert.deepEqual(readingPortion("", 0), { from: 0, to: 0, part: 1, parts: 1 });
});

test("parseLetter: the subject line and the body", async () => {
  const { parseLetter, letterPrompt } = await import("./study.js");
  assert.deepEqual(parseLetter("**Subject:** בקשת הארכה\nשלום ד״ר כהן,\nאבקש..."), { subject: "בקשת הארכה", body: "שלום ד״ר כהן,\nאבקש..." });
  assert.deepEqual(parseLetter("נושא: ערעור\n\nשלום רב"), { subject: "ערעור", body: "שלום רב" });
  assert.equal(parseLetter("רק גוף").subject, "");
  assert.match(letterPrompt("reserve"), /מילואים/);
});

test("speechStats: words a minute and filler words, Hebrew and English", async () => {
  const { speechStats } = await import("./study.js");
  const s = speechStats("אממ אז היום כאילו נדבר על הלב, בעצם על המדורים. You know, like the heart. אממ", 30);
  assert.equal(s.words, 16);
  assert.equal(s.wpm, 32);
  assert.deepEqual(s.fillers.map((f) => [f.word, f.n]), [["אממ", 2], ["כאילו", 1], ["בעצם", 1], ["like", 1], ["you know", 1]]);
  assert.equal(s.fillerShare, 43.8);
});

test("cleanEnglish: questions with a valid answer, words with both sides", async () => {
  const { cleanEnglish } = await import("./study.js");
  const r = cleanEnglish({ questions: [{ q: "What is the main idea?", options: ["a", "b", "c", "d"], answer: 2, explain: "כי…" }, { q: "bad", options: ["a"], answer: 0 }, { q: "bad2", options: ["a", "b"], answer: 5 }], words: [{ en: "albeit", he: "אף על פי ש" }, { en: "", he: "x" }] });
  assert.equal(r.questions.length, 1);
  assert.deepEqual(r.words, [{ en: "albeit", he: "אף על פי ש" }]);
});
