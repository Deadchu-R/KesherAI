import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";
import { toast } from "../library";
import { refreshPersonas } from "../Personas";
import { refreshPrompts } from "../SlashMenu";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Catalog {
  official: {
    prompts: Array<{ command: string; title: string; text: string; have: boolean }>;
    personas: Array<{ name: string; icon?: string; instructions: string; have: boolean }>;
    skills: Array<{ source: string; name: string; description: string; have: boolean }>;
  };
  community: Array<{ source: string; name: string; description: string; stars: number; url: string; author: string; have: boolean }>;
}
interface Skill { name: string; description: string; own: boolean }

/** Prompts, personas and skills from the shared library and the community, one click to add. */
export function LibraryStore({ kind }: { kind: "prompts" | "skills" }) {
  const [cat, setCat] = useState<Catalog | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [source, setSource] = useState("");
  const [warn, setWarn] = useState<string | null>(null);
  const load = () => {
    api<Catalog>("/api/library/catalog").then(setCat, (e: Error) => setError(e.message));
    api<Skill[]>("/api/skills").then(setSkills, () => undefined);
  };
  useEffect(load, []);

  const run = async (key: string, f: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await f();
      toast(done);
      load();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy("");
      setWarn(null);
    }
  };
  const installSkill = (src: string) => run(src, () => api("/api/skills/install", { method: "POST", body: { source: src } }), L("המיומנות הותקנה. המודלים יראו אותה מההודעה הבאה.", "Skill installed. Models see it from the next message."));

  if (error) return <p className="error">{error}</p>;
  if (!cat) return <p className="muted">{L("טוען…", "Loading…")}</p>;

  if (kind === "prompts") {
    return (
      <div className="stack">
        <h2>{L("פרומפטים", "Prompts")}</h2>
        <div className="store-grid">
          {cat.official.prompts.map((p) => (
            <article key={p.command} className="store-card official">
              <div className="store-card-top">
                <div className="store-card-name"><strong className="slash-cmd" dir="ltr">/{p.command}</strong><span className="muted small">{p.title}</span></div>
              </div>
              <p className="store-desc" dir="auto">{p.text.replace("{{input}}", "…").slice(0, 160)}</p>
              <div className="store-actions">
                {p.have ? <span className="muted small">✓ {L("יש לכם", "Added")}</span> : <button type="button" className="primary" disabled={!!busy} onClick={() => void run(p.command, async () => { await api("/api/prompts", { method: "POST", body: p }); await refreshPrompts(); }, L(`נוסף: /${p.command}`, `Added /${p.command}`))}>{L("הוספה", "Add")}</button>}
              </div>
            </article>
          ))}
        </div>
        <h2>{L("פרסונות", "Personas")}</h2>
        <div className="store-grid">
          {cat.official.personas.map((p) => (
            <article key={p.name} className="store-card official">
              <div className="store-card-top">
                <span className="store-avatar" aria-hidden>{p.icon ?? p.name[0]}</span>
                <div className="store-card-name"><strong>{p.name}</strong></div>
              </div>
              <p className="store-desc" dir="auto">{p.instructions.slice(0, 180)}</p>
              <div className="store-actions">
                {p.have ? <span className="muted small">✓ {L("יש לכם", "Added")}</span> : <button type="button" className="primary" disabled={!!busy} onClick={() => void run(p.name, async () => { await api("/api/personas", { method: "POST", body: p }); await refreshPersonas(); }, L(`נוספה הפרסונה ${p.name}`, `Added ${p.name}`))}>{L("הוספה", "Add")}</button>}
              </div>
            </article>
          ))}
        </div>
        <p className="muted small store-foot">{L("רוצים לשתף פרומפט או פרסונה? פתחו בקשת שינוי (Pull Request) לקובץ community/library.json במאגר של KesherAI.", "Want to share a prompt or persona? Open a pull request to community/library.json in KesherAI's repository.")} <a href="https://github.com/Deadchu-R/KesherAI/blob/main/community/library.json" target="_blank" rel="noreferrer">GitHub</a></p>
      </div>
    );
  }

  return (
    <div className="stack">
      <p className="muted">{L("מיומנויות (SKILL.md) מלמדות את המודלים איך לבצע סוג מסוים של משימה. המודל רואה את השם והתיאור, וטוען את המיומנות כשהיא מתאימה. זה אותו פורמט פתוח של Claude Code — אפשר להתקין גם מיומנויות שנכתבו בשבילו.", "Skills (SKILL.md) teach models how to do a kind of task. The model sees each name and description and loads a skill when it fits. It is the same open format as Claude Code, so skills written for it work too.")}</p>
      {skills.length > 0 && (
        <section className="card">
          <h3>{L("המיומנויות שלכם", "Your skills")}</h3>
          <ul className="key-list">
            {skills.map((k) => (
              <li key={k.name} className="row">
                <strong dir="ltr">{k.name}</strong>
                <span className="muted small grow" dir="auto">{k.description}</span>
                {k.own && <button type="button" onClick={() => void run(k.name, () => api(`/api/skills/${encodeURIComponent(k.name)}`, { method: "DELETE" }), L("המיומנות נמחקה.", "Skill deleted."))}>{L("מחיקה", "Delete")}</button>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (source.trim()) setWarn(source.trim()); }}>
        <input className="grow" dir="ltr" value={source} onChange={(e) => setSource(e.target.value)} placeholder="owner/repo/skills/name  ·  https://github.com/…" />
        <button type="submit" disabled={!source.trim() || !!busy}>{L("התקנה מ-GitHub", "Install from GitHub")}</button>
      </form>
      <h2>{L("מהספרייה של KesherAI", "From KesherAI's library")}</h2>
      <div className="store-grid">
        {cat.official.skills.map((k) => (
          <article key={k.source} className="store-card official">
            <div className="store-card-top"><div className="store-card-name"><strong dir="ltr">{k.name}</strong></div><span className="pill good">✓ {L("רשמי", "Official")}</span></div>
            <p className="store-desc">{k.description}</p>
            <div className="store-actions">{k.have ? <span className="muted small">✓ {L("מותקן", "Installed")}</span> : <button type="button" className="primary" disabled={!!busy} onClick={() => void installSkill(k.source)}>{busy === k.source ? L("מתקין…", "Installing…") : L("התקנה", "Install")}</button>}</div>
          </article>
        ))}
      </div>
      <h2>{L("מהקהילה", "From the community")}</h2>
      {cat.community.length === 0 ? (
        <p className="muted small">{L("עוד אין. כדי לפרסם מיומנות: מאגר ציבורי ב-GitHub עם SKILL.md והתגית kesherai-skill.", "None yet. To publish a skill: a public GitHub repository with a SKILL.md and the topic kesherai-skill.")}</p>
      ) : (
        <div className="store-grid">
          {cat.community.map((k) => (
            <article key={k.source} className="store-card">
              <div className="store-card-top"><div className="store-card-name"><strong dir="ltr">{k.name}</strong><span className="muted small" dir="ltr">{k.author}</span></div><span className="pill">★ {k.stars}</span></div>
              <p className="store-desc" dir="auto">{k.description}</p>
              <div className="store-actions">
                {k.have ? <span className="muted small">✓ {L("מותקן", "Installed")}</span> : <button type="button" className="primary" disabled={!!busy} onClick={() => setWarn(k.source)}>{L("התקנה", "Install")}</button>}
                <a href={k.url} target="_blank" rel="noreferrer">{L("לקוד", "View")}</a>
              </div>
            </article>
          ))}
        </div>
      )}
      {warn && (
        <div className="dialog-backdrop" role="presentation" onClick={() => setWarn(null)}>
          <div className="dialog card store-confirm" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <strong>{L("להתקין מיומנות שלא נבדקה?", "Install a skill nobody checked?")}</strong>
            <p dir="ltr" className="mono small">{warn}</p>
            <p>{L("מיומנות היא הוראות למודל. KesherAI מעתיק רק את הקבצים ולא מריץ כלום, אבל הוראות זדוניות יכולות לנסות לגרום למודל לעשות דברים שלא ביקשתם. התקינו רק ממקור שאתם סומכים עליו.", "A skill is instructions for the model. KesherAI only copies its files and runs nothing, but bad instructions could try to make the model do things you did not ask for. Install only from sources you trust.")}</p>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setWarn(null)}>{L("ביטול", "Cancel")}</button>
              <button type="button" className="primary" disabled={!!busy} onClick={() => { const s = warn; setSource(""); void installSkill(s); }}>{L("התקנה", "Install")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
