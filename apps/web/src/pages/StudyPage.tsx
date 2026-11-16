import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type ExamPlan, benefitsFor, calcCorrect, clinicalField, LAB_VALUES, STUDY_FIELDS, practiceProblem, STUDY_FORMATS, type CalcKind, type LabValue, type StudyDrug, type CalcProblem, type StudyCard, type StudyCourse, type StudyFormat, type StudyLecture, type StudyQuiz, type StudyTerm } from "@kesher/shared";
import { api, withToken } from "../api";
import { speak, stopSpeaking } from "../Speak";
import { getLocale } from "../i18n";
import { toast } from "../library";
import { RichText } from "../RichText";
import { parseFlow } from "../study-diagram";
import { StudyRecorder } from "../StudyRecorder";
import { AvatarCamera } from "./AvatarCamera";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

type CourseRow = StudyCourse & { lectures: number; cards: number; due: number; daysLeft?: number; perDay?: number };
type LectureRow = Omit<StudyLecture, "text" | "summary"> & { chars: number; summarized: boolean; cards: number };
interface CourseInfo { course: StudyCourse; lectures: LectureRow[]; cards: number; due: number; drugs: StudyDrug[]; quizzes: Array<{ id: string; t: number; score?: number; of: number }>; plan: ExamPlan | null }
interface Progress { formats: Array<{ format: StudyFormat; n: number; recall: number; enough: boolean }>; byKind: Array<{ kind: string; formats: Progress["formats"] }>; weak: Array<{ lectureId: string; title: string; correct: number; n: number }>; reviews: number }

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

function BackLink({ to }: { to: string }) {
  return <a className="study-back" href={to}>{L("› חזרה", "‹ Back")}</a>;
}

function StudyHome() {
  const [courses, setCourses] = useState<CourseRow[] | null>(null);
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
  return (
    <div className="page study-page">
      <h1>{L("לימודים", "Study")}</h1>
      {!!courses?.length && <section className="study-today">
        <h2>{L("להיום", "Today")}</h2>
        <div className="study-actions">
          {firstDue ? <a className="button primary" href={`#/study/${firstDue.id}/review`}>{L(`חזרה על ${due} כרטיסיות`, `Review ${due} cards`)} ▶</a> : <span className="muted">{L("אין כרטיסיות לחזרה עכשיו.", "No cards to review now.")}</span>}
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
      <section className="study-life card">
        <h2>{L("שאלה על הלימודים", "A question about your studies")}</h2>
        <p className="muted small">{L("שאלות מעשיות מקבלות תשובה עדכנית מהרשת, עם מקור רשמי.", "Practical questions get a current answer from the web, with an official source.")}</p>
        <div className="study-actions">
          {LIFE.filter(([, , clinical]) => !clinical || courses?.some((c) => clinicalField(c.field))).map(([he, en]) => <button key={en} type="button" className="study-life-q" onClick={() => askChat(`${L(he, en)}\n\n${LIFE_RULE}`)}>{L(he, en)}</button>)}
        </div>
      </section>
      <a className="study-avatar-link" href="#/study/benefits">{L("הטבות לסטודנטים: הנחה בתחבורה, תוכנות ו-AI בחינם", "Student benefits: transport discount, free software and AI")}</a>
      <a className="study-avatar-link" href="#/study/avatar">{L("מצלמת אווטאר לשיעורים בזום", "Avatar camera for Zoom lessons")}</a>
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
  ["quiz", ["בוחן", "Quiz"]],
  ["ask", ["שאלי את הקורס", "Ask the course"]],
  ["calc", ["חישובים", "Calculations"]],
  ["terms", ["מילון", "Glossary"]],
  ["drugs", ["תרופות", "Drugs"]],
  ["labs", ["ערכי מעבדה", "Lab values"]],
  ["progress", ["מה עובד בשבילי", "What works for me"]],
];

function CoursePage({ id, tab, lectureId }: { id: string; tab: string; lectureId?: string }) {
  const [info, setInfo] = useState<CourseInfo | null>(null);
  const load = useCallback(() => void api<CourseInfo>(`/api/study/courses/${id}`).then(setInfo, (e: Error) => toast(e.message)), [id]);
  useEffect(load, [load]);
  if (!info) return <div className="page study-page"><BackLink to="#/study" /><p className="muted">…</p></div>;
  const on = lectureId ? "lectures" : tab;
  return (
    <div className="page study-page">
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
        <label className="study-field">
          <span>{L("מבחן", "Exam")}</span>
          <input type="date" value={info.course.examDate ?? ""} onChange={async (e) => { if (await call(api(`/api/study/courses/${id}`, { method: "PATCH", body: { examDate: e.target.value } }))) load(); }} />
        </label>
        <button type="button" className="small" onClick={() => void shareCourseFile(id, info.course.name)}>{L("שיתוף הקורס", "Share the course")}</button>
        <button type="button" className="small ghost" onClick={async () => {
          if (!confirm(L(`למחוק את הקורס "${info.course.name}" עם כל ההרצאות והכרטיסיות? אי אפשר לבטל.`, `Delete "${info.course.name}" with all its lectures and cards? This cannot be undone.`))) return;
          if (await call(api(`/api/study/courses/${id}`, { method: "DELETE" }))) go("#/study");
        }}>{L("מחק קורס", "Delete course")}</button>
      </div>
      {info.plan && !lectureId && <ExamPlanCard id={id} plan={info.plan} />}
      <div className="seg-pills" role="tablist" aria-label={L("חלקי הקורס", "Course sections")}>
        {TABS.filter(([t]) => clinicalField(info.course.field) || !CLINICAL_TABS.has(t)).map(([t, n]) => (
          <button key={t} type="button" role="tab" aria-selected={on === t} className={on === t ? "on" : ""} onClick={() => go(`#/study/${id}/${t}`)}>
            {L(...n)}{t === "review" && info.due ? ` (${info.due})` : ""}
          </button>
        ))}
      </div>
      {lectureId ? <LectureView courseId={id} lectureId={lectureId} courseField={info.course.field} onChange={load} />
        : on === "review" ? <Review courseId={id} onChange={load} />
        : on === "quiz" ? <Quiz courseId={id} lectures={info.lectures} onChange={load} />
        : on === "calc" ? <CalcPractice />
        : on === "terms" ? <Glossary lectures={info.lectures} />
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
  const [turns, setTurns] = useState<Array<{ role: "user" | "assistant"; content: string; sources?: Array<{ lectureId: string; title: string }> }>>([]);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const send = async () => {
    const question = q.trim();
    if (!question || busy) return;
    setQ("");
    setBusy(true);
    const history = turns.map(({ role, content }) => ({ role, content }));
    setTurns((t) => [...t, { role: "user", content: question }]);
    const r = await call(api<{ answer: string; sources: Array<{ lectureId: string; title: string }> }>(`/api/study/courses/${courseId}/ask`, { method: "POST", body: { question, history } }));
    setBusy(false);
    if (r) setTurns((t) => [...t, { role: "assistant", content: r.answer, sources: r.sources }]);
  };
  if (!hasLectures) return <p className="muted">{L("קודם הוסיפי הרצאה: התשובות מגיעות רק מההרצאות שלך.", "Add a lecture first: answers come only from your lectures.")}</p>;
  return (
    <section className="study-ask">
      <p className="muted small">{L("התשובות רק מההרצאות שלך, עם שם ההרצאה ליד כל עובדה. כשההרצאות לא מכסות שאלה, זה ייאמר.", "Answers come only from your lectures, with the lecture named by each fact. When they do not cover a question, it says so.")}</p>
      <div className="study-ask-turns" aria-live="polite">
        {turns.map((t, i) => (
          <div key={i} className={`study-ask-turn ${t.role}`} dir="auto">
            <p>{t.content}</p>
            {t.sources && t.sources.length > 0 && <small className="muted">{L("מתוך: ", "From: ")}{t.sources.map((s, j) => <span key={s.lectureId}>{j ? " · " : ""}<a href={`#/study/${courseId}/l/${s.lectureId}`}>{s.title}</a></span>)}</small>}
          </div>
        ))}
        {busy && <p className="muted">{L("מחפשת בהרצאות…", "Looking through your lectures…")}</p>}
      </div>
      <form className="study-add" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} dir={q ? "auto" : getLocale() === "he" ? "rtl" : "ltr"} aria-label={L("שאלה", "Question")} placeholder={L("למשל: מה ההבדל בין סוג 1 לסוג 2?", "e.g. What is the difference between type 1 and type 2?")} />
        <button type="submit" className="primary" disabled={busy || !q.trim()}>{L("שאלי", "Ask")}</button>
      </form>
    </section>
  );
}

/** The plan toward the exam: the days left, the day's cards, what has nothing to study from yet, the test week. */
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
      {recording ? (
        <StudyRecorder onCancel={() => setRecording(false)} onDone={async (t) => {
          setRecording(false);
          if (!t.trim()) return toast(L("לא נשמע דיבור בהקלטה.", "No speech was heard in the recording."));
          const l = await call(api<StudyLecture>(`/api/study/courses/${courseId}/lectures`, { method: "POST", body: { title: L(`הרצאה ${info.lectures.length + 1}`, `Lecture ${info.lectures.length + 1}`), text: t } }));
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

function LectureView({ courseId, lectureId, courseField, onChange }: { courseId: string; lectureId: string; courseField?: string; onChange: () => void }) {
  const [l, setL] = useState<StudyLecture | null>(null);
  const [view, setView] = useState<"summary" | "terms" | "diagram" | "text">("summary");
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
      <div className="seg-pills" role="tablist" aria-label={L("תצוגה", "View")}>
        {(["summary", "terms", "diagram", "text"] as const).map((v) => (
          <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
            {{ summary: L("סיכום", "Summary"), terms: L("מונחים", "Terms"), diagram: L("תרשים", "Diagram"), text: L("הטקסט המלא", "Full text") }[v]}
          </button>
        ))}
      </div>
      <div className="study-lecture-body">
        {view === "text" ? <div className="study-text" dir="auto">{l.text}</div>
          : !l.summary ? (
            <div className="study-empty">
              <p className="muted">{L("עוד לא סוכם. הסיכום, המונחים והתרשים נכתבים מהטקסט של ההרצאה בלבד.", "Not summarized yet. The summary, terms and diagram come from the lecture's text only.")}</p>
              <button type="button" className="primary" disabled={!!busy} onClick={() => void summarize()}>{busy === "summary" ? L("מסכם… (הרצאה ארוכה לוקחת כמה דקות)", "Summarizing… (a long lecture takes a few minutes)") : L("סכם את ההרצאה", "Summarize the lecture")}</button>
            </div>
          ) : view === "summary" ? <div dir="auto"><RichText text={l.summary} /></div>
          : view === "terms" ? <TermList terms={l.terms ?? []} />
          : l.diagram ? <FlowView src={l.diagram} /> : <p className="muted">{L("בהרצאה הזאת אין תהליך שמתאים לתרשים.", "This lecture has no process that fits a diagram.")}</p>}
      </div>
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

function Review({ courseId, onChange }: { courseId: string; onChange: () => void }) {
  const [cards, setCards] = useState<StudyCard[] | null>(null);
  const [shown, setShown] = useState(false);
  const [done, setDone] = useState(0);
  useEffect(() => void api<{ cards: StudyCard[] }>(`/api/study/courses/${courseId}/review`).then((r) => setCards(r.cards), (e: Error) => toast(e.message)), [courseId]);
  const card = cards?.[0];
  const rate = useCallback(async (rating: number) => {
    if (!card) return;
    const ok = await call(api(`/api/study/courses/${courseId}/cards/${card.id}/review`, { method: "POST", body: { rating } }));
    if (!ok) return;
    setShown(false);
    setDone((d) => d + 1);
    // "Again" comes back in this session (after the others).
    setCards((cs) => (cs ? [...cs.slice(1), ...(rating === 1 ? [card] : [])] : cs));
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
  if (!cards) return <p className="muted">…</p>;
  if (!card) return <div className="study-empty"><p>{done ? L(`סיימת! חזרת על ${done} כרטיסיות.`, `Done! You reviewed ${done} cards.`) : L("אין כרטיסיות לחזרה עכשיו. כרטיסיות חדשות נוצרות מהרצאה.", "No cards to review now. New cards are made from a lecture.")}</p></div>;
  return (
    <section className="study-review">
      <p className="muted small">{L(`נשארו ${cards.length}`, `${cards.length} left`)} · {fmtName(card.format)}</p>
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

function Quiz({ courseId, lectures, onChange }: { courseId: string; lectures: LectureRow[]; onChange: () => void }) {
  const only = new URLSearchParams(location.hash.split("?")[1] ?? "").get("l") ?? undefined;
  const [quiz, setQuiz] = useState<StudyQuiz | null>(null);
  const [answers, setAnswers] = useState<number[]>([]);
  const [i, setI] = useState(0);
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState(10);
  const [exam, setExam] = useState(false);
  const [ends, setEnds] = useState(0);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!ends) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [ends]);
  const make = async (weak: boolean, licensing = false) => {
    setBusy(true);
    const n = licensing ? 30 : count;
    const z = await call(api<StudyQuiz>(`/api/study/courses/${courseId}/quiz`, { method: "POST", body: { count: n, weak, ...(licensing ? { style: "licensing" } : {}), ...(only ? { lectureIds: [only] } : {}) } }));
    setBusy(false);
    if (z) {
      setQuiz(z); setAnswers([]); setI(0); setExam(licensing);
      // The licensing exam: 90 questions in about two hours, so about 80 seconds each.
      setEnds(licensing ? Date.now() + z.questions.length * 80_000 : 0);
    }
  };
  const finish = async () => {
    const r = await call(api<StudyQuiz>(`/api/study/courses/${courseId}/quiz/${quiz!.id}/answers`, { method: "POST", body: { answers } }));
    if (r) { setQuiz(r); onChange(); }
  };
  if (!lectures.length) return <p className="muted">{L("הוסיפי הרצאה כדי לקבל בוחן.", "Add a lecture to get a quiz.")}</p>;
  if (!quiz) return (
    <section className="card study-quiz-setup">
      <h2>{only ? L(`בוחן על "${lectures.find((l) => l.id === only)?.title ?? ""}"`, `Quiz on "${lectures.find((l) => l.id === only)?.title ?? ""}"`) : L("בוחן על כל הקורס", "Quiz on the whole course")}</h2>
      <label>{L("מספר שאלות", "Questions")} <select value={count} onChange={(e) => setCount(Number(e.target.value))}>{[5, 10, 15, 20].map((n) => <option key={n}>{n}</option>)}</select></label>
      <div className="study-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void make(false)}>{busy ? L("כותב שאלות…", "Writing questions…") : L("התחל בוחן", "Start quiz")}</button>
        {!only && <button type="button" disabled={busy} onClick={() => void make(true)}>{L("על הנושאים החלשים", "On weak topics")}</button>}
        {!only && <button type="button" disabled={busy} onClick={() => void make(false, true)}>{L("מבחן בסגנון בחינת הרישוי (30 שאלות, עם זמן)", "Licensing-exam style (30 questions, timed)")}</button>}
      </div>
      <p className="muted small">{L("השאלות נכתבות מהחומר שלך בלבד, והבדיקה נעשית בקוד.", "Questions come from your material only; grading is done by code.")}</p>
    </section>
  );
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
      {p.weak.length > 0 && (
        <div className="card">
          <h2>{L("נושאים חלשים", "Weak topics")}</h2>
          <ul className="study-list">{p.weak.map((w) => <li key={w.lectureId}><a href={`#/study/${courseId}/l/${w.lectureId}`}><b dir="auto">{w.title}</b><small className="warn">{Math.round(w.correct * 100)}%</small></a></li>)}</ul>
          <a className="button primary" href={`#/study/${courseId}/quiz`}>{L("בוחן על הנושאים החלשים", "Quiz on weak topics")}</a>
        </div>
      )}
    </section>
  );
}
