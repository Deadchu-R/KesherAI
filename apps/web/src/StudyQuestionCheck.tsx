import { useState } from "react";
import type { StudyQuiz } from "@kesher/shared";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

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
 * "This question looks wrong" under a missed question (design QuestionCheck): the local model can get its own key
 * wrong, so she can have it checked against the lecture, or say her answer is the right one. The score updates.
 */
export function QuestionCheck({ courseId, quizId, index, mine, onQuiz }: { courseId: string; quizId: string; index: number; mine?: number | undefined; onQuiz: (z: StudyQuiz) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const run = async (body: { mine?: number }) => {
    setBusy(true);
    const r = await call(api<{ quiz: StudyQuiz; check: { verdict: "right" | "fix" | "broken"; quote?: string; explain: string } }>(`/api/study/courses/${courseId}/quiz/${quizId}/questions/${index}/check`, { method: "POST", body }));
    setBusy(false);
    if (!r) return;
    const why = [r.check.quote ? `"${r.check.quote}"` : "", r.check.explain].filter(Boolean).join(" ");
    const line = r.check.verdict === "right" ? L(`המפתח נכון לפי ההרצאה. ${why}`, `The key is right by the lecture. ${why}`)
      : r.check.verdict === "broken" ? L(`השאלה לא טובה, אז הוצאתי אותה מהבוחן ומהציון. ${why}`, `The question is not a good one, so it is out of the quiz and the score. ${why}`)
      : body.mine !== undefined ? L("סימנתי את התשובה שלך כנכונה, והציון עודכן.", "Your answer is marked right, and the score is updated.")
      : L(`צדקת: תיקנתי את המפתח, והציון עודכן. ${why}`, `You were right: the key is fixed and the score is updated. ${why}`);
    setSaid(line);
    // A fixed or removed question leaves this row (it shows "fixed" or goes), so the answer also comes as a toast.
    if (r.check.verdict !== "right") toast(line);
    onQuiz(r.quiz);
  };
  if (!open) return <button type="button" className="small" onClick={() => setOpen(true)}>⚠️ {L("נראה לי שהשאלה שגויה", "I think this question is wrong")}</button>;
  return (
    <div className="study-qcheck" aria-live="polite">
      <span className="small">{L("המודל יכול לטעות. בודקים מול ההרצאה, או מסמנים שהתשובה שלך היא הנכונה.", "The model can be wrong. Check it against the lecture, or mark your answer as the right one.")}</span>
      {!said && <div className="study-actions">
        <button type="button" className="primary" disabled={busy} onClick={() => void run({})}>{busy ? L("בודק מול ההרצאה…", "Checking the lecture…") : `🔎 ${L("לבדוק מול ההרצאה", "Check against the lecture")}`}</button>
        {mine !== undefined && mine >= 0 && <button type="button" disabled={busy} onClick={() => void run({ mine })}>✓ {L("התשובה שלי נכונה", "My answer is right")}</button>}
      </div>}
      {said && <span className="small" dir="auto">{said}</span>}
    </div>
  );
}
