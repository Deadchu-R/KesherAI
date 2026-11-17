import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { celebrate } from "../celebrate";
import { StudyMistakes } from "../StudyMistakes";
import { playFocusSound, setFocusVolume, stopFocusSound, type FocusSound } from "../focus-sounds";
import { ReadAlong } from "../ReadAlong";
import { StudyWelcome } from "../StudyWelcome";
import { GOAL_NAMES } from "../settings/StudySection";
import { StudyMatch } from "../StudyMatch";
import { type ExamPlan, type StudyNext, type StudySyllabus, type StudyCourseSummary, type StudyHit, type StudyLevel, type StudyPicture, type StudyMediaKind, syllabusNow, toolsFor, benefitsFor, calcCorrect, clinicalField, LAB_VALUES, STUDY_FIELDS, practiceProblem, STUDY_FORMATS, type CalcKind, type LabValue, type StudyDrug, type CalcProblem, type StudyCard, type StudyCourse, type StudyFormat, type StudyLecture, type StudyQuiz, type StudyTerm, GOAL_KINDS, type GoalKind, type StudyGoal } from "@kesher/shared";
import { api, withToken } from "../api";
import { speak, stopSpeaking } from "../Speak";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";
import { RichText } from "../RichText";
import { parseFlow } from "../study-diagram";
import { StudyRecorder } from "../StudyRecorder";
import { AvatarCamera } from "./AvatarCamera";
import { MoodleCard } from "../MoodleCard";
import { StudyVideo } from "../StudyVideo";
import { StudyTeachBack } from "../StudyTeachBack";
import { StudyVideoLecture } from "../StudyVideoLecture";
import { StudyPlans } from "../StudyPlans";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

type CourseRow = StudyCourse & { lectures: number; cards: number; due: number; daysLeft?: number; perDay?: number };
type LectureRow = Omit<StudyLecture, "text" | "summary"> & { chars: number; summarized: boolean; cards: number };
interface CourseInfo { course: StudyCourse; lectures: LectureRow[]; cards: number; due: number; drugs: StudyDrug[]; quizzes: Array<{ id: string; t: number; score?: number; of: number }>; plan: ExamPlan | null; pastExams?: Array<{ id: string; title: string; t: number; chars: number }>; syllabus?: StudySyllabus | null; courseSummary?: StudyCourseSummary | null }
interface Progress { formats: Array<{ format: StudyFormat; n: number; recall: number; enough: boolean }>; byKind: Array<{ kind: string; formats: Progress["formats"] }>; weak: Array<{ lectureId: string; title: string; correct: number; n: number }>; mastery?: Array<{ lectureId: string; title: string; mastery: number; n: number; change: number }>; reviews: number; quizzed?: string[] }

const FORMAT_NAME: Record<StudyFormat, [string, string]> = {
  text: ["טקסט", "Text"],
  diagram: ["תרשים", "Diagram"],
  audio: ["קול", "Audio"],
  example: ["דוגמה מהמחלקה", "Worked example"],
  explain: ["להסביר במילים שלי", "Explain it back"],
};
const fmtName = (f: StudyFormat) => L(...FORMAT_NAME[f]);
const go = (h: string) => (location.hash = h);
/** Opens a new chat with the question ready in the box (the chat can search the web and give links). */
const askChat = (q: string) => go(`#/?ask=${encodeURIComponent(q)}`);

/** Student life: practical questions that need current, official answers. */
const LIFE: Array<[string, string, boolean?]> = [
  ["אילו חיסונים צריך סטודנט/ית לסיעוד בישראל לפני ההתנסות הקלינית, ואיפה ואיך קובעים תור?", "Which vaccinations does a nursing student in Israel need before clinical practice, and where and how do I book them?", true],
  ["אילו מסמכים ואישורים צריך להביא לפני ההתנסות הקלינית בבית החולים?", "Which documents and certificates do I need before clinical practice at the hospital?", true],
  ["איך מגישים בקשה למועד מיוחד או להתאמות בבחינה?", "How do I apply for a special exam date or exam accommodations?"],
];
const LIFE_RULE = L(
  "חפש ברשת ותן תשובה עדכנית עם קישור למקור רשמי (משרד הבריאות, gov.il, קופות החולים או המוסד שלי) ותאריך הבדיקה. אם זה משתנה בין מוסדות, כתוב מה לבדוק מול התוכנית שלי.",
  "Search the web and give a current answer with a link to an official source (the Ministry of Health, gov.il, the health funds or my school) and the date checked. Where it differs between schools, say what to check with my programme.",
);

/** Calls the computer, with a toast on failure; `undefined` when it failed. */
async function call<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (e) {
    toast((e as Error).message);
    return undefined;
  }
}

/**
 * Study (students): courses and their lectures, summaries, flashcards on a spaced-repetition schedule, quizzes,
 * medication calculations and "what works for me". `#/study`, `#/study/<course>[/<tab>]`, `#/study/<course>/l/<lecture>`
 * and `#/study/calc`. Built for the phone (390 px) and the computer; the calculations run in the page (no model).
 */
export function StudyPage({ hash }: { hash: string }) {
  const parts = hash.split("/").slice(2);
  if (parts[0] === "avatar") return <div className="page study-page"><BackLink to="#/study" /><h1>{L("מצלמת אווטאר", "Avatar camera")}</h1><AvatarCamera /></div>;
  if (parts[0] === "benefits") return <div className="page study-page"><BackLink to="#/study" /><h1>{L("הטבות לסטודנטים", "Student benefits")}</h1><Benefits /></div>;
  if (parts[0] === "labs") return <div className="page study-page"><BackLink to="#/study" /><h1>{L("ערכי מעבדה", "Lab values")}</h1><LabValues /></div>;
  if (parts[0] === "calc") return <div className="page study-page"><BackLink to="#/study" /><h1>{L("חישובי תרופות", "Medication calculations")}</h1><CalcPractice /></div>;
  if (!parts[0]) return <StudyHome />;
  return <CoursePage key={parts[0]} id={parts[0]} tab={parts[1] ?? "lectures"} lectureId={parts[1] === "l" ? parts[2] : undefined} />;
}

/**
 * Sends the course as a file to a classmate: the phone's share sheet (WhatsApp, mail…) where there is one, otherwise a
 * download. Her own reviews and answers stay out of it.
 */
async function shareCourseFile(id: string, name: string) {
  const res = await fetch(withToken(`/api/study/courses/${id}/export`)).catch(() => undefined);
  if (!res?.ok) return toast(L("לא הצלחתי להכין את הקובץ.", "Could not make the file."));
  const file = new File([await res.blob()], `${name}.kesherai-course.json`, { type: "application/json" });
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean };
  if (nav.canShare?.({ files: [file] })) return void navigator.share({ files: [file], title: name }).catch(() => undefined);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** The course's cards for Anki or Quizlet (tab-separated text), downloaded or shared. */
async function ankiFile(id: string, name: string) {
  const res = await fetch(withToken(`/api/study/courses/${id}/anki`)).catch(() => undefined);
  if (!res?.ok) return toast(L("לא הצלחתי להכין את הקובץ.", "Could not make the file."));
  const file = new File([await res.blob()], `${name}.anki.txt`, { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** In simple mode, a "More tools" fold; otherwise the children as they are. */
function MoreTools({ simple, children }: { simple: boolean; children: React.ReactNode }) {
  if (!simple) return <>{children}</>;
  return (
    <details className="study-more">
      <summary>⋯ {L("עוד כלים", "More tools")}</summary>
      {children}
    </details>
  );
}

function BackLink({ to }: { to: string }) {
  return <a className="study-back" href={to}>{L("› חזרה", "‹ Back")}</a>;
}

/** Simple mode and the first visit (design StudySimple / StudyWelcome), shared by the home and the course. */
type StudyPrefs = { simple: boolean; welcomed: boolean; easyRead?: boolean };
function useStudyPrefs(): [StudyPrefs | null, (p: StudyPrefs) => void] {
  const [p, setP] = useState<StudyPrefs | null>(null);
  useEffect(() => void api<StudyPrefs>("/api/study/prefs").then(setP, () => setP({ simple: false, welcomed: true })), []);
  return [p, setP];
}
/** The course tabs of simple mode; the rest are under "More tools". */
const SIMPLE_TABS = new Set(["lectures", "review", "quiz", "ask", "game", "progress"]);

function StudyHome() {
  const [courses, setCourses] = useState<CourseRow[] | null>(null);
  const [prefs, setPrefs] = useStudyPrefs();
  const [name, setName] = useState("");
  const load = () => void api<{ courses: CourseRow[] }>("/api/study").then((r) => setCourses(r.courses), (e: Error) => toast(e.message));
  useEffect(load, []);
  const add = async () => {
    if (!name.trim()) return;
    const c = await call(api<StudyCourse>("/api/study/courses", { method: "POST", body: { name } }));
    if (c) go(`#/study/${c.id}`);
  };
  const due = courses?.reduce((n, c) => n + c.due, 0) ?? 0;
  const firstDue = courses?.find((c) => c.due > 0);
  // A 5-minute lesson in the course with the most due cards, else the one with the most cards.
  const quickCourse = firstDue ?? [...(courses ?? [])].sort((a, b) => b.cards - a.cards).find((c) => c.cards > 0);
  if (courses && !courses.length && prefs && !prefs.welcomed) {
    return (
      <div className="page study-page">
        <h1>{L("לימודים", "Study")}</h1>
        <StudyWelcome onSkip={() => { setPrefs({ ...prefs, welcomed: true }); void api("/api/study/prefs", { method: "PUT", body: { welcomed: true } }).catch(() => undefined); }} />
      </div>
    );
  }
  const simple = !!prefs?.simple;
  return (
    <div className={`page study-page${prefs?.easyRead ? " study-easy-read" : ""}`}>
      <h1>{L("לימודים", "Study")}</h1>
      {!!courses?.length && <StudySearch />}
      {!!courses?.length && <NextStep />}
      {!!courses?.length && <GoalCard />}
      {!!courses?.length && <FocusCard courses={courses} />}
      {!!courses?.length && <WeekCard />}
      {!!courses?.length && <section className="study-today">
        <h2>{L("להיום", "Today")}</h2>
        <div className="study-actions">
          {firstDue ? <a className="button primary" href={`#/study/${firstDue.id}/review`}>{L(`חזרה על ${due} כרטיסיות`, `Review ${due} cards`)} ▶</a> : <span className="muted">{L("אין כרטיסיות לחזרה עכשיו.", "No cards to review now.")}</span>}
          {quickCourse && <a className="button" href={`#/study/${quickCourse.id}/quick`}>⏱ {L("שיעור של 5 דקות", "A 5-minute lesson")}</a>}
          {courses?.some((c) => clinicalField(c.field)) && <>
            <a className="button" href="#/study/calc">{L("תרגול חישובי תרופות", "Medication calculations")}</a>
            <a className="button" href="#/study/labs">{L("ערכי מעבדה", "Lab values")}</a>
          </>}
        </div>
      </section>}
      {courses && !courses.length && (
        <section className="card study-start">
          <h2>{L("איך זה עובד", "How it works")}</h2>
          <ol>
            <li><b>{L("פותחים קורס", "Open a course")}</b> {L("למטה, בשם שלו (למשל ״פרמקולוגיה״). התחום מזוהה לבד, ואיתו הכלים שלו.", "below, by its name (e.g. “Pharmacology”). Its field is recognised by itself, with its tools.")}</li>
            <li><b>{L("מוסיפים הרצאה", "Add a lecture")}</b> {L("בהקלטה בזמן השיעור, בהדבקת טקסט, ממצגת או PDF, או בצילום של הלוח והמחברת.", "by recording it in class, pasting text, from slides or a PDF, or a photo of the board and notebook.")}</li>
            <li><b>{L("מקבלים חומר ללמידה", "Get material to study")}</b> {L("סיכום, מושגים, תרשים, כרטיסיות לחזרה בזמן הנכון, ומבחן תרגול שנבדק אוטומטית.", "a summary, terms, a diagram, flashcards reviewed at the right time, and a practice test graded automatically.")}</li>
          </ol>
          <p className="muted small">{L("הכול נשמר במחשב שלך, ומסתנכרן עם לשונית הלימודים באפליקציה בטלפון.", "Everything stays on your computer, and syncs with the Study tab in the phone app.")}</p>
        </section>
      )}
      <MoreTools simple={simple}>
      <section className="study-life card">
        <h2>{L("שאלה על הלימודים", "A question about your studies")}</h2>
        <p className="muted small">{L("שאלות מעשיות מקבלות תשובה עדכנית מהרשת, עם מקור רשמי.", "Practical questions get a current answer from the web, with an official source.")}</p>
        <div className="study-actions">
          {LIFE.filter(([, , clinical]) => !clinical || courses?.some((c) => clinicalField(c.field))).map(([he, en]) => <button key={en} type="button" className="study-life-q" onClick={() => askChat(`${L(he, en)}\n\n${LIFE_RULE}`)}>{L(he, en)}</button>)}
        </div>
      </section>
      <a className="study-avatar-link" href="#/study/benefits">{L("הטבות לסטודנטים: הנחה בתחבורה, תוכנות ו-AI בחינם", "Student benefits: transport discount, free software and AI")}</a>
      <a className="study-avatar-link" href="#/study/avatar">{L("מצלמת אווטאר לשיעורים בזום", "Avatar camera for Zoom lessons")}</a>
      </MoreTools>
      <StudyPlans />
      <MoodleCard courses={(courses ?? []).map((c) => ({ id: c.id, name: c.name }))} onAdded={load} />
      <h2>{L("הקורסים שלי", "My courses")}</h2>
      <label className="study-import small">
        {L("קיבלת קורס מחבר/ה? ", "Got a course from a classmate? ")}<span className="link-btn">{L("לפתוח קובץ קורס", "Open a course file")}</span>
        <input type="file" accept=".json,application/json" hidden onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          let data: unknown;
          try { data = JSON.parse(await f.text()); } catch { return toast(L("זה לא קובץ קורס של KesherAI.", "This is not a KesherAI course file.")); }
          const c = await call(api<StudyCourse>("/api/study/import", { method: "POST", body: data }));
          if (c) go(`#/study/${c.id}`);
        }} />
      </label>
      <form className="study-add" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={L("שם קורס חדש, למשל פרמקולוגיה", "New course name, e.g. Pharmacology")} aria-label={L("שם קורס", "Course name")} dir="auto" />
        <button type="submit" disabled={!name.trim()}>{L("+ קורס", "+ Course")}</button>
      </form>
      {!courses ? <p className="muted">…</p> : (
        <ul className="study-courses">
          {courses.map((c) => (
            <li key={c.id}>
              <a href={`#/study/${c.id}`} className="study-course">
                <b dir="auto">{c.name}</b>
                <small>{[fieldName(c.field), L(`${c.lectures} הרצאות · ${c.cards} כרטיסיות`, `${c.lectures} lectures · ${c.cards} cards`)].filter(Boolean).join(" · ")}</small>
                <small className={c.due ? "warn" : "good"}>{c.due ? L(`${c.due} לחזרה`, `${c.due} to review`) : L("הכול מעודכן", "All caught up")}</small>
                {c.daysLeft !== undefined && <small className={c.daysLeft <= 7 ? "warn" : ""}>{c.daysLeft === 0 ? L("מבחן היום", "Exam today") : L(`מבחן בעוד ${c.daysLeft} ימים · ${c.perDay} כרטיסיות ביום`, `Exam in ${c.daysLeft} days · ${c.perDay} cards a day`)}</small>}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A field's name in the page's language. */
const fieldName = (id: string | undefined) => {
  const f = STUDY_FIELDS.find((x) => x.id === id);
  return f ? L(f.he, f.en) : "";
};

/** Tabs only a clinical course has. */
const CLINICAL_TABS = new Set(["calc", "drugs", "labs"]);

/** Student benefits, the ones for her fields first, each with how to turn it on and its official page. */
/** "What to study now": one step, the most urgent across her courses, with the button that does it. */
const HIT_KIND: Record<StudyHit["kind"], [string, string]> = { term: ["מונח", "Term"], notes: ["ההערות שלי", "My notes"], summary: ["סיכום", "Summary"], lecture: ["הרצאה", "Lecture"], card: ["כרטיסייה", "Card"] };

/** One search over all her courses: lectures, summaries, her notes, cards and terms. */
function StudySearch() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<StudyHit[] | null>(null);
  useEffect(() => {
    if (q.trim().length < 2) { setHits(null); return; }
    const t = setTimeout(() => void api<{ hits: StudyHit[] }>(`/api/study/search?q=${encodeURIComponent(q.trim())}`).then((r) => setHits(r.hits), () => setHits([])), 250);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <section className="study-search">
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L("חיפוש בכל הקורסים", "Search all courses")} aria-label={L("חיפוש בכל הקורסים", "Search all courses")} dir="auto" />
      {hits && (hits.length ? (
        <ul className="study-hits">
          {hits.map((h, i) => (
            <li key={i}>
              <a href={h.lectureId && h.kind !== "card" ? `#/study/${h.courseId}/l/${h.lectureId}` : `#/study/${h.courseId}`} dir="auto">
                <b>{h.title}</b> <span className="muted small">{h.course} · {L(...HIT_KIND[h.kind])}</span>
                <span className="small study-hit-snip">{h.snippet}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : <p className="muted small">{L("לא נמצא בשום קורס.", "Not found in any course.")}</p>)}
    </section>
  );
}

function NextStep() {
  const [n, setN] = useState<StudyNext | null>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => void api<{ next: StudyNext | null }>("/api/study/next").then((r) => setN(r.next), () => undefined), []);
  if (!n) return null;
  const c = `#/study/${n.courseId}`;
  const days = (d = 0) => (d === 0 ? L("היום", "today") : d === 1 ? L("מחר", "tomorrow") : L(`בעוד ${d} ימים`, `in ${d} days`));
  const [text, href, button] = {
    "due-soon": [L(`להגשה ${days(n.days)}: ${n.what} (${n.course})`, `Due ${days(n.days)}: ${n.what} (${n.course})`), c, L("לקורס", "To the course")],
    "exam-soon": [L(`המבחן ב${n.course} ${days(n.days)}: מבחן תרגול על הנושאים החלשים`, `The ${n.course} exam is ${days(n.days)}: a practice test on the weak topics`), `${c}/quiz`, L("למבחן תרגול", "Practice test")],
    review: [L(`${n.what} כרטיסיות מחכות לחזרה ב${n.course}`, `${n.what} cards wait for review in ${n.course}`), `${c}/review`, L("לחזרה", "Review")],
    weak: [L(`חזרה על "${n.what}": שם היה לך קשה בבוחן`, `Go over "${n.what}": it was hard in the quiz`), `${c}/l/${n.lectureId}`, L("להרצאה", "Open the lecture")],
    summarize: [L(`לסכם את "${n.what}"`, `Summarize "${n.what}"`), `${c}/l/${n.lectureId}`, L("להרצאה", "Open the lecture")],
    cards: [L(`ליצור כרטיסיות מ"${n.what}"`, `Make cards from "${n.what}"`), `${c}/l/${n.lectureId}`, L("להרצאה", "Open the lecture")],
    focus: [L(`25 דקות ריכוז על ${n.course}`, `25 minutes of focus on ${n.course}`), "", ""],
  }[n.kind];
  // "Hard to start" (RESEARCH_LOG students part 26 #3): the next thing as a step of two minutes, and five minutes on the timer.
  const tiny = {
    "due-soon": L(`רק לפתוח את המטלה ולכתוב משפט אחד: מה היא מבקשת.`, "Just open the assignment and write one sentence: what it asks for."),
    "exam-soon": L("רק 3 שאלות תרגול. לא מבחן שלם.", "Just 3 practice questions. Not a whole test."),
    review: L("רק 5 כרטיסיות. אפשר לעצור אחריהן.", "Just 5 cards. You can stop after them."),
    weak: L("רק לקרוא את הפסקה הראשונה של הסיכום, ולהגיד אותה בקול במילים שלך.", "Just read the summary's first paragraph and say it aloud in your words."),
    summarize: L("רק ללחוץ על \"לסכם\" ולקרוא את שלוש השורות הראשונות.", "Just press \"Summarize\" and read the first three lines."),
    cards: L("רק ליצור את הכרטיסיות ולעבור על 3 מהן.", "Just make the cards and go through 3 of them."),
    focus: L("רק 5 דקות. טיימר קטן, בלי מטרה גדולה.", "Just 5 minutes. A small timer, no big aim."),
  }[n.kind];
  const startSmall = () => {
    const now = Date.now();
    try {
      localStorage.setItem(FOCUS_KEY, JSON.stringify({ courseId: n.courseId, minutes: 5, start: now, end: now + 5 * 60_000 } satisfies Running));
    } catch {
      // no storage: the timer is not kept
    }
    dispatchEvent(new Event("kesher-focus-start"));
    if (href) location.hash = href;
  };
  return (
    <section className="card study-next" aria-label={L("מה ללמוד עכשיו", "What to study now")}>
      <span className="muted small">{L("מה עכשיו", "What now")}</span>
      <p dir="auto">{text}</p>
      <div className="row">
        {href && <a className="button primary" href={href}>{button}</a>}
        <button type="button" className="study-stuck-btn" aria-expanded={stuck} onClick={() => setStuck(!stuck)}>🆘 {L("קשה להתחיל", "Hard to start")}</button>
      </div>
      {stuck && (
        <div className="study-stuck" role="status">
          <p dir="auto"><b>{L("צעד של 2 דקות:", "A 2-minute step:")}</b> {tiny}</p>
          <p className="muted small">{L("זה הכל. אחרי 5 דקות אפשר להפסיק בלי רגשות אשם, או להמשיך אם זה זורם.", "That's all. After 5 minutes you can stop, no guilt, or go on if it flows.")}</p>
          <button type="button" className="primary" onClick={startSmall}>▶ {L("רק 5 דקות", "Just 5 minutes")}</button>
        </div>
      )}
    </section>
  );
}

/** The last 7 days in one card (students part 25 #6): what she did, days studied, topics that rose or dropped. */
function WeekCard() {
  type Week = { counts: Record<GoalKind, number>; days: number; streak: number; rose: Array<{ course: string; title: string; change: number }>; dropped: Array<{ course: string; title: string; change: number }> };
  const [w, setW] = useState<Week | null>(null);
  useEffect(() => void api<Week>("/api/study/week").then(setW, () => undefined), []);
  if (!w || !w.days) return null;
  const parts = GOAL_KINDS.filter((k) => w.counts[k] > 0).map((k) => `${w.counts[k]} ${L(GOAL_NAMES[k][0], GOAL_NAMES[k][1].toLowerCase())}`);
  return (
    <details className="card study-week">
      <summary><b>📊 {L("השבוע שלך", "Your week")}</b> <span className="muted small">{L(`למדת ב-${w.days} מתוך 7 ימים`, `You studied on ${w.days} of 7 days`)}{w.streak ? ` · 🔥 ${w.streak}` : ""}</span></summary>
      <p dir="auto">{parts.join(" · ")}</p>
      {w.rose.length > 0 && <p className="small" dir="auto">📈 {L("עלו", "Rose")}: {w.rose.map((m) => `${m.title} (+${m.change})`).join(", ")}</p>}
      {w.dropped.length > 0 && <p className="small" dir="auto">📉 {L("ירדו, שווה חזרה", "Dropped, worth a review")}: {w.dropped.map((m) => `${m.title} (${m.change})`).join(", ")}</p>}
      <p className="muted small">{w.days >= 5 ? L("שבוע חזק. 💪", "A strong week. 💪") : w.days >= 3 ? L("שבוע טוב. עוד יום אחד וזה כבר הרגל.", "A good week. One more day and it's a habit.") : L("כל יום שלומדים בו נחשב. גם 10 דקות.", "Every day you study counts. Even 10 minutes.")}</p>
    </details>
  );
}

/** The focus timer's running session, kept so it survives a reload or the screen turning off. */
interface Running { courseId: string; minutes: number; end: number; start: number }
const FOCUS_KEY = "kesher-focus-running";
const readRunning = (): Running | null => {
  try {
    return JSON.parse(localStorage.getItem(FOCUS_KEY) || "null") as Running | null;
  } catch {
    return null;
  }
};

/**
 * Today's goal (design DailyGoal): only when she turned it on in Settings → Study. A ring per part of the goal, the
 * days in a row she reached it, and when the reminder comes.
 */
function GoalCard() {
  const [p, setP] = useState<{ goal: StudyGoal; today: { counts: Record<GoalKind, number>; done: boolean; streak: number; targets: Partial<Record<GoalKind, number>>; energy?: "high" | "ok" | "low" } } | null>(null);
  useEffect(() => {
    const load = () => void api<NonNullable<typeof p>>("/api/study/progress").then(setP, () => undefined);
    load();
    const t = window.setInterval(load, 60_000);
    addEventListener("focus", load);
    return () => {
      window.clearInterval(t);
      removeEventListener("focus", load);
    };
  }, []);
  // The goal reached while she is here: a small celebration, once a day.
  const wasDone = useRef<boolean | null>(null);
  useEffect(() => {
    if (!p?.goal.on) return;
    if (wasDone.current === false && p.today.done) {
      try {
        const k = `kesher-goal-celebrated:${new Date().toDateString()}`;
        if (!localStorage.getItem(k)) {
          localStorage.setItem(k, "1");
          celebrate();
        }
      } catch {
        celebrate();
      }
    }
    wasDone.current = p.today.done;
  }, [p]);
  const energy = async (level: "high" | "ok" | "low") => {
    try {
      setP(await api<NonNullable<typeof p>>("/api/study/energy", { method: "PUT", body: { level } }));
    } catch (e) {
      toast((e as Error).message);
    }
  };
  if (!p) return null;
  // "How am I today" (design FocusComfort): asked once a day; a low day halves the goal, without guilt.
  const ask = (
    <div className="study-energy">
      <b>{L("איך את היום?", "How are you today?")}</b>
      <div className="row">
        {([["high", "🔋", "מלאה אנרגיה", "Full of energy"], ["ok", "🙂", "בסדר", "OK"], ["low", "🪫", "עייפה", "Tired"]] as const).map(([k, icon, he, en]) => (
          <button type="button" key={k} className={p.today.energy === k ? "on" : ""} aria-pressed={p.today.energy === k} onClick={() => void energy(k)}>{icon} {L(he, en)}</button>
        ))}
      </div>
      {p.today.energy === "low" && <span className="small">{p.goal.on ? L("יום קל: חצי מהיעד מספיק היום, והרצף נשמר 💜", "A light day: half the goal is enough today, and the streak stays 💜") : L("יום קל. גם 10 דקות זה הרבה 💜", "A light day. Even 10 minutes is a lot 💜")}</span>}
      {p.today.energy === "high" && <span className="small">{L("יום טוב לנושא הכי קשה. 💪", "A good day for the hardest topic. 💪")}</span>}
    </div>
  );
  if (!p.goal.on) return <section className="card study-goal">{ask}</section>;
  const kinds = GOAL_KINDS.filter((k) => (p.today.targets[k] ?? 0) > 0);
  if (!kinds.length) return <section className="card study-goal">{ask}</section>;
  const left = kinds.filter((k) => p.today.counts[k] < p.today.targets[k]!);
  return (
    <section className="card study-goal" aria-label={L("היעד של היום", "Today's goal")}>
      <div className="goal-rings">
        {kinds.map((k) => {
          const target = p.today.targets[k]!;
          const n = p.today.counts[k];
          return (
            <div key={k} className={`goal-ring${n >= target ? " done" : ""}`} style={{ ["--p" as string]: String(Math.min(1, n / target)) }} title={L(GOAL_NAMES[k][0], GOAL_NAMES[k][1])}>
              <b dir="ltr">{n >= target ? `✓ ${n}` : `${n}/${target}`}</b>
              <small>{L(GOAL_NAMES[k][0], GOAL_NAMES[k][1])}</small>
            </div>
          );
        })}
      </div>
      <div className="study-goal-text">
        <b>🎯 {L("היעד של היום", "Today's goal")}</b>
        <span className="small">{p.today.done ? L("הושלם! 🎉", "Done! 🎉") : L(`נשאר: ${left.map((k) => `${p.today.targets[k]! - p.today.counts[k]} ${GOAL_NAMES[k][0]}`).join(", ")}`, `Left: ${left.map((k) => `${p.today.targets[k]! - p.today.counts[k]} ${GOAL_NAMES[k][1].toLowerCase()}`).join(", ")}`)}</span>
        <span className="muted small">🔥 {p.today.streak ? L(`${p.today.streak} ימים ברצף ביעד`, `${p.today.streak} days in a row`) : L("היום הראשון של הרצף", "Day one of the streak")}{p.goal.remind ? L(` · תזכורת ב-${p.goal.remind} אם עוד לא`, ` · reminder at ${p.goal.remind} if not yet`) : ""}</span>
        <a href="#/settings/study" className="small">⚙ {L("לשנות יעד", "Change the goal")}</a>
      </div>
      {ask}
    </section>
  );
}

/**
 * Focus timer with a study streak (Pomodoro 25 or 50 minutes, or her own length), tied to a course. A day counts
 * when she focused or reviewed cards; one missed day a week keeps the streak. This week's minutes per day under it.
 */
function FocusCard({ courses }: { courses: CourseRow[] }) {
  const [progress, setProgress] = useState<{ streak: { days: number; today: boolean; shield: boolean }; week: Array<{ day: string; minutes: number }> } | null>(null);
  const [running, setRunning] = useState<Running | null>(readRunning);
  // "Just 5 minutes" from "Hard to start" starts it here too.
  useEffect(() => {
    const on = () => setRunning(readRunning());
    addEventListener("kesher-focus-start", on);
    return () => removeEventListener("kesher-focus-start", on);
  }, []);
  const [courseId, setCourseId] = useState(courses[0]!.id);
  const [minutes, setMinutes] = useState(25);
  const [, tick] = useState(0);
  // Focus sounds and the study buddy (design FocusComfort), remembered on this device.
  const saved = (k: string, d: string) => {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  };
  const [sound, setSound] = useState<FocusSound>(() => saved("kesher-focus-sound", "off") as FocusSound);
  const [vol, setVol] = useState(() => Number(saved("kesher-focus-volume", "0.4")));
  const [buddy, setBuddy] = useState(() => saved("kesher-focus-buddy", "0") === "1");
  const remember = (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // private mode
    }
  };
  // The sound plays while the timer runs.
  useEffect(() => {
    if (running) playFocusSound(sound);
    else stopFocusSound();
  }, [running, sound]);
  useEffect(() => {
    setFocusVolume(vol);
  }, [vol]);
  useEffect(() => () => stopFocusSound(), []);
  // The buddy: every 10 minutes a quiet line that she is not alone in it.
  useEffect(() => {
    if (!running || !buddy) return;
    const lines = [
      L("אני פה איתך. עברו 10 דקות, את בכיוון 💜", "I'm here with you. 10 minutes in, you're on it 💜"),
      L("עוד קצת. נשימה עמוקה, וממשיכים.", "A bit more. A deep breath, and on we go."),
      L("כל הכבוד שאת עדיין פה. זה החלק הקשה.", "Well done for still being here. This is the hard part."),
    ];
    let n = 0;
    const t = window.setInterval(() => toast(lines[n++ % lines.length]!), 10 * 60_000);
    return () => window.clearInterval(t);
  }, [running, buddy]);
  const load = () => void api<NonNullable<typeof progress>>("/api/study/progress").then(setProgress, () => undefined);
  useEffect(load, []);
  const keep = (r: Running | null) => {
    setRunning(r);
    try {
      if (r) localStorage.setItem(FOCUS_KEY, JSON.stringify(r));
      else localStorage.removeItem(FOCUS_KEY);
    } catch {
      // private mode: this visit only
    }
  };
  const finish = useCallback(async (r: Running, early: boolean) => {
    keep(null);
    const done = Math.round((Math.min(Date.now(), r.end) - r.start) / 60000);
    // A session stopped before 5 minutes does not count.
    if (early && done < 5) return;
    await call(api(`/api/study/courses/${r.courseId}/focus`, { method: "POST", body: { minutes: Math.max(1, done) } }));
    if (!early) {
      toast(L(`כל הכבוד! ${done} דקות ריכוז. הפסקה קצרה.`, `Well done! ${done} minutes of focus. Take a short break.`));
      navigator.vibrate?.([200, 100, 200]);
    }
    load();
  }, []);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      if (Date.now() >= running.end) void finish(running, false);
      else tick((n) => n + 1);
    }, 1000);
    return () => clearInterval(t);
  }, [running, finish]);
  const left = running ? Math.max(0, running.end - Date.now()) : 0;
  const mm = String(Math.floor(left / 60000)).padStart(2, "0");
  const ss = String(Math.floor((left % 60000) / 1000)).padStart(2, "0");
  const max = Math.max(25, ...(progress?.week.map((w) => w.minutes) ?? [0]));
  const dayName = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(getLocale() === "he" ? "he-IL" : "en-GB", { weekday: "narrow" });
  return (
    <section className="card study-focus" aria-label={L("טיימר ריכוז", "Focus timer")}>
      <div className="study-focus-top">
        <div>
          <h2>{L("טיימר ריכוז", "Focus timer")}</h2>
          {progress && <p className="muted small">{progress.streak.days ? L(`רצף: ${progress.streak.days} ימים${progress.streak.today ? "" : " · עוד לא היום"}`, `Streak: ${progress.streak.days} days${progress.streak.today ? "" : " · not yet today"}`) : L("כל יום שלומדים בו (ריכוז או חזרה) נכנס לרצף. יום אחד בשבוע מותר לפספס.", "Every day you study (focus or review) joins the streak. One missed day a week is allowed.")}{progress?.streak.shield ? L(" · יום חופש נוצל השבוע", " · this week's free day used") : ""}</p>}
        </div>
        {progress && <div className="study-focus-week" aria-label={L("דקות ריכוז השבוע", "Focus minutes this week")}>
          {progress.week.map((w) => <span key={w.day} title={`${w.minutes} ${L("דק׳", "min")}`}><i style={{ height: `${Math.round((w.minutes / max) * 28) + 2}px` }} />{dayName(w.day)}</span>)}
        </div>}
      </div>
      {running ? (
        <div className="study-focus-run">
          <strong className="study-focus-clock" aria-live="off">{mm}:{ss}</strong>
          <span className="muted small">{courses.find((c) => c.id === running.courseId)?.name}</span>
          <button type="button" onClick={() => void finish(running, true)}>{L("עצירה", "Stop")}</button>
        </div>
      ) : null}
      <div className="focus-comfort">
        <div className="focus-sounds" role="radiogroup" aria-label={L("צליל רקע", "Background sound")}>
          {([["off", "🔇", "שקט", "Quiet"], ["brown", "🟤", "רעש חום", "Brown noise"], ["rain", "🌧", "גשם", "Rain"], ["waves", "🌊", "גלים", "Waves"]] as const).map(([k, icon, he, en]) => (
            <button type="button" key={k} role="radio" aria-checked={sound === k} className={sound === k ? "on" : ""} onClick={() => { setSound(k); remember("kesher-focus-sound", k); }}>{icon} {L(he, en)}</button>
          ))}
          {sound !== "off" && <input type="range" min={0} max={1} step={0.05} value={vol} aria-label={L("עוצמה", "Volume")} onChange={(e) => { setVol(Number(e.target.value)); remember("kesher-focus-volume", e.target.value); }} />}
        </div>
        <label className="study-check small"><input type="checkbox" checked={buddy} onChange={(e) => { setBuddy(e.target.checked); remember("kesher-focus-buddy", e.target.checked ? "1" : "0"); }} /> 👋 {L("חבר ללמידה: מילה טובה כל 10 דקות", "Study buddy: a kind word every 10 minutes")}</label>
      </div>
      {running ? null : (
        <div className="study-actions">
          <select value={courseId} onChange={(e) => setCourseId(e.target.value)} aria-label={L("קורס", "Course")}>{courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          {[25, 50].map((m) => <button key={m} type="button" className={minutes === m ? "on" : ""} aria-pressed={minutes === m} onClick={() => setMinutes(m)}>{m} {L("דק׳", "min")}</button>)}
          <input type="number" min={5} max={180} value={minutes} onChange={(e) => setMinutes(Math.min(180, Math.max(5, Number(e.target.value) || 25)))} aria-label={L("דקות", "Minutes")} style={{ width: 72 }} />
          <button type="button" className="primary" onClick={() => { const now = Date.now(); keep({ courseId, minutes, start: now, end: now + minutes * 60000 }); }}>{L("התחלה", "Start")}</button>
        </div>
      )}
    </section>
  );
}

function Benefits() {
  const [fields, setFields] = useState<Array<string | undefined>>([]);
  useEffect(() => void api<{ courses: CourseRow[] }>("/api/study").then((r) => setFields(r.courses.map((c) => c.field)), () => undefined), []);
  const list = benefitsFor(fields);
  const check = () => askChat(L(
    `חפש ברשת אילו הטבות לסטודנטים בישראל קיימות עכשיו (תחבורה ציבורית, תוכנות, AI כמו Gemini, טלפון ואינטרנט, תרבות, טיסות, בנקים) ומה צריך כדי להפעיל כל אחת. לכל הטבה: למי היא, איך מפעילים, וקישור לעמוד הרשמי. ציין אם היא זמינה בישראל ומתי בדקת. התחומים שלי: ${fields.filter(Boolean).join(", ") || "לא ידוע"}.`,
    `Search the web for the student benefits available in Israel now (public transport, software, AI like Gemini, phone and internet, culture, flights, banks) and what each needs to turn it on. For each: who it is for, how to turn it on, and a link to the official page. Say whether it is available in Israel and when you checked. My fields: ${fields.filter(Boolean).join(", ") || "unknown"}.`,
  ));
  return (
    <section className="study-benefits">
      <p className="muted small">{L("הטבות משתנות: בכל אחת כתוב מתי נבדקה, ותמיד כדאי לאשר בעמוד הרשמי לפני שמפעילים.", "Benefits change: each says when it was checked; always confirm on the official page before turning it on.")}</p>
      <button type="button" className="primary" onClick={check}>{L("בדוק מה חדש עכשיו (חיפוש ברשת)", "Check what is new now (web search)")}</button>
      <ul className="study-list">
        {list.map((b) => (
          <li key={b.id}>
            <details className="study-benefit">
              <summary><b>{L(b.name.he, b.name.en)}</b><small>{L(b.what.he, b.what.en)}</small></summary>
              <ol>{(getLocale() === "he" ? b.how.he : b.how.en).map((h, i) => <li key={i}>{h}</li>)}</ol>
              {b.note && <p className="warn small">{L(b.note.he, b.note.en)}</p>}
              <p className="small"><a href={b.url} target="_blank" rel="noreferrer">{L("לעמוד הרשמי", "Official page")}</a> · <span className="muted">{L(`נבדק ${b.checked.split("-").reverse().join(".")}`, `Checked ${b.checked}`)}</span></p>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}

const TABS: Array<[string, [string, string]]> = [
  ["lectures", ["הרצאות", "Lectures"]],
  ["review", ["חזרה", "Review"]],
  ["summary", ["סיכום הקורס", "Course summary"]],
  ["tools", ["כלים לתחום", "Field tools"]],
  ["quiz", ["בוחן", "Quiz"]],
  ["ask", ["שאלי את הקורס", "Ask the course"]],
  ["calc", ["חישובים", "Calculations"]],
  ["terms", ["מילון", "Glossary"]],
  ["game", ["🎯 משחק", "🎯 Game"]],
  ["drugs", ["תרופות", "Drugs"]],
  ["labs", ["ערכי מעבדה", "Lab values"]],
  ["progress", ["מה עובד בשבילי", "What works for me"]],
];

type ModelState = { waiting?: { want: string; now?: string; why: string; since: number }; switched: boolean; hebrew?: string; models: string[] };

/** Which model writes for the course: automatic (the best Hebrew model on the computer) or one she picks. */
/** When the semester ends, shown when recordings are deleted "after the semester" and nothing else says the date. */
function SemesterEnd({ id, course, syllabusEnd, onChange }: { id: string; course: StudyCourse; syllabusEnd?: string; onChange: () => void }) {
  const [after, setAfter] = useState<string>("");
  useEffect(() => void api<{ deleteAfter: string }>("/api/study/recordings").then((r) => setAfter(r.deleteAfter), () => undefined), []);
  if (after !== "semester" || (!course.semesterEnd && (syllabusEnd || course.examDate))) return null;
  return (
    <label className="study-field" title={L("ההקלטות של הקורס נמחקות אחרי התאריך הזה", "The course's recordings are deleted after this date")}>
      <span>{L("סוף סמסטר", "Semester ends")}</span>
      <input type="date" value={course.semesterEnd ?? ""} onChange={async (e) => { if (await call(api(`/api/study/courses/${id}`, { method: "PATCH", body: { semesterEnd: e.target.value } }))) onChange(); }} />
    </label>
  );
}

function CourseModel({ id, model, onChange }: { id: string; model?: string; onChange: () => void }) {
  const [st, setSt] = useState<ModelState | null>(null);
  useEffect(() => void api<ModelState>("/api/study/model").then(setSt, () => undefined), []);
  // A readable name: no provider, no quantization or "Thinking" tail, spaces for dashes (fits 390 px).
  const short = (m: string) => m.replace(/^llamacpp\//, "").replace(/\.gguf$/i, "").replace(/[-_](Thinking|Instruct)?[-_]?(UD[-_])?(I?Q\d.*|F16|BF16)$/i, "").replace(/[-_]+/g, " ");
  return (
    <label className="study-field">
      <span>{L("מודל", "Model")}</span>
      <select value={model ?? ""} title={L("איזה מודל כותב סיכומים, שאלות ותשובות בקורס הזה", "Which model writes summaries, questions and answers for this course")} onChange={async (e) => { if (await call(api(`/api/study/courses/${id}`, { method: "PATCH", body: { model: e.target.value } }))) onChange(); }}>
        <option value="">{st?.hebrew ? L(`אוטומטי: הכי טוב בעברית (${short(st.hebrew)})`, `Automatic: best in Hebrew (${short(st.hebrew)})`) : L("אוטומטי: מודל הצ׳אט הפעיל", "Automatic: the active chat model")}</option>
        {(st?.models ?? []).map((m) => <option key={m} value={m} dir="ltr">{short(m)}</option>)}
        {model && !(st?.models ?? []).includes(model) && <option value={model} dir="ltr">{short(model)}</option>}
      </select>
    </label>
  );
}

/** While a course waits for its own model (a chat or self-work uses the loaded one): what it waits for, and "Switch now". */
function ModelWait() {
  const [st, setSt] = useState<ModelState | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () => void api<ModelState>("/api/study/model").then((r) => alive && setSt(r), () => undefined);
    tick();
    const t = setInterval(tick, 3000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const w = st?.waiting;
  if (!w) return null;
  const now = w.now?.replace(/\.gguf$/i, "") ?? L("מודל אחר", "another model");
  const want = w.want.replace(/\.gguf$/i, "");
  return (
    <div className="card study-wait" role="status">
      <strong>{L("מחכה למודל של הקורס", "Waiting for the course's model")}</strong>
      <p className="small">{w.why === "chat"
        ? L(`צ׳אט עונה עכשיו עם ${now}. כשיסיים, ${want} ייטען, ואחר כך המודל הקודם יחזור.`, `A chat is answering with ${now}. When it ends, ${want} loads, and the earlier model comes back after.`)
        : L(`המחשב משתמש עכשיו ב-${now} לעבודה עצמית. כשיתפנה, ${want} ייטען, ואחר כך המודל הקודם יחזור.`, `The computer is using ${now} for self-work. When it is free, ${want} loads, and the earlier model comes back after.`)}</p>
      <div className="row"><button type="button" className="primary" onClick={() => void api("/api/study/model/now", { method: "POST" }).then(() => toast(L("מחליף…", "Switching…")), (e: Error) => toast(e.message))}>{L("להחליף עכשיו", "Switch now")}</button></div>
    </div>
  );
}

function CoursePage({ id, tab, lectureId }: { id: string; tab: string; lectureId?: string }) {
  const [info, setInfo] = useState<CourseInfo | null>(null);
  const [prefs] = useStudyPrefs();
  const [allTabs, setAllTabs] = useState(false);
  const load = useCallback(() => void api<CourseInfo>(`/api/study/courses/${id}`).then(setInfo, (e: Error) => toast(e.message)), [id]);
  useEffect(load, [load]);
  if (!info) return <div className="page study-page"><BackLink to="#/study" /><p className="muted">…</p></div>;
  const on = lectureId ? "lectures" : tab;
  return (
    <div className={`page study-page${prefs?.easyRead ? " study-easy-read" : ""}`}>
      <BackLink to={lectureId ? `#/study/${id}` : "#/study"} />
      <div className="study-head">
        <h1 dir="auto">{info.course.name}</h1>
        <label className="study-field">
          <span>{L("תחום", "Field")}</span>
          <select value={info.course.fieldChosen ? info.course.field ?? "" : ""} onChange={async (e) => { if (await call(api(`/api/study/courses/${id}`, { method: "PATCH", body: { field: e.target.value } }))) load(); }}>
            <option value="">{info.course.field && !info.course.fieldChosen ? L(`זוהה: ${fieldName(info.course.field)}`, `Recognised: ${fieldName(info.course.field)}`) : L("לזהות לבד", "Recognise by itself")}</option>
            {STUDY_FIELDS.map((f) => <option key={f.id} value={f.id}>{L(f.he, f.en)}</option>)}
          </select>
        </label>
        <CourseModel id={id} model={info.course.model} onChange={load} />
        <SemesterEnd id={id} course={info.course} syllabusEnd={[...(info.syllabus?.exams ?? [])].map((e) => e.date).sort().at(-1)} onChange={load} />
        <label className="study-field">
          <span>{L("מבחן", "Exam")}</span>
          <input type="date" value={info.course.examDate ?? ""} onChange={async (e) => { if (await call(api(`/api/study/courses/${id}`, { method: "PATCH", body: { examDate: e.target.value } }))) load(); }} />
        </label>
        <button type="button" className="small" onClick={() => void shareCourseFile(id, info.course.name)}>{L("שיתוף הקורס", "Share the course")}</button>
        {info.cards > 0 && <button type="button" className="small" title={L("קובץ טקסט שנכנס ל-Anki (ייבוא ← הערות בטקסט פשוט) ול-Quizlet", "A text file for Anki (Import → Notes in plain text) and Quizlet")} onClick={() => void ankiFile(id, info.course.name)}>{L("ייצוא ל-Anki / Quizlet", "Export to Anki / Quizlet")}</button>}
        <label className="button small" title={L("קובץ ייצוא של Anki או Quizlet (טקסט מופרד בטאבים)", "An Anki or Quizlet export (tab-separated text)")}>{L("ייבוא כרטיסיות", "Import cards")}
          <input type="file" hidden accept=".txt,.tsv,.csv,text/plain" onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            const r = await call(api<{ added: number; skipped: number }>(`/api/study/courses/${id}/cards/import`, { method: "POST", body: { text: await f.text() } }));
            if (r) { toast(L(`נוספו ${r.added} כרטיסיות${r.skipped ? ` (${r.skipped} כבר היו)` : ""}`, `${r.added} cards added${r.skipped ? ` (${r.skipped} already there)` : ""}`)); load(); }
          }} />
        </label>
        <button type="button" className="small ghost" onClick={async () => {
          if (!confirm(L(`למחוק את הקורס "${info.course.name}" עם כל ההרצאות והכרטיסיות? אי אפשר לבטל.`, `Delete "${info.course.name}" with all its lectures and cards? This cannot be undone.`))) return;
          if (await call(api(`/api/study/courses/${id}`, { method: "DELETE" }))) go("#/study");
        }}>{L("מחק קורס", "Delete course")}</button>
      </div>
      {info.plan && !lectureId && <ExamPlanCard id={id} plan={info.plan} />}
      {!lectureId && <SyllabusCard id={id} syllabus={info.syllabus ?? null} onChange={load} />}
      <ModelWait />
      <div className="seg-pills" role="tablist" aria-label={L("חלקי הקורס", "Course sections")}>
        {TABS.filter(([t]) => clinicalField(info.course.field) || !CLINICAL_TABS.has(t)).filter(([t]) => !prefs?.simple || allTabs || SIMPLE_TABS.has(t) || t === on).map(([t, n]) => (
          <button key={t} type="button" role="tab" aria-selected={on === t} className={on === t ? "on" : ""} onClick={() => go(`#/study/${id}/${t}`)}>
            {L(...n)}{t === "review" && info.due ? ` (${info.due})` : ""}
          </button>
        ))}
        {prefs?.simple && <button type="button" className="study-more-tabs" aria-expanded={allTabs} onClick={() => setAllTabs(!allTabs)}>{allTabs ? L("פחות", "Fewer") : `⋯ ${L("עוד כלים", "More tools")}`}</button>}
      </div>
      {lectureId ? <LectureView courseId={id} lectureId={lectureId} courseField={info.course.field} onChange={load} />
        : on === "review" ? <Review courseId={id} courseName={info.course.name} onChange={load} />
        : on === "quick" ? <StudyMistakes quick courseId={id} courseName={info.course.name} onClose={() => { load(); go(`#/study/${id}`); }} />
        : on === "quiz" ? <Quiz courseId={id} lectures={info.lectures} pastExams={info.pastExams ?? []} onChange={load} />
        : on === "calc" ? <CalcPractice />
        : on === "terms" ? <Glossary lectures={info.lectures} />
        : on === "game" ? <StudyMatch courseId={id} courseName={info.course.name} terms={info.lectures.flatMap((l) => l.terms ?? [])} />
        : on === "summary" ? <CourseSummary id={id} info={info} onChange={load} />
        : on === "tools" ? <FieldTools id={id} info={info} onChange={load} />
        : on === "drugs" ? <Drugs courseId={id} info={info} onChange={load} />
        : on === "labs" ? <LabValues />
        : on === "progress" ? <ProgressView courseId={id} />
        : on === "ask" ? <AskCourse courseId={id} hasLectures={info.lectures.length > 0} />
        : <Lectures courseId={id} info={info} onChange={load} />}
    </div>
  );
}

/** The course's tutor: questions answered only from her lectures, each fact with its lecture. */
function AskCourse({ courseId, hasLectures }: { courseId: string; hasLectures: boolean }) {
  const [turns, setTurns] = useState<Array<{ role: "user" | "assistant"; content: string; sources?: Array<{ lectureId: string; title: string; page?: number }> }>>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  // "ask": she asks, answers come from her lectures. "study": the tutor asks her, waits, then corrects.
  const [mode, setMode] = useState<"ask" | "study" | "homework">("ask");
  const switchMode = (m: "ask" | "study" | "homework") => { setMode(m); setTurns([]); setQ(""); };
  const send = async (start = false, preset?: string) => {
    const question = (preset ?? q).trim();
    if ((!question && !start) || busy) return;
    setQ("");
    setBusy(true);
    const history = turns.map(({ role, content }) => ({ role, content }));
    if (question) setTurns((t) => [...t, { role: "user", content: question }]);
    const r = await call(api<{ answer: string; sources: Array<{ lectureId: string; title: string; page?: number }> }>(`/api/study/courses/${courseId}/ask`, { method: "POST", body: { question, history, mode } }));
    setBusy(false);
    if (r) setTurns((t) => [...t, { role: "assistant", content: r.answer, sources: r.sources }]);
  };
  if (!hasLectures) return <p className="muted">{L("קודם הוסיפי הרצאה: התשובות מגיעות רק מההרצאות שלך.", "Add a lecture first: answers come only from your lectures.")}</p>;
  return (
    <section className="study-ask">
      <div className="seg-pills" role="tablist" aria-label={L("איך לומדים", "How to study")}>
        <button type="button" role="tab" aria-selected={mode === "ask"} className={mode === "ask" ? "on" : ""} onClick={() => switchMode("ask")}>{L("השאלות שלי", "My questions")}</button>
        <button type="button" role="tab" aria-selected={mode === "study"} className={mode === "study" ? "on" : ""} onClick={() => switchMode("study")}>{L("מצב תרגול: המורה שואלת", "Study mode: the tutor asks")}</button>
        <button type="button" role="tab" aria-selected={mode === "homework"} className={mode === "homework" ? "on" : ""} onClick={() => switchMode("homework")}>{L("שיעורי בית: צעד אחר צעד", "Homework: step by step")}</button>
      </div>
      <p className="muted small">{mode === "homework" ? L("הדביקי את התרגיל. המורה עוזרת צעד אחר צעד: כתבי כל צעד שעשית והיא תבדוק, בקשי רמז כשנתקעת, ופתרון מלא כשתרצי.", "Paste the exercise. The tutor helps step by step: write each step you took and it checks it, ask for a hint when stuck, and for the full solution when you want it.") : mode === "ask" ? L("התשובות רק מההרצאות שלך, עם שם ההרצאה ליד כל עובדה. כשההרצאות לא מכסות שאלה, זה ייאמר.", "Answers come only from your lectures, with the lecture named by each fact. When they do not cover a question, it says so.") : L("המורה שואלת שאלה אחת מההרצאות שלך, מחכה לתשובה, אומרת אם צדקת ומסבירה, וממשיכה. אפשר לבקש רמז.", "The tutor asks one question from your lectures, waits for your answer, says whether it is right and explains, then goes on. You can ask for a hint.")}</p>
      {mode === "study" && turns.length === 0 && !busy && <button type="button" className="primary" onClick={() => void send(true)}>{L("התחילי תרגול", "Start practising")}</button>}
      <div className="study-ask-turns" aria-live="polite">
        {turns.map((t, i) => (
          <div key={i} className={`study-ask-turn ${t.role}`} dir="auto">
            <p>{t.content}</p>
            {t.sources && t.sources.length > 0 && <small className="muted">{L("מתוך: ", "From: ")}{t.sources.map((s, j) => <span key={s.lectureId}>{j ? " · " : ""}<a href={`#/study/${courseId}/l/${s.lectureId}`}>{s.title}{s.page ? L(`, עמ׳ ${s.page}`, `, p. ${s.page}`) : ""}</a></span>)}</small>}
          </div>
        ))}
        {busy && <p className="muted">{mode === "study" ? L("חושבת על שאלה…", "Thinking of a question…") : L("מחפשת בהרצאות…", "Looking through your lectures…")}</p>}
      </div>
      {mode === "homework" && turns.length > 0 && !busy && (
        <div className="study-actions">
          <button type="button" onClick={() => void send(false, L("רמז, בבקשה", "A hint, please"))}>{L("רמז", "Hint")}</button>
          <button type="button" onClick={() => void send(false, L("הראי לי את הפתרון המלא, צעד אחר צעד", "Show me the full solution, step by step"))}>{L("פתרון מלא", "Full solution")}</button>
        </div>
      )}
      <form className="study-add" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} dir={q ? "auto" : getLocale() === "he" ? "rtl" : "ltr"} aria-label={mode === "study" ? L("התשובה שלך", "Your answer") : L("שאלה", "Question")} placeholder={mode === "homework" ? (turns.length ? L("הצעד שעשית, או שאלה", "Your step, or a question") : L("התרגיל (הדביקי את הנוסח)", "The exercise (paste it)")) : mode === "study" ? L("התשובה שלך, או \"רמז\"", "Your answer, or \"hint\"") : L("למשל: מה ההבדל בין סוג 1 לסוג 2?", "e.g. What is the difference between type 1 and type 2?")} />
        <button type="submit" className="primary" disabled={busy || !q.trim()}>{mode === "study" ? L("שליחת תשובה", "Answer") : mode === "homework" ? L("שליחה", "Send") : L("שאלי", "Ask")}</button>
      </form>
    </section>
  );
}

/** The plan toward the exam: the days left, the day's cards, what has nothing to study from yet, the test week. */
/**
 * The course's syllabus: what is next (exam, assignments in the next three weeks, this week's topic), or "add the
 * syllabus": read once from a file or photo, shown to her to confirm, then kept (the exam date follows it).
 */
function SyllabusCard({ id, syllabus, onChange }: { id: string; syllabus: StudySyllabus | null; onChange: () => void }) {
  const [busy, setBusy] = useState("");
  const [draft, setDraft] = useState<StudySyllabus | null>(null);
  const read = async (f: File | undefined) => {
    if (!f) return;
    setBusy(L("קורא את הסילבוס…", "Reading the syllabus…"));
    const x = await call(api<{ text: string }>("/api/study/extract", { method: "POST", body: { name: f.name, data: await fileBase64(f) } }));
    setBusy(x ? L("מחפש מבחנים, מטלות ונושאים…", "Finding exams, assignments and topics…") : "");
    const s = x && (await call(api<StudySyllabus>(`/api/study/courses/${id}/syllabus/read`, { method: "POST", body: { text: x.text } })));
    setBusy("");
    if (s) setDraft(s);
  };
  const save = async (s: StudySyllabus | null) => {
    const r = await call(api(`/api/study/courses/${id}/syllabus`, { method: "PUT", body: { syllabus: s } }));
    if (r) { setDraft(null); onChange(); }
  };
  const fmt = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(getLocale() === "he" ? "he-IL" : "en-GB", { day: "numeric", month: "numeric" });
  if (draft) return (
    <section className="card study-syllabus">
      <h2>{L("זה מה שמצאתי בסילבוס. נכון?", "This is what I found in the syllabus. Right?")}</h2>
      {draft.exams.length > 0 && <><h3>{L("מבחנים", "Exams")}</h3><ul>{draft.exams.map((e, i) => <li key={i} dir="auto">{fmt(e.date)} · {e.title} <button type="button" className="ghost small" aria-label={L("הסרה", "Remove")} onClick={() => setDraft({ ...draft, exams: draft.exams.filter((_, k) => k !== i) })}>✕</button></li>)}</ul></>}
      {draft.assignments.length > 0 && <><h3>{L("מטלות", "Assignments")}</h3><ul>{draft.assignments.map((e, i) => <li key={i} dir="auto">{fmt(e.date)} · {e.title} <button type="button" className="ghost small" aria-label={L("הסרה", "Remove")} onClick={() => setDraft({ ...draft, assignments: draft.assignments.filter((_, k) => k !== i) })}>✕</button></li>)}</ul></>}
      {draft.weeks.length > 0 && <><h3>{L("נושאים לפי שבוע", "Topics by week")}</h3><ul>{draft.weeks.map((w, i) => <li key={i} dir="auto">{L(`שבוע ${w.week}`, `Week ${w.week}`)}{w.date ? ` (${fmt(w.date)})` : ""} · {w.topic}</li>)}</ul></>}
      <div className="study-actions">
        <button type="button" className="primary" onClick={() => void save(draft)}>{L("שמירה", "Save")}</button>
        <button type="button" className="ghost" onClick={() => setDraft(null)}>{L("ביטול", "Cancel")}</button>
      </div>
      <p className="muted small">{L("המבחן הקרוב יהפוך לתאריך המבחן של הקורס (אם עוד לא קבעת). כדאי להשוות לסילבוס עצמו.", "The next exam becomes the course's exam date (if you have not set one). Compare with the syllabus itself.")}</p>
    </section>
  );
  const now = syllabusNow(syllabus ?? undefined);
  return (
    <section className="card study-syllabus">
      <h2>{L("סילבוס", "Syllabus")}</h2>
      {syllabus ? (
        <>
          {now.week && <p dir="auto">{L(`השבוע (שבוע ${now.week.week}): `, `This week (week ${now.week.week}): `)}<b>{now.week.topic}</b></p>}
          {now.nextExam && <p dir="auto">{L("המבחן הבא: ", "Next exam: ")}{now.nextExam.title} · {fmt(now.nextExam.date)} ({L(`בעוד ${now.nextExam.daysLeft} ימים`, `in ${now.nextExam.daysLeft} days`)})</p>}
          {now.due.map((a, i) => <p key={i} className="small" dir="auto">{L("להגשה: ", "Due: ")}{a.title} · {fmt(a.date)} ({a.daysLeft === 0 ? L("היום", "today") : L(`בעוד ${a.daysLeft} ימים`, `in ${a.daysLeft} days`)})</p>)}
          {!now.week && !now.nextExam && !now.due.length && <p className="muted">{L("אין משהו קרוב בסילבוס.", "Nothing coming up in the syllabus.")}</p>}
        </>
      ) : <p className="muted">{L("הוסיפי את הסילבוס של הקורס ותקבלי את המבחנים, המטלות ונושא כל שבוע, ותאריך המבחן ייקבע לבד.", "Add the course's syllabus to get its exams, assignments and each week's topic; the exam date is set by itself.")}</p>}
      <div className="study-actions">
        <label className="button">{busy || (syllabus ? L("סילבוס חדש", "A new syllabus") : L("הוספת סילבוס (PDF, Word או צילום)", "Add the syllabus (PDF, Word or photo)"))}
          <input type="file" hidden accept=".pdf,.docx,.pptx,.txt,image/*" disabled={!!busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void read(f); }} />
        </label>
        {syllabus && <button type="button" className="ghost" onClick={() => void save(null)}>{L("הסרת הסילבוס", "Remove the syllabus")}</button>}
      </div>
    </section>
  );
}

/**
 * One summary of the whole course by topic, grown from the lectures' summaries (a few lectures per step), with a
 * search inside it.
 */
function CourseSummary({ id, info, onChange }: { id: string; info: CourseInfo; onChange: () => void }) {
  const [busy, setBusy] = useState("");
  const [find, setFind] = useState("");
  const s = info.courseSummary ?? null;
  const summarized = info.lectures.filter((l) => l.summarized);
  const missing = summarized.filter((l) => !s?.lectureIds.includes(l.id)).length;
  const grow = async () => {
    for (let step = 1; step <= 20; step++) {
      setBusy(L(`כותב את הסיכום… (שלב ${step})`, `Writing the summary… (step ${step})`));
      const r = await call(api<{ more: boolean }>(`/api/study/courses/${id}/summary`, { method: "POST" }));
      if (!r?.more) break;
    }
    setBusy("");
    onChange();
  };
  const shown = useMemo(() => {
    if (!s || !find.trim()) return s?.text ?? "";
    const q = find.trim().toLowerCase();
    // Whole topics (## …) that mention what she looks for.
    return s.text.split(/\n(?=## )/).filter((part) => part.toLowerCase().includes(q)).join("\n") || "";
  }, [s, find]);
  return (
    <section className="card study-course-summary">
      <h2>{L("סיכום הקורס לפי נושאים", "The course by topic")}</h2>
      {!summarized.length ? <p className="muted">{L("סכמי לפחות הרצאה אחת, והסיכום של כל הקורס ייבנה ממנה ויגדל עם כל הרצאה.", "Summarize at least one lecture; the course summary is built from it and grows with each lecture.")}</p> : (
        <div className="study-actions">
          {(!s || missing > 0) && <button type="button" className="primary" disabled={!!busy} onClick={() => void grow()}>{busy || (s ? L(`הוספת ${missing} הרצאות חדשות לסיכום`, `Add ${missing} new lectures to the summary`) : L("כתיבת סיכום הקורס", "Write the course summary"))}</button>}
          {s && <input type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder={L("חיפוש בסיכום", "Search the summary")} aria-label={L("חיפוש בסיכום", "Search the summary")} />}
        </div>
      )}
      {s && (shown ? <div dir="auto" className="study-summary-text"><RichText text={shown} /></div> : <p className="muted">{L("אין נושא שמזכיר את זה.", "No topic mentions that.")}</p>)}
      {s && <p className="muted small">{L(`נבנה מ-${s.lectureIds.length} הרצאות. כל שורה מציינת מאיזו הרצאה היא באה.`, `Built from ${s.lectureIds.length} lectures. Each line says which lecture it came from.`)}</p>}
    </section>
  );
}

/** The tools of the course's field: she picks one, pastes text (or it reads the course), and can keep the result. */
function FieldTools({ id, info, onChange }: { id: string; info: CourseInfo; onChange: () => void }) {
  const tools = toolsFor(info.course.field);
  const [pick, setPick] = useState(tools[0]?.id ?? "");
  const [text, setText] = useState("");
  const [out, setOut] = useState("");
  const [busy, setBusy] = useState(false);
  const tool = tools.find((t) => t.id === pick);
  const run = async () => {
    setBusy(true);
    setOut("");
    const r = await call(api<{ text: string }>(`/api/study/courses/${id}/tools/${pick}`, { method: "POST", body: { text } }));
    setBusy(false);
    if (r) setOut(r.text);
  };
  const keep = async () => {
    const r = await call(api<StudyLecture>(`/api/study/courses/${id}/lectures`, { method: "POST", body: { title: tool ? L(tool.he, tool.en) : "", text: out } }));
    if (r) { toast(L("נשמר כהרצאה בקורס", "Kept as a lecture in the course")); onChange(); }
  };
  if (!tool) return null;
  return (
    <section className="card study-tools">
      <h2>{L("כלים לתחום", "Field tools")}</h2>
      <div className="study-formats" role="radiogroup" aria-label={L("כלי", "Tool")}>
        {tools.map((t) => <button key={t.id} type="button" role="radio" aria-checked={pick === t.id} className={`chip${pick === t.id ? " on" : ""}`} onClick={() => { setPick(t.id); setOut(""); }}>{L(t.he, t.en)}</button>)}
      </div>
      {tool.input === "text"
        ? <textarea rows={8} dir="auto" value={text} onChange={(e) => setText(e.target.value)} placeholder={tool.placeholder ? L(...tool.placeholder) : ""} aria-label={L(tool.he, tool.en)} />
        : <p className="muted small">{L(`נכתב מ-${info.lectures.length} ההרצאות של הקורס.`, `Written from the course's ${info.lectures.length} lectures.`)}</p>}
      <div className="study-actions">
        <button type="button" className="primary" disabled={busy || (tool.input === "text" ? text.trim().length < 10 : !info.lectures.length)} onClick={() => void run()}>{busy ? L("עובד…", "Working…") : L(tool.he, tool.en)}</button>
        {out && <button type="button" onClick={() => void keep()}>{L("שמירה כהרצאה בקורס", "Keep as a lecture")}</button>}
        {out && <button type="button" className="ghost" onClick={() => void navigator.clipboard.writeText(out).then(() => toast(L("הועתק", "Copied")))}>{L("העתקה", "Copy")}</button>}
      </div>
      {out && <div dir="auto" className="study-summary-text"><RichText text={out} /></div>}
      <p className="muted small">{L("הכלי עובד רק ממה שהדבקת או מההרצאות שלך. מה שחסר מסומן [חסר]. כדאי לבדוק מול המקור.", "The tool works only from what you pasted or your lectures; anything missing is marked [missing]. Check against the source.")}</p>
    </section>
  );
}

function ExamPlanCard({ id, plan }: { id: string; plan: ExamPlan }) {
  const when = plan.daysLeft === 0 ? L("המבחן היום", "The exam is today") : plan.daysLeft === 1 ? L("המבחן מחר", "The exam is tomorrow") : L(`המבחן בעוד ${plan.daysLeft} ימים`, `The exam is in ${plan.daysLeft} days`);
  return (
    <section className="card study-plan">
      <h2>{when}</h2>
      <p>{plan.perDay ? L(`${plan.perDay} כרטיסיות ביום עד המבחן`, `${plan.perDay} cards a day until the exam`) : L("אין כרטיסיות לחזרה עד המבחן.", "No cards to review before the exam.")}{plan.beforeExam ? L(` (כולל ${plan.beforeExam} שהיו מתוזמנות אחרי המבחן ומוקדמות לפניו)`, ` (including ${plan.beforeExam} scheduled after the exam, brought before it)`) : ""}</p>
      {plan.notReady.length > 0 && (
        <p className="small">{L("עוד אין מה ללמוד מ: ", "Nothing to study from yet: ")}{plan.notReady.slice(0, 6).map((l, i) => <span key={l.id}>{i ? " · " : ""}<a href={`#/study/${id}/l/${l.id}`} dir="auto">{l.title}</a></span>)}{plan.notReady.length > 6 ? " …" : ""}</p>
      )}
      <div className="study-actions">
        {plan.perDay > 0 && <a className="button primary" href={`#/study/${id}/review`}>{L("לחזרה של היום", "Today's review")}</a>}
        {plan.testWeek && <a className="button" href={`#/study/${id}/quiz`}>{L("שבוע מבחן: מבחן תרגול על הנושאים החלשים", "Exam week: a practice test on the weak topics")}</a>}
      </div>
    </section>
  );
}

/**
 * The course as a path (design CoursePath, like Duolingo's): each lecture a step with 📝 summary, 🃏 cards, ❓ quiz and
 * 👑 mastery 80+; the first one not crowned is "now", with one button to its next step.
 */
function CoursePath({ courseId, lectures }: { courseId: string; lectures: LectureRow[] }) {
  const [p, setP] = useState<Progress | null>(null);
  useEffect(() => void api<Progress>(`/api/study/courses/${courseId}/progress`).then(setP, () => undefined), [courseId]);
  if (lectures.length < 2 || !p) return null;
  const mastery = new Map((p.mastery ?? []).map((m) => [m.lectureId, m.mastery]));
  const quizzed = new Set(p.quizzed ?? []);
  const steps = (l: LectureRow) => ({ summary: l.summarized, cards: l.cards > 0, quiz: quizzed.has(l.id), crown: (mastery.get(l.id) ?? 0) >= 80 });
  const ordered = [...lectures].sort((a, b) => a.date.localeCompare(b.date));
  const now = ordered.find((l) => !steps(l).crown);
  const next = (l: LectureRow): [string, string] => {
    const s = steps(l);
    if (!s.summary) return [L("לסכם", "Summarize"), `#/study/${courseId}/l/${l.id}`];
    if (!s.cards) return [L("ליצור כרטיסיות", "Make cards"), `#/study/${courseId}/l/${l.id}`];
    return [L("בוחן קצר", "A short quiz"), `#/study/${courseId}/quiz?l=${l.id}`];
  };
  return (
    <details className="course-path" open>
      <summary><b>🗺 {L("המסלול של הקורס", "The course path")}</b> <span className="muted small">📝 {L("סיכום", "summary")} · 🃏 {L("כרטיסיות", "cards")} · ❓ {L("בוחן", "quiz")} · 👑 {L("שליטה 80+", "mastery 80+")}</span></summary>
      <ol>
        {ordered.map((l, i) => {
          const s = steps(l);
          const state = s.crown ? "done" : l === now ? "now" : "next";
          return (
            <li key={l.id} className={`path-node ${state}`} style={{ ["--off" as string]: `${[0, 40, 70, 40][i % 4]}px` }}>
              <a className="path-dot" href={`#/study/${courseId}/l/${l.id}`} aria-label={l.title}>{s.crown ? "👑" : i + 1}</a>
              <div>
                <b dir="auto">{l.title}</b>
                <div className="path-steps" aria-label={L("שלבים", "Steps")}>
                  {([["📝", s.summary, L("סיכום", "Summary")], ["🃏", s.cards, L("כרטיסיות", "Cards")], ["❓", s.quiz, L("בוחן", "Quiz")], ["👑", s.crown, L("שליטה", "Mastery")]] as const).map(([e, ok, name]) => <span key={e} className={ok ? "ok" : ""} title={`${name}: ${ok ? "✓" : "—"}`}>{e}</span>)}
                </div>
                {state === "now" && <a className="button primary small" href={next(l)[1]}>{L("להמשיך", "Continue")}: {next(l)[0]} ›</a>}
              </div>
            </li>
          );
        })}
      </ol>
    </details>
  );
}

function Lectures({ courseId, info, onChange }: { courseId: string; info: CourseInfo; onChange: () => void }) {
  const [adding, setAdding] = useState(!info.lectures.length);
  const [recording, setRecording] = useState(false);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const photo = useRef<HTMLInputElement>(null);
  /** A file becomes the lecture's text (read here for text files, on the computer for the rest); she checks it, then saves. */
  const fromFile = async (f: File | undefined, input: HTMLInputElement) => {
    input.value = "";
    if (!f) return;
    if (!title) setTitle(f.name.replace(/\.[^.]+$/, ""));
    if (/\.(txt|md|srt|vtt)$/i.test(f.name)) {
      const words = (await f.text()).replace(/^\d+\s*$|^\d\d:\d\d:\d\d[,.]\d+ --> .*$|^WEBVTT.*$/gm, "").replace(/\n{3,}/g, "\n\n");
      setText((t) => (t.trim() ? `${t}\n\n${words}` : words));
      return;
    }
    if (f.size > 50 * 1024 * 1024) return toast(L("הקובץ גדול מ-50MB.", "The file is larger than 50 MB."));
    setBusy(true);
    const bytes = new Uint8Array(await f.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const r = await call(api<{ title: string; text: string }>("/api/study/extract", { method: "POST", body: { name: f.name, data: btoa(bin) } }));
    setBusy(false);
    // Several photos (the board, then the notebook) add up in one lecture.
    if (r) setText((t) => (t.trim() ? `${t}\n\n${r.text}` : r.text));
  };
  const [yt, setYt] = useState("");
  const videoFile = useRef<HTMLInputElement>(null);
  const fromVideoFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    toast(L("מעלה ומתמלל את הסרטון… (הרצאה ארוכה לוקחת כמה דקות)", "Uploading and transcribing the video… (a long lecture takes a few minutes)"));
    const res = await fetch(withToken(`/api/study/courses/${courseId}/lectures/video-upload`), { method: "POST", headers: { "content-type": "application/x-kesher-video", "x-file-name": encodeURIComponent(f.name), "x-video-type": f.type || "video/mp4" }, body: f }).catch(() => undefined);
    setBusy(false);
    const l = res?.ok ? ((await res.json()) as StudyLecture) : undefined;
    if (!l) return toast(res ? ((await res.json().catch(() => ({}))) as { error?: string }).error ?? L("ההעלאה נכשלה.", "The upload failed.") : L("ההעלאה נכשלה.", "The upload failed."));
    onChange();
    go(`#/study/${courseId}/l/${l.id}`);
  };
  const fromYoutube = async () => {
    setBusy(true);
    // YouTube by its captions; any other video site (Panopto, Kaltura, Vimeo…) through her sign-in in KesherAI's browser.
    const isYt = /(^|\.)(youtube\.com|youtu\.be)\//.test(yt.replace(/^https?:\/\//, ""));
    const l = await call(api<StudyLecture>(`/api/study/courses/${courseId}/lectures/${isYt ? "youtube" : "web-video"}`, { method: "POST", body: { url: yt } }));
    setBusy(false);
    if (!l) return;
    setYt("");
    onChange();
    go(`#/study/${courseId}/l/${l.id}`);
  };
  const save = async () => {
    setBusy(true);
    const l = await call(api<StudyLecture>(`/api/study/courses/${courseId}/lectures`, { method: "POST", body: { title, text } }));
    setBusy(false);
    if (!l) return;
    onChange();
    go(`#/study/${courseId}/l/${l.id}`);
  };
  return (
    <div className="study-lectures">
      {!adding && !recording && <CoursePath courseId={courseId} lectures={info.lectures} />}
      {recording ? (
        <StudyRecorder onCancel={() => setRecording(false)} onDone={async (t, audio) => {
          setRecording(false);
          if (!t.trim()) return toast(L("לא נשמע דיבור בהקלטה.", "No speech was heard in the recording."));
          const l = await call(api<StudyLecture>(`/api/study/courses/${courseId}/lectures`, { method: "POST", body: { title: L(`הרצאה ${info.lectures.length + 1}`, `Lecture ${info.lectures.length + 1}`), text: t } }));
          // The kept audio goes up after the lecture exists (its transcript is safe even if this fails).
          if (l && audio) {
            const res = await fetch(withToken(`/api/study/courses/${courseId}/lectures/${l.id}/recording`), { method: "POST", headers: { "content-type": audio.type || "audio/webm" }, body: audio }).catch(() => undefined);
            if (!res?.ok) toast(L("התמלול נשמר, אבל ההקלטה לא נשמרה.", "The transcript is saved, but the recording was not."));
          }
          if (l) { onChange(); go(`#/study/${courseId}/l/${l.id}`); }
        }} />
      ) : adding ? (
        <section className="card study-new-lecture">
          <h2>{L("הרצאה חדשה", "New lecture")}</h2>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={L("כותרת, למשל: תרופות לב", "Title, e.g. Heart drugs")} aria-label={L("כותרת", "Title")} dir="auto" />
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} dir="auto" aria-label={L("טקסט ההרצאה", "Lecture text")}
            placeholder={L("הדביקי כאן את התמלול או הסיכום שלך, או הוסיפי מצגת, PDF או צילום (אפשר כמה צילומים להרצאה אחת).", "Paste the transcript or your notes, or add slides, a PDF or photos (several photos can go into one lecture).")} />
          <div className="study-actions">
            <button type="button" className="primary" disabled={busy || !text.trim()} onClick={() => void save()}>{busy ? L("קורא את הקובץ…", "Reading the file…") : L("שמור הרצאה", "Save lecture")}</button>
            <button type="button" disabled={busy} onClick={() => file.current?.click()}>{L("מקובץ: מצגת, PDF, Word", "From a file: slides, PDF, Word")}</button>
            <button type="button" disabled={busy} onClick={() => photo.current?.click()}>{L("📷 צילום לוח או מחברת", "📷 Photo of the board or notebook")}</button>
            <input ref={file} type="file" accept=".pdf,.pptx,.docx,.txt,.md,.srt,.vtt,image/*" hidden onChange={(e) => void fromFile(e.target.files?.[0], e.target)} />
            <input ref={photo} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void fromFile(e.target.files?.[0], e.target)} />
            <button type="button" onClick={() => { setAdding(false); setRecording(true); }}>{L("או: הקלט הרצאה", "Or: record a lecture")}</button>
            {info.lectures.length > 0 && <button type="button" className="ghost" onClick={() => setAdding(false)}>{L("ביטול", "Cancel")}</button>}
          </div>
          <form className="row study-youtube" onSubmit={(e) => { e.preventDefault(); void fromYoutube(); }}>
            <span aria-hidden className="yt-mark">▶</span>
            <input className="grow" dir="ltr" value={yt} onChange={(e) => setYt(e.target.value)} placeholder={L("קישור: YouTube, Panopto, Kaltura, Vimeo…", "A link: YouTube, Panopto, Kaltura, Vimeo…")} aria-label={L("קישור להרצאה בווידאו", "A video lecture link")} />
            <button type="submit" disabled={busy || !yt.trim()}>{busy && yt ? L("מביא את ההרצאה…", "Getting the lecture…") : L("הרצאה מקישור", "Lecture from a link")}</button>
            <button type="button" disabled={busy} onClick={() => videoFile.current?.click()}>🎞 {L("קובץ וידאו", "A video file")}</button>
            <input ref={videoFile} type="file" accept="video/*,.mp4,.mkv,.mov,.webm" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void fromVideoFile(f); }} />
          </form>
          <p className="muted small">{L("הסרטון נכנס כהרצאה עם הכתוביות שלו (או הדיבור, כשאין), ואפשר לחלק אותו לפרקים עם שאלות. Panopto ו-Kaltura של המודל: היכנסי פעם אחת בדפדפן של קשר. בפעם הראשונה קשר מוריד את yt-dlp (חינם, קוד פתוח).", "The video becomes a lecture with its captions (or its speech, when there are none), and can be split into chapters with questions. Your Moodle's Panopto or Kaltura: sign in once in KesherAI's browser. The first time, KesherAI downloads yt-dlp (free, open source).")}</p>
        </section>
      ) : (
        <div className="study-actions">
          <button type="button" className="primary" onClick={() => setRecording(true)}>{L("הקלט הרצאה", "Record a lecture")}</button>
          <button type="button" onClick={() => setAdding(true)}>{L("+ הרצאה מטקסט, מצגת או צילום", "+ Lecture from text, slides or a photo")}</button>
        </div>
      )}
      <ul className="study-list">
        {[...info.lectures].reverse().map((l) => (
          <li key={l.id}>
            <a href={`#/study/${courseId}/l/${l.id}`}>
              <b dir="auto">{l.title}</b>
              <small>{l.date.split("-").reverse().join(".")} · {l.summarized ? L("✓ סוכם", "✓ Summarized") : L("לא סוכם", "Not summarized")} · {L(`${l.cards} כרטיסיות`, `${l.cards} cards`)}</small>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A lecture's flowchart as boxes and arrows (or its source, when it is not a simple flowchart). */
export function FlowView({ src }: { src: string }) {
  const flow = useMemo(() => parseFlow(src), [src]);
  if (!flow) return <pre className="study-diagram-src" dir="ltr">{src}</pre>;
  const label = (id: string) => flow.nodes.find((n) => n.id === id)?.label ?? id;
  // Follow the arrows from the first box; boxes not reached are listed after.
  const order: string[] = [];
  const visit = (id: string) => {
    if (order.includes(id)) return;
    order.push(id);
    flow.edges.filter((e) => e.from === id).forEach((e) => visit(e.to));
  };
  flow.nodes.forEach((n) => visit(n.id));
  return (
    <div className={`study-flow ${flow.dir === "LR" ? "row" : "col"}`} dir="ltr" role="img" aria-label={flow.edges.map((e) => `${label(e.from)} → ${label(e.to)}`).join(", ")}>
      {order.map((id, i) => {
        const into = flow.edges.find((e) => e.to === id && order.indexOf(e.from) === i - 1);
        return (
          <span key={id} className="study-flow-step">
            {i > 0 && <span className="study-flow-arrow" aria-hidden="true">{into?.label ? <small>{into.label}</small> : null}→</span>}
            <span className="study-flow-box" dir="auto">{label(id)}</span>
          </span>
        );
      })}
    </div>
  );
}

/** The lecture's text with each [mm:ss] mark as a button that plays the kept recording from there. */
function StampedText({ text, onSeek }: { text: string; onSeek: (sec: number) => void }) {
  return (
    <>
      {text.split("\n").map((line, i) => {
        const m = /^\[(?:(\d+):)?(\d+):(\d\d)\]/.exec(line);
        if (!m) return <div key={i}>{line || "\u00a0"}</div>;
        const sec = Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        return (
          <div key={i}>
            <button type="button" className="study-stamp" dir="ltr" title={L("לנגן מכאן", "Play from here")} onClick={() => onSeek(sec)}>{m[0]}</button>{line.slice(m[0].length)}
          </div>
        );
      })}
    </>
  );
}

type RecordingSettings = { keep: boolean; deleteAfter: "never" | "30" | "90" | "semester"; asked?: boolean };

/** The kept recording: a player (the text's minute marks play from there), delete, and the first-time question. */
function LectureAudio({ courseId, lecture, player, onRemoved }: { courseId: string; lecture: StudyLecture; player: React.RefObject<HTMLAudioElement | null>; onRemoved: () => void }) {
  const [settings, setSettings] = useState<RecordingSettings | null>(null);
  useEffect(() => void api<RecordingSettings>("/api/study/recordings").then(setSettings, () => undefined), []);
  const src = withToken(`/api/study/courses/${courseId}/lectures/${lecture.id}/recording`);
  const choose = async (deleteAfter: RecordingSettings["deleteAfter"]) => {
    const r = await call(api<RecordingSettings>("/api/study/recordings", { method: "PUT", body: { deleteAfter, asked: true } }));
    if (r) setSettings(r);
  };
  const mb = Math.max(1, Math.round((lecture.recording?.bytes ?? 0) / 1024 / 1024));
  return (
    <div className="study-audio">
      <audio ref={player} controls preload="metadata" src={src} />
      <div className="row small">
        <span className="muted">{L(`ההקלטה נשמרה במחשב (${mb}MB). לחיצה על דקה בטקסט המלא מנגנת משם.`, `The recording is kept on the computer (${mb} MB). A minute in the full text plays from there.`)}</span>
        <button type="button" className="small ghost" onClick={async () => {
          if (!confirm(L("למחוק את ההקלטה? התמלול נשאר. אי אפשר לבטל.", "Delete the recording? The transcript stays. This cannot be undone."))) return;
          if (await call(api(`/api/study/courses/${courseId}/lectures/${lecture.id}/recording`, { method: "DELETE" }))) onRemoved();
        }}>{L("מחיקת ההקלטה", "Delete the recording")}</button>
      </div>
      {settings && !settings.asked && (
        <div className="card study-rec-ask">
          <strong>{L("ההקלטות נשמרות", "Recordings are kept")}</strong>
          <p className="small">{L("הרצאה של שעה וחצי היא בערך 20MB. למחוק אותן אוטומטית?", "A 90-minute lecture is about 20 MB. Delete them automatically?")}</p>
          <div className="row wrap">
            <button type="button" className="primary" onClick={() => void choose("never")}>{L("לא למחוק אף פעם", "Never delete")}</button>
            <button type="button" onClick={() => void choose("30")}>{L("אחרי 30 יום", "After 30 days")}</button>
            <button type="button" onClick={() => void choose("90")}>{L("אחרי 90 יום", "After 90 days")}</button>
            <button type="button" onClick={() => void choose("semester")}>{L("אחרי סוף הסמסטר", "After the semester ends")}</button>
          </div>
          <p className="muted small">{L("סוף הסמסטר לכל קורס: לפי המבחן האחרון בסילבוס או תאריך המבחן, או תאריך שתכתבי בקורס. אפשר לשנות בהגדרות ← לימודים.", "Each course's semester end: its syllabus's last exam or its exam date, or a date you write on the course. Change it in Settings → Study.")}</p>
        </div>
      )}
    </div>
  );
}

function LectureView({ courseId, lectureId, courseField, onChange }: { courseId: string; lectureId: string; courseField?: string; onChange: () => void }) {
  const [l, setL] = useState<StudyLecture | null>(null);
  const [view, setView] = useState<"watch" | "summary" | "terms" | "diagram" | "video" | "teach" | "text">("summary");
  // A video lecture opens on its video.
  useEffect(() => {
    if (l?.youtube || l?.videoFile) setView("watch");
  }, [l?.id]);
  const player = useRef<HTMLAudioElement>(null);
  // "Explain this": text she selected in the lecture, and its explanation.
  const [sel, setSel] = useState("");
  const [explained, setExplained] = useState("");
  const [explaining, setExplaining] = useState(false);
  const pickSelection = () => {
    const t = window.getSelection()?.toString().trim() ?? "";
    if (t.length >= 3 && t !== sel) { setSel(t.slice(0, 3000)); setExplained(""); }
  };
  const explainSel = async (kind: "explain" | "simple" | "example") => {
    setExplaining(true);
    const r = await call(api<{ text: string }>(`/api/study/courses/${courseId}/lectures/${lectureId}/explain`, { method: "POST", body: { text: sel, kind } }));
    setExplaining(false);
    if (r) setExplained(r.text);
  };
  const selToCard = async () => {
    const front = L(`מה המשמעות של: "${sel.slice(0, 200)}"?`, `What does this mean: "${sel.slice(0, 200)}"?`);
    const r = await call(api(`/api/study/courses/${courseId}/cards`, { method: "POST", body: { front, back: explained.slice(0, 3000), lectureId } }));
    if (r) { toast(L("נוספה כרטיסייה", "Card added")); onChange(); }
  };
  const [busy, setBusy] = useState("");
  const [format, setFormat] = useState<StudyFormat>("text");
  const base = `/api/study/courses/${courseId}/lectures/${lectureId}`;
  useEffect(() => void api<StudyLecture>(base).then(setL, (e: Error) => toast(e.message)), [base]);
  const [playing, setPlaying] = useState(false);
  useEffect(() => () => stopSpeaking(), []);
  if (!l) return <p className="muted">…</p>;
  const run = async (what: string, p: () => Promise<unknown>) => {
    setBusy(what);
    await p();
    setBusy("");
  };
  const summarize = () => run("summary", async () => {
    const r = await call(api<StudyLecture>(`${base}/summarize`, { method: "POST" }));
    if (r) { setL(r); onChange(); }
  });
  /** The spoken review: made once by the chat model, then read aloud with her chosen voice. */
  const listen = async () => {
    if (playing) {
      stopSpeaking();
      setPlaying(false);
      return;
    }
    let text = l.audio;
    if (!text) {
      setBusy("audio");
      const r = await call(api<StudyLecture>(`${base}/audio`, { method: "POST" }));
      setBusy("");
      if (!r?.audio) return;
      setL(r);
      text = r.audio;
    }
    setPlaying(true);
    void speak(text, () => setPlaying(false));
  };
  const makeCards = () => run("cards", async () => {
    const r = await call(api<{ cards: StudyCard[] }>(`${base}/cards`, { method: "POST", body: { format, count: 12 } }));
    if (r) { toast(L(`נוצרו ${r.cards.length} כרטיסיות`, `${r.cards.length} cards made`)); onChange(); }
  });
  return (
    <article className="study-lecture card">
      <h2 dir="auto">{l.title}</h2>
      {l.web && <p className="muted small">🔗 {L("נשמר מ:", "Saved from:")} <a href={l.web} target="_blank" rel="noopener noreferrer" dir="ltr">{l.web.replace(/^https?:\/\//, "").slice(0, 80)}</a></p>}
      {l.recording && <LectureAudio courseId={courseId} lecture={l} player={player} onRemoved={() => setL({ ...l, recording: undefined })} />}
      <div className="seg-pills" role="tablist" aria-label={L("תצוגה", "View")}>
        {(["watch", "summary", "terms", "diagram", "video", "teach", "text"] as const).filter((v) => v !== "watch" || l.youtube || l.videoFile).map((v) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
            {{ watch: L("▶ הרצאה בווידאו", "▶ Video lecture"), summary: L("סיכום", "Summary"), terms: L("מונחים", "Terms"), diagram: L("תרשים", "Diagram"), video: L("🎬 סרטון", "🎬 Video"), teach: L("🎓 ללמד בחזרה", "🎓 Teach back"), text: L("הטקסט המלא", "Full text") }[v]}
          </button>
        ))}
      </div>
      <div className="study-lecture-body" onMouseUp={pickSelection} onTouchEnd={() => setTimeout(pickSelection, 50)} onKeyUp={pickSelection}>
        {view === "watch" ? <StudyVideoLecture base={base} lecture={l} onLecture={setL} />
          : view === "video" ? <StudyVideo base={base} lecture={l} onLecture={setL} />
          : view === "teach" ? <StudyTeachBack base={base} lecture={l} />
          : view === "text" ? <div className="study-text" dir="auto">{l.recording ? <StampedText text={l.text} onSeek={(sec) => { const a = player.current; if (a) { a.currentTime = sec; void a.play().catch(() => undefined); } }} /> : l.youtube ? <StampedText text={l.text} onSeek={(sec) => window.open(`https://www.youtube.com/watch?v=${l.youtube}&t=${sec}s`, "_blank", "noopener")} /> : l.text}</div>
          : !l.summary ? (
            <div className="study-empty">
              <p className="muted">{L("עוד לא סוכם. הסיכום, המונחים והתרשים נכתבים מהטקסט של ההרצאה בלבד.", "Not summarized yet. The summary, terms and diagram come from the lecture's text only.")}</p>
              <button type="button" className="primary" disabled={!!busy} onClick={() => void summarize()}>{busy === "summary" ? L("מסכם… (הרצאה ארוכה לוקחת כמה דקות)", "Summarizing… (a long lecture takes a few minutes)") : L("סכם את ההרצאה", "Summarize the lecture")}</button>
            </div>
          ) : view === "summary" ? <ReadAlong text={l.summary} />
          : view === "terms" ? <TermList terms={l.terms ?? []} />
          : l.diagram ? <FlowView src={l.diagram} /> : <p className="muted">{L("בהרצאה הזאת אין תהליך שמתאים לתרשים.", "This lecture has no process that fits a diagram.")}</p>}
      </div>
      <LectureNotes key={l.id} base={base} notes={l.notes ?? ""} />
      <LecturePictures key={`p${l.id}`} base={base} />
      {sel && (
        <div className="study-explain" aria-live="polite">
          <p className="muted small" dir="auto">{L("נבחר: ", "Selected: ")}“{sel.length > 140 ? `${sel.slice(0, 140)}…` : sel}”</p>
          <div className="study-actions">
            {(["explain", "simple", "example"] as const).map((k) => <button key={k} type="button" disabled={explaining} onClick={() => void explainSel(k)}>{{ explain: L("הסבר", "Explain"), simple: L("בפשטות", "Simpler"), example: L("דוגמה", "Example") }[k]}</button>)}
            {explained && <button type="button" onClick={() => void selToCard()}>{L("לכרטיסייה", "To a card")}</button>}
            <button type="button" className="ghost" onClick={() => { setSel(""); setExplained(""); }}>{L("סגירה", "Close")}</button>
          </div>
          {explaining && <p className="muted">{L("מסבירה…", "Explaining…")}</p>}
          {explained && <div dir="auto"><RichText text={explained} /></div>}
        </div>
      )}
      <div className="study-actions">
        <button type="button" className={playing ? "primary" : ""} disabled={busy === "audio"} onClick={() => void listen()}>{busy === "audio" ? L("כותב סקירה קולית…", "Writing the audio review…") : playing ? L("⏹ עצירה", "⏹ Stop") : L("🎧 האזנה לסקירה (כ-3 דקות)", "🎧 Listen to a review (about 3 minutes)")}</button>
      </div>
      {l.summary && view !== "text" && <button type="button" className="small ghost" disabled={!!busy} onClick={() => void summarize()}>{busy === "summary" ? "…" : L("סכם מחדש", "Summarize again")}</button>}
      <h3>{L("להפוך לכרטיסיות, בפורמט:", "Make cards, studied as:")}</h3>
      <div className="study-formats" role="radiogroup" aria-label={L("פורמט", "Format")}>
        {STUDY_FORMATS.map((f) => <button key={f} type="button" role="radio" aria-checked={format === f} className={`chip${format === f ? " on" : ""}`} onClick={() => setFormat(f)}>{fmtName(f)}</button>)}
      </div>
      <div className="study-actions">
        <button type="button" className="primary" disabled={!!busy} onClick={() => void makeCards()}>{busy === "cards" ? L("יוצר כרטיסיות…", "Making cards…") : L("צור 12 כרטיסיות", "Make 12 cards")}</button>
        <a className="button" href={`#/study/${courseId}/quiz?l=${l.id}`}>{L("בוחן על ההרצאה", "Quiz on this lecture")}</a>
        <button type="button" onClick={() => askChat(L(
          `מצא 3–5 סרטונים ומאמרים טובים על "${l.title}"${l.terms?.length ? ` (${l.terms.slice(0, 6).map((t) => t.en || t.term).join(", ")})` : ""}: עדיף בעברית, אחרת באנגלית, ממקורות אמינים (אוניברסיטאות, ארגוני בריאות, ספרות מקצועית). לכל אחד: קישור, מקור, אורך, ומשפט למה הוא עוזר.`,
          `Find 3–5 good videos and articles about "${l.title}"${l.terms?.length ? ` (${l.terms.slice(0, 6).map((t) => t.en || t.term).join(", ")})` : ""} from reliable sources (universities, health bodies, professional literature). For each: link, source, length, and one line on why it helps.`,
        ))}>{L("מצא סרטונים ומאמרים", "Find videos and articles")}</button>
        {clinicalField(courseField) && <button type="button" disabled={!!busy} onClick={() => void run("drugs", async () => {
          const r = await call(api<{ drugs: StudyDrug[] }>(`${base}/drugs`, { method: "POST" }));
          if (r) { toast(L("כרטיסי התרופות עודכנו", "Drug cards updated")); onChange(); go(`#/study/${courseId}/drugs`); }
        })}>{busy === "drugs" ? L("כותב כרטיסי תרופות…", "Writing drug cards…") : L("כרטיסי תרופות מההרצאה", "Drug cards from this lecture")}</button>}
        <button type="button" className="ghost" onClick={async () => {
          if (!confirm(L("למחוק את ההרצאה? הכרטיסיות שלה נשארות.", "Delete this lecture? Its cards stay."))) return;
          if (await call(api(base, { method: "DELETE" }))) { onChange(); go(`#/study/${courseId}`); }
        }}>{L("מחק הרצאה", "Delete lecture")}</button>
      </div>
    </article>
  );
}

/**
 * Free pictures, animations (GIF) and videos of the lecture's topic from Wikimedia Commons, each with its licence and
 * author. A video shows its still here and opens on Commons (the page plays nothing from another site).
 */
function LecturePictures({ base }: { base: string }) {
  const [kind, setKind] = useState<StudyMediaKind>("image");
  const [got, setGot] = useState<Partial<Record<StudyMediaKind, { query: string; pictures: StudyPicture[] }>>>({});
  const [busy, setBusy] = useState(false);
  const find = async (k: StudyMediaKind) => {
    setKind(k);
    if (got[k] || busy) return;
    setBusy(true);
    const x = await call(api<{ query: string; pictures: StudyPicture[] }>(`${base}/pictures?kind=${k}`));
    setBusy(false);
    if (x) setGot((g) => ({ ...g, [k]: x }));
  };
  const r = got[kind];
  const KINDS: Array<[StudyMediaKind, string, string]> = [["image", "תמונות", "Pictures"], ["gif", "אנימציות", "Animations"], ["video", "סרטונים", "Videos"]];
  return (
    <details className="study-notes" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && !got.image && !busy) void find("image"); }}>
      <summary>{L("תמונות, אנימציות וסרטונים מוויקישיתוף", "Pictures, animations and videos from Wikimedia")}</summary>
      <div className="seg-pills" role="tablist" aria-label={L("סוג", "Kind")} style={{ marginTop: 8 }}>
        {KINDS.map(([k, he, en]) => <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? "on" : ""} onClick={() => void find(k)}>{L(he, en)}</button>)}
      </div>
      {busy && <p className="muted small">{L("מחפש…", "Searching…")}</p>}
      {r && (r.pictures.length ? (
        <div className="study-pics">
          {r.pictures.map((p, i) => (
            <figure key={i}>
              {p.video && p.page ? <a href={p.page} target="_blank" rel="noreferrer noopener" className="study-pic-video" aria-label={L("צפייה בסרטון בוויקישיתוף", "Watch the video on Wikimedia")}><img src={p.src} alt={r.query} loading="lazy" /><span aria-hidden="true">▶</span></a> : <img src={p.src} alt={r.query} loading="lazy" />}
              <figcaption className="small muted" dir="auto">{p.page ? <a href={p.page} target="_blank" rel="noreferrer noopener">{p.artist}</a> : p.artist} · {p.license}</figcaption>
            </figure>
          ))}
        </div>
      ) : <p className="muted small">{L(`לא נמצא ל-"${r.query}".`, `Nothing found for "${r.query}".`)}</p>)}
      {r && <p className="muted small">{kind === "video" ? L("סרטון נפתח בוויקישיתוף. ", "A video opens on Wikimedia. ") : ""}{L("חומר חופשי מוויקישיתוף לפי המונחים של ההרצאה. כדאי לוודא שהוא מתאים לחומר.", "Free material from Wikimedia Commons by the lecture's terms. Check it matches the material.")}</p>}
    </details>
  );
}

/** Her own notes beside the summary, saved as she types (a short pause). */
function LectureNotes({ base, notes }: { base: string; notes: string }) {
  const [text, setText] = useState(notes);
  const [state, setState] = useState<"" | "saving" | "saved">("");
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setState("saving");
    const t = setTimeout(() => void api(base, { method: "PATCH", body: { notes: text } }).then(() => setState("saved"), (e: Error) => { setState(""); toast(e.message); }), 700);
    return () => clearTimeout(t);
  }, [text, base]);
  return (
    <details className="study-notes" open={!!notes}>
      <summary>{L("ההערות שלי", "My notes")}{state === "saving" ? L(" · שומר…", " · saving…") : state === "saved" ? L(" · נשמר", " · saved") : ""}</summary>
      <textarea rows={4} dir="auto" value={text} onChange={(e) => setText(e.target.value)} placeholder={L("מה המרצה הדגיש, מה לשאול, מה לא הבנתי…", "What the lecturer stressed, what to ask, what I did not get…")} aria-label={L("ההערות שלי", "My notes")} />
    </details>
  );
}

function TermList({ terms }: { terms: StudyTerm[] }) {
  if (!terms.length) return <p className="muted">{L("אין מונחים.", "No terms.")}</p>;
  return (
    <dl className="study-terms">
      {terms.map((t, i) => (
        <div key={i}>
          <dt dir="auto">{t.term}{t.en && t.en !== t.term ? <span className="muted" dir="ltr"> · {t.en}</span> : null}</dt>
          <dd dir="auto">{t.explain}</dd>
        </div>
      ))}
    </dl>
  );
}

function Glossary({ lectures }: { lectures: LectureRow[] }) {
  const [q, setQ] = useState("");
  const all = lectures.flatMap((l) => (l.terms ?? []).map((t) => ({ ...t, from: l.title })));
  const shown = all.filter((t) => !q || `${t.term} ${t.en ?? ""} ${t.explain}`.toLowerCase().includes(q.toLowerCase())).sort((a, b) => a.term.localeCompare(b.term, "he"));
  return (
    <section className="study-glossary">
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L("חיפוש מונח, בעברית או באנגלית", "Search a term, Hebrew or English")} aria-label={L("חיפוש", "Search")} dir="auto" />
      {!all.length ? <p className="muted">{L("המילון מתמלא מהמונחים של כל הרצאה שסוכמה.", "The glossary fills from the terms of every summarized lecture.")}</p> : <TermList terms={shown} />}
    </section>
  );
}

const RATINGS: Array<[number, [string, string], string]> = [
  [1, ["שוב", "Again"], "bad"],
  [2, ["קשה", "Hard"], "warn"],
  [3, ["טוב", "Good"], "accent"],
  [4, ["קל", "Easy"], "good"],
];

function Review({ courseId, courseName, onChange }: { courseId: string; courseName: string; onChange: () => void }) {
  const [cards, setCards] = useState<StudyCard[] | null>(null);
  const [mistakes, setMistakes] = useState(false);
  const [shown, setShown] = useState(false);
  const [done, setDone] = useState(0);
  // The last missed card's explanation (shown above the next card).
  const [why, setWhy] = useState<{ front: string; text?: string }>();
  useEffect(() => void api<{ cards: StudyCard[] }>(`/api/study/courses/${courseId}/review`).then((r) => setCards(r.cards), (e: Error) => toast(e.message)), [courseId]);
  const card = cards?.[0];
  const rate = useCallback(async (rating: number) => {
    if (!card) return;
    const ok = await call(api(`/api/study/courses/${courseId}/cards/${card.id}/review`, { method: "POST", body: { rating } }));
    if (!ok) return;
    setShown(false);
    setDone((d) => d + 1);
    // "Again" comes back in this session (after the others), with a line on why the answer is right.
    setCards((cs) => (cs ? [...cs.slice(1), ...(rating === 1 ? [card] : [])] : cs));
    if (rating === 1) {
      setWhy({ front: card.front });
      void api<{ text: string }>(`/api/study/courses/${courseId}/cards/${card.id}/explain`, { method: "POST", body: {} }).then((r) => setWhy((w) => (w?.front === card.front ? { front: card.front, text: r.text } : w)), () => setWhy(undefined));
    } else setWhy(undefined);
    onChange();
  }, [card, courseId, onChange]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea")) return;
      if (e.key === " " && !shown) { e.preventDefault(); setShown(true); }
      else if (shown && /^[1-4]$/.test(e.key)) void rate(Number(e.key));
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [shown, rate]);
  if (mistakes) return <StudyMistakes courseId={courseId} courseName={courseName} onClose={() => { setMistakes(false); onChange(); }} />;
  const toMistakes = <button type="button" className="study-mistakes-btn" onClick={() => setMistakes(true)}>❌ {L("הטעויות שלי", "My mistakes")}</button>;
  if (!cards) return <p className="muted">…</p>;
  if (!card) return <div className="study-empty">{toMistakes}<p>{done ? L(`סיימת! חזרת על ${done} כרטיסיות.`, `Done! You reviewed ${done} cards.`) : L("אין כרטיסיות לחזרה עכשיו. כרטיסיות חדשות נוצרות מהרצאה.", "No cards to review now. New cards are made from a lecture.")}</p></div>;
  return (
    <section className="study-review">
      <p className="muted small">{L(`נשארו ${cards.length}`, `${cards.length} left`)} · {fmtName(card.format)} · {toMistakes}</p>
      {why && (
        <div className="study-why" aria-live="polite" dir="auto">
          <strong>{L("למה? ", "Why? ")}</strong>{why.front}
          <p>{why.text ?? L("מסבירה…", "Explaining…")}</p>
        </div>
      )}
      <button type="button" className="study-card card" onClick={() => setShown(true)} aria-label={shown ? undefined : L("הצג תשובה", "Show answer")}>
        <span className="study-card-front" dir="auto">{card.front}</span>
        {shown ? <span className="study-card-back" dir="auto"><RichText text={card.back} /></span> : <span className="muted small">{L("הקישי או לחצי רווח כדי לראות את התשובה", "Tap or press space to see the answer")}</span>}
      </button>
      {shown && (
        <div className="study-ratings" role="group" aria-label={L("כמה זכרת?", "How well did you remember?")}>
          {RATINGS.map(([r, n, tone]) => <button key={r} type="button" className={`study-rate ${tone}`} onClick={() => void rate(r)}>{L(...n)}<small>{r}</small></button>)}
        </div>
      )}
    </section>
  );
}

/** Base64 of a file, for /api/study/extract. */
async function fileBase64(f: File): Promise<string> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Past exams of the course: add one from a file or photo, remove one; practice tests can follow their style. */
function PastExams({ courseId, exams, onChange }: { courseId: string; exams: NonNullable<CourseInfo["pastExams"]>; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const add = async (f: File | undefined) => {
    if (!f) return;
    if (f.size > 50 * 1024 * 1024) return toast(L("הקובץ גדול מ-50MB.", "The file is larger than 50 MB."));
    setBusy(true);
    const r = await call(api<{ title: string; text: string }>("/api/study/extract", { method: "POST", body: { name: f.name, data: await fileBase64(f) } }));
    if (r?.text.trim()) await call(api(`/api/study/courses/${courseId}/past-exams`, { method: "POST", body: { title: f.name.replace(/\.[^.]+$/, ""), text: r.text } }));
    setBusy(false);
    onChange();
  };
  return (
    <div className="study-past">
      <h3>{L("מבחנים קודמים", "Past exams")}</h3>
      {exams.map((e) => (
        <div key={e.id} className="study-past-row">
          <span dir="auto">{e.title}</span>
          <button type="button" className="ghost small" aria-label={L("הסרה", "Remove")} onClick={() => void call(api(`/api/study/courses/${courseId}/past-exams/${e.id}`, { method: "DELETE" })).then(onChange)}>✕</button>
        </div>
      ))}
      <label className="button">{busy ? L("קורא את המבחן…", "Reading the exam…") : L("הוספת מבחן קודם (PDF, Word או צילום)", "Add a past exam (PDF, Word or photo)")}
        <input type="file" hidden accept=".pdf,.docx,.pptx,.txt,image/*" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void add(f); }} />
      </label>
      <p className="muted small">{L("המבחן נקרא פעם אחת. מבחני התרגול נכתבים מההרצאות שלך, באותו סגנון, אורך ורמת קושי.", "The exam is read once. Practice tests are written from your lectures, in the same style, length and difficulty.")}</p>
    </div>
  );
}

function Quiz({ courseId, lectures, pastExams, onChange }: { courseId: string; lectures: LectureRow[]; pastExams: NonNullable<CourseInfo["pastExams"]>; onChange: () => void }) {
  const only = new URLSearchParams(location.hash.split("?")[1] ?? "").get("l") ?? undefined;
  const [quiz, setQuiz] = useState<StudyQuiz | null>(null);
  const [answers, setAnswers] = useState<number[]>([]);
  const [i, setI] = useState(0);
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState(10);
  const [kind, setKind] = useState<"choice" | "open" | "case">("choice");
  // "Adapted to me" by default: the level follows her mastery (students part 25 #7).
  const [level, setLevel] = useState<StudyLevel | "auto">("auto");
  const [texts, setTexts] = useState<string[]>([]);
  const [exam, setExam] = useState(false);
  const [ends, setEnds] = useState(0);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!ends) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [ends]);
  const make = async (weak: boolean, licensing = false, past = false) => {
    setBusy(true);
    const n = licensing ? 30 : past ? 20 : count;
    const open = !licensing && !past && kind !== "choice";
    const z = await call(api<StudyQuiz>(`/api/study/courses/${courseId}/quiz`, { method: "POST", body: { count: open ? Math.min(n, 10) : n, weak, level, ...(open ? { kind } : {}), ...(licensing ? { style: "licensing" } : past ? { style: "past" } : {}), ...(only ? { lectureIds: [only] } : {}) } }));
    setBusy(false);
    if (z) {
      setQuiz(z); setAnswers([]); setTexts([]); setI(0); setExam(licensing || past);
      // A timed exam: the licensing exam is 90 questions in about two hours (about 80 seconds each); a past-exam
      // style test the same pace.
      setEnds(licensing || past ? Date.now() + z.questions.length * 80_000 : 0);
    }
  };
  const finish = async () => {
    if (quiz!.kind) setBusy(true);
    const r = await call(quiz!.kind
      ? api<StudyQuiz>(`/api/study/courses/${courseId}/quiz/${quiz!.id}/open-answers`, { method: "POST", body: { texts } })
      : api<StudyQuiz>(`/api/study/courses/${courseId}/quiz/${quiz!.id}/answers`, { method: "POST", body: { answers } }));
    setBusy(false);
    if (r) { setQuiz(r); onChange(); }
  };
  if (!lectures.length) return <p className="muted">{L("הוסיפי הרצאה כדי לקבל בוחן.", "Add a lecture to get a quiz.")}</p>;
  if (!quiz) return (
    <section className="card study-quiz-setup">
      <h2>{only ? L(`בוחן על "${lectures.find((l) => l.id === only)?.title ?? ""}"`, `Quiz on "${lectures.find((l) => l.id === only)?.title ?? ""}"`) : L("בוחן על כל הקורס", "Quiz on the whole course")}</h2>
      <div className="study-formats" role="radiogroup" aria-label={L("סוג השאלות", "Question type")}>
        {([["choice", L("אמריקאיות", "Multiple choice")], ["open", L("פתוחות", "Open")], ["case", L("מקרה", "Case")]] as const).map(([k, n]) => <button key={k} type="button" role="radio" aria-checked={kind === k} className={`chip${kind === k ? " on" : ""}`} onClick={() => setKind(k)}>{n}</button>)}
      </div>
      <div className="study-formats" role="radiogroup" aria-label={L("רמת קושי", "Difficulty")}>
        {([["auto", L("מותאם אליי", "Adapted to me")], ["easy", L("קל", "Easy")], ["normal", L("בינוני", "Medium")], ["hard", L("קשה", "Hard")]] as const).map(([k, n]) => <button key={k} type="button" role="radio" aria-checked={level === k} className={`chip${level === k ? " on" : ""}`} onClick={() => setLevel(k)}>{n}</button>)}
      </div>
      <label>{L("מספר שאלות", "Questions")} <select value={count} onChange={(e) => setCount(Number(e.target.value))}>{(kind === "choice" ? [5, 10, 15, 20] : [3, 5, 10]).map((n) => <option key={n}>{n}</option>)}</select></label>
      {kind !== "choice" && <p className="muted small">{kind === "case" ? L("כל שאלה מתחילה במקרה קצר מהתחום שלך, ואת עונה במילים שלך.", "Each question starts with a short case from your field; you answer in your words.") : L("עונים במילים שלך, והתשובה נבדקת מול ההרצאה.", "Answer in your words; it is checked against the lecture.")}</p>}
      <div className="study-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void make(false)}>{busy ? L("כותב שאלות…", "Writing questions…") : L("התחל בוחן", "Start quiz")}</button>
        {!only && <button type="button" disabled={busy} onClick={() => void make(true)}>{L("על הנושאים החלשים", "On weak topics")}</button>}
        {!only && <button type="button" disabled={busy} onClick={() => void make(false, true)}>{L("מבחן בסגנון בחינת הרישוי (30 שאלות, עם זמן)", "Licensing-exam style (30 questions, timed)")}</button>}
        {!only && pastExams.length > 0 && <button type="button" disabled={busy} onClick={() => void make(false, false, true)}>{L("מבחן בסגנון המבחנים הקודמים (20 שאלות, עם זמן)", "Like the past exams (20 questions, timed)")}</button>}
      </div>
      {!only && <PastExams courseId={courseId} exams={pastExams} onChange={onChange} />}
      <p className="muted small">{kind === "choice" ? L("השאלות נכתבות מהחומר שלך בלבד, והבדיקה נעשית בקוד.", "Questions come from your material only; grading is done by code.") : L("השאלות נכתבות מהחומר שלך בלבד. את התשובות בודק המודל מול תשובה לדוגמה ומול ההרצאה.", "Questions come from your material only. The model checks answers against a model answer and the lecture.")}</p>
    </section>
  );
  if (quiz.kind && quiz.score !== undefined) return (
    <section className="card study-quiz-done">
      <h2>{L(`${quiz.score} מתוך ${quiz.questions.length}`, `${quiz.score} of ${quiz.questions.length}`)}</h2>
      <ol className="study-quiz-review">
        {quiz.questions.map((q, k) => (
          <li key={k} className={(quiz.marks?.[k] ?? 0) >= 1 ? "good" : "bad"}>
            <b dir="auto">{q.q}</b>
            {quiz.texts?.[k] && <span dir="auto" className="muted">{L("ענית", "You answered")}: {quiz.texts[k]}</span>}
            <span dir="auto">{quiz.feedback?.[k]}</span>
            <small dir="auto">{L("תשובה לדוגמה: ", "Model answer: ")}{q.explain}</small>
          </li>
        ))}
      </ol>
      <button type="button" className="primary" onClick={() => setQuiz(null)}>{L("בוחן נוסף", "Another quiz")}</button>
    </section>
  );
  if (quiz.kind) {
    const q = quiz.questions[i]!;
    const last = i + 1 >= quiz.questions.length;
    return (
      <section className="card study-quiz">
        <p className="muted small">{L(`שאלה ${i + 1} מתוך ${quiz.questions.length}`, `Question ${i + 1} of ${quiz.questions.length}`)}</p>
        <progress max={quiz.questions.length} value={i} aria-hidden="true" />
        <h2 dir="auto" style={{ whiteSpace: "pre-wrap" }}>{q.q}</h2>
        <textarea rows={5} dir="auto" value={texts[i] ?? ""} onChange={(e) => setTexts((t) => { const n = [...t]; n[i] = e.target.value; return n; })} placeholder={L("התשובה שלך, במילים שלך", "Your answer, in your words")} aria-label={L("התשובה שלך", "Your answer")} />
        <div className="study-actions">
          {i > 0 && <button type="button" onClick={() => setI(i - 1)}>{L("לשאלה הקודמת", "Previous")}</button>}
          {!last ? <button type="button" className="primary" onClick={() => setI(i + 1)}>{L("לשאלה הבאה", "Next question")}</button>
            : <button type="button" className="primary" disabled={busy} onClick={() => void finish()}>{busy ? L("בודק את התשובות…", "Checking the answers…") : L("סיום ובדיקה", "Finish and check")}</button>}
        </div>
      </section>
    );
  }
  if (quiz.score !== undefined) return (
    <section className="card study-quiz-done">
      <h2>{L(`${quiz.score} מתוך ${quiz.questions.length}`, `${quiz.score} of ${quiz.questions.length}`)}</h2>
      <ol className="study-quiz-review">
        {quiz.questions.map((q, k) => (
          <li key={k} className={quiz.answers?.[k] === q.answer ? "good" : "bad"}>
            <b dir="auto">{q.q}</b>
            <span dir="auto">✓ {q.options[q.answer]}</span>
            {quiz.answers?.[k] !== q.answer && quiz.answers?.[k] !== undefined && quiz.answers[k]! >= 0 && <span dir="auto" className="muted">{L("ענית", "You answered")}: {q.options[quiz.answers[k]!]}</span>}
            <small dir="auto">{q.explain}</small>
          </li>
        ))}
      </ol>
      <button type="button" className="primary" onClick={() => setQuiz(null)}>{L("בוחן נוסף", "Another quiz")}</button>
    </section>
  );
  const q = quiz.questions[i]!;
  const picked = answers[i];
  const left = ends ? Math.max(0, Math.round((ends - Date.now()) / 1000)) : 0;
  const src = lectures.find((l) => l.id === q.lectureId);
  return (
    <section className="card study-quiz">
      <p className="muted small">{L(`שאלה ${i + 1} מתוך ${quiz.questions.length}`, `Question ${i + 1} of ${quiz.questions.length}`)}{ends ? <span className={left < 300 ? "warn" : ""} dir="ltr"> · {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</span> : null}</p>
      <progress max={quiz.questions.length} value={i + (picked !== undefined ? 1 : 0)} aria-hidden="true" />
      <h2 dir="auto">{q.q}</h2>
      <div className="study-options" role="radiogroup">
        {q.options.map((o, k) => {
          const state = picked === undefined ? "" : exam ? (k === picked ? " picked" : "") : k === q.answer ? " right" : k === picked ? " wrong" : "";
          return <button key={k} type="button" role="radio" aria-checked={picked === k} disabled={picked !== undefined} className={`study-option${state}`} onClick={() => setAnswers((a) => { const n = [...a]; n[i] = k; return n; })} dir="auto">{o}</button>;
        })}
      </div>
      {picked !== undefined && exam && (
        <div className="study-actions">
          {i + 1 < quiz.questions.length && left > 0 ? <button type="button" className="primary" onClick={() => setI(i + 1)}>{L("לשאלה הבאה", "Next question")}</button> : <button type="button" className="primary" onClick={() => void finish()}>{L("סיום ובדיקה", "Finish")}</button>}
        </div>
      )}
      {picked !== undefined && !exam && (
        <div className="study-explain">
          <p dir="auto"><b>{picked === q.answer ? L("✓ נכון.", "✓ Right.") : L("לא נכון.", "Not right.")}</b> {q.explain}</p>
          {src && <a href={`#/study/${courseId}/l/${src.id}`} className="small">{L("מקור", "Source")}: {src.title}</a>}
          <div className="study-actions">
            {i + 1 < quiz.questions.length ? <button type="button" className="primary" onClick={() => setI(i + 1)}>{L("לשאלה הבאה", "Next question")}</button> : <button type="button" className="primary" onClick={() => void finish()}>{L("סיום ובדיקה", "Finish")}</button>}
          </div>
        </div>
      )}
    </section>
  );
}

function Drugs({ courseId, info, onChange }: { courseId: string; info: CourseInfo; onChange: () => void }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string>();
  const shown = info.drugs.filter((d) => !q || `${d.name} ${d.brands ?? ""} ${d.drugClass ?? ""}`.toLowerCase().includes(q.toLowerCase())).sort((a, b) => a.name.localeCompare(b.name));
  const rows: Array<[keyof StudyDrug, [string, string]]> = [["brands", ["שמות מסחריים", "Brand names"]], ["drugClass", ["קבוצה", "Class"]], ["action", ["מנגנון פעולה", "How it works"]], ["uses", ["התוויות", "Uses"]], ["dose", ["מינון ודרך מתן", "Dose and route"]], ["sideEffects", ["תופעות לוואי", "Side effects"]], ["contraindications", ["התוויות נגד", "Contraindications"]], ["nursing", ["תפקיד האחות", "Nursing"]], ["teaching", ["הדרכת המטופל", "Patient teaching"]]];
  return (
    <section className="study-drugs">
      <p className="muted small">{L("כרטיסי התרופות נכתבים מההרצאות שלך בלבד (בעמוד ההרצאה: ״כרטיסי תרופות מההרצאה״). כל תרופה מוסיפה גם שלוש כרטיסיות לחזרה. מינונים — תמיד לפי ההוראה ובית המרקחת.", "Drug cards come from your lectures only (on a lecture: “Drug cards from this lecture”). Each drug also adds three review cards. Doses: always by the order and the pharmacy.")}</p>
      {info.drugs.length > 0 && <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L("חיפוש תרופה", "Search a drug")} aria-label={L("חיפוש", "Search")} dir="auto" />}
      {!info.drugs.length ? <p className="muted">{L("עוד אין כרטיסי תרופות.", "No drug cards yet.")}</p> : (
        <ul className="study-list">
          {shown.map((d) => (
            <li key={d.id} className="study-drug">
              <button type="button" className="study-drug-head" aria-expanded={open === d.id} onClick={() => setOpen(open === d.id ? undefined : d.id)}>
                <b dir="ltr">{d.name}</b>
                {d.drugClass && <small dir="auto">{d.drugClass}</small>}
              </button>
              {open === d.id && (
                <dl className="study-drug-body">
                  {rows.filter(([k]) => d[k]).map(([k, n]) => <div key={k}><dt>{L(...n)}</dt><dd dir="auto">{String(d[k])}</dd></div>)}
                  <button type="button" className="small ghost" onClick={async () => { if (confirm(L(`להסיר את ${d.name}?`, `Remove ${d.name}?`)) && (await call(api(`/api/study/courses/${courseId}/drugs/${d.id}`, { method: "DELETE" })))) onChange(); }}>{L("הסר", "Remove")}</button>
                </dl>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const LAB_GROUPS: Record<LabValue["group"], [string, string]> = { electrolytes: ["אלקטרוליטים", "Electrolytes"], blood: ["ספירת דם וסוכר", "Blood count and glucose"], kidney: ["כליות", "Kidneys"], gases: ["גזים בדם", "Blood gases"], coagulation: ["קרישה", "Clotting"], other: ["עוד", "Other"] };

/** Normal adult lab ranges, by group, with a search. */
function LabValues() {
  const [q, setQ] = useState("");
  const shown = LAB_VALUES.filter((v) => !q || `${v.name} ${v.he}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <section className="study-labs">
      <p className="muted small">{L("ערכים תקינים למבוגרים כפי שמלמדים בדרך כלל. לכל מעבדה טווחים משלה: תמיד לבדוק מול הטווח של בית החולים ושל הקורס.", "Normal adult values as usually taught. Every lab has its own ranges: always check your hospital's and your course's.")}</p>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L("חיפוש, למשל אשלגן", "Search, e.g. potassium")} aria-label={L("חיפוש", "Search")} dir="auto" />
      {(Object.keys(LAB_GROUPS) as Array<LabValue["group"]>).map((g) => {
        const rows = shown.filter((v) => v.group === g);
        if (!rows.length) return null;
        return (
          <div key={g} className="card">
            <h2>{L(...LAB_GROUPS[g])}</h2>
            <table className="study-lab-table">
              <tbody>
                {rows.map((v) => (
                  <tr key={v.name}>
                    <th scope="row"><span>{v.he}</span> <small dir="ltr">{v.name}</small></th>
                    <td dir="ltr">{v.range} <small>{v.unit}</small>{v.note ? <small> · {v.note}</small> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </section>
  );
}

const CALC: Array<[CalcKind, [string, string]]> = [
  ["volume", ["נפח למתן", "Volume to give"]],
  ["tablets", ["טבליות", "Tablets"]],
  ["weight", ["לפי משקל", "By weight"]],
  ["rate", ["קצב משאבה", "Pump rate"]],
  ["drops", ["טיפות לדקה", "Drops per minute"]],
  ["infusion", ["עירוי mcg/kg/min", "Infusion mcg/kg/min"]],
];

/** A number with its unit kept together in right-to-left text. */
const u = (n: number | undefined, unit: string) => `\u2068${n} ${unit}\u2069`;

/** The problem in words, from its numbers. */
function calcQuestion(p: CalcProblem): string {
  const v = p.values;
  switch (p.kind) {
    case "volume": return L(`הוראה: ${u(v.doseMg, "mg")}. בבקבוקון יש ${u(v.haveMg, "mg")} ב-${u(v.perMl, "mL")}. כמה mL לתת?`, `Ordered ${u(v.doseMg, "mg")}. The vial has ${u(v.haveMg, "mg")} in ${u(v.perMl, "mL")}. How many mL?`);
    case "tablets": return L(`הוראה: ${u(v.doseMg, "mg")}. כל טבליה ${u(v.tabletMg, "mg")}. כמה טבליות לתת?`, `Ordered ${u(v.doseMg, "mg")}. Each tablet is ${u(v.tabletMg, "mg")}. How many tablets?`);
    case "weight": return L(`הוראה: ${u(v.mgPerKg, "mg/kg")}. המטופל שוקל ${u(v.kg, "kg")}. כמה mg לתת?`, `Ordered ${u(v.mgPerKg, "mg/kg")}. The patient weighs ${u(v.kg, "kg")}. How many mg?`);
    case "rate": return L(`יש לתת ${u(v.volumeMl, "mL")} במשך ${v.hours} שעות במשאבה. מה הקצב ב-mL/h?`, `Give ${u(v.volumeMl, "mL")} over ${v.hours} hours by pump. What rate in mL/h?`);
    case "drops": return L(`יש לתת ${u(v.volumeMl, "mL")} במשך ${v.minutes} דקות בסט של ${v.dropFactor} טיפות ל-mL. כמה טיפות לדקה?`, `Give ${u(v.volumeMl, "mL")} over ${v.minutes} minutes with a ${v.dropFactor} drops/mL set. Drops per minute?`);
    case "infusion": return L(`הוראה: ${u(v.mcgPerKgMin, "mcg/kg/min")}, משקל ${u(v.kg, "kg")}. בשקית ${u(v.drugMg, "mg")} ב-${u(v.bagMl, "mL")}. מה קצב המשאבה ב-mL/h?`, `Ordered ${u(v.mcgPerKgMin, "mcg/kg/min")}, weight ${u(v.kg, "kg")}. The bag has ${u(v.drugMg, "mg")} in ${u(v.bagMl, "mL")}. Pump rate in mL/h?`);
  }
}

function CalcPractice() {
  const [kind, setKind] = useState<CalcKind>("volume");
  const [p, setP] = useState(() => practiceProblem("volume"));
  const [answer, setAnswer] = useState("");
  const [checked, setChecked] = useState<boolean | null>(null);
  const next = (k = kind) => { setKind(k); setP(practiceProblem(k)); setAnswer(""); setChecked(null); };
  return (
    <section className="study-calc">
      <p className="muted small">{L("התשובה מחושבת בקוד, לא במודל — אפשר לסמוך עליה. תמיד לבדוק מול הוראות המחלקה.", "The answer is computed by code, not by a model. Always check against your ward's rules.")}</p>
      <div className="seg-pills" role="tablist" aria-label={L("סוג חישוב", "Kind")}>
        {CALC.map(([k, n]) => <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? "on" : ""} onClick={() => next(k)}>{L(...n)}</button>)}
      </div>
      <div className="card">
        <p className="study-calc-q" dir="auto">{calcQuestion(p)}</p>
        <form className="study-calc-answer" onSubmit={(e) => { e.preventDefault(); setChecked(calcCorrect(Number(answer.replace(",", ".")), p.result)); }}>
          <input inputMode="decimal" value={answer} onChange={(e) => { setAnswer(e.target.value); setChecked(null); }} aria-label={L("התשובה שלך", "Your answer")} dir="ltr" />
          <span className="muted" dir="ltr">{p.result.unit}</span>
          <button type="submit" className="primary" disabled={!answer.trim()}>{L("בדוק", "Check")}</button>
        </form>
        {checked !== null && (
          <div className={`study-calc-result ${checked ? "good" : "bad"}`}>
            <b>{checked ? L("✓ נכון. הדרך:", "✓ Right. The way:") : L(`לא נכון. התשובה: ${u(p.result.value, p.result.unit)}. הדרך:`, `Not right. The answer: ${p.result.value} ${p.result.unit}. The way:`)}</b>
            <ol dir="ltr">{p.result.steps.map((s, k) => <li key={k}>{s}</li>)}</ol>
          </div>
        )}
        <button type="button" onClick={() => next()}>{L("תרגיל נוסף", "Another problem")}</button>
      </div>
    </section>
  );
}

/** Mastery per topic (design "TopicMastery"): a colored bar per lecture, weakest first, and a nudge when one dropped this week. */
function TopicMasteryCard({ courseId, rows }: { courseId: string; rows: NonNullable<Progress["mastery"]> }) {
  const tone = (v: number) => (v < 50 ? "low" : v < 80 ? "mid" : "high");
  const drop = rows.filter((r) => r.change <= -10).sort((a, b) => a.change - b.change)[0];
  return (
    <>
      <div className="card">
        <h2>{L("שליטה לפי נושא", "Mastery by topic")}</h2>
        <p className="muted">{L("מהחזרות על הכרטיסיות ומהבחנים שלך. תשובות אחרונות שוקלות יותר.", "From your card reviews and quizzes. Recent answers count more.")}</p>
        <ul className="mastery-bars">
          {rows.map((r) => (
            <li key={r.lectureId}>
              <a href={`#/study/${courseId}/l/${r.lectureId}`} dir="auto">{r.title}</a>
              <span className={`mastery-track ${tone(r.mastery)}`}><span style={{ width: `${r.mastery}%` }} /></span>
              <small dir="ltr" className={tone(r.mastery)}><b>{r.mastery}%</b>{r.change ? <span className={r.change < 0 ? "low" : "high"}> {r.change < 0 ? "▼" : "▲"}{Math.abs(r.change)}</span> : null}</small>
            </li>
          ))}
        </ul>
      </div>
      {drop && (
        <div className="card mastery-drop">
          <p dir="auto">📉 {L(`"${drop.title}" ירד ב-${-drop.change} נקודות השבוע.`, `"${drop.title}" dropped ${-drop.change} points this week.`)}</p>
          <div className="row">
            <a className="button primary" href={`#/study/${courseId}/quiz?l=${drop.lectureId}`}>{L("בוחן קצר על הנושא", "Short quiz on it")}</a>
            <a className="button" href={`#/study/${courseId}/l/${drop.lectureId}`}>{L("להרצאה", "Open the lecture")}</a>
          </div>
        </div>
      )}
      {rows.some((r) => r.mastery < 80) && <a className="button" href={`#/study/${courseId}/quiz`}>{L("בוחן על הנושאים החלשים", "Quiz on weak topics")}</a>}
    </>
  );
}

function ProgressView({ courseId }: { courseId: string }) {
  const [p, setP] = useState<Progress | null>(null);
  useEffect(() => void api<Progress>(`/api/study/courses/${courseId}/progress`).then(setP, (e: Error) => toast(e.message)), [courseId]);
  if (!p) return <p className="muted">…</p>;
  const best = p.formats.filter((f) => f.enough).sort((a, b) => b.recall - a.recall)[0];
  return (
    <section className="study-progress">
      <p className="muted">{L("לפי מה שזכרת בחזרות אחרי יום ויותר. לא \"סגנון למידה\" — התוצאות שלך.", "From what you remembered in reviews a day or more later. Not a \"learning style\" — your own results.")}</p>
      <div className="card">
        <h2>{L("כמה זכרת, לפי הדרך שבה למדת", "How much you remembered, by how you studied")}</h2>
        {!p.formats.length ? <p className="muted">{L("עוד אין מספיק חזרות. נסי כרטיסיות בכמה פורמטים, וחזרי אליהן בימים הבאים.", "Not enough reviews yet. Try cards in a few formats and review them over the next days.")}</p> : (
          <ul className="study-bars">
            {STUDY_FORMATS.map((f) => {
              const s = p.formats.find((x) => x.format === f);
              return (
                <li key={f}>
                  <span>{fmtName(f)}</span>
                  {s ? <><meter min={0} max={1} value={s.recall} className={s.enough ? "" : "thin"} aria-label={fmtName(f)} /><small dir="ltr">{Math.round(s.recall * 100)}% · {s.n}{s.enough ? "" : L(" · עוד מעט נתונים", " · little data")}</small></> : <small className="muted">{L("עוד לא למדת כך", "Not tried yet")}</small>}
                </li>
              );
            })}
          </ul>
        )}
        {best && <p dir="auto"><b>{L("המלצה", "Suggestion")}:</b> {L(`${fmtName(best.format)} עבד לך הכי טוב (${Math.round(best.recall * 100)}%). חזרה מרווחת ובחנים נשארים תמיד — הם עוזרים לכולם.`, `${fmtName(best.format)} worked best for you (${Math.round(best.recall * 100)}%). Spaced review and quizzes stay on: they help everyone.`)}</p>}
      </div>
      {!!p.mastery?.length && <TopicMasteryCard courseId={courseId} rows={p.mastery} />}
      {p.weak.length > 0 && !p.mastery?.length && (
        <div className="card">
          <h2>{L("נושאים חלשים", "Weak topics")}</h2>
          <ul className="study-list">{p.weak.map((w) => <li key={w.lectureId}><a href={`#/study/${courseId}/l/${w.lectureId}`}><b dir="auto">{w.title}</b><small className="warn">{Math.round(w.correct * 100)}%</small></a></li>)}</ul>
          <a className="button primary" href={`#/study/${courseId}/quiz`}>{L("בוחן על הנושאים החלשים", "Quiz on weak topics")}</a>
        </div>
      )}
    </section>
  );
}
