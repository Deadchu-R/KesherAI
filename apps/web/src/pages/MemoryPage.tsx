import { useEffect, useState } from "react";
import { askText } from "../ui/askText";
import { api } from "../api";
import { getLocale } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Fact { text: string; at: string; source: "you" | "auto" }
interface Topic { id: string; title: string; project?: string; facts: Fact[]; updatedAt: string }
interface Memory { topics: Topic[]; paused: boolean; auto: boolean; isolated: string[]; projects: Record<string, string> }
interface Coach { notes: string[]; learn: boolean }

/**
 * What KesherAI remembers about you, like Claude's memory: topics (general, and each project's own), filed after
 * a chat's answer or when you say "remember"; edit and delete each fact; pause; reset; a project can keep to its
 * own memory. The coach's notes on how you work stay below.
 */
export function MemoryPage() {
  const [m, setM] = useState<Memory | null>(null);
  const [coach, setCoach] = useState<Coach | null>(null);
  const [topic, setTopic] = useState("");
  const [text, setText] = useState("");
  const [where, setWhere] = useState("");
  const [editing, setEditing] = useState<{ topic: string; i: number; text: string } | null>(null);
  const [importText, setImportText] = useState<string | null>(null);
  const load = () => {
    void api<Memory>("/api/memory").then(setM, () => undefined);
    void api<Coach>("/api/coach/profile").then(setCoach, () => undefined);
  };
  useEffect(load, []);
  if (!m) return null;
  const call = async (fn: () => Promise<Memory>) => {
    try {
      setM(await fn());
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const add = () =>
    void call(async () => {
      const r = await api<Memory>("/api/memory/facts", { method: "POST", body: { topic: topic.trim() || L("עליך", "About you"), text: text.trim(), ...(where ? { project: where } : {}) } });
      setText("");
      return r;
    });
  const groups: Array<{ key: string; title: string; topics: Topic[] }> = [
    { key: "", title: L("כללי", "General"), topics: m.topics.filter((t) => !t.project) },
    ...Object.entries(m.projects)
      .map(([id, name]) => ({ key: id, title: L(`פרויקט: ${name}`, `Project: ${name}`), topics: m.topics.filter((t) => t.project === id) }))
      .filter((g) => g.topics.length),
  ];

  return (
    <div className="page memory-page">
      <h1>{L("זיכרון", "Memory")}</h1>
      <p className="muted">
        {L(
          "מה ש-KesherAI זוכר עליך, לפי נושאים. אחרי תשובה בצ'אט הוא שומר לבד דברים שאמרת על עצמך (לא ניחושים שלו), או כשאתה אומר \"תזכור ש…\". לכל פרויקט זיכרון משלו. הכול נשמר רק במחשב הזה. סיסמאות, מפתחות ומספרי כרטיס/חשבון/ת\"ז לא נשמרים אף פעם.",
          "What KesherAI remembers about you, by topic. After an answer it files what you said about yourself (not its own guesses), or when you say \"remember that…\". Each project has its own memory. It all stays on this computer. Passwords, keys and card/account/ID numbers are never kept.",
        )}
      </p>
      <section className="card stack">
        <label className="check">
          <input type="checkbox" checked={!m.paused} onChange={(e) => void call(() => api<Memory>("/api/memory/settings", { method: "PUT", body: { paused: !e.target.checked } }))} />
          {L("להשתמש בזיכרון (כבוי = מושהה: לא נקרא ולא מתמלא, מה שנשמר נשאר)", "Use memory (off = paused: not read or filled; what is kept stays)")}
        </label>
        <label className="check">
          <input type="checkbox" checked={m.auto} disabled={m.paused} onChange={(e) => void call(() => api<Memory>("/api/memory/settings", { method: "PUT", body: { auto: e.target.checked } }))} />
          {L("לשמור לבד אחרי תשובות (כבוי = רק כשאני מבקש)", "File by itself after answers (off = only when I ask)")}
        </label>
        {coach && (
          <label className="check">
            <input type="checkbox" checked={coach.learn} onChange={(e) => void api("/api/coach/settings", { method: "PUT", body: { learn: e.target.checked } }).then(load)} />
            {L("ללמוד גם איך אני עובד (המאמן)", "Also learn how I work (the coach)")}
          </label>
        )}
        <p className="muted small">{L("צ'אט בלי זיכרון: בצ'אט חדש לחצו על 👻 — הוא לא קורא ולא שומר זיכרון, ולא מופיע בחיפוש.", "A chat without memory: in a new chat press 👻 — it neither reads nor files memory, and stays out of search.")}</p>
      </section>

      <section className="card stack">
        <h2>{L("להוסיף", "Add")}</h2>
        <form className="row memory-add" onSubmit={(e) => { e.preventDefault(); if (text.trim()) add(); }}>
          <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={L("נושא (למשל עבודה)", "Topic (e.g. Work)")} aria-label={L("נושא", "Topic")} dir="auto" list="memory-topics" />
          <datalist id="memory-topics">{[...new Set(m.topics.map((t) => t.title))].map((t) => <option key={t} value={t} />)}</datalist>
          <input className="grow" value={text} onChange={(e) => setText(e.target.value)} placeholder={L("למשל: אני מפתח משחקים ב-Unreal", "e.g. I make games in Unreal")} aria-label={L("משהו לזכור", "Something to remember")} dir="auto" />
          {Object.keys(m.projects).length > 0 && (
            <select value={where} onChange={(e) => setWhere(e.target.value)} aria-label={L("איפה", "Where")}>
              <option value="">{L("כללי", "General")}</option>
              {Object.entries(m.projects).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          )}
          <button type="submit" className="primary" disabled={!text.trim()}>{L("הוסף", "Add")}</button>
        </form>
      </section>

      <section className="card stack">
        {importText === null ? (
          <button type="button" style={{ alignSelf: "start" }} onClick={() => setImportText("")}>{L("ייבוא זיכרון מעוזר אחר…", "Import memory from another assistant…")}</button>
        ) : (
          <>
            <h2>{L("ייבוא זיכרון", "Import memory")}</h2>
            <p className="muted small">{L("בקשו מ-ChatGPT או מ-Claude: \"תכתוב רשימה של כל מה שאתה זוכר עליי, שורה לכל פרט\", והדביקו כאן. שורה בצורה \"נושא: פרט\" נשמרת תחת הנושא. סיסמאות ומספרים רגישים מדולגים.", "Ask ChatGPT or Claude: \"List everything you remember about me, one fact per line\", and paste it here. A \"Topic: fact\" line keeps its topic. Passwords and sensitive numbers are skipped.")}</p>
            <textarea rows={6} value={importText} onChange={(e) => setImportText(e.target.value)} dir="auto" aria-label={L("הטקסט לייבוא", "Text to import")} />
            <div className="row">
              <button type="button" className="primary" disabled={!importText.trim()} onClick={() => void call(async () => {
                const r = await api<Memory & { added: number; skipped: number }>("/api/memory/import", { method: "POST", body: { text: importText } });
                toast(L(`יובאו ${r.added} פרטים${r.skipped ? `, ${r.skipped} דולגו` : ""}.`, `Imported ${r.added} facts${r.skipped ? `, skipped ${r.skipped}` : ""}.`));
                setImportText(null);
                return r;
              })}>{L("ייבוא", "Import")}</button>
              <button type="button" onClick={() => setImportText(null)}>{L("ביטול", "Cancel")}</button>
            </div>
          </>
        )}
      </section>

      {m.topics.length === 0 && <p className="muted">{L("עוד אין כלום בזיכרון.", "Nothing in memory yet.")}</p>}
      {groups.map((g) =>
        g.topics.length ? (
          <section key={g.key || "general"} className="stack memory-group">
            <div className="row">
              <h2 className="grow">{g.title}</h2>
              {g.key && (
                <label className="check small">
                  <input type="checkbox" checked={!m.isolated.includes(g.key)} onChange={(e) => void call(() => api<Memory>("/api/memory/settings", { method: "PUT", body: { isolate: { project: g.key, on: !e.target.checked } } }))} />
                  {L("קורא גם את הזיכרון הכללי", "Also reads the general memory")}
                </label>
              )}
            </div>
            {g.topics.map((t) => (
              <article key={t.id} className="card stack memory-topic">
                <div className="row">
                  <h3 className="grow" dir="auto">{t.title}</h3>
                  <button type="button" className="link-btn" onClick={() => void askText(L("שם הנושא:", "Topic name:"), t.title).then((v) => { if (v?.trim()) void call(() => api<Memory>(`/api/memory/topics/${t.id}`, { method: "PUT", body: { title: v } })); })}>{L("שינוי שם", "Rename")}</button>
                  <button type="button" className="link-btn" onClick={() => confirm(L(`למחוק את הנושא "${t.title}"?`, `Delete the topic "${t.title}"?`)) && void call(() => api<Memory>(`/api/memory/topics/${t.id}`, { method: "DELETE" }))}>{L("מחק נושא", "Delete topic")}</button>
                </div>
                <ul className="memory-list">
                  {t.facts.map((f, i) => (
                    <li key={`${i}-${f.text}`} className="row">
                      {editing?.topic === t.id && editing.i === i ? (
                        <form className="row grow" onSubmit={(e) => { e.preventDefault(); void call(() => api<Memory>(`/api/memory/topics/${t.id}/facts/${i}`, { method: "PUT", body: { text: editing.text } })).then(() => setEditing(null)); }}>
                          <input className="grow" autoFocus value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} dir="auto" />
                          <button type="submit" className="primary">{L("שמור", "Save")}</button>
                          <button type="button" onClick={() => setEditing(null)}>{L("ביטול", "Cancel")}</button>
                        </form>
                      ) : (
                        <>
                          <span className="grow" dir="auto">{f.text}</span>
                          <span className="muted small" title={new Date(f.at).toLocaleString()}>{f.source === "auto" ? L("נשמר לבד", "filed") : L("ממך", "from you")}</span>
                          <button type="button" className="link-btn" onClick={() => setEditing({ topic: t.id, i, text: f.text })}>{L("ערוך", "Edit")}</button>
                          <button type="button" className="link-btn" onClick={() => void call(() => api<Memory>(`/api/memory/topics/${t.id}/facts/${i}`, { method: "PUT", body: { text: "" } }))}>{L("מחק", "Delete")}</button>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </section>
        ) : null,
      )}

      {coach && coach.notes.length > 0 && (
        <section className="card stack">
          <h2>{L("איך אתה עובד (המאמן)", "How you work (the coach)")}</h2>
          <ul className="memory-list">
            {coach.notes.map((n, i) => (
              <li key={`${i}-${n}`} className="row">
                <span className="grow" dir="auto">{n}</span>
                <button type="button" className="link-btn" onClick={() => void api(`/api/coach/profile?index=${i}`, { method: "DELETE" }).then(load)}>{L("מחק", "Delete")}</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {m.topics.length > 0 && (
        <button type="button" className="as-link danger" style={{ alignSelf: "start" }} onClick={() => confirm(L("למחוק את כל הזיכרון, כולל של הפרויקטים? אי אפשר לבטל את זה.", "Delete all memory, projects' too? This cannot be undone.")) && void call(() => api<Memory>("/api/memory/reset", { method: "POST" }))}>
          {L("איפוס: מחק את כל הזיכרון", "Reset: delete all memory")}
        </button>
      )}
    </div>
  );
}
