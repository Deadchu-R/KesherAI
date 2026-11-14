import type { AnswerSources } from "./answerSources";
import { getLocale } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/**
 * An answer's sources beside the chat (like ChatGPT's and Perplexity's Sources sidebar): the pages the model read,
 * then what it only saw in search results, and the searches it ran.
 */
export function SourcesPanel({ data, onClose }: { data: AnswerSources; onClose: () => void }) {
  const read = data.sources.filter((s) => s.read);
  const found = data.sources.filter((s) => !s.read);
  const card = (s: AnswerSources["sources"][number]) => (
    <li key={s.url} className="source-card">
      <a href={s.url} target="_blank" rel="noreferrer noopener">
        <span className="source-site" dir="ltr">{s.domain}</span>
        <span className="source-title" dir="auto">{s.title || s.url}</span>
      </a>
      {s.snippet && <p className="muted small" dir="auto">{s.snippet}</p>}
    </li>
  );
  return (
    <section className="sources-pane stack" aria-label={L("מקורות", "Sources")}>
      <div className="row">
        <strong className="grow">🔗 {L("מקורות", "Sources")}</strong>
        <button type="button" className="icon-btn" aria-label={L("סגור את המקורות", "Close the sources")} onClick={onClose}>✕</button>
      </div>
      {read.length > 0 && (
        <>
          <h3 className="small">{L(`נקראו (${read.length})`, `Read (${read.length})`)}</h3>
          <ul className="source-list">{read.map(card)}</ul>
        </>
      )}
      {found.length > 0 && (
        <>
          <h3 className="small">{L(`בתוצאות החיפוש (${found.length})`, `In the search results (${found.length})`)}</h3>
          <ul className="source-list">{found.map(card)}</ul>
        </>
      )}
      {data.queries.length > 0 && (
        <p className="muted small">
          {L("חיפושים: ", "Searches: ")}
          {data.queries.map((q, i) => (
            <span key={i} dir="auto">{i ? " · " : ""}“{q}”</span>
          ))}
        </p>
      )}
    </section>
  );
}
