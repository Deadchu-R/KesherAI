import { useEffect, useState } from "react";
import { api, isRemote } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

interface Course { id: string; name: string }
interface Due { id: string; name: string; course: string; due: number; url?: string }
interface State { base: string | null; map: Record<string, string>; cached: { at: number; courses: Course[]; due: Due[] } | null; pane: boolean }

/** Days until a time, as words and a colour (orange: by tomorrow, purple: this week, green: later). */
function when(due: number): { text: string; tone: string } {
  const days = Math.ceil((due - Date.now()) / 86_400_000);
  if (days <= 0) return { text: L("היום", "Today"), tone: "#f07a5a" };
  if (days === 1) return { text: L("מחר", "Tomorrow"), tone: "#f0a830" };
  return { text: L(`בעוד ${days} ימים`, `In ${days} days`), tone: days <= 7 ? "#a5b4ff" : "#7fd8a8" };
}

/**
 * Study → Moodle (design MoodleStudy): her Moodle's courses and what is due, read with her own sign-in in KesherAI's
 * browser; a course's lecture files come in as lectures of the Study course she chose. Read only.
 */
export function MoodleCard({ courses, onAdded }: { courses: Array<{ id: string; name: string }>; onAdded: () => void }) {
  const [st, setSt] = useState<State | null>(null);
  const [addr, setAddr] = useState("");
  const [busy, setBusy] = useState("");
  const load = () => void api<State>("/api/moodle").then(setSt, () => undefined);
  useEffect(load, []);
  if (!st) return null;
  const run = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    try { await fn(); } catch (e) {
      const err = e as { code?: string; message: string };
      toast(err.code === "moodle-signin" ? L("צריך להיכנס למודל בדפדפן של קשר. לחץ \"כניסה\".", "Sign in to Moodle in KesherAI's browser first: press Sign in.") : err.message);
    } finally { setBusy(""); }
  };
  const refresh = () => run("refresh", async () => { await api("/api/moodle/refresh", { method: "POST" }); load(); });
  if (!st.base) {
    return (
      <section className="card stack moodle-card">
        <div className="row"><span className="moodle-logo" aria-hidden>M</span><h2 className="grow">{L("Moodle של האוניברסיטה", "Your university's Moodle")}</h2></div>
        <p className="muted small">{L("הקורסים, קבצי ההרצאות ומה שצריך להגיש נכנסים לקשר לבד. רק קריאה: קשר לא מגיש ולא משנה כלום במודל.", "Courses, lecture files and what is due come into KesherAI by themselves. Read only: KesherAI never submits or changes anything in Moodle.")}</p>
        <form className="row" onSubmit={(e) => { e.preventDefault(); void run("site", async () => { await api("/api/moodle/site", { method: "POST", body: { base: addr } }); load(); }); }}>
          <input className="grow" dir="ltr" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="moodle.university.ac.il" aria-label={L("כתובת המודל", "Moodle address")} />
          <button type="submit" className="primary" disabled={!addr.trim() || !!busy}>{L("חבר", "Connect")}</button>
        </form>
      </section>
    );
  }
  const c = st.cached;
  return (
    <section className="card stack moodle-card">
      <div className="row wrap">
        <span className="moodle-logo" aria-hidden>M</span>
        <div className="grow"><b dir="ltr">Moodle · {st.base.replace(/^https:\/\//, "")}</b><div className="muted small">{c ? L(`עודכן ${new Date(c.at).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}`, `Updated ${new Date(c.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`) : L("עוד לא נקרא", "Not read yet")}</div></div>
        {!isRemote() && st.pane && <button type="button" onClick={() => void run("signin", async () => { await api("/api/moodle/signin", { method: "POST" }); toast(L("המודל נפתח בדפדפן של קשר. היכנס שם, ואז לחץ ↻.", "Moodle opened in KesherAI's browser. Sign in there, then press ↻.")); })}>{L("כניסה", "Sign in")}</button>}
        <button type="button" disabled={!!busy} onClick={() => void refresh()} aria-label={L("עדכן עכשיו", "Refresh now")}>{busy === "refresh" ? "…" : "↻"}</button>
        <button type="button" className="ghost small" onClick={() => { if (confirm(L("לנתק את המודל מקשר?", "Disconnect Moodle from KesherAI?"))) void api("/api/moodle/site", { method: "POST", body: { base: null } }).then(load); }}>{L("נתק", "Disconnect")}</button>
      </div>
      {!st.pane && <p className="muted small">{L("המודל נקרא דרך הדפדפן של קשר באפליקציה במחשב. מהטלפון רואים את מה שנקרא שם.", "Moodle is read through KesherAI's browser in the desktop app. The phone sees what was read there.")}</p>}
      {c && (
        <div className="moodle-cols">
          <div className="stack">
            <b>{L("הקורסים שלך במודל", "Your Moodle courses")}</b>
            {c.courses.length === 0 && <span className="muted small">{L("לא נמצאו קורסים פעילים.", "No current courses found.")}</span>}
            {c.courses.map((mc) => {
              const to = st.map[mc.id];
              return (
                <div key={mc.id} className="moodle-course">
                  <span className="grow" dir="auto">{mc.name}</span>
                  <select value={to ?? ""} onChange={(e) => void run(`map${mc.id}`, async () => { await api("/api/moodle/map", { method: "POST", body: { course: mc.id, to: e.target.value || null } }); load(); if (e.target.value === "new") onAdded(); })} aria-label={L("לאיזה קורס בקשר", "Which KesherAI course")}>
                    <option value="">{L("לא נכנס", "Not brought in")}</option>
                    {courses.map((k) => <option key={k.id} value={k.id}>→ {k.name}</option>)}
                    <option value="new">{L("→ קורס חדש בשם הזה", "→ A new course with this name")}</option>
                  </select>
                  {to && <button type="button" className="primary small" disabled={!!busy} onClick={() => void run(`imp${mc.id}`, async () => {
                    const r = await api<{ added: string[]; skipped: string[] }>(`/api/moodle/courses/${mc.id}/import`, { method: "POST" });
                    toast(r.added.length ? L(`נוספו ${r.added.length} הרצאות`, `${r.added.length} lectures added`) : L("אין קבצים חדשים", "No new files"));
                    if (r.added.length) onAdded();
                  })}>{busy === `imp${mc.id}` ? "…" : L("הבא קבצים חדשים", "Bring new files")}</button>}
                </div>
              );
            })}
          </div>
          <div className="stack">
            <b>{L("מה צריך להגיש", "What is due")}</b>
            {c.due.length === 0 && <span className="muted small">{L("אין הגשות קרובות.", "Nothing due soon.")}</span>}
            {c.due.map((d) => {
              const w = when(d.due);
              return (
                <a key={d.id} className="moodle-due" href={d.url} target="_blank" rel="noreferrer" style={{ borderInlineStartColor: w.tone }}>
                  <span className="grow"><span dir="auto">{d.name}</span><span className="muted small" dir="auto">{d.course}</span></span>
                  <span className="moodle-when" style={{ color: w.tone, borderColor: w.tone }}>{w.text}</span>
                </a>
              );
            })}
            <span className="muted small">{L("רק קריאה: קשר לא מגיש, לא מפרסם ולא משנה כלום במודל.", "Read only: KesherAI never submits, posts or changes anything in Moodle.")}</span>
          </div>
        </div>
      )}
      {!c && st.pane && <button type="button" className="primary" disabled={!!busy} onClick={() => void refresh()}>{L("קרא את המודל", "Read Moodle")}</button>}
    </section>
  );
}
