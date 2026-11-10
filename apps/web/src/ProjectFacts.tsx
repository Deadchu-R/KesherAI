import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Fact { id: string; family: string; text: string; state: "candidate" | "active" | "retired"; confirmations: number }

/**
 * What KesherAI learned about a project from its chats' commands (a form that
 * fails here and one that works, a missing tool), told to every new chat in
 * it once 3 chats showed it. Each can be removed; shown only when there is one.
 *
 * @param p.folder - The project folder.
 */
export function ProjectFacts(p: { folder: string }) {
  const [facts, setFacts] = useState<Fact[]>([]);
  useEffect(() => {
    if (!p.folder) return setFacts([]);
    void api<{ facts: Fact[] }>(`/api/project-facts?workspace=${encodeURIComponent(p.folder)}`).then((r) => setFacts(r.facts.filter((f) => f.state !== "retired")), () => setFacts([]));
  }, [p.folder]);
  if (!facts.length) return null;
  const remove = (id: string) =>
    void api("/api/project-facts/remove", { method: "POST", body: { workspace: p.folder, id } }).then(
      () => setFacts((fs) => fs.filter((f) => f.id !== id)),
      (e: Error) => toast(e.message),
    );
  return (
    <details className="card project-facts">
      <summary>{L(`מה KesherAI למד על הפרויקט (${facts.length})`, `What KesherAI learned about this project (${facts.length})`)}</summary>
      <p className="muted small">{L("נלמד מפקודות שנכשלו ותוקנו בצ'אטים קודמים. עובדה נמסרת לכל צ'אט חדש בפרויקט אחרי ש־3 צ'אטים הראו אותה.", "Learned from commands that failed and were fixed in earlier chats. A fact is told to every new chat here once 3 chats showed it.")}</p>
      <ul className="list">
        {facts.map((f) => (
          <li key={f.id} className="row">
            <span className="grow small" dir="ltr">{f.text}</span>
            <span className={`pill${f.state === "active" ? " good" : ""}`}>{f.state === "active" ? L("בשימוש", "In use") : L(`${f.confirmations}/3`, `${f.confirmations}/3`)}</span>
            <button type="button" className="as-link small" onClick={() => remove(f.id)}>{L("הסר", "Remove")}</button>
          </li>
        ))}
      </ul>
    </details>
  );
}
