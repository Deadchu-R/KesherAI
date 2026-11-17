import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

interface Step { title: string; date: string; minutes: number; done?: boolean }
interface Plan { id: string; title: string; course: string; due: number; steps: Step[]; calendar?: boolean }

const TONES = ["#a5b4ff", "#7fd8a8", "#f0a830", "#e88ad8", "#6ac0d0"];
const dayName = (key: string) => {
  const today = new Date();
  const t = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  if (key === t) return L("היום", "Today");
  const d = new Date(`${key}T12:00`);
  return d.toLocaleDateString(getLocale() === "he" ? "he-IL" : "en-GB", { weekday: "long", day: "numeric", month: "numeric" });
};

/** Starts a plan for something due (used by the Moodle card's "Plan"). */
export async function planDue(title: string, course: string, due: number): Promise<void> {
  await api("/api/study/plans", { method: "POST", body: { title, course, due, lang: getLocale() === "he" ? "he" : "en" } });
  dispatchEvent(new Event("kesher-plans"));
}

/**
 * Study → my week (design DeadlinePlan): every assignment's steps by day, ticked off as they are done; a plan can be
 * planned again or put on Google Calendar. Each assignment has its own colour.
 */
export function StudyPlans() {
  const [data, setData] = useState<{ plans: Plan[]; calendar: boolean } | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ title: "", course: "", date: "" });
  const [busy, setBusy] = useState("");
  const load = () => void api<{ plans: Plan[]; calendar: boolean }>("/api/study/plans").then(setData, () => undefined);
  useEffect(() => {
    load();
    addEventListener("kesher-plans", load);
    return () => removeEventListener("kesher-plans", load);
  }, []);
  if (!data) return null;
  const run = async (what: string, fn: () => Promise<unknown>) => {
    setBusy(what);
    try { await fn(); load(); } catch (e) { toast((e as Error).message); } finally { setBusy(""); }
  };
  const days = new Map<string, Array<{ plan: Plan; step: Step; i: number; tone: string }>>();
  data.plans.forEach((plan, n) => plan.steps.forEach((step, i) => {
    const list = days.get(step.date) ?? [];
    list.push({ plan, step, i, tone: TONES[n % TONES.length]! });
    days.set(step.date, list);
  }));
  const keys = [...days.keys()].sort().slice(0, 10);
  return (
    <section className="card stack study-plans">
      <div className="row"><h2 className="grow">📅 {L("השבוע שלי", "My week")}</h2><button type="button" onClick={() => setAdding((a) => !a)}>{L("+ הגשה", "+ Assignment")}</button></div>
      {adding && (
        <form className="row wrap" onSubmit={(e) => { e.preventDefault(); void run("add", async () => { await api("/api/study/plans", { method: "POST", body: { title: form.title, course: form.course, due: new Date(`${form.date}T23:59`).getTime(), lang: getLocale() === "he" ? "he" : "en" } }); setAdding(false); setForm({ title: "", course: "", date: "" }); }); }}>
          <input className="grow" dir="auto" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder={L("מה צריך להגיש", "What is due")} aria-label={L("מה צריך להגיש", "What is due")} />
          <input dir="auto" value={form.course} onChange={(e) => setForm({ ...form, course: e.target.value })} placeholder={L("קורס", "Course")} aria-label={L("קורס", "Course")} />
          <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} aria-label={L("תאריך הגשה", "Due date")} />
          <button type="submit" className="primary" disabled={!form.title.trim() || !form.date || !!busy}>{busy === "add" ? L("מתכנן…", "Planning…") : L("תכנן", "Plan it")}</button>
        </form>
      )}
      {data.plans.length === 0 && !adding && <p className="muted small">{L("הגשה שמוסיפים (או \"תכנן\" ליד הגשה במודל) מתפרקת לשלבים לפני התאריך, בלי להעמיס יום אחד.", "An assignment you add (or \"Plan\" next to one from Moodle) is broken into steps before its date, without overloading a day.")}</p>}
      {keys.length > 0 && (
        <div className="plan-week">
          {keys.map((k) => (
            <div key={k} className="plan-day">
              <span className="muted small plan-day-name">{dayName(k)}</span>
              <div className="plan-day-items">
                {days.get(k)!.map(({ plan, step, i, tone }) => (
                  <label key={`${plan.id}-${i}`} className={`plan-step${step.done ? " done" : ""}`} style={{ borderColor: tone }}>
                    <input type="checkbox" checked={!!step.done} onChange={(e) => void run(`s${plan.id}${i}`, () => api(`/api/study/plans/${plan.id}/steps/${i}`, { method: "POST", body: { done: e.target.checked } }))} />
                    <span className="grow" dir="auto">{step.title}<span className="muted small"> · {plan.title}</span></span>
                    <span className="muted small">{step.minutes}{L(" דק׳", " min")}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {data.plans.map((p, n) => (
        <div key={p.id} className="row wrap plan-row" style={{ borderInlineStartColor: TONES[n % TONES.length] }}>
          <span className="grow" dir="auto"><b>{p.title}</b> <span className="muted small">{p.course} · {L("להגשה", "due")} {new Date(p.due).toLocaleDateString(getLocale() === "he" ? "he-IL" : "en-GB")}</span></span>
          {data.calendar && <button type="button" className="small" disabled={!!busy || p.calendar} onClick={() => void run(`c${p.id}`, () => api(`/api/study/plans/${p.id}/calendar`, { method: "POST" }))}>{p.calendar ? L("ביומן ✓", "On the calendar ✓") : L("📅 ליומן Google", "📅 To Google Calendar")}</button>}
          <button type="button" className="ghost small" disabled={!!busy} onClick={() => void run(`r${p.id}`, () => api(`/api/study/plans/${p.id}/replan`, { method: "POST" }))}>↻ {L("תכנן מחדש", "Plan again")}</button>
          <button type="button" className="ghost small" onClick={() => { if (confirm(L("למחוק את התכנון?", "Delete this plan?"))) void run(`d${p.id}`, () => api(`/api/study/plans/${p.id}`, { method: "DELETE" })); }}>✕</button>
        </div>
      ))}
    </section>
  );
}
