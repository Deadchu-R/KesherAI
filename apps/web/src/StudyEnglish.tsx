import { useState } from "react";
import type { EnglishPractice } from "@kesher/shared";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * Academic English practice (design AcademicEnglish, students part 33 #1, for the exemption / AMIRNET level): she
 * pastes an English text (an article, an abstract from her sources); she gets reading-comprehension questions in the
 * exam's style and the text's hard words with their Hebrew meaning, which can become cards in a course.
 */
export function StudyEnglish({ courses }: { courses: Array<{ id: string; name: string }> }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [p, setP] = useState<EnglishPractice | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [chosen, setCourse] = useState("");
  // The courses arrive after the first render: the first one until she picks.
  const course = chosen || courses[0]?.id || "";
  const make = async () => {
    setBusy(true);
    try {
      setP(await api<EnglishPractice>("/api/study/english", { method: "POST", body: { text } }));
      setPicked([]);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const right = p ? p.questions.filter((q, i) => picked[i] === q.answer).length : 0;
  const answered = p ? p.questions.filter((_, i) => picked[i] !== undefined).length : 0;
  const toCards = async () => {
    if (!p || !course) return;
    let n = 0;
    for (const w of p.words) if (await api(`/api/study/courses/${course}/cards`, { method: "POST", body: { front: w.en, back: w.he, kind: "english" } }).then(() => true, () => false)) n++;
    toast(L(`נוספו ${n} כרטיסיות`, `${n} cards added`));
  };
  return (
    <section className="card study-english">
      <button type="button" className="study-grades-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <b>📘 {L("אנגלית אקדמית", "Academic English")}</b>
        <span className="grow" />
        <span className="muted small">{L("הבנת הנקרא ומילים, לקראת פטור", "Reading and words, toward exemption")}</span>
        <span aria-hidden="true">{open ? "▴" : "▾"}</span>
      </button>
      {open && (
        <>
          <textarea rows={5} dir="ltr" value={text} onChange={(e) => setText(e.target.value)} placeholder={L("הדביקי כאן טקסט באנגלית: מאמר, פסקה מספר, או תקציר מהמקורות שלך", "Paste an English text: an article, a book paragraph, or an abstract from your sources")} aria-label={L("טקסט באנגלית", "English text")} />
          <div className="study-actions"><button type="button" className="primary" disabled={busy || text.trim().length < 200} onClick={() => void make()}>{busy ? L("כותב שאלות…", "Writing questions…") : L("לתרגל על הטקסט", "Practise on this text")}</button></div>
          {p && (
            <>
              <ol className="study-english-qs">
                {p.questions.map((q, i) => (
                  <li key={i}>
                    <b dir="ltr">{q.q}</b>
                    {q.options.map((o, k) => {
                      const mine = picked[i];
                      const cls = mine === undefined ? "" : k === q.answer ? " right" : k === mine ? " wrong" : "";
                      return <button key={k} type="button" dir="ltr" className={`vl-option${cls}`} disabled={mine !== undefined} onClick={() => { const n = [...picked]; n[i] = k; setPicked(n); }}>{o}</button>;
                    })}
                    {picked[i] !== undefined && q.explain && <p className="muted small" dir="auto">{q.explain}</p>}
                  </li>
                ))}
              </ol>
              {answered === p.questions.length && <p><b>{L(`${right} מתוך ${p.questions.length}`, `${right} of ${p.questions.length}`)}</b></p>}
              {p.words.length > 0 && (
                <div className="study-english-words">
                  <b className="small">{L("מילים מהטקסט", "Words from the text")}</b>
                  <dl>{p.words.map((w, i) => <div key={i}><dt dir="ltr">{w.en}</dt><dd dir="rtl">{w.he}</dd></div>)}</dl>
                  {courses.length > 0 && (
                    <div className="row">
                      <select value={course} onChange={(e) => setCourse(e.target.value)} aria-label={L("לאיזה קורס", "Which course")}>{courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
                      <button type="button" className="small" onClick={() => void toCards()}>📇 {L("המילים לכרטיסיות", "Words into cards")}</button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
