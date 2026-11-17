import { useState } from "react";
import type { StudyCourse } from "@kesher/shared";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

type GoalPick = "none" | "m15" | "m30" | "c20";
const GOALS: Array<[GoalPick, string, string]> = [
  ["none", "בלי יעד", "No goal"],
  ["m15", "15 דקות", "15 minutes"],
  ["m30", "30 דקות", "30 minutes"],
  ["c20", "20 כרטיסיות", "20 cards"],
];

/**
 * The first visit to Study (design StudyWelcome): her first course, a small daily goal or none, and simple or all
 * tools. Three short steps, then the course opens with the "add a lecture" form ready.
 */
export function StudyWelcome({ onSkip }: { onSkip: () => void }) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [exam, setExam] = useState("");
  const [goal, setGoal] = useState<GoalPick>("m15");
  const [remind, setRemind] = useState<"" | "20:30">("20:30");
  const [phone, setPhone] = useState(false);
  const [simple, setSimple] = useState(true);
  const [busy, setBusy] = useState(false);

  const finish = async () => {
    setBusy(true);
    try {
      const c = await api<StudyCourse>("/api/study/courses", { method: "POST", body: { name: name.trim() } });
      if (exam) await api(`/api/study/courses/${c.id}`, { method: "PATCH", body: { examDate: exam } }).catch(() => undefined);
      await api("/api/study/goal", {
        method: "PUT",
        body: goal === "none" ? { on: false } : { on: true, targets: { minutes: goal === "m15" ? 15 : goal === "m30" ? 30 : 0, cards: goal === "c20" ? 20 : 0 }, remind, phone },
      });
      await api("/api/study/prefs", { method: "PUT", body: { simple, welcomed: true } });
      location.hash = `#/study/${c.id}`;
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card study-welcome" aria-label={L("כניסה ראשונה ללימודים", "Getting started with Study")}>
      <ol className="study-welcome-steps" aria-label={L("שלבים", "Steps")}>
        {[0, 1, 2].map((i) => <li key={i} className={i === step ? "now" : i < step ? "done" : ""} aria-current={i === step ? "step" : undefined} />)}
      </ol>
      {step === 0 && (
        <form className="study-welcome-body" onSubmit={(e) => { e.preventDefault(); if (name.trim()) setStep(1); }}>
          <h2>👋 {L("בואי נתחיל", "Let's start")}</h2>
          <label>{L("מה הקורס הראשון שלך?", "What's your first course?")}<input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={L("למשל: פרמקולוגיה", "e.g. Pharmacology")} dir="auto" /></label>
          <label>{L("מתי המבחן? (לא חובה)", "When is the exam? (optional)")}<input type="date" value={exam} onChange={(e) => setExam(e.target.value)} /></label>
          <div className="row">
            <button type="submit" className="primary" disabled={!name.trim()}>{L("הבא ›", "Next ›")}</button>
            <button type="button" className="link" onClick={onSkip}>{L("לדלג, אסתדר לבד", "Skip, I'll find my way")}</button>
          </div>
        </form>
      )}
      {step === 1 && (
        <div className="study-welcome-body">
          <h2>🎯 {L("יעד קטן לכל יום?", "A small goal each day?")}</h2>
          <p className="muted">{L("אפשר לשנות בכל רגע. יום בלי יעד זה גם בסדר.", "You can change it any time. A day without a goal is fine too.")}</p>
          <div className="study-welcome-opts" role="radiogroup">
            {GOALS.map(([k, he, en]) => <button type="button" key={k} role="radio" aria-checked={goal === k} className={goal === k ? "on" : ""} onClick={() => setGoal(k)}>{goal === k ? "✓ " : ""}{L(he, en)}</button>)}
          </div>
          {goal !== "none" && (
            <>
              <span className="small">{L("תזכורת עדינה, רק בימים שעוד לא למדת", "A gentle reminder, only on days you have not studied yet")}</span>
              <div className="study-welcome-opts">
                <button type="button" className={!remind ? "on" : ""} aria-pressed={!remind} onClick={() => setRemind("")}>{!remind ? "✓ " : ""}{L("בלי", "None")}</button>
                <button type="button" className={remind ? "on" : ""} aria-pressed={!!remind} onClick={() => setRemind("20:30")}>{remind ? "✓ " : ""}20:30</button>
                {remind && <button type="button" className={phone ? "on" : ""} aria-pressed={phone} onClick={() => setPhone(!phone)}>{phone ? "✓ " : ""}📱 {L("גם לטלפון", "To the phone too")}</button>}
              </div>
            </>
          )}
          <div className="row">
            <button type="button" className="primary" onClick={() => setStep(2)}>{L("הבא ›", "Next ›")}</button>
            <button type="button" className="link" onClick={() => setStep(0)}>{L("‹ חזרה", "‹ Back")}</button>
          </div>
        </div>
      )}
      {step === 2 && (
        <div className="study-welcome-body">
          <h2>🧹 {L("כמה כלים להראות?", "How many tools to show?")}</h2>
          <button type="button" className={`study-welcome-choice${simple ? " on" : ""}`} aria-pressed={simple} onClick={() => setSimple(true)}>
            <b>{simple ? "✓ " : ""}{L("תצוגה פשוטה (מומלץ)", "Simple view (recommended)")}</b>
            <span className="muted small">{L("הרצאות · חזרה · בוחן · שאלי · משחק · התקדמות. השאר תחת \"עוד כלים\".", "Lectures · review · quiz · ask · game · progress. The rest under \"More tools\".")}</span>
          </button>
          <button type="button" className={`study-welcome-choice${!simple ? " on" : ""}`} aria-pressed={!simple} onClick={() => setSimple(false)}>
            <b>{!simple ? "✓ " : ""}{L("כל הכלים", "All tools")}</b>
            <span className="muted small">{L("סיכום הקורס, כלים לתחום, מילון, חישובים ועוד.", "Course summary, field tools, glossary, calculations and more.")}</span>
          </button>
          <div className="row">
            <button type="button" className="primary" disabled={busy} onClick={() => void finish()}>{busy ? "…" : L("להוסיף הרצאה ראשונה ›", "Add a first lecture ›")}</button>
            <button type="button" className="link" onClick={() => setStep(1)}>{L("‹ חזרה", "‹ Back")}</button>
          </div>
          <p className="muted small">{L("ההרצאה נכנסת בהקלטה, בהעלאת קובץ או סרטון, בצילום הלוח, מקישור או מ-Moodle.", "A lecture comes in by recording, uploading a file or video, a photo of the board, a link, or from Moodle.")}</p>
        </div>
      )}
    </section>
  );
}
