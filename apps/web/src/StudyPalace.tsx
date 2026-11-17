import { useEffect, useState } from "react";
import { PALACE_SPOTS_HE, type StudyPalace as Palace, type StudyTerm } from "@kesher/shared";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const SPOTS_EN = ["The front door", "The hallway", "The sofa", "The TV", "The dining table", "The fridge", "The kitchen sink", "The bed", "The wardrobe", "The shower"];

/**
 * A memory palace (design MemoryPalace, students part 29 #6, the method of loci, like Coconote's): spots in a place
 * she knows well, each holding one of her terms in a vivid scene; she walks through it to learn, then walks again and
 * recalls which term waits at each spot.
 */
export function StudyPalace({ courseId, terms }: { courseId: string; terms: StudyTerm[] }) {
  const [palace, setPalace] = useState<Palace | null | undefined>(undefined);
  const [building, setBuilding] = useState(false);
  const [place, setPlace] = useState(L("הבית שלי", "My home"));
  const [spots, setSpots] = useState<string[]>(() => (getLocale() === "he" ? PALACE_SPOTS_HE : SPOTS_EN).slice(0, 8));
  const [picked, setPicked] = useState<number[]>(() => terms.slice(0, 8).map((_, i) => i));
  const [busy, setBusy] = useState(false);
  const [walk, setWalk] = useState<{ i: number; shown: boolean; got: number } | null>(null);
  useEffect(() => void api<{ palace: Palace | null }>(`/api/study/courses/${courseId}/palace`).then((r) => setPalace(r.palace), () => setPalace(null)), [courseId]);
  if (palace === undefined) return <p className="muted">…</p>;
  if (terms.length < 2) return <p className="muted">{L("ארמון זיכרון נבנה מהמונחים של ההרצאות. סכמי הרצאה אחת לפחות.", "A memory palace is built from the lectures' terms. Summarize a lecture first.")}</p>;

  const build = async () => {
    setBusy(true);
    try {
      const chosen = picked.slice(0, spots.length).map((i) => terms[i]!).map((t) => ({ term: t.term, explain: t.explain }));
      const r = await api<{ palace: Palace }>(`/api/study/courses/${courseId}/palace`, { method: "POST", body: { place, spots: spots.filter((s) => s.trim()), terms: chosen } });
      setPalace(r.palace);
      setBuilding(false);
      setWalk(null);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (building || !palace) {
    const n = Math.min(spots.filter((s) => s.trim()).length, picked.length);
    return (
      <section className="card study-palace">
        <h2>🏛 {L("ארמון זיכרון", "Memory palace")}</h2>
        <p className="muted small">{L("שיטת המקומות: כל מונח נקשר לפינה במקום שאת מכירה בעיניים עצומות, בסצנה מוזרה ומצחיקה שקל לזכור. אחר כך הולכים במקום בדמיון והמונחים חוזרים.", "The method of loci: each term is tied to a spot in a place you know with your eyes closed, in a strange, funny scene. Then you walk it in your mind and the terms come back.")}</p>
        <label className="small">{L("המקום", "The place")} <input dir="auto" value={place} onChange={(e) => setPlace(e.target.value)} /></label>
        <b className="small">{L("הפינות, לפי הסדר שבו את עוברת בהן", "The spots, in the order you walk past them")}</b>
        <ol className="study-palace-spots">
          {spots.map((s, i) => (
            <li key={i} className="row">
              <input dir="auto" value={s} onChange={(e) => setSpots(spots.map((x, j) => (j === i ? e.target.value : x)))} aria-label={L(`פינה ${i + 1}`, `Spot ${i + 1}`)} />
              <button type="button" className="ghost small" aria-label={L("להסיר", "Remove")} onClick={() => setSpots(spots.filter((_, j) => j !== i))}>✕</button>
            </li>
          ))}
        </ol>
        {spots.length < 12 && <button type="button" className="ghost small" onClick={() => setSpots([...spots, ""])}>＋ {L("פינה", "Spot")}</button>}
        <b className="small">{L(`המונחים (${picked.length} נבחרו)`, `The terms (${picked.length} chosen)`)}</b>
        <div className="study-palace-terms">
          {terms.slice(0, 60).map((t, i) => (
            <label key={i} className={`study-palace-term${picked.includes(i) ? " on" : ""}`}>
              <input type="checkbox" hidden checked={picked.includes(i)} onChange={() => setPicked(picked.includes(i) ? picked.filter((x) => x !== i) : picked.length < 12 ? [...picked, i] : picked)} />
              <span dir="auto">{t.term}</span>
            </label>
          ))}
        </div>
        <div className="study-actions">
          <button type="button" className="primary" disabled={busy || n < 2} onClick={() => void build()}>{busy ? L("בונה את הארמון…", "Building the palace…") : L(`לבנות ארמון עם ${n} מונחים`, `Build a palace with ${n} terms`)}</button>
          {palace && <button type="button" className="ghost" onClick={() => setBuilding(false)}>{L("ביטול", "Cancel")}</button>}
        </div>
      </section>
    );
  }

  if (walk) {
    const it = palace.items[walk.i];
    if (!it)
      return (
        <section className="card study-palace">
          <h2>🏛 {L(`זכרת ${walk.got} מתוך ${palace.items.length}`, `You recalled ${walk.got} of ${palace.items.length}`)}</h2>
          <div className="study-actions">
            <button type="button" className="primary" onClick={() => setWalk({ i: 0, shown: false, got: 0 })}>{L("עוד הליכה", "Walk again")}</button>
            <button type="button" className="ghost" onClick={() => setWalk(null)}>{L("לראות את הארמון", "See the palace")}</button>
          </div>
        </section>
      );
    return (
      <section className="card study-palace">
        <p className="muted small">{L(`${palace.place} · פינה ${walk.i + 1} מתוך ${palace.items.length}`, `${palace.place} · spot ${walk.i + 1} of ${palace.items.length}`)}</p>
        <h2 dir="auto">📍 {it.spot}</h2>
        <p className="muted">{L("איזה מונח מחכה כאן? נסי להיזכר בסצנה.", "Which term waits here? Try to recall the scene.")}</p>
        {walk.shown ? (
          <>
            <div className="study-palace-scene" dir="auto">{it.scene}</div>
            <b dir="auto">{it.term}</b>
            <span className="small" dir="auto">{it.explain}</span>
            <div className="study-actions">
              <button type="button" className="primary" onClick={() => setWalk({ i: walk.i + 1, shown: false, got: walk.got + 1 })}>{L("זכרתי ✓", "I recalled it ✓")}</button>
              <button type="button" onClick={() => setWalk({ i: walk.i + 1, shown: false, got: walk.got })}>{L("לא זכרתי", "I did not")}</button>
            </div>
          </>
        ) : <div className="study-actions"><button type="button" className="primary" onClick={() => setWalk({ ...walk, shown: true })}>{L("לגלות", "Reveal")}</button></div>}
      </section>
    );
  }

  return (
    <section className="card study-palace">
      <div className="row study-live-head">
        <h2 dir="auto">🏛 {palace.place}</h2>
        <button type="button" className="ghost small" onClick={() => setBuilding(true)}>{L("ארמון חדש", "New palace")}</button>
      </div>
      <p className="muted small">{L("עברי על הפינות לפי הסדר ודמייני כל סצנה לכמה שניות. אחר כך \"ללכת ולהיזכר\".", "Go through the spots in order and picture each scene for a few seconds. Then \"Walk and recall\".")}</p>
      <ol className="study-palace-list">
        {palace.items.map((it, i) => (
          <li key={i}>
            <b dir="auto">📍 {it.spot} ← {it.term}</b>
            <span dir="auto">{it.scene}</span>
          </li>
        ))}
      </ol>
      <div className="study-actions"><button type="button" className="primary" onClick={() => setWalk({ i: 0, shown: false, got: 0 })}>{L("ללכת ולהיזכר", "Walk and recall")}</button></div>
    </section>
  );
}
