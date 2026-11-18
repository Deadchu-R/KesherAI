import { useEffect, useState } from "react";
import type { FeedItem } from "@kesher/shared";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";
import { RichText } from "./RichText";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * The study feed (design StudyFeed, students part 34 #1, like ScrollToStudy): the course as short bites, one per
 * screen, swiped up like a social feed: a term, a card to flip, a question to answer, a line of a summary. A term can
 * go into her cards with one tap.
 */
export function StudyFeed({ courseId }: { courseId: string }) {
  const [items, setItems] = useState<FeedItem[] | null>(null);
  useEffect(() => void api<{ items: FeedItem[] }>(`/api/study/courses/${courseId}/feed`).then((r) => setItems(r.items), (e: Error) => toast(e.message)), [courseId]);
  if (!items) return <p className="muted">…</p>;
  if (!items.length) return <p className="muted">{L("הפיד מתמלא מהמונחים, הכרטיסיות, הבחנים והסיכומים של הקורס. סכמי הרצאה כדי להתחיל.", "The feed fills from the course's terms, cards, quizzes and summaries. Summarize a lecture to start.")}</p>;
  return (
    <div className="study-feed" aria-label={L("פיד לימוד", "Study feed")}>
      {items.map((it, i) => <Bite key={i} it={it} courseId={courseId} i={i} n={items.length} />)}
      <section className="study-bite end"><b>🎉 {L("זהו להיום!", "That's it for today!")}</b><span className="muted small">{L("מחר הפיד יסודר אחרת.", "Tomorrow the feed comes in another order.")}</span></section>
    </div>
  );
}

function Bite({ it, courseId, i, n }: { it: FeedItem; courseId: string; i: number; n: number }) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<number | null>(null);
  const [saved, setSaved] = useState(false);
  const tag = { term: L("מונח", "Term"), card: L("כרטיסייה", "Card"), question: L("שאלה", "Question"), line: L("מהסיכום", "From the summary") }[it.kind];
  return (
    <section className={`study-bite ${it.kind}`}>
      <span className="muted small study-bite-top">{tag}{it.lecture ? ` · ${it.lecture}` : ""} · {i + 1}/{n}</span>
      {it.kind === "term" && (
        <>
          <b className="study-bite-big" dir="auto">{it.term}</b>
          {it.en && it.en !== it.term && <span className="muted study-bite-en" dir="ltr">{it.en}</span>}
          <p dir="auto">{it.explain}</p>
          <button type="button" className="small" disabled={saved} onClick={() => void api(`/api/study/courses/${courseId}/cards`, { method: "POST", body: { front: it.term, back: it.explain } }).then(() => { setSaved(true); toast(L("נוסף לכרטיסיות", "Added to your cards")); }, (e: Error) => toast(e.message))}>{saved ? L("✓ בכרטיסיות", "✓ In your cards") : L("💾 לכרטיסיות", "💾 To my cards")}</button>
        </>
      )}
      {it.kind === "card" && (
        <button type="button" className="study-bite-flip" onClick={() => setOpen(!open)} aria-expanded={open}>
          <b className="study-bite-big" dir="auto"><RichText text={it.front} /></b>
          {open ? <span dir="auto"><RichText text={it.back} /></span> : <span className="muted small">{L("הקישי כדי להפוך", "Tap to flip")}</span>}
        </button>
      )}
      {it.kind === "question" && (
        <>
          <b dir="auto">{it.q}</b>
          {it.options.map((o, k) => <button key={k} type="button" dir="auto" className={`vl-option${pick === null ? "" : k === it.answer ? " right" : k === pick ? " wrong" : ""}`} disabled={pick !== null} onClick={() => setPick(k)}>{o}</button>)}
          {pick !== null && it.explain && <p className="muted small" dir="auto" aria-live="polite">{it.explain}</p>}
        </>
      )}
      {it.kind === "line" && <p className="study-bite-line" dir="auto">{it.text}</p>}
      {i === 0 && <span className="muted small study-bite-hint">{L("↑ לגלול למעלה לפריט הבא", "↑ Swipe up for the next one")}</span>}
    </section>
  );
}
