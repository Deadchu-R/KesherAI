import type { ReactNode } from "react";
import type { StudyLecture } from "@kesher/shared";
import { getLocale, he$ } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** The summary's main points: its list lines (Markdown taken off), else its first sentences; at most six. */
export function keyPoints(summary: string, max = 6): string[] {
  const plain = (s: string) => s.replace(/\*\*|__|`/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
  const bullets = summary.split("\n").map((l) => /^\s*(?:[-*•]|\d+[.)])\s+(.+)/.exec(l)?.[1]).filter((x): x is string => !!x).map(plain).filter((x) => x.length > 3);
  if (bullets.length >= 3) return bullets.slice(0, max);
  const sentences = plain(summary.replace(/^#+.*$/gm, "")).split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 10);
  return [...bullets, ...sentences].slice(0, max);
}

/**
 * A one-page sheet of a lecture (design LectureSheet, students part 27 #6, like NotebookLM's infographics): its main
 * points, its terms and its diagram on one printable page, made from the summary she already has (no model call).
 * "PDF" prints only the sheet.
 */
export function StudySheet({ lecture, diagram }: { lecture: StudyLecture; diagram?: ReactNode }) {
  if (!lecture.summary) return <p className="muted">{L("קודם מסכמים את ההרצאה, ואז יש ממנה דף סיכום.", "Summarize the lecture first; the sheet is made from the summary.")}</p>;
  const points = keyPoints(lecture.summary);
  const terms = (lecture.terms ?? []).slice(0, 8);
  const print = () => {
    document.body.classList.add("printing-sheet");
    const done = () => {
      document.body.classList.remove("printing-sheet");
      removeEventListener("afterprint", done);
    };
    addEventListener("afterprint", done);
    print_();
  };
  return (
    <div className="study-sheet-wrap">
      <div className="study-actions"><button type="button" onClick={print}>⬇ PDF / {L("הדפסה", "Print")}</button></div>
      <article className="study-sheet" dir="auto">
        <header>
          <h2>{lecture.title}</h2>
          <span className="muted small">{lecture.date}</span>
        </header>
        <section className="study-sheet-points">
          <h3>{L("עיקרי הדברים", "Main points")}</h3>
          <ol>{points.map((p, i) => <li key={i}>{p}</li>)}</ol>
        </section>
        {terms.length > 0 && (
          <section className="study-sheet-terms">
            <h3>{L("מושגים", "Terms")}</h3>
            <div>{terms.map((t) => <div key={t.term} className="study-sheet-term"><b>{t.term}</b>{t.en && t.en !== t.term ? <span dir="ltr" className="muted small"> {t.en}</span> : null}<p className="small">{t.explain}</p></div>)}</div>
          </section>
        )}
        {diagram && lecture.diagram && <section className="study-sheet-diagram"><h3>{L("התהליך", "The process")}</h3>{diagram}</section>}
      </article>
    </div>
  );
}

/** The browser's print (kept apart so the sheet's button reads as one action). */
const print_ = () => window.print();
