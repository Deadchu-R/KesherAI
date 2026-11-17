import { useEffect, useState } from "react";
import type { StudyCard, StudyQuestion } from "@kesher/shared";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";
import { RichText } from "./RichText";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
type Item = { key: string; card?: StudyCard; q?: StudyQuestion & { t: number }; right: number };
const NEED = 2;

/**
 * "My mistakes" (design MyMistakes, like Duolingo's practice hub): the cards she forgot and the quiz questions she got
 * wrong lately, mixed; each comes back until it is right twice. A card she rates also counts in spaced review.
 */
export function StudyMistakes({ courseId, courseName, onClose }: { courseId: string; courseName: string; onClose: () => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [i, setI] = useState(0);
  const [shown, setShown] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  useEffect(() => {
    void api<{ cards: StudyCard[]; questions: Array<StudyQuestion & { t: number }> }>(`/api/study/courses/${courseId}/mistakes`).then((r) => {
      const all: Item[] = [...r.cards.map((card) => ({ key: `c${card.id}`, card, right: 0 })), ...r.questions.map((q, n) => ({ key: `q${n}`, q, right: 0 }))];
      // Mixed, so it is not all cards and then all questions.
      for (let a = all.length - 1; a > 0; a--) {
        const b = Math.floor(Math.random() * (a + 1));
        [all[a], all[b]] = [all[b]!, all[a]!];
      }
      setItems(all);
    }, (e: Error) => toast(e.message));
  }, [courseId]);
  if (!items) return <p className="muted">…</p>;
  const left = items.filter((x) => x.right < NEED);
  const done = items.length - left.length;
  if (!items.length) return (
    <section className="card mistakes-done">
      <b>🎉 {L("אין טעויות מהזמן האחרון!", "No recent mistakes!")}</b>
      <button type="button" onClick={onClose}>{L("חזרה", "Back")}</button>
    </section>
  );
  if (!left.length) return (
    <section className="card mistakes-done">
      <b>🏆 {L(`כל ${items.length} הטעויות נכונות עכשיו פעמיים`, `All ${items.length} mistakes are now right twice`)}</b>
      <button type="button" className="primary" onClick={onClose}>{L("סיום", "Done")}</button>
    </section>
  );
  const cur = left[i % left.length]!;
  const answer = async (ok: boolean) => {
    if (cur.card) void api(`/api/study/courses/${courseId}/cards/${cur.card.id}/review`, { method: "POST", body: { rating: ok ? 3 : 1 } }).catch(() => undefined);
    setItems(items.map((x) => (x.key === cur.key ? { ...x, right: ok ? x.right + 1 : 0 } : x)));
    setShown(false);
    setPicked(null);
    // The next one; a wrong one comes back later in the round.
    setI((n) => n + 1);
  };
  return (
    <section className="study-mistakes">
      <div className="mistakes-head">
        <b>❌ {L("הטעויות שלי", "My mistakes")} · {courseName}</b>
        <span className="muted small">{L(`${done} מתוך ${items.length} נכונות פעמיים`, `${done} of ${items.length} right twice`)}</span>
        <button type="button" className="link" onClick={onClose}>{L("לעצור", "Stop")}</button>
      </div>
      <div className="mistakes-bar"><span style={{ width: `${(done / items.length) * 100}%` }} /></div>
      <div className="card mistakes-item">
        <span className="muted small">{cur.card ? L("כרטיסייה ששכחת", "A card you forgot") : L(`שאלה מבוחן מ-${new Date(cur.q!.t).toLocaleDateString("he-IL", { day: "numeric", month: "numeric" })}`, `A quiz question from ${new Date(cur.q!.t).toLocaleDateString("en-GB", { day: "numeric", month: "numeric" })}`)}{cur.right ? ` · ✓ ${L("פעם אחת נכון", "right once")}` : ""}</span>
        {cur.card ? (
          <>
            <div dir="auto" className="mistakes-front"><RichText text={cur.card.front} /></div>
            {shown ? (
              <>
                <div dir="auto" className="mistakes-back"><RichText text={cur.card.back} /></div>
                <div className="row">
                  <button type="button" className="primary" onClick={() => void answer(true)}>✓ {L("ידעתי", "I knew it")}</button>
                  <button type="button" onClick={() => void answer(false)}>✗ {L("לא ידעתי", "I didn't")}</button>
                </div>
              </>
            ) : <button type="button" className="primary" onClick={() => setShown(true)}>{L("להראות תשובה", "Show the answer")}</button>}
          </>
        ) : (
          <>
            <b dir="auto">{cur.q!.q}</b>
            <div className="mistakes-options">
              {cur.q!.options.map((o, n) => (
                <button type="button" key={n} dir="auto" disabled={picked !== null} className={picked === null ? "" : n === cur.q!.answer ? "right" : n === picked ? "wrong" : ""} onClick={() => setPicked(n)}>{o}{picked !== null && n === cur.q!.answer ? " ✓" : ""}</button>
              ))}
            </div>
            {picked !== null && (
              <>
                {cur.q!.explain && <p className="small" dir="auto">{cur.q!.explain}</p>}
                <button type="button" className="primary" onClick={() => void answer(picked === cur.q!.answer)}>{L("הבא ›", "Next ›")}</button>
              </>
            )}
          </>
        )}
      </div>
      <p className="muted small">{L("כל טעות מ-30 הימים האחרונים חוזרת עד שעונים עליה נכון פעמיים.", "Every mistake from the last 30 days comes back until you get it right twice.")}</p>
    </section>
  );
}
