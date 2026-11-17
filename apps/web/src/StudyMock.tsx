import { useEffect, useRef, useState } from "react";
import { mockMinutes, mockResult, mockTime, type StudyMock as Mock, type StudyQuiz } from "@kesher/shared";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";
import { celebrate } from "./celebrate";
import { QuestionCheck } from "./StudyQuestionCheck";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const EXTRA_KEY = "kesher-mock-extra";
const readExtra = () => {
  try {
    return localStorage.getItem(EXTRA_KEY) === "1";
  } catch {
    return false;
  }
};
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

type Style = "plain" | "past" | "licensing";

/**
 * A mock exam (design MockExam, students part 27 #1): like the day of the exam — her length and mix of questions, a
 * countdown (a quarter more with extra time), a map of the questions with flags, no answers or hints until she hands
 * it in (or the time ends), then a grade out of 100, the lectures to go back to, and her earlier results. Wrong
 * answers go to "My mistakes" like any quiz's.
 */
export function StudyMock({ courseId, lectures, pastExams, clinical, history, onDone, onClose }: {
  courseId: string;
  lectures: Array<{ id: string; title: string }>;
  pastExams: number;
  clinical: boolean;
  history: Array<{ t: number; grade: number }>;
  onDone: () => void;
  onClose: () => void;
}) {
  const [choice, setChoice] = useState(20);
  const [open, setOpen] = useState(0);
  const [style, setStyle] = useState<Style>("plain");
  const [extra, setExtra] = useState(readExtra);
  const [minutes, setMinutes] = useState<number | null>(null);
  const [making, setMaking] = useState("");
  const [parts, setParts] = useState<StudyQuiz[] | null>(null);
  const [mock, setMock] = useState<Mock | null>(null);
  const [answers, setAnswers] = useState<number[]>([]);
  const [texts, setTexts] = useState<string[]>([]);
  const [flags, setFlags] = useState<Set<number>>(new Set());
  const [i, setI] = useState(0);
  const [ends, setEnds] = useState(0);
  const [, tick] = useState(0);
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<StudyQuiz[] | null>(null);
  const [review, setReview] = useState(false);
  const sent = useRef(false);
  const time = minutes ?? mockMinutes(choice, open);

  const choicePart = parts?.find((p) => !p.kind);
  const openPart = parts?.find((p) => p.kind);
  const nChoice = choicePart?.questions.length ?? 0;
  const total = nChoice + (openPart?.questions.length ?? 0);
  const left = ends ? Math.max(0, Math.round((ends - Date.now()) / 1000)) : 0;

  const submit = async () => {
    if (!parts || sent.current) return;
    sent.current = true;
    setSending(true);
    try {
      const out: StudyQuiz[] = [];
      if (choicePart) out.push(await api<StudyQuiz>(`/api/study/courses/${courseId}/quiz/${choicePart.id}/answers`, { method: "POST", body: { answers: choicePart.questions.map((_, k) => answers[k] ?? -1) } }));
      if (openPart) out.push(await api<StudyQuiz>(`/api/study/courses/${courseId}/quiz/${openPart.id}/open-answers`, { method: "POST", body: { texts: openPart.questions.map((_, k) => texts[k] ?? "") } }));
      setDone(out);
      setEnds(0);
      const r = mockResult(out);
      if (r && r.grade >= 85) celebrate();
      onDone();
    } catch (e) {
      sent.current = false;
      toast((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    if (!ends) return;
    const t = setInterval(() => {
      tick((n) => n + 1);
      if (Date.now() >= ends) void submit();
    }, 1000);
    return () => clearInterval(t);
  }, [ends, answers, texts]);

  const start = async () => {
    const m: Mock = { group: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, minutes: time, ...(extra ? { extra: true } : {}) };
    try {
      localStorage.setItem(EXTRA_KEY, extra ? "1" : "0");
    } catch {
      /* only a convenience */
    }
    const got: StudyQuiz[] = [];
    try {
      setMaking(L(open ? "כותב את השאלות האמריקאיות…" : "כותב את השאלות…", "Writing the questions…"));
      got.push(await api<StudyQuiz>(`/api/study/courses/${courseId}/quiz`, { method: "POST", body: { count: choice, level: "normal", mock: m, ...(style !== "plain" ? { style } : {}) } }));
      if (open) {
        setMaking(L("כותב את השאלות הפתוחות…", "Writing the open questions…"));
        got.push(await api<StudyQuiz>(`/api/study/courses/${courseId}/quiz`, { method: "POST", body: { count: open, kind: style === "licensing" ? "case" : "open", level: "normal", mock: m } }));
      }
    } catch (e) {
      toast((e as Error).message);
      setMaking("");
      return;
    }
    setMaking("");
    sent.current = false;
    setParts(got);
    setMock(m);
    setAnswers([]);
    setTexts([]);
    setFlags(new Set());
    setI(0);
    setDone(null);
    setEnds(Date.now() + mockTime(m) * 60_000);
  };

  if (done) {
    const r = mockResult(done);
    const name = (id: string) => lectures.find((l) => l.id === id)?.title ?? "";
    const weak = (r?.byLecture ?? []).filter((b) => b.got / b.of < 0.8).slice(0, 4);
    const wrong = (r ? r.choice - r.right : 0) + (r ? r.openMax - r.open : 0);
    return (
      <section className="card study-mock">
        <div className="study-mock-grade" dir="auto"><b>{r?.grade ?? "–"}</b><span className="muted small">{L("ציון משוער", "Estimated grade")}{r ? ` · ${r.right}/${r.choice}` : ""}{r?.openMax ? ` · ${L("פתוחות", "open")} ${r.open}/${r.openMax}` : ""}</span></div>
        {!!weak.length && <>
          <b className="small">{L("לחזור על:", "Go back to:")}</b>
          {weak.map((b) => (
            <div key={b.lectureId} className="study-mock-topic">
              <span dir="auto">{name(b.lectureId)} <span className="muted">{Math.round(b.got * 10) / 10}/{b.of}</span></span>
              <div className="study-mock-bar"><i style={{ width: `${Math.round((b.got / b.of) * 100)}%` }} className={b.got / b.of < 0.5 ? "low" : ""} /></div>
              <a className="small" href={`#/study/${courseId}/quiz?l=${b.lectureId}`}>{L("בוחן על זה", "Quiz on it")}</a>
            </div>
          ))}
        </>}
        {wrong > 0 && <p className="muted small">{L("השאלות שטעית בהן נכנסו ל\"הטעויות שלי\".", "The ones you got wrong are in \"My mistakes\".")}</p>}
        {history.length > 0 && <p className="muted small" dir="auto">{L("התוצאות הקודמות", "Earlier results")}: {[...history.map((h) => h.grade), ...(r ? [r.grade] : [])].slice(-6).join(" · ")}</p>}
        <div className="study-actions">
          <button type="button" onClick={() => setReview(!review)}>{review ? L("להסתיר את השאלות", "Hide the questions") : L("לראות את השאלות", "See the questions")}</button>
          <button type="button" className="primary" onClick={() => { setDone(null); setParts(null); setReview(false); }}>{L("מבחן דמה נוסף", "Another mock exam")}</button>
          <button type="button" className="ghost" onClick={onClose}>{L("סגירה", "Close")}</button>
        </div>
        {review && (
          <ol className="study-quiz-review">
            {done.flatMap((p) => p.questions.map((q, k) => {
              const ok = p.kind ? (p.marks?.[k] ?? 0) >= 1 : p.answers?.[k] === q.answer;
              return (
                <li key={`${p.id}${q.q}`} className={ok ? "good" : "bad"}>
                  <b dir="auto" style={{ whiteSpace: "pre-wrap" }}>{q.q}</b>
                  {p.kind ? <>
                    {p.texts?.[k] && <span dir="auto" className="muted">{L("ענית", "You answered")}: {p.texts[k]}</span>}
                    <span dir="auto">{p.feedback?.[k]}</span>
                    <small dir="auto">{L("תשובה לדוגמה: ", "Model answer: ")}{q.explain}</small>
                  </> : <>
                    <span dir="auto">✓ {q.options[q.answer]}</span>
                    {!ok && (p.answers?.[k] ?? -1) >= 0 && <span dir="auto" className="muted">{L("ענית", "You answered")}: {q.options[p.answers![k]!]}</span>}
                    {!ok && (p.answers?.[k] ?? -1) < 0 && <span className="muted">{L("לא ענית", "Not answered")}</span>}
                    <small dir="auto">{q.explain}</small>
                    {q.fixed ? <small className="muted">{q.fixed.by === "her" ? L("✎ תוקן לפי התשובה שלך", "✎ Fixed to your answer") : L("✎ תוקן לפי ההרצאה", "✎ Fixed by the lecture")}</small>
                      : !ok && <QuestionCheck courseId={courseId} quizId={p.id} index={k} mine={p.answers?.[k]} onQuiz={(z) => setDone((all) => all && all.map((x) => (x.id === z.id ? z : x)))} />}
                  </>}
                </li>
              );
            }))}
          </ol>
        )}
      </section>
    );
  }

  if (parts && mock) {
    const isOpen = i >= nChoice;
    const q = isOpen ? openPart!.questions[i - nChoice]! : choicePart!.questions[i]!;
    const answered = (k: number) => (k < nChoice ? (answers[k] ?? -1) >= 0 : !!texts[k - nChoice]?.trim());
    const missing = Array.from({ length: total }, (_, k) => k).filter((k) => !answered(k)).length;
    const handIn = () => {
      if (missing && !confirm(L(`נשארו ${missing} שאלות בלי תשובה. להגיש בכל זאת?`, `${missing} questions have no answer. Hand in anyway?`))) return;
      void submit();
    };
    return (
      <section className="card study-mock">
        <div className="row study-mock-head">
          <span className="muted small">{L(`שאלה ${i + 1} מתוך ${total}`, `Question ${i + 1} of ${total}`)}{isOpen ? ` · ${L("פתוחה", "open")}` : ""}</span>
          <span className="grow" />
          <b dir="ltr" className={left < 300 ? "warn" : ""} aria-label={L("זמן שנשאר", "Time left")}>⏱ {clock(left)}</b>
        </div>
        <div className="study-mock-map" role="navigation" aria-label={L("מפת השאלות", "Question map")}>
          {Array.from({ length: total }, (_, k) => (
            <button key={k} type="button" className={`${k === i ? "on" : ""}${answered(k) ? " done" : ""}`} onClick={() => setI(k)} aria-label={L(`שאלה ${k + 1}`, `Question ${k + 1}`)}>{flags.has(k) ? "🚩" : k + 1}</button>
          ))}
        </div>
        <h2 dir="auto" style={{ whiteSpace: "pre-wrap" }}>{q.q}</h2>
        {isOpen ? (
          <textarea rows={6} dir="auto" value={texts[i - nChoice] ?? ""} onChange={(e) => setTexts((t) => { const n = [...t]; n[i - nChoice] = e.target.value; return n; })} placeholder={L("התשובה שלך, במילים שלך", "Your answer, in your words")} aria-label={L("התשובה שלך", "Your answer")} />
        ) : (
          <div className="study-options" role="radiogroup">
            {q.options.map((o, k) => <button key={k} type="button" role="radio" aria-checked={answers[i] === k} className={`study-option${answers[i] === k ? " picked" : ""}`} onClick={() => setAnswers((a) => { const n = [...a]; n[i] = k; return n; })} dir="auto">{o}</button>)}
          </div>
        )}
        <div className="study-actions">
          {i > 0 && <button type="button" onClick={() => setI(i - 1)}>‹ {L("הקודמת", "Previous")}</button>}
          <button type="button" onClick={() => setFlags((f) => { const n = new Set(f); if (n.has(i)) n.delete(i); else n.add(i); return n; })}>{flags.has(i) ? L("✓ בלי דגל", "✓ Unflag") : L("🚩 לחזור אליה", "🚩 Come back to it")}</button>
          {i + 1 < total ? <button type="button" className="primary" onClick={() => setI(i + 1)}>{L("הבאה", "Next")} ›</button> : <button type="button" className="primary" disabled={sending} onClick={handIn}>{sending ? L("בודק…", "Checking…") : L("הגשה", "Hand in")}</button>}
        </div>
        {i + 1 < total && <button type="button" className="link small" disabled={sending} onClick={handIn}>{L("להגיש עכשיו", "Hand in now")}</button>}
      </section>
    );
  }

  const chip = <T extends string | number>(v: T, cur: T, set: (x: T) => void, label: string) => (
    <button key={String(v)} type="button" role="radio" aria-checked={cur === v} className={`chip${cur === v ? " on" : ""}`} onClick={() => { set(v); setMinutes(null); }}>{label}</button>
  );
  return (
    <section className="card study-mock">
      <h2>📝 {L("מבחן דמה", "Mock exam")}</h2>
      <p className="muted small">{L("כמו ביום המבחן: שעון, בלי רמזים ובלי תשובות עד ההגשה, ציון בסוף.", "Like the day of the exam: a clock, no hints or answers until you hand in, a grade at the end.")}</p>
      <div className="study-formats" role="radiogroup" aria-label={L("שאלות אמריקאיות", "Multiple-choice questions")}>
        <span className="small">{L("אמריקאיות", "Multiple choice")}</span>{[10, 20, 30, 40].map((n) => chip(n, choice, setChoice, String(n)))}
      </div>
      <div className="study-formats" role="radiogroup" aria-label={L("שאלות פתוחות", "Open questions")}>
        <span className="small">{L(style === "licensing" ? "מקרים" : "פתוחות", style === "licensing" ? "Cases" : "Open")}</span>{[0, 2, 4].map((n) => chip(n, open, setOpen, String(n)))}
      </div>
      {(pastExams > 0 || clinical) && (
        <div className="study-formats" role="radiogroup" aria-label={L("סגנון", "Style")}>
          <span className="small">{L("סגנון", "Style")}</span>
          {chip<Style>("plain", style, setStyle, L("רגיל", "Plain"))}
          {pastExams > 0 && chip<Style>("past", style, setStyle, L("כמו המבחנים הקודמים", "Like the past exams"))}
          {clinical && chip<Style>("licensing", style, setStyle, L("בחינת רישוי", "Licensing exam"))}
        </div>
      )}
      <div className="row study-mock-time">
        <label className="small">{L("זמן (דקות)", "Time (minutes)")} <input type="number" min={5} max={300} value={time} onChange={(e) => setMinutes(Math.max(5, Math.min(300, Number(e.target.value) || 5)))} /></label>
        <label className="small"><input type="checkbox" checked={extra} onChange={(e) => setExtra(e.target.checked)} /> {L("הארכת זמן (25%)", "Extra time (25%)")}{extra ? ` → ${mockTime({ minutes: time, extra: true })} ${L("דק׳", "min")}` : ""}</label>
      </div>
      <div className="study-actions">
        <button type="button" className="primary" disabled={!!making || !lectures.length} onClick={() => void start()}>{making || L("התחלת המבחן", "Start the exam")}</button>
        <button type="button" className="ghost" disabled={!!making} onClick={onClose}>{L("ביטול", "Cancel")}</button>
      </div>
      {making && <p className="muted small">{L("כתיבת מבחן ארוך לוקחת כמה דקות. השעון יתחיל רק כשהשאלות מוכנות.", "A long exam takes a few minutes to write. The clock starts only when the questions are ready.")}</p>}
      {history.length > 0 && <p className="muted small" dir="auto">{L("התוצאות הקודמות", "Earlier results")}: {history.map((h) => h.grade).join(" · ")}</p>}
    </section>
  );
}
