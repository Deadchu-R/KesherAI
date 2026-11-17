import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);
type Web = { nodes: Array<{ id: string; title: string }>; edges: Array<{ a: string; b: string; terms: string[] }> };

/**
 * The course as a web (design CourseWeb, students part 33 #2, like Obsidian's graph view): each lecture a point on a
 * circle, a line for every pair that shares terms (thicker with more); tapping a lecture shows what joins it to the
 * others and opens it.
 */
export function StudyWeb({ courseId }: { courseId: string }) {
  const [web, setWeb] = useState<Web | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => void api<Web>(`/api/study/courses/${courseId}/web`).then(setWeb, (e: Error) => toast(e.message)), [courseId]);
  if (!web) return <p className="muted">…</p>;
  if (web.nodes.length < 2) return <p className="muted">{L("המפה נבנית כשיש לפחות שתי הרצאות עם מונחים.", "The web appears with at least two lectures that have terms.")}</p>;
  const n = web.nodes.length;
  const size = 340;
  const r = size / 2 - 40;
  const pos = new Map(web.nodes.map((node, i) => [node.id, { x: size / 2 + r * Math.cos((2 * Math.PI * i) / n - Math.PI / 2), y: size / 2 + r * Math.sin((2 * Math.PI * i) / n - Math.PI / 2) }]));
  const deg = (id: string) => web.edges.filter((e) => e.a === id || e.b === id).length;
  const mine = sel ? web.edges.filter((e) => e.a === sel || e.b === sel) : [];
  const title = (id: string) => web.nodes.find((x) => x.id === id)?.title ?? "";
  return (
    <section className="card study-web">
      <h2>🕸 {L("הקורס כמפה", "The course as a web")}</h2>
      <p className="muted small">{L("כל נקודה היא הרצאה. קו מחבר הרצאות שמדברות על אותם מונחים, ועבה יותר כשיש יותר מונחים משותפים. הקישי על הרצאה.", "Each point is a lecture; a line joins lectures that talk about the same terms (thicker with more). Tap a lecture.")}</p>
      <svg viewBox={`0 0 ${size} ${size}`} className="study-web-svg" role="img" aria-label={L("מפת ההרצאות", "The lectures' web")}>
        {web.edges.map((e, i) => {
          const a = pos.get(e.a)!;
          const b = pos.get(e.b)!;
          const on = sel && (e.a === sel || e.b === sel);
          return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={on ? "on" : sel ? "off" : ""} strokeWidth={Math.min(6, 1 + e.terms.length)} />;
        })}
        {web.nodes.map((node, i) => {
          const p = pos.get(node.id)!;
          return (
            <g key={node.id} className={`study-web-node${sel === node.id ? " sel" : ""}`} onClick={() => setSel(sel === node.id ? null : node.id)} role="button" tabIndex={0} aria-label={node.title} onKeyDown={(ev) => { if (ev.key === "Enter") setSel(sel === node.id ? null : node.id); }}>
              <circle cx={p.x} cy={p.y} r={8 + Math.min(10, deg(node.id) * 2)} />
              <text x={p.x} y={p.y + 4} textAnchor="middle">{i + 1}</text>
            </g>
          );
        })}
      </svg>
      <ol className="study-web-list">
        {web.nodes.map((node) => <li key={node.id} className={sel === node.id ? "sel" : ""}><button type="button" className="ghost small" onClick={() => setSel(sel === node.id ? null : node.id)} dir="auto">{node.title}</button></li>)}
      </ol>
      {sel && (
        <div className="study-web-sel">
          <a className="button small primary" href={`#/study/${courseId}/l/${sel}`} dir="auto">📖 {title(sel)}</a>
          {mine.length ? mine.map((e, i) => {
            const other = e.a === sel ? e.b : e.a;
            return <p key={i} className="small" dir="auto"><a href={`#/study/${courseId}/l/${other}`}>{title(other)}</a> · {e.terms.join(", ")}</p>;
          }) : <p className="muted small">{L("להרצאה הזו אין עדיין מונחים משותפים עם אחרות.", "This lecture shares no terms with the others yet.")}</p>}
        </div>
      )}
    </section>
  );
}
