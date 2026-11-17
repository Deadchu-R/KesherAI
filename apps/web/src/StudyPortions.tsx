import { useState } from "react";
import { readingPortion, type StudyLecture } from "@kesher/shared";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * Reading a long text in portions (design Portions, students part 30 #4, SuperMemo's incremental reading): today's
 * portion (about ten minutes), her place kept between days, cards from the portion she just read.
 */
export function StudyPortions({ base, lecture, onLecture, onCards }: { base: string; lecture: StudyLecture; onLecture: (l: StudyLecture) => void; onCards: () => void }) {
  const [pos, setPos] = useState(lecture.readPos ?? 0);
  const [busy, setBusy] = useState("");
  const p = readingPortion(lecture.text, pos);
  const done = (lecture.readPos ?? 0) >= lecture.text.length;
  const go = async (to: number) => {
    setPos(to);
    try {
      onLecture(await api<StudyLecture>(base, { method: "PATCH", body: { readPos: to } }));
    } catch (e) {
      toast((e as Error).message);
    }
    document.querySelector(".study-portion")?.scrollIntoView({ block: "start", behavior: "smooth" });
  };
  const cards = async () => {
    setBusy("cards");
    try {
      const r = await api<{ cards: unknown[] }>(`${base}/cards`, { method: "POST", body: { count: 6, range: { from: p.from, to: p.to } } });
      toast(L(`נוצרו ${r.cards.length} כרטיסיות מהמנה`, `${r.cards.length} cards from this portion`));
      onCards();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const minutes = Math.max(1, Math.round((p.to - p.from) / 900));
  return (
    <div className="study-portion">
      <div className="row study-portion-head">
        <b>{L(`מנה ${p.part} מתוך ${p.parts}`, `Portion ${p.part} of ${p.parts}`)}</b>
        <span className="muted small">{L(`כ-${minutes} דקות קריאה`, `about ${minutes} minutes`)}</span>
      </div>
      <progress max={p.parts} value={done ? p.parts : p.part - 1} aria-hidden="true" />
      <div className="study-text study-portion-text" dir="auto">{lecture.text.slice(p.from, p.to)}</div>
      <div className="study-actions">
        {p.to < lecture.text.length ? <button type="button" className="primary" onClick={() => void go(p.to)}>{L("✓ סיימתי, למנה הבאה", "✓ Done, next portion")}</button>
          : <button type="button" className="primary" disabled={done} onClick={() => void go(lecture.text.length)}>{done ? L("✓ סיימת את כל הטקסט", "✓ You finished the whole text") : L("✓ סיימתי את המנה האחרונה", "✓ Done with the last portion")}</button>}
        <button type="button" disabled={!!busy} onClick={() => void cards()}>{busy ? L("כותב כרטיסיות…", "Writing cards…") : L("📇 כרטיסיות מהמנה", "📇 Cards from this portion")}</button>
        {p.part > 1 && <button type="button" className="ghost" onClick={() => void go(readingPortion(lecture.text, p.from - 1).from)}>{L("למנה הקודמת", "Previous portion")}</button>}
      </div>
      <p className="muted small">{L("המקום נשמר. מנה ביום, וכרטיסיות מכל מנה, עדיפות על פני קריאה של הכל בבת אחת.", "Your place is kept. A portion a day, with cards from each, beats reading it all at once.")}</p>
    </div>
  );
}
