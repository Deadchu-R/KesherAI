import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StudyWriting } from "../StudyWriting";
import { Mic } from "../Mic";
import { StudyMistakes } from "../StudyMistakes";
import { StudyMock } from "../StudyMock";
import { StudyLive } from "../StudyLive";
import { StudyTogether } from "../StudyTogether";
import { StudyPapers } from "../StudyPapers";
import { StudyPalace } from "../StudyPalace";
import { StudyLeeches } from "../StudyLeeches";
import { StudyLetter } from "../StudyLetter";
import { StudyRehearse } from "../StudyRehearse";
import { StudyExamEve } from "../StudyExamEve";
import { StudyWeb } from "../StudyWeb";
import { StudyFeed } from "../StudyFeed";
import { StudyNotesTab } from "../StudyTimeNotes";
import { OcclusionCard } from "../StudyOcclusion";
import { StudyMatch } from "../StudyMatch";
import { SIMILAR_MARK, markdownTableCsv, type ExamPlan, type StudySyllabus, type StudyLevel, syllabusNow, toolsFor, clinicalField, STUDY_FIELDS, STUDY_FORMATS, type StudyCard, type StudyLecture, type StudyQuiz, type StudyTerm } from "@kesher/shared";
import { api, withToken } from "../api";
import { QuestionCheck } from "../StudyQuestionCheck";
import { speak, stopSpeaking } from "../Speak";
import { getLocale } from "../i18n";
import { toast } from "../library";
import { RichText } from "../RichText";
import { StudyRecorder } from "../StudyRecorder";
import { AvatarCamera } from "./AvatarCamera";
import { CourseInfo, L, LectureRow, Progress, call, fmtName, go } from "./study/common";
import { BackLink, Benefits, CLINICAL_TABS, CourseModel, ModelWait, SIMPLE_TABS, SemesterEnd, StudyHome, TABS, fieldName, useStudyPrefs } from "./study/StudyHomeCards";
import { Glossary, LectureView, RATINGS } from "./study/StudyLectureView";
import { CalcPractice, Drugs, LabValues } from "./study/StudyClinical";

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
  return <CoursePage key={parts[0]} id={parts[0]} tab={parts[1] ?? "lectures"} lectureId={parts[1] === "l" ? parts[2] : undefined} {...(parts[1] === "l" && /^\d+$/.test(parts[3] ?? "") ? { startAt: Number(parts[3]) } : {})} />;
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

function CoursePage({ id, tab, lectureId, startAt }: { id: string; tab: string; lectureId?: string; startAt?: number }) {
  const [info, setInfo] = useState<CourseInfo | null>(null);
  const [prefs] = useStudyPrefs();
  const [allTabs, setAllTabs] = useState(false);
  // A letter to the lecturer (design Letters).
  const [letter, setLetter] = useState(false);
  const load = useCallback(() => void api<CourseInfo>(`/api/study/courses/${id}`).then(setInfo, (e: Error) => toast(e.message)), [id]);
  useEffect(load, [load]);
  if (!info) return <div className="page study-page"><BackLink to="#/study" /><p className="muted">…</p></div>;
  const on = lectureId ? "lectures" : tab;
  return (
    <div className={`page study-page${prefs?.easyRead ? " study-easy-read" : ""}${prefs?.readFont ? " study-read-font" : ""}`}>
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
        <button type="button" className="small" aria-expanded={letter} onClick={() => setLetter(!letter)}>✉️ {L("מכתב למרצה", "Letter to the lecturer")}</button>
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
      {letter && <StudyLetter courseId={id} onClose={() => setLetter(false)} />}
      {!lectureId && <StudyExamEve courseId={id} {...(info.course.examDate ? { examDate: info.course.examDate } : {})} lectures={info.lectures.map((l) => ({ id: l.id, title: l.title }))} />}
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
      {lectureId ? <LectureView key={`${lectureId}-${startAt ?? ""}`} courseId={id} lectureId={lectureId} courseField={info.course.field} {...(startAt !== undefined ? { startAt } : {})} onChange={load} />
        : on === "notes" ? <StudyNotesTab courseId={id} />
        : on === "papers" ? <StudyPapers courseId={id} courseName={info.course.name} />
        : on === "rehearse" ? <StudyRehearse courseId={id} />
        : on === "together" ? <StudyTogether courseId={id} courseName={info.course.name} groups={info.course.groups ?? []} onChange={load} />
        : on === "review" ? <Review courseId={id} courseName={info.course.name} onChange={load} />
        : on === "quick" ? <StudyMistakes quick courseId={id} courseName={info.course.name} onClose={() => { load(); go(`#/study/${id}`); }} />
        : on === "quiz" ? <Quiz courseId={id} lectures={info.lectures} pastExams={info.pastExams ?? []} clinical={clinicalField(info.course.field)} mocks={info.mocks ?? []} onChange={load} />
        : on === "calc" ? <CalcPractice />
        : on === "web" ? <StudyWeb courseId={id} />
        : on === "feed" ? <StudyFeed courseId={id} />
        : on === "terms" ? <Glossary courseId={id} lectures={info.lectures} />
        : on === "writing" ? <StudyWriting courseId={id} />
        : on === "game" ? <StudyGames courseId={id} courseName={info.course.name} terms={info.lectures.flatMap((l) => l.terms ?? [])} />
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
  // Oral exam (design OralExam): in study mode, each question is read aloud and she answers by voice.
  const [oral, setOral] = useState(false);
  // A photo of the exercise (design ProblemPhoto, students part 29 #1): the vision model writes it out into the box.
  const [reading, setReading] = useState(false);
  const fromPhoto = async (f: File | undefined) => {
    if (!f) return;
    setReading(true);
    try {
      const im = new Image();
      im.src = URL.createObjectURL(f);
      await im.decode();
      const k = Math.min(1, 2000 / Math.max(im.naturalWidth, im.naturalHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(im.naturalWidth * k);
      c.height = Math.round(im.naturalHeight * k);
      c.getContext("2d")!.drawImage(im, 0, 0, c.width, c.height);
      URL.revokeObjectURL(im.src);
      const r = await api<{ text: string }>("/api/study/extract", { method: "POST", body: { name: "problem.jpg", data: c.toDataURL("image/jpeg", 0.9).split(",")[1] } });
      const text = r.text.replace(/\s*\n+\s*/g, " ").trim();
      setQ((x) => (x.trim() ? `${x} ${text}` : text).slice(0, 4000));
      toast(L("התרגיל הועתק מהצילום. בדקי שהוא נכון ושלחי.", "The exercise was copied from the photo. Check it and send."));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setReading(false);
    }
  };
  const send = async (start = false, preset?: string) => {
    const question = (preset ?? q).trim();
    if ((!question && !start) || busy) return;
    setQ("");
    setBusy(true);
    const history = turns.map(({ role, content }) => ({ role, content }));
    if (question) setTurns((t) => [...t, { role: "user", content: question }]);
    const r = await call(api<{ answer: string; sources: Array<{ lectureId: string; title: string; page?: number }> }>(`/api/study/courses/${courseId}/ask`, { method: "POST", body: { question, history, mode } }));
    setBusy(false);
    if (r) {
      setTurns((t) => [...t, { role: "assistant", content: r.answer, sources: r.sources }]);
      if (oral) void speak(r.answer);
    }
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
      {(
        <label className="study-check"><input type="checkbox" checked={oral} onChange={(e) => { setOral(e.target.checked); if (!e.target.checked) stopSpeaking(); }} /> 🗣 {mode === "study" ? L("בעל פה: השאלות מוקראות ועונים בקול, כמו מבחן בעל פה", "Oral: questions read aloud, you answer by voice, like an oral exam") : L("בקול: שואלים במיקרופון ושומעים את התשובה", "By voice: ask with the microphone and hear the answer")}</label>
      )}
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
          <button type="button" onClick={() => void send(false, `${SIMILAR_MARK} ${L("תרגיל דומה לתרגול, בבקשה (בלי הפתרון)", "A similar problem to practice, please (without the solution)")}`)}>{SIMILAR_MARK} {L("תרגיל דומה", "A similar problem")}</button>
          <button type="button" onClick={() => void send(false, L("הראי לי דרך אחרת לפתור את אותו תרגיל (שיטה אחרת), צעד אחר צעד, ומתי כדאי כל דרך", "Show me another way to solve the same problem (a different method), step by step, and when each way is better"))}>🔀 {L("דרך אחרת", "Another way")}</button>
        </div>
      )}
      <form className="study-add" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} dir={q ? "auto" : getLocale() === "he" ? "rtl" : "ltr"} aria-label={mode === "study" ? L("התשובה שלך", "Your answer") : L("שאלה", "Question")} placeholder={mode === "homework" ? (turns.length ? L("הצעד שעשית, או שאלה", "Your step, or a question") : L("התרגיל (הדביקי את הנוסח)", "The exercise (paste it)")) : mode === "study" ? L("התשובה שלך, או \"רמז\"", "Your answer, or \"hint\"") : L("למשל: מה ההבדל בין סוג 1 לסוג 2?", "e.g. What is the difference between type 1 and type 2?")} />
        {oral && <Mic onText={(t) => { stopSpeaking(); void send(false, t); }} />}
        {mode !== "study" && <label className="button study-photo" title={L("צילום של התרגיל או השאלה", "A photo of the exercise or question")} aria-disabled={busy || reading}>{reading ? "…" : "📷"}<input type="file" accept="image/*" hidden disabled={busy || reading} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void fromPhoto(f); }} /></label>}
        <button type="submit" className="primary" disabled={busy || !q.trim()}>{mode === "study" ? L("שליחת תשובה", "Answer") : mode === "homework" ? L("שליחה", "Send") : L("שאלי", "Ask")}</button>
      </form>
    </section>
  );
}

/** The course's games: matching against the clock, and the memory palace (design MemoryPalace). */
function StudyGames({ courseId, courseName, terms }: { courseId: string; courseName: string; terms: StudyTerm[] }) {
  const [game, setGame] = useState<"match" | "palace">("match");
  return (
    <>
      <div className="seg-pills" role="tablist" aria-label={L("משחק", "Game")}>
        <button type="button" role="tab" aria-selected={game === "match"} className={game === "match" ? "on" : ""} onClick={() => setGame("match")}>🎯 {L("התאמה נגד השעון", "Match against the clock")}</button>
        <button type="button" role="tab" aria-selected={game === "palace"} className={game === "palace" ? "on" : ""} onClick={() => setGame("palace")}>🏛 {L("ארמון זיכרון", "Memory palace")}</button>
      </div>
      {game === "match" ? <StudyMatch courseId={courseId} courseName={courseName} terms={terms} /> : <StudyPalace courseId={courseId} terms={terms} />}
    </>
  );
}

/** "What should I learn from this?" after a quiz (design QuizTalk): a short plan from the questions she missed. */
function QuizTalk({ courseId, quizId }: { courseId: string; quizId: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ask = async () => {
    setBusy(true);
    const r = await call(api<{ text: string }>(`/api/study/courses/${courseId}/quiz/${quizId}/advice`, { method: "POST" }));
    setBusy(false);
    if (r) setText(r.text);
  };
  return text ? <div className="card study-quiz-talk" dir="auto"><b>💬 {L("מה ללמוד מזה", "What to learn from this")}</b><p>{text}</p></div>
    : <button type="button" disabled={busy} onClick={() => void ask()}>{busy ? L("קורא את הטעויות…", "Reading the mistakes…") : L("💬 מה ללמוד מזה?", "💬 What should I learn from this?")}</button>;
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
/**
 * The course's sources (RESEARCH_LOG students: a sources library, like Zotero's, kept small): the pages, videos and
 * files her lectures came from, with an APA 7 list made from them on request.
 */
function SourcesCard({ courseId, lectures }: { courseId: string; lectures: LectureRow[] }) {
  const [apa, setApa] = useState("");
  const [busy, setBusy] = useState(false);
  const rows = lectures.flatMap((l) => {
    const url = l.web ?? (l.youtube ? `https://www.youtube.com/watch?v=${l.youtube}` : l.videoFile?.from);
    return url ? [{ id: l.id, title: l.title, url, date: l.date }] : [];
  });
  if (!rows.length) return null;
  const make = async () => {
    setBusy(true);
    const lines = rows.map((r) => `${r.title}. ${r.url} (retrieved ${r.date})`).join("\n");
    const res = await call(api<{ text: string }>(`/api/study/courses/${courseId}/tools/apa`, { method: "POST", body: { text: lines } }));
    setBusy(false);
    if (res) setApa(res.text);
  };
  return (
    <details className="card study-sources">
      <summary><b>📚 {L("המקורות של הקורס", "The course's sources")}</b> <span className="muted small">{rows.length}</span></summary>
      <ul>{rows.map((r) => <li key={r.id}><a href={`#/study/${courseId}/l/${r.id}`} dir="auto">{r.title}</a> · <a href={r.url} target="_blank" rel="noopener noreferrer" dir="ltr" className="small">{r.url.replace(/^https?:\/\//, "").slice(0, 60)}</a></li>)}</ul>
      <div className="row">
        <button type="button" disabled={busy} onClick={() => void make()}>{busy ? "…" : L("רשימה ביבליוגרפית APA 7", "APA 7 reference list")}</button>
        {apa && <button type="button" className="ghost" onClick={() => void navigator.clipboard.writeText(apa).then(() => toast(L("הועתק", "Copied")))}>{L("העתקה", "Copy")}</button>}
      </div>
      {apa && <div dir="auto" className="study-summary-text"><RichText text={apa} /></div>}
    </details>
  );
}

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
    <>
    <SourcesCard courseId={id} lectures={info.lectures} />
    <section className="card study-tools">
      <h2>{L("כלים לתחום", "Field tools")}</h2>
      <div className="study-formats" role="radiogroup" aria-label={L("כלי", "Tool")}>
        {tools.map((t) => <button key={t.id} type="button" role="radio" aria-checked={pick === t.id} className={`chip${pick === t.id ? " on" : ""}`} onClick={() => { setPick(t.id); setOut(""); }}>{L(t.he, t.en)}</button>)}
      </div>
      {tool.input === "text"
        ? <textarea rows={8} dir="auto" value={text} onChange={(e) => setText(e.target.value)} placeholder={tool.placeholder ? L(...tool.placeholder) : ""} aria-label={L(tool.he, tool.en)} />
        : tool.input === "both"
        ? <input dir="auto" value={text} onChange={(e) => setText(e.target.value)} placeholder={tool.placeholder ? L(...tool.placeholder) : ""} aria-label={L(tool.he, tool.en)} />
        : <p className="muted small">{L(`נכתב מ-${info.lectures.length} ההרצאות של הקורס.`, `Written from the course's ${info.lectures.length} lectures.`)}</p>}
      <div className="study-actions">
        <button type="button" className="primary" disabled={busy || (tool.input === "text" ? text.trim().length < 10 : !info.lectures.length) || (tool.id === "compare" && text.trim().length < 3)} onClick={() => void run()}>{busy ? L("עובד…", "Working…") : L(tool.he, tool.en)}</button>
        {out && <button type="button" onClick={() => void keep()}>{L("שמירה כהרצאה בקורס", "Keep as a lecture")}</button>}
        {out && <button type="button" className="ghost" onClick={() => void navigator.clipboard.writeText(out).then(() => toast(L("הועתק", "Copied")))}>{L("העתקה", "Copy")}</button>}
        {out && markdownTableCsv(out) && (
          <button type="button" onClick={() => void api<{ id: string }>("/api/sheets", { method: "POST", body: { title: `${info.course.name}: ${tool ? L(tool.he, tool.en) : ""}${text.trim() ? ` · ${text.trim().slice(0, 60)}` : ""}`, csv: markdownTableCsv(out) } }).then((r) => { location.hash = `#/sheets/${r.id}`; }, (e: Error) => toast(e.message))}>📊 {L("פתיחה כגיליון", "Open as a sheet")}</button>
        )}
      </div>
      {out && <div dir="auto" className="study-summary-text"><RichText text={out} /></div>}
      <p className="muted small">{L("הכלי עובד רק ממה שהדבקת או מההרצאות שלך. מה שחסר מסומן [חסר]. כדאי לבדוק מול המקור.", "The tool works only from what you pasted or your lectures; anything missing is marked [missing]. Check against the source.")}</p>
    </section>
    </>
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
  // "Record the class" from the timetable or its note (#/study/<id>?record=1) opens the recorder in this course.
  const fromClass = /[?&]record=1\b/.test(location.hash);
  // The path is optional (Settings → Study → View).
  const [prefs] = useStudyPrefs();
  const showPath = prefs?.path !== false;
  const [adding, setAdding] = useState(!info.lectures.length);
  const [recording, setRecording] = useState(fromClass);
  useEffect(() => {
    if (fromClass) history.replaceState(null, "", location.hash.replace(/[?&]record=1\b/, ""));
  }, [fromClass]);
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
      {!adding && !recording && showPath && <CoursePath courseId={courseId} lectures={info.lectures} />}
      {recording ? (
        <StudyRecorder courseId={courseId} onCancel={() => setRecording(false)} onDone={async (t, audio) => {
          setRecording(false);
          if (!t.trim()) return toast(L("לא נשמע דיבור בהקלטה.", "No speech was heard in the recording."));
          const l = await call(api<StudyLecture>(`/api/study/courses/${courseId}/lectures`, { method: "POST", body: { title: L(`הרצאה ${info.lectures.length + 1}`, `Lecture ${info.lectures.length + 1}`), text: t } }));
          // The kept audio goes up after the lecture exists (its transcript is safe even if this fails).
          if (l && audio) {
            const res = await fetch(withToken(`/api/study/courses/${courseId}/lectures/${l.id}/recording`), { method: "POST", headers: audio.type === "audio/wav" ? { "content-type": "application/x-kesher-audio", "x-audio-type": "audio/wav" } : { "content-type": audio.type || "audio/webm" }, body: audio }).catch(() => undefined);
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
            <input ref={file} type="file" accept=".pdf,.pptx,.docx,.epub,.odt,.odp,.txt,.md,.srt,.vtt,image/*" hidden onChange={(e) => void fromFile(e.target.files?.[0], e.target)} />
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

function Review({ courseId, courseName, onChange }: { courseId: string; courseName: string; onChange: () => void }) {
  const [cards, setCards] = useState<StudyCard[] | null>(null);
  const [mistakes, setMistakes] = useState(false);
  const [shown, setShown] = useState(false);
  // "How sure are you?" before the answer (students part 27 #4); undefined when she just opened it.
  const [sure, setSure] = useState<boolean>();
  const [done, setDone] = useState(0);
  // The last missed card's explanation (shown above the next card).
  const [why, setWhy] = useState<{ front: string; text?: string; sure?: boolean }>();
  // A timer per card (design CardTimer, students part 30 #3, like Anki's Speed Focus Mode): 0 is off; the answer shows by itself.
  const [limit, setLimit] = useState(() => { try { return Number(localStorage.getItem("kesher-card-timer")) || 0; } catch { return 0; } });
  const [left, setLeft] = useState(0);
  const cardKey = cards?.[0]?.id;
  useEffect(() => {
    if (!limit || shown || !cardKey) return;
    setLeft(limit);
    const t = setInterval(() => setLeft((n) => { if (n <= 1) { clearInterval(t); setShown(true); return 0; } return n - 1; }), 1000);
    return () => clearInterval(t);
  }, [limit, shown, cardKey]);
  // "#/study/<id>/review/today-30": only today's portion of a backlog, young and recent cards first (design BackOnTrack).
  const today = Number(/\/review\/today-(\d{1,3})\b/.exec(location.hash)?.[1] ?? 0);
  useEffect(() => void api<{ cards: StudyCard[] }>(`/api/study/courses/${courseId}/review${today ? `?limit=${today}&backlog=1` : ""}`).then((r) => setCards(r.cards), (e: Error) => toast(e.message)), [courseId, today]);
  const card = cards?.[0];
  const rate = useCallback(async (rating: number) => {
    if (!card) return;
    const ok = await call(api(`/api/study/courses/${courseId}/cards/${card.id}/review`, { method: "POST", body: { rating, ...(sure !== undefined ? { sure } : {}) } }));
    if (!ok) return;
    setShown(false);
    setSure(undefined);
    setDone((d) => d + 1);
    // "Again" comes back in this session (after the others), with a line on why the answer is right.
    setCards((cs) => (cs ? [...cs.slice(1), ...(rating === 1 ? [card] : [])] : cs));
    if (rating === 1) {
      setWhy({ front: card.front, ...(sure ? { sure: true } : {}) });
      void api<{ text: string }>(`/api/study/courses/${courseId}/cards/${card.id}/explain`, { method: "POST", body: {} }).then((r) => setWhy((w) => (w?.front === card.front ? { ...w, text: r.text } : w)), () => setWhy(undefined));
    } else setWhy(undefined);
    onChange();
  }, [card, courseId, onChange, sure]);
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
  if (!card) return <div className="study-empty">{toMistakes}<StudyLeeches courseId={courseId} onChange={onChange} /><p>{done ? L(`סיימת! חזרת על ${done} כרטיסיות.`, `Done! You reviewed ${done} cards.`) : L("אין כרטיסיות לחזרה עכשיו. כרטיסיות חדשות נוצרות מהרצאה.", "No cards to review now. New cards are made from a lecture.")}</p></div>;
  return (
    <section className="study-review">
      <p className="muted small">{L(`נשארו ${cards.length}`, `${cards.length} left`)} · {fmtName(card.format)} · {toMistakes}</p>
      {done === 0 && !shown && <StudyLeeches courseId={courseId} onChange={onChange} />}
      <label className="small study-card-timer">⏱ {L("טיימר לכרטיסייה", "Timer per card")} <select value={limit} onChange={(e) => { const v = Number(e.target.value); setLimit(v); try { localStorage.setItem("kesher-card-timer", String(v)); } catch { /* a convenience */ } }}>{[0, 5, 10, 20, 30, 60].map((n) => <option key={n} value={n}>{n ? L(`${n} שניות`, `${n} s`) : L("כבוי", "Off")}</option>)}</select></label>
      {limit > 0 && !shown && <div className="study-card-clock" role="timer" aria-label={L(`נשארו ${left} שניות`, `${left} seconds left`)}><span style={{ width: `${(left / limit) * 100}%` }} /></div>}
      {why && (
        <div className="study-why" aria-live="polite" dir="auto">
          {why.sure && <p className="small"><b>{L("היית בטוחה וטעית: זו בדיוק הטעות שנזכרת הכי טוב כשמתקנים אותה. הכרטיסייה תחזור עוד פעם היום.", "You were sure and it was wrong: exactly the mistake that sticks best once corrected. The card comes back again today.")}</b></p>}
          <strong>{L("למה? ", "Why? ")}</strong>{why.front}
          <p>{why.text ?? L("מסבירה…", "Explaining…")}</p>
        </div>
      )}
      <button type="button" className="study-card card" onClick={() => setShown(true)} aria-label={shown ? undefined : L("הצג תשובה", "Show answer")}>
        {card.occlusion ? <OcclusionCard courseId={courseId} occ={card.occlusion} shown={shown} /> : <span className="study-card-front" dir="auto"><RichText text={card.front} /></span>}
        {shown ? <span className="study-card-back" dir="auto"><RichText text={card.back} /></span> : <span className="muted small">{L("הקישי או לחצי רווח כדי לראות את התשובה", "Tap or press space to see the answer")}</span>}
      </button>
      {!shown && (
        <div className="study-sure" role="group" aria-label={L("כמה את בטוחה?", "How sure are you?")}>
          <span className="muted small">{L("לפני שרואים: כמה את בטוחה?", "Before you look: how sure are you?")}</span>
          <button type="button" className="ghost small" onClick={() => { setSure(true); setShown(true); }}>🙂 {L("בטוחה", "Sure")}</button>
          <button type="button" className="ghost small" onClick={() => { setSure(false); setShown(true); }}>🤔 {L("לא בטוחה", "Not sure")}</button>
        </div>
      )}
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

function Quiz({ courseId, lectures, pastExams, clinical, mocks, onChange }: { courseId: string; lectures: LectureRow[]; pastExams: NonNullable<CourseInfo["pastExams"]>; clinical: boolean; mocks: NonNullable<CourseInfo["mocks"]>; onChange: () => void }) {
  const [mock, setMock] = useState(false);
  const [live, setLive] = useState(false);
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
  if (live) return <StudyLive courseId={courseId} {...(only ? { lectureIds: [only] } : {})} onClose={() => setLive(false)} />;
  if (mock) return <StudyMock courseId={courseId} lectures={lectures} pastExams={pastExams.length} clinical={clinical} history={mocks} onDone={onChange} onClose={() => setMock(false)} />;
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
        {!only && <button type="button" disabled={busy} onClick={() => setMock(true)}>📝 {L("מבחן דמה (עם שעון, ציון בסוף)", "Mock exam (timed, graded at the end)")}</button>}
        <button type="button" disabled={busy} onClick={() => setLive(true)}>🎮 {L("בוחן חי עם חברים", "Live quiz with friends")}</button>
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
      {quiz.score < quiz.questions.length && <QuizTalk courseId={courseId} quizId={quiz.id} />}
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
          <li key={q.q} className={quiz.answers?.[k] === q.answer ? "good" : "bad"}>
            <b dir="auto">{q.q}</b>
            <span dir="auto">✓ {q.options[q.answer]}</span>
            {quiz.answers?.[k] !== q.answer && quiz.answers?.[k] !== undefined && quiz.answers[k]! >= 0 && <span dir="auto" className="muted">{L("ענית", "You answered")}: {q.options[quiz.answers[k]!]}</span>}
            <small dir="auto">{q.explain}</small>
            {q.fixed ? <small className="muted">{q.fixed.by === "her" ? L("✎ תוקן לפי התשובה שלך", "✎ Fixed to your answer") : L("✎ תוקן לפי ההרצאה", "✎ Fixed by the lecture")}</small>
              : quiz.answers?.[k] !== q.answer && <QuestionCheck courseId={courseId} quizId={quiz.id} index={k} mine={quiz.answers?.[k]} onQuiz={setQuiz} />}
          </li>
        ))}
      </ol>
      {quiz.score < quiz.questions.length && <QuizTalk courseId={courseId} quizId={quiz.id} />}
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
