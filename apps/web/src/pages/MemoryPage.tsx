import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Profile { notes: string[]; learn: boolean; updatedAt?: string }

/**
 * What KesherAI remembers about you: every note the models get in each
 * chat, which you can add, change or remove, and turn off.
 */
export function MemoryPage() {
  const [p, setP] = useState<Profile | null>(null);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState<{ i: number; text: string } | null>(null);
  const load = () => void api<Profile>("/api/coach/profile").then(setP, () => undefined);
  useEffect(load, []);
  if (!p) return null;
  const add = async () => {
    const v = text.trim();
    if (!v) return;
    setP({ ...p, ...(await api<Profile>("/api/coach/profile", { method: "POST", body: { text: v } })) });
    setText("");
  };
  return (
    <div className="page">
      <h1>{L("זיכרון", "Memory")}</h1>
      <p className="muted">{L("מה ש-KesherAI זוכר עליך. המודלים מקבלים את זה בכל צ'אט כדי לענות לך טוב יותר. זה נשמר רק במחשב הזה, ואתה רואה ומשנה כל מילה. בצ'אט אפשר גם להגיד \"תזכור ש…\" או \"תשכח ש…\".", "What KesherAI remembers about you. The models get it in every chat so they answer you better. It stays on this computer, and you see and change every word. In a chat you can also say \"remember that…\" or \"forget that…\".")}</p>
      <section className="card stack">
        <label className="check">
          <input type="checkbox" checked={p.learn} onChange={(e) => void api("/api/coach/settings", { method: "PUT", body: { learn: e.target.checked } }).then(load)} />
          {L("להשתמש בזיכרון וללמוד ממנו", "Use memory, and learn from how I work")}
        </label>
        <form className="row" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <input className="grow" value={text} onChange={(e) => setText(e.target.value)} placeholder={L("למשל: אני מפתח משחקים ב-Unreal", "e.g. I make games in Unreal")} aria-label={L("משהו לזכור", "Something to remember")} dir="auto" />
          <button type="submit" className="primary" disabled={!text.trim()}>{L("הוסף", "Add")}</button>
        </form>
        {p.notes.length === 0 ? (
          <p className="muted">{L("עוד אין כלום בזיכרון.", "Nothing in memory yet.")}</p>
        ) : (
          <ul className="memory-list">
            {p.notes.map((n, i) => (
              <li key={`${i}-${n}`} className="row">
                {editing?.i === i ? (
                  <form className="row grow" onSubmit={(e) => { e.preventDefault(); void api<Profile>(`/api/coach/profile/${i}`, { method: "PUT", body: { text: editing.text } }).then((r) => { setP({ ...p, ...r }); setEditing(null); }); }}>
                    <input className="grow" autoFocus value={editing.text} onChange={(e) => setEditing({ i, text: e.target.value })} dir="auto" />
                    <button type="submit" className="primary">{L("שמור", "Save")}</button>
                    <button type="button" onClick={() => setEditing(null)}>{L("ביטול", "Cancel")}</button>
                  </form>
                ) : (
                  <>
                    <span className="grow" dir="auto">{n}</span>
                    <button type="button" className="link-btn" onClick={() => setEditing({ i, text: n })}>{L("ערוך", "Edit")}</button>
                    <button type="button" className="link-btn" onClick={() => void api<Profile>(`/api/coach/profile?index=${i}`, { method: "DELETE" }).then((r) => setP({ ...p, ...r }))}>{L("מחק", "Delete")}</button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {p.notes.length > 0 && <button type="button" className="as-link" style={{ alignSelf: "start" }} onClick={() => void api<Profile>("/api/coach/profile", { method: "DELETE" }).then((r) => setP({ ...p, ...r }))}>{L("מחק את כל הזיכרון", "Delete all memory")}</button>}
      </section>
    </div>
  );
}
