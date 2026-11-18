/**
 * The Study home page's cards: what to study next, the week, the daily goal, focus, benefits, search, back on track.
 * Part of the Study page (pages/StudyPage.tsx).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { celebrate } from "../../celebrate";
import { playFocusSound, setFocusVolume, stopFocusSound, type FocusSound } from "../../focus-sounds";
import { StudySetupChecklist, StudyWelcome } from "../../StudyWelcome";
import { GOAL_NAMES } from "../../settings/StudySection";
import { StudyEnglish } from "../../StudyEnglish";
import { StudyGrades } from "../../StudyGrades";
import { StudyTimetable } from "../../StudyTimetable";
import { cleanStudyPrefs, type StudyPrefs, type StudyNext, type StudyHit, benefitsFor, clinicalField, STUDY_FIELDS, type StudyCourse, GOAL_KINDS, type GoalKind, type StudyGoal } from "@kesher/shared";
import { api } from "../../api";
import { getLocale } from "../../i18n";
import { toast } from "../../library";
import { MoodleCard } from "../../MoodleCard";
import { StudyPlans } from "../../StudyPlans";
import { CourseRow, L, LIFE, LIFE_RULE, askChat, call, go } from "./common";

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

/**
 * "Back on track" (design BackOnTrack, students part 39): after days off, a pile of due cards is cleared a little more
 * each day instead of in one long session. Her usual day, a pace (gentle / steady, remembered on this device), the day
 * it ends, and "Today's N".
 */
function BackOnTrack({ courses }: { courses: CourseRow[] }) {
  const [pace, setPace] = useState<"steady" | "gentle">(() => { try { return localStorage.getItem("kesher-backlog-pace") === "gentle" ? "gentle" : "steady"; } catch { return "steady"; } });
  const c = [...courses].filter((x) => x.backlog).sort((a, b) => b.backlog!.steady.due - a.backlog!.steady.due)[0];
  if (!c?.backlog) return null;
  const pick = (p: "steady" | "gentle") => { setPace(p); try { localStorage.setItem("kesher-backlog-pace", p); } catch { /* this visit only */ } };
  const day = (k: string) => new Date(`${k}T12:00`).toLocaleDateString(getLocale() === "he" ? "he-IL" : "en-GB", { weekday: "long", day: "numeric", month: "numeric" });
  const plan = c.backlog[pace];
  return (
    <section className="card study-back-on-track" aria-label={L("חוזרים למסלול", "Back on track")}>
      <h2>🌱 {L("חוזרים למסלול", "Back on track")}: <span dir="auto">{c.name}</span></h2>
      <p>{L(`מחכות ${plan.due} כרטיסיות. בלי לחץ: לא צריך הכול היום.`, `${plan.due} cards are waiting. No pressure: not all today.`)}</p>
      <div className="study-welcome-opts" role="radiogroup" aria-label={L("קצב", "Pace")}>
        {(["gentle", "steady"] as const).map((p) => (
          <button type="button" key={p} role="radio" aria-checked={pace === p} className={pace === p ? "on" : ""} onClick={() => pick(p)}>
            {pace === p ? "✓ " : ""}{p === "gentle" ? L("🐢 בנחת", "🐢 Gentle") : L("🚶 בקצב", "🚶 Steady")} · {L(`${c.backlog![p].perDay} ביום`, `${c.backlog![p].perDay} a day`)}
          </button>
        ))}
      </div>
      <p className="muted small">{L(`ביום רגיל את עושה בערך ${plan.usual}. ככה חוזרים למסלול עד ${day(plan.finish)}; החדשות ממשיכות כרגיל, וקודם הכרטיסיות שלמדת לאחרונה.`, `On a usual day you do about ${plan.usual}. This way you are back on track by ${day(plan.finish)}; new cards go on as usual, and the ones you learned lately come first.`)}</p>
      <a className="button primary" href={`#/study/${c.id}/review/today-${plan.perDay}`}>▶ {L(`${plan.perDay} של היום`, `Today's ${plan.perDay}`)}</a>
    </section>
  );
}

/** "← Back" to another Study address. */
export function BackLink({ to }: { to: string }) {
  return <a className="study-back" href={to}>{L("› חזרה", "‹ Back")}</a>;
}

/** Simple mode and the first visit (design StudySimple / StudyWelcome), shared by the home and the course. */
export function useStudyPrefs(): [StudyPrefs | null, (p: StudyPrefs) => void] {
  const [p, setP] = useState<StudyPrefs | null>(null);
  useEffect(() => void api<StudyPrefs>("/api/study/prefs").then(setP, () => setP(cleanStudyPrefs({ welcomed: true }))), []);
  return [p, setP];
}
/** The course tabs of simple mode; the rest are under "More tools". */
export const SIMPLE_TABS = new Set(["lectures", "review", "quiz", "notes", "ask", "game", "feed", "progress"]);

/** The Study home page: her courses and the cards around them (next step, week, goal, focus, benefits, search). */
export function StudyHome() {
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
  // The first setup: for a new start, or to finish a setup she left in the middle (design StudySetupWizard).
  if (courses && prefs && !prefs.welcomed && (!courses.length || prefs.setupStep > 0)) {
    return (
      <div className="page study-page">
        <h1>{L("לימודים", "Study")}</h1>
        <StudyWelcome prefs={prefs} onPrefs={setPrefs} onDone={load} onSkip={() => { setPrefs({ ...prefs, welcomed: true }); void api("/api/study/prefs", { method: "PUT", body: { welcomed: true } }).catch(() => undefined); }} />
      </div>
    );
  }
  const simple = !!prefs?.simple;
  return (
    <div className={`page study-page${prefs?.easyRead ? " study-easy-read" : ""}${prefs?.readFont ? " study-read-font" : ""}`}>
      <h1>{L("לימודים", "Study")}</h1>
      {!!courses?.length && prefs && <StudySetupChecklist prefs={prefs} onPrefs={setPrefs} courses={courses} />}
      {!!courses?.length && <StudySearch />}
      {/* "Now: <class>" first, the timetable itself lower with the other set-up cards (simple mode: under "more"). */}
      {!!courses?.length && <StudyTimetable part="now" courses={courses.map((c) => ({ id: c.id, name: c.name }))} />}
      {!!courses?.length && <BackOnTrack courses={courses} />}
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
      {!!courses?.length && <StudyTimetable part="card" courses={courses.map((c) => ({ id: c.id, name: c.name }))} onCourses={load} />}
      {!!courses?.length && <StudyGrades courses={courses.map((c) => ({ id: c.id, name: c.name }))} />}
      <StudyEnglish courses={(courses ?? []).map((c) => ({ id: c.id, name: c.name }))} />
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
export const fieldName = (id: string | undefined) => {
  const f = STUDY_FIELDS.find((x) => x.id === id);
  return f ? L(f.he, f.en) : "";
};

/** Tabs only a clinical course has. */
export const CLINICAL_TABS = new Set(["calc", "drugs", "labs"]);

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
  type Week = { counts: Record<GoalKind, number>; days: number; streak: number; badges: Array<{ id: string; icon: string; he: string; en: string }>; rose: Array<{ course: string; title: string; change: number }>; dropped: Array<{ course: string; title: string; change: number }> };
  const [w, setW] = useState<Week | null>(null);
  useEffect(() => void api<Week>("/api/study/week").then((r) => {
    setW(r);
    // A badge not seen on this device before: a small celebration and its name.
    try {
      const seen = new Set((localStorage.getItem("kesher-badges-seen") ?? "").split(",").filter(Boolean));
      const fresh = r.badges.filter((b) => !seen.has(b.id));
      localStorage.setItem("kesher-badges-seen", r.badges.map((b) => b.id).join(","));
      if (fresh.length && seen.size) {
        celebrate();
        toast(`${fresh[0]!.icon} ${L(`תג חדש: ${fresh[0]!.he}`, `New badge: ${fresh[0]!.en}`)}`);
      }
    } catch {
      // private mode
    }
  }, () => undefined), []);
  if (!w || (!w.days && !w.badges.length)) return null;
  const parts = GOAL_KINDS.filter((k) => w.counts[k] > 0).map((k) => `${w.counts[k]} ${L(GOAL_NAMES[k][0], GOAL_NAMES[k][1].toLowerCase())}`);
  return (
    <details className="card study-week">
      <summary><b>📊 {L("השבוע שלך", "Your week")}</b> <span className="muted small">{L(`למדת ב-${w.days} מתוך 7 ימים`, `You studied on ${w.days} of 7 days`)}{w.streak ? ` · 🔥 ${w.streak}` : ""}</span></summary>
      {parts.length > 0 && <p dir="auto">{parts.join(" · ")}</p>}
      {w.badges.length > 0 && <p className="study-badges" aria-label={L("תגים", "Badges")}>{w.badges.map((b) => <span key={b.id} title={L(b.he, b.en)}>{b.icon} <small>{L(b.he, b.en)}</small></span>)}</p>}
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

/** Student benefits that fit her fields, each with its official page and when it was checked. */
export function Benefits() {
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

export const TABS: Array<[string, [string, string]]> = [
  ["lectures", ["הרצאות", "Lectures"]],
  ["review", ["חזרה", "Review"]],
  ["summary", ["סיכום הקורס", "Course summary"]],
  ["tools", ["כלים לתחום", "Field tools"]],
  ["quiz", ["בוחן", "Quiz"]],
  ["notes", ["📝 ההערות שלי", "📝 My notes"]],
  ["ask", ["שאלי את הקורס", "Ask the course"]],
  ["calc", ["חישובים", "Calculations"]],
  ["terms", ["מילון", "Glossary"]],
  ["web", ["🕸 מפת הקורס", "🕸 Course web"]],
  ["game", ["🎯 משחק", "🎯 Game"]],
  ["feed", ["📱 פיד", "📱 Feed"]],
  ["together", ["👥 לומדים יחד", "👥 Study together"]],
  ["rehearse", ["🎤 חזרה על הצגה", "🎤 Rehearse a talk"]],
  ["writing", ["✍ כתיבה", "✍ Writing"]],
  ["papers", ["📚 מאמרים ומקורות", "📚 Papers and sources"]],
  ["drugs", ["תרופות", "Drugs"]],
  ["labs", ["ערכי מעבדה", "Lab values"]],
  ["progress", ["מה עובד בשבילי", "What works for me"]],
];

type ModelState = { waiting?: { want: string; now?: string; why: string; since: number }; switched: boolean; hebrew?: string; models: string[] };

/** Which model writes for the course: automatic (the best Hebrew model on the computer) or one she picks. */
/** When the semester ends, shown when recordings are deleted "after the semester" and nothing else says the date. */
export function SemesterEnd({ id, course, syllabusEnd, onChange }: { id: string; course: StudyCourse; syllabusEnd?: string; onChange: () => void }) {
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

/** The model one course uses (or the default), chosen from the installed ones. */
export function CourseModel({ id, model, onChange }: { id: string; model?: string; onChange: () => void }) {
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
export function ModelWait() {
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
