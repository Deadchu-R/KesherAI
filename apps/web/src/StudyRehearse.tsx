import { useState } from "react";
import { speechStats } from "@kesher/shared";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";
import { Mic } from "./Mic";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * Presentation rehearsal (design Rehearse, students part 32 #1, like Yoodli and Orai): she says her talk into the
 * microphone; KesherAI counts her pace and filler words against her time, and the model comments on structure,
 * clarity and content against her lectures. Nothing is kept.
 */
export function StudyRehearse({ courseId }: { courseId: string }) {
  const [target, setTarget] = useState(5);
  const [take, setTake] = useState<{ text: string; seconds: number } | null>(null);
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const stats = take ? speechStats(take.text, take.seconds) : null;
  const ask = async () => {
    if (!take) return;
    setBusy(true);
    try {
      setFeedback((await api<{ feedback: string }>(`/api/study/courses/${courseId}/rehearse`, { method: "POST", body: { ...take, target } })).feedback);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const mm = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  const paceNote = (wpm: number) => (wpm > 170 ? L("מהר מדי: כדאי להאט ולעצור אחרי רעיון", "Too fast: slow down and pause after each idea") : wpm < 100 ? L("לאט: אפשר קצת יותר קצב", "Slow: a little more pace") : L("קצב נוח", "A comfortable pace"));
  return (
    <section className="card study-rehearse">
      <h2>🎤 {L("חזרה על הצגה", "Rehearse a talk")}</h2>
      <p className="muted small">{L("לוחצים על המיקרופון, אומרים את ההצגה או התשובה בעל פה כמו מול הכיתה, ולוחצים שוב בסוף. מקבלים קצב, מילות מילוי, אורך, והערות לפי החומר שלך. ההקלטה לא נשמרת.", "Press the microphone, give your talk as in front of the class, press again at the end. You get pace, filler words, length and notes against your material. The recording is not kept.")}</p>
      <div className="row study-rehearse-go">
        <label className="small">{L("הזמן שהוקצב", "Your time")} <select value={target} onChange={(e) => setTarget(Number(e.target.value))}>{[2, 3, 5, 7, 10, 15, 20].map((n) => <option key={n} value={n}>{L(`${n} דק׳`, `${n} min`)}</option>)}</select></label>
        <Mic onText={(text, seconds) => { setTake({ text, seconds: seconds || 1 }); setFeedback(""); }} />
      </div>
      {take && stats && (
        <>
          <div className="study-rehearse-stats">
            <div><b>{mm(take.seconds)}</b><span className="muted small">{take.seconds > target * 60 * 1.1 ? L(`ארוך מ-${target} דק׳`, `over ${target} min`) : take.seconds < target * 60 * 0.6 ? L("קצר מהזמן", "short of the time") : L("בזמן", "on time")}</span></div>
            <div><b>{stats.wpm}</b><span className="muted small">{L("מילים לדקה", "words a minute")} · {paceNote(stats.wpm)}</span></div>
            <div><b>{stats.fillerShare}%</b><span className="muted small">{L("מילות מילוי", "filler words")}{stats.fillers.length ? `: ${stats.fillers.slice(0, 4).map((f) => `${f.word} ×${f.n}`).join(", ")}` : L(": אין 👏", ": none 👏")}</span></div>
          </div>
          <details><summary className="small">{L("מה נשמע", "What was heard")}</summary><p className="small" dir="auto">{take.text}</p></details>
          {feedback ? <div className="study-rehearse-feedback" dir="auto">{feedback}</div>
            : <button type="button" className="primary" disabled={busy} onClick={() => void ask()}>{busy ? L("מקשיב שוב…", "Listening again…") : L("💬 הערות על התוכן והמבנה", "💬 Notes on content and structure")}</button>}
        </>
      )}
    </section>
  );
}
