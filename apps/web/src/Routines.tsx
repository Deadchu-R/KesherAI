import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";
import { desktop, toast } from "./library";
import { usePersonas } from "./Personas";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

type Schedule = { kind: "daily"; time: string; days?: number[] } | { kind: "every"; minutes: number } | { kind: "startup"; delayMinutes?: number };
type Action = { type: "pipeline"; pipelineId: string; inputs?: Record<string, string> } | { type: "prompt"; prompt: string; modelId?: string; personaId?: string; quiet?: boolean; web?: boolean; folder?: string; background?: boolean } | { type: "self-work"; repo: string; goal: string; hours: number; check: string; modelId?: string };
interface Routine { id?: string; name: string; enabled: boolean; schedule: Schedule; action: Action; notify: boolean; telegram?: boolean; lastRun?: string; lastStatus?: string; lastMessage?: string; lastLink?: string; nextRun?: string | null; running?: boolean }

const DAYS: Array<[string, string]> = [["א׳", "Su"], ["ב׳", "Mo"], ["ג׳", "Tu"], ["ד׳", "We"], ["ה׳", "Th"], ["ו׳", "Fr"], ["ש׳", "Sa"]];
const when = (iso: string) => new Date(iso).toLocaleString(getLocale() === "he" ? "he-IL" : undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

/** Routines: pipelines and prompts that run by themselves on a schedule. */
export function RoutinesSection({ pipelines }: { pipelines: Array<{ id?: string; name: string; inputs: Array<{ name: string; label?: string }> }> }) {
  const personas = usePersonas();
  const [list, setList] = useState<Routine[]>([]);
  const [draft, setDraft] = useState<Routine | null>(null);
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    void api<{ models: Array<{ id: string; name: string; category: string }> }>("/api/models").then((r) => setModels(r.models.filter((m) => m.category === "chat")), () => undefined);
  }, []);
  const setPrompt = (patch: Partial<Extract<Action, { type: "prompt" }>>) => draft && setDraft({ ...draft, action: { ...(draft.action as Extract<Action, { type: "prompt" }>), ...patch } });
  const load = () => api<Routine[]>("/api/routines").then(setList, () => undefined);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, []);
  const save = async (r: Routine) => {
    try {
      await api("/api/routines", { method: "POST", body: r });
      setDraft(null);
      void load();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const describe = (s: Schedule) =>
    s.kind === "startup" ? L(`בכל הפעלה (+${s.delayMinutes ?? 3} דק׳)`, `each start (+${s.delayMinutes ?? 3} min)`) : s.kind === "every" ? L(`כל ${s.minutes} דקות`, `every ${s.minutes} min`) : `${s.days?.length && s.days.length < 7 ? s.days.map((d) => L(...DAYS[d]!)).join(" ") : L("כל יום", "daily")} ${s.time}`;
  return (
    <section className="card stack">
      <div className="row">
        <h2 className="grow">{L("שגרות", "Routines")}</h2>
        {!draft && <button type="button" onClick={() => setDraft({ name: "", enabled: true, notify: true, schedule: { kind: "daily", time: "08:00", days: [0, 1, 2, 3, 4] }, action: { type: "prompt", prompt: "" } })}>{L("+ שגרה", "+ Routine")}</button>}
        {!draft && (
          <button type="button" title={L("בודק מדי פעם ומודיע רק כשמשהו צריך אותך", "Checks now and then, and tells you only when something needs you")} onClick={() => setDraft({ name: L("בדיקה תקופתית", "Heartbeat"), enabled: true, notify: true, schedule: { kind: "every", minutes: 30 }, action: { type: "prompt", quiet: true, prompt: L("בדוק את המיילים שלא נקראו ואת היומן של היום. משהו דחוף, פגישה בשעה הקרובה, או מישהו שמחכה לתשובה שלי?", "Check my unread mail and today's calendar. Anything urgent, a meeting in the next hour, or someone waiting for my answer?") } })}>
            {L("💓 בדיקה תקופתית", "💓 Heartbeat")}
          </button>
        )}
      </div>
      <p className="muted small">{L("עבודה שרצה לבד לפי לוח זמנים — צינור או שאלה למודל — עם התראה כשהיא מסתיימת. רצה כש-KesherAI פועל (אפשר להפעיל אותו עם המחשב, בהגדרות).", "Work that runs by itself on a schedule — a pipeline or a question to a model — with a notification when done. Runs while KesherAI runs (it can start with the computer, in Settings).")}</p>
      {draft && (
        <form className="stack pl-inputs" onSubmit={(e) => { e.preventDefault(); void save(draft); }}>
          <label className="pl-field">{L("שם", "Name")}<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={L("למשל: סיכום בוקר", "e.g. Morning summary")} autoFocus /></label>
          <div className="row">
            <select value={draft.schedule.kind} onChange={(e) => setDraft({ ...draft, schedule: e.target.value === "every" ? { kind: "every", minutes: 60 } : e.target.value === "startup" ? { kind: "startup", delayMinutes: 3 } : { kind: "daily", time: "08:00", days: [0, 1, 2, 3, 4] } })}>
              <option value="daily">{L("בשעה קבועה", "At a time")}</option>
              <option value="every">{L("כל כמה דקות", "Every few minutes")}</option>
              <option value="startup">{L("בכל הפעלה של KesherAI", "Each time KesherAI starts")}</option>
            </select>
            {draft.schedule.kind === "startup" ? (
              <label className="row">{L("אחרי", "After")}<input type="number" min={0} max={120} value={draft.schedule.delayMinutes ?? 3} onChange={(e) => setDraft({ ...draft, schedule: { kind: "startup", delayMinutes: Number(e.target.value) } })} style={{ width: 80 }} />{L("דקות", "minutes")}</label>
            ) : draft.schedule.kind === "daily" ? (
              <>
                <input type="time" value={draft.schedule.time} onChange={(e) => setDraft({ ...draft, schedule: { ...(draft.schedule as Extract<Schedule, { kind: "daily" }>), time: e.target.value } })} />
                <div className="row rt-days">
                  {DAYS.map((d, i) => {
                    const s = draft.schedule as Extract<Schedule, { kind: "daily" }>;
                    const on = !s.days?.length || s.days.includes(i);
                    return (
                      <button key={i} type="button" className={on ? "on" : ""} aria-pressed={on} onClick={() => {
                        const cur = s.days?.length ? s.days : [0, 1, 2, 3, 4, 5, 6];
                        const next = on ? cur.filter((x) => x !== i) : [...cur, i].sort();
                        setDraft({ ...draft, schedule: { ...s, days: next.length ? next : [i] } });
                      }}>{L(...d)}</button>
                    );
                  })}
                </div>
              </>
            ) : (
              <label className="row">{L("כל", "Every")}<input type="number" min={5} value={draft.schedule.minutes} onChange={(e) => setDraft({ ...draft, schedule: { kind: "every", minutes: Number(e.target.value) } })} style={{ width: 90 }} />{L("דקות", "minutes")}</label>
            )}
          </div>
          <div className="row">
            <select value={draft.action.type} onChange={(e) => setDraft({ ...draft, action: e.target.value === "pipeline" ? { type: "pipeline", pipelineId: pipelines[0]?.id ?? "" } : { type: "prompt", prompt: "" } })}>
              <option value="prompt">{L("שאלה למודל (שיחה חדשה כל פעם)", "Ask a model (a new chat each time)")}</option>
              <option value="pipeline" disabled={!pipelines.length}>{L("הרצת צינור", "Run a pipeline")}</option>
              {draft.action.type === "self-work" && <option value="self-work">{L("עבודה עצמית (נקבעה בדף הקוד)", "Self-work (set on the code page)")}</option>}
            </select>
            {draft.action.type === "prompt" && personas.length > 0 && (
              <select value={draft.action.personaId ?? ""} onChange={(e) => setDraft({ ...draft, action: { ...(draft.action as Extract<Action, { type: "prompt" }>), ...(e.target.value ? { personaId: e.target.value } : { personaId: undefined }) } })}>
                <option value="">{L("ללא פרסונה", "No persona")}</option>
                {personas.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
            {draft.action.type === "prompt" && models.length > 0 && (
              <select value={draft.action.modelId ?? ""} onChange={(e) => setPrompt({ modelId: e.target.value || undefined })} aria-label={L("מודל", "Model")} title={L("למשימה פשוטה מספיק מודל קטן ומהיר", "A small, fast model is enough for simple work")}>
                <option value="">{L("מודל הצ'אט הפעיל", "Active chat model")}</option>
                {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            )}
            {draft.action.type === "pipeline" && (
              <select value={draft.action.pipelineId} onChange={(e) => setDraft({ ...draft, action: { type: "pipeline", pipelineId: e.target.value } })}>
                {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
          </div>
          {draft.action.type === "prompt" && <textarea rows={3} dir="auto" value={draft.action.prompt} placeholder={L("למשל: סכם את המיילים שלא נקראו ואת הפגישות של היום", "e.g. Summarize my unread mail and today's meetings")} onChange={(e) => setDraft({ ...draft, action: { ...(draft.action as Extract<Action, { type: "prompt" }>), prompt: e.target.value } })} />}
          {draft.action.type === "pipeline" && (() => {
            const a = draft.action;
            const p = pipelines.find((x) => x.id === a.pipelineId);
            return p?.inputs.map((inp) => (
              <label key={inp.name} className="pl-field">{inp.label || inp.name}<input dir="auto" value={a.inputs?.[inp.name] ?? ""} onChange={(e) => setDraft({ ...draft, action: { ...a, inputs: { ...(a.inputs ?? {}), [inp.name]: e.target.value } } })} /></label>
            ));
          })()}
          {draft.action.type === "prompt" && (
            <label className="check"><input type="checkbox" checked={!!draft.action.quiet} onChange={(e) => setDraft({ ...draft, action: { ...(draft.action as Extract<Action, { type: "prompt" }>), quiet: e.target.checked } })} /> {L("רק כשמשהו צריך אותי (בלי צ'אט ובלי התראה כשאין כלום)", "Only when something needs me (no chat and no notification when there is nothing)")}</label>
          )}
          {draft.action.type === "prompt" && (
            <>
              <label className="check"><input type="checkbox" checked={!!draft.action.web} onChange={(e) => setPrompt({ web: e.target.checked })} /> {L("מותר לחפש באינטרנט", "May search the web")}</label>
              <label className="check"><input type="checkbox" checked={!!draft.action.background} onChange={(e) => setPrompt({ background: e.target.checked })} /> {L("ברקע: מתחילה רק כשאף צ'אט לא עובד (לא מאטה אותך)", "In the background: starts only when no chat is working (never slows you)")}</label>
              <div className="row">
                <label className="pl-field grow">{L("תיקייה שהיא יכולה לכתוב בה (לא חובה)", "A folder it may write in (optional)")}<input dir="ltr" value={draft.action.folder ?? ""} onChange={(e) => setPrompt({ folder: e.target.value || undefined })} placeholder={L("למשל C:\\Users\\you\\Documents\\Research", "e.g. C:\\Users\\you\\Documents\\Research")} /></label>
                {desktop()?.pickFolder && <button type="button" onClick={() => void desktop()!.pickFolder().then((f) => f && setPrompt({ folder: f }))}>{L("בחר…", "Choose…")}</button>}
              </div>
            </>
          )}
          <label className="check"><input type="checkbox" checked={draft.notify} onChange={(e) => setDraft({ ...draft, notify: e.target.checked })} /> {L("התראה כשהיא מסתיימת (גם לטלפון, אם מוגדר)", "Notify when done (the phone too, if set up)")}</label>
          <label className="check"><input type="checkbox" checked={!!draft.telegram} onChange={(e) => setDraft({ ...draft, telegram: e.target.checked })} /> {L("לשלוח גם לטלגרם (לא מוצפן מקצה לקצה)", "Also send to Telegram (not end-to-end encrypted)")}</label>
          <div className="row"><button type="submit" className="primary">{L("שמירה", "Save")}</button><button type="button" onClick={() => setDraft(null)}>{L("ביטול", "Cancel")}</button></div>
        </form>
      )}
      {list.length > 0 && (
        <ul className="key-list">
          {list.map((r) => (
            <li key={r.id} className="row">
              <input type="checkbox" aria-label={L("פעילה", "On")} checked={r.enabled} onChange={(e) => void save({ ...r, enabled: e.target.checked })} />
              <strong>{r.name}</strong>
              <span className="muted small">{describe(r.schedule)}</span>
              <span className="muted small grow" dir="auto">
                {r.running ? L("רצה עכשיו…", "Running now…") : r.nextRun ? `${L("הבאה:", "Next:")} ${when(r.nextRun)}` : ""}
                {r.lastRun && !r.running ? ` · ${r.lastStatus === "done" ? "✓" : "⚠"} ` : ""}
                {r.lastRun && !r.running && r.lastLink ? <a href={r.lastLink}>{L("תוצאה אחרונה", "last result")}</a> : null}
              </span>
              <button type="button" disabled={r.running} onClick={() => void api(`/api/routines/${r.id}/run`, { method: "POST" }).then(() => setTimeout(() => void load(), 500))}>▶ {L("עכשיו", "Now")}</button>
              <button type="button" onClick={() => setDraft(r)}>{L("עריכה", "Edit")}</button>
              <button type="button" onClick={() => confirm(L(`למחוק את "${r.name}"?`, `Delete "${r.name}"?`)) && void api(`/api/routines/${r.id}`, { method: "DELETE" }).then(load)}>✕</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
