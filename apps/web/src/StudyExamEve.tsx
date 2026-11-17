import { useEffect, useState } from "react";
import { getLocale, he$ } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const CHECK: Array<[string, string]> = [
  ["תעודת זהות או כרטיס סטודנט", "ID or student card"],
  ["מחשבון / דף נוסחאות אם מותר", "Calculator / formula sheet if allowed"],
  ["עטים, מים ומשהו לאכול", "Pens, water and a snack"],
  ["לבדוק כיתה ושעה (ותחבורה)", "Check the room and time (and the way there)"],
  ["לישון 7 שעות בלילה שלפני", "Sleep 7 hours the night before"],
];

/** Days from today to a YYYY-MM-DD date (0 = today). */
const daysTo = (date: string) => Math.round((new Date(`${date}T00:00:00`).getTime() - new Date(new Date().toDateString()).getTime()) / 86_400_000);

/**
 * The last days before an exam (design ExamEve, students part 32 #2, like exam-countdown and last-minute revision
 * apps): from two days before the exam date, a card with the countdown, what to do first (hard cards and mistakes, a
 * short quiz, the one-page sheets), a checklist for the day and a minute of calm breathing.
 */
export function StudyExamEve({ courseId, examDate, lectures }: { courseId: string; examDate?: string; lectures: Array<{ id: string; title: string }> }) {
  const key = `kesher-exam-eve-${courseId}-${examDate ?? ""}`;
  const [done, setDone] = useState<number[]>(() => { try { return JSON.parse(localStorage.getItem(key) ?? "[]") as number[]; } catch { return []; } });
  const [breath, setBreath] = useState(0);
  useEffect(() => {
    if (!breath) return;
    const t = setTimeout(() => setBreath((b) => (b >= 60 ? 0 : b + 1)), 1000);
    return () => clearTimeout(t);
  }, [breath]);
  if (!examDate) return null;
  const days = daysTo(examDate);
  if (days < 0 || days > 2) return null;
  const tick = (i: number) => {
    const next = done.includes(i) ? done.filter((x) => x !== i) : [...done, i];
    setDone(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* a convenience */ }
  };
  // Breathing 4 in, 4 hold, 6 out (14 s a round).
  const phase = breath ? ((breath - 1) % 14 < 4 ? L("שאיפה…", "Breathe in…") : (breath - 1) % 14 < 8 ? L("להחזיק…", "Hold…") : L("נשיפה ארוכה…", "Long breath out…")) : "";
  return (
    <section className="card study-eve">
      <h2>🎯 {days === 0 ? L("המבחן היום. בהצלחה!", "The exam is today. Good luck!") : days === 1 ? L("המבחן מחר", "The exam is tomorrow") : L("המבחן בעוד יומיים", "The exam is in two days")}</h2>
      {days > 0 && (
        <div className="study-eve-do">
          <b className="small">{L("מה לעשות עכשיו, לפי הסדר:", "What to do now, in order:")}</b>
          <a className="button" href={`#/study/${courseId}/quick`}>1. ❌ {L("הטעויות והכרטיסיות הקשות", "Your mistakes and hard cards")}</a>
          <a className="button" href={`#/study/${courseId}/quiz`}>2. 📝 {L("בוחן קצר על כל הקורס", "A short quiz on the whole course")}</a>
          {lectures.length > 0 && <details><summary className="small">3. 📄 {L("לעבור על דפי הסיכום", "Go over the one-page sheets")}</summary>{lectures.map((l) => <a key={l.id} className="study-eve-sheet small" href={`#/study/${courseId}/l/${l.id}`} dir="auto">{l.title}</a>)}</details>}
        </div>
      )}
      <div className="study-eve-check">
        <b className="small">{L("ליום המבחן", "For the exam day")}</b>
        {CHECK.map(([he, en], i) => <label key={i} className="study-check"><input type="checkbox" checked={done.includes(i)} onChange={() => tick(i)} /> {L(he, en)}</label>)}
      </div>
      <div className="row study-eve-breath">
        <button type="button" onClick={() => setBreath(breath ? 0 : 1)}>{breath ? L("לעצור", "Stop") : L("🫁 דקה של נשימה רגועה", "🫁 A minute of calm breathing")}</button>
        {breath > 0 && <span className={`study-eve-ball ${(breath - 1) % 14 < 4 ? "in" : (breath - 1) % 14 < 8 ? "hold" : "out"}`} aria-hidden="true" />}
        {breath > 0 && <span className="small" aria-live="polite">{phase}</span>}
      </div>
    </section>
  );
}
