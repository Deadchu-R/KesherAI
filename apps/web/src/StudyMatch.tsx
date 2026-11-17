import { useEffect, useMemo, useRef, useState } from "react";
import type { StudyTerm } from "@kesher/shared";
import { getLocale, he$ } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
const PAIRS = 6;
const shuffle = <T,>(a: T[]): T[] => {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j]!, b[i]!];
  }
  return b;
};
const time = (ms: number) => `${Math.floor(ms / 60000)}:${((ms % 60000) / 1000).toFixed(1).padStart(4, "0")}`;
/** A meaning short enough for a tile: its first sentence, at most 70 letters. */
const short = (s: string) => {
  const first = s.split(/(?<=[.!?。])\s/)[0] ?? s;
  return first.length > 70 ? `${first.slice(0, 68)}…` : first;
};

type Tile = { key: string; pair: number; text: string; term: boolean };

/**
 * The match game (design StudyMatch, like Quizlet Match): six terms from her course and their meanings, shuffled;
 * tap a term then its meaning (or the other way). A wrong pair adds a second. Her best time is kept per course.
 */
export function StudyMatch({ courseId, courseName, terms }: { courseId: string; courseName: string; terms: StudyTerm[] }) {
  const pool = useMemo(() => {
    const seen = new Set<string>();
    return terms.filter((t) => t.term.trim() && t.explain.trim() && !seen.has(t.term) && seen.add(t.term));
  }, [terms]);
  const [round, setRound] = useState(0);
  // A new round reshuffles.
  const tiles = useMemo<Tile[]>(() => {
    const picked = shuffle(pool).slice(0, PAIRS);
    return shuffle(picked.flatMap((t, i) => [{ key: `t${i}`, pair: i, text: t.term, term: true }, { key: `m${i}`, pair: i, text: short(t.explain), term: false }]));
  }, [pool, round]);
  const [sel, setSel] = useState<Tile | null>(null);
  const [done, setDone] = useState<Set<number>>(new Set());
  const [bad, setBad] = useState<string[]>([]);
  const [penalty, setPenalty] = useState(0);
  const [start, setStart] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [finished, setFinished] = useState<number | null>(null);
  const bestKey = `kesher-match-best:${courseId}`;
  const [best, setBest] = useState<number | null>(() => {
    try {
      return Number(localStorage.getItem(bestKey)) || null;
    } catch {
      return null;
    }
  });
  const timer = useRef(0);
  useEffect(() => {
    if (start === null || finished !== null) return;
    timer.current = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(timer.current);
  }, [start, finished]);

  const pairs = Math.min(PAIRS, pool.length);
  if (pool.length < 3) return <p className="muted">{L("צריך לפחות 3 מונחים. סכמי הרצאה (הסיכום מוציא מונחים) ואז חזרי למשחק.", "At least 3 terms are needed. Summarize a lecture (summaries pull out terms), then come back.")}</p>;

  const again = () => {
    setRound((r) => r + 1);
    setSel(null);
    setDone(new Set());
    setBad([]);
    setPenalty(0);
    setStart(null);
    setFinished(null);
  };
  const tap = (t: Tile) => {
    if (done.has(t.pair) || finished !== null) return;
    if (start === null) setStart(Date.now());
    if (!sel || sel.term === t.term) return setSel(sel?.key === t.key ? null : t);
    if (sel.pair === t.pair) {
      const next = new Set(done).add(t.pair);
      setDone(next);
      setSel(null);
      if (next.size === pairs) {
        const ms = Date.now() - (start ?? Date.now()) + penalty;
        setFinished(ms);
        if (!best || ms < best) {
          setBest(ms);
          try {
            localStorage.setItem(bestKey, String(ms));
          } catch {
            // no storage
          }
        }
      }
    } else {
      setBad([sel.key, t.key]);
      setPenalty((p) => p + 1000);
      setSel(null);
      window.setTimeout(() => setBad([]), 450);
    }
  };
  const elapsed = finished ?? (start === null ? 0 : now - start + penalty);
  return (
    <section className="study-match">
      <div className="study-match-head">
        <b>🎯 {L("התאמה", "Match")}: {courseName}</b>
        <span className="muted small">{L(`${pairs} זוגות`, `${pairs} pairs`)}</span>
        <span className="grow" />
        <b className="study-match-time" dir="ltr">{time(elapsed)}</b>
        {best && <span className="muted small">{L("שיא", "Best")}: <span dir="ltr">{time(best)}</span></span>}
      </div>
      {finished !== null ? (
        <div className="card study-match-done">
          <b>{finished === best ? L("🏆 שיא חדש!", "🏆 New best!") : L("✓ כל הזוגות", "✓ All pairs")}</b>
          <span dir="ltr">{time(finished)}</span>
          {penalty > 0 && <span className="muted small">{L(`כולל ${penalty / 1000} שניות על טעויות`, `incl. ${penalty / 1000}s for mistakes`)}</span>}
          <button type="button" className="primary" onClick={again}>{L("עוד סיבוב", "Play again")}</button>
        </div>
      ) : (
        <div className="study-match-grid">
          {tiles.map((t) =>
            done.has(t.pair) ? <span key={t.key} className="study-match-tile gone" aria-hidden="true" /> : (
              <button type="button" key={t.key} dir="auto" className={`study-match-tile${t.term ? " term" : ""}${sel?.key === t.key ? " sel" : ""}${bad.includes(t.key) ? " bad" : ""}`} onClick={() => tap(t)}>{t.text}</button>
            ),
          )}
        </div>
      )}
      <p className="muted small">{L("הקישי מונח ואז את ההסבר שלו. טעות מוסיפה שנייה. המונחים מההרצאות שסוכמו.", "Tap a term, then its meaning. A mistake adds a second. Terms come from summarized lectures.")}</p>
    </section>
  );
}
