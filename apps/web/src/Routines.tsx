import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";
import { desktop, toast } from "./library";
import { usePersonas } from "./Personas";
import { Select } from "./ui/Select";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

type Schedule = { kind: "daily"; time: string; days?: number[] } | { kind: "every"; minutes: number } | { kind: "startup"; delayMinutes?: number } | { kind: "page"; url: string; minutes: number } | { kind: "folder"; path: string } | { kind: "download"; match?: string } | { kind: "once"; at: string };
type Action = { type: "pipeline"; pipelineId: string; inputs?: Record<string, string> } | { type: "prompt"; prompt: string; modelId?: string; personaId?: string; quiet?: boolean; web?: boolean; folder?: string; background?: boolean } | { type: "self-work"; repo?: string; goal?: string; hours: number; check?: string; modelId?: string; whenFree?: boolean } | { type: "inbox-run"; taskId: string } | { type: "inbox-pause" } | { type: "inbox-resume" } | { type: "loop"; on: boolean } | { type: "digest" };
interface Routine { id?: string; name: string; enabled: boolean; schedule: Schedule; action: Action; notify: boolean; telegram?: boolean; lastRun?: string; lastStatus?: string; lastMessage?: string; lastLink?: string; nextRun?: string | null; running?: boolean }

const DAYS: Array<[string, string]> = [["א׳", "Su"], ["ב׳", "Mo"], ["ג׳", "Tu"], ["ד׳", "We"], ["ה׳", "Th"], ["ו׳", "Fr"], ["ש׳", "Sa"]];
/** The routine's action kinds the picker offers besides a prompt and a pipeline (the work-driving ones), with their labels. */
const WORK_ACTIONS: Array<[Action["type"], string, string]> = [
  ["self-work", "עבודה עצמית (הפרויקט האחרון)", "Self-work (the last project)"],
  ["inbox-run", "הרצת משימה מתיבת המשימות", "Run an inbox task"],
  ["inbox-pause", "השהיית תיבת המשימות", "Pause the task inbox"],
  ["inbox-resume", "המשך תיבת המשימות", "Resume the task inbox"],
  ["loop", "מתג לולאת העבודה", "Work loop switch"],
  ["digest", "תקציר תיבת המשימות לקובץ (בלי מודל)", "Write the inbox digest (no model)"],
];

/** A new action of a kind, with its usual starting values. */
const newAction = (type: string, pipelines: Array<{ id?: string }>): Action =>
  type === "pipeline" ? { type: "pipeline", pipelineId: pipelines[0]?.id ?? "" }
  : type === "self-work" ? { type: "self-work", hours: 6, whenFree: true }
  : type === "inbox-run" ? { type: "inbox-run", taskId: "" }
  : type === "inbox-pause" || type === "inbox-resume" || type === "digest" ? { type }
  : type === "loop" ? { type: "loop", on: true }
  : { type: "prompt", prompt: "" };

/** The local date and time `YYYY-MM-DDTHH:mm` an hour from now (the one-time picker's start). */
const inAnHour = () => {
  const d = new Date(Date.now() + 3_600_000);
  d.setMinutes(0, 0, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}:00`;
};

const when = (iso: string) => new Date(iso).toLocaleString(getLocale() === "he" ? "he-IL" : undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });

/** Routines: pipelines and prompts that run by themselves on a schedule. */
export function RoutinesSection({ pipelines }: { pipelines: Array<{ id?: string; name: string; inputs: Array<{ name: string; label?: string }> }> }) {
  const personas = usePersonas();
  const [list, setList] = useState<Routine[]>([]);
  const [draft, setDraft] = useState<Routine | null>(null);
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  /** The inbox tasks that can still be run (for "Run an inbox task"), loaded when that action is picked. */
  const [inboxTasks, setInboxTasks] = useState<Array<{ id: string; title: string }>>([]);
  const wantsTasks = draft?.action.type === "inbox-run";
  useEffect(() => {
    if (wantsTasks) void api<{ tasks: Array<{ id: string; title: string; status: string }> }>("/api/task-inbox").then((r) => setInboxTasks(r.tasks.filter((t) => ["waiting", "failed", "partial", "deferred-quota"].includes(t.status))), () => undefined);
  }, [wantsTasks]);
  const setWork = (patch: Record<string, unknown>) => draft && setDraft({ ...draft, action: { ...draft.action, ...patch } as Action });
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
    s.kind === "once" ? L(`פעם אחת ב-${s.at.replace("T", " ")}`, `once at ${s.at.replace("T", " ")}`)
    : s.kind === "page" ? L(`כשהעמוד משתנה (בדיקה כל ${s.minutes} דק׳)`, `when the page changes (checked every ${s.minutes} min)`)
    : s.kind === "folder" ? L(`כשקבצים משתנים ב-${s.path}`, `when files change in ${s.path}`)
    : s.kind === "download" ? L(`כשהורדה מסתיימת${s.match ? ` (${s.match})` : ""}`, `when a download finishes${s.match ? ` (${s.match})` : ""}`)
    : s.kind === "startup" ? L(`בכל הפעלה (+${s.delayMinutes ?? 3} דק׳)`, `each start (+${s.delayMinutes ?? 3} min)`) : s.kind === "every" ? L(`כל ${s.minutes} דקות`, `every ${s.minutes} min`) : `${s.days?.length && s.days.length < 7 ? s.days.map((d) => L(...DAYS[d]!)).join(" ") : L("כל יום", "daily")} ${s.time}`;
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
      <p className="muted small">{L("עבודה שרצה לבד לפי לוח זמנים או כשמשהו קורה (עמוד שהשתנה, קבצים בתיקייה, הורדה שהסתיימה) — צינור או שאלה למודל — עם התראה כשהיא מסתיימת. רצה כש-KesherAI פועל (אפשר להפעיל אותו עם המחשב, בהגדרות).", "Work that runs by itself on a schedule or when something happens (a page changed, files in a folder, a download finished) — a pipeline or a question to a model — with a notification when done. Runs while KesherAI runs (it can start with the computer, in Settings).")}</p>
      {draft && (
        <form className="stack pl-inputs" onSubmit={(e) => { e.preventDefault(); void save(draft); }}>
          <label className="pl-field">{L("שם", "Name")}<input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={L("למשל: סיכום בוקר", "e.g. Morning summary")} autoFocus /></label>
          <div className="row">
            <Select value={draft.schedule.kind} onChange={(e) => {
              const k = e.target.value;
              setDraft({ ...draft, schedule: k === "every" ? { kind: "every", minutes: 60 } : k === "startup" ? { kind: "startup", delayMinutes: 3 } : k === "page" ? { kind: "page", url: "", minutes: 60 } : k === "folder" ? { kind: "folder", path: "" } : k === "download" ? { kind: "download" } : k === "once" ? { kind: "once", at: inAnHour() } : { kind: "daily", time: "08:00", days: [0, 1, 2, 3, 4] } });
            }}>
              <option value="daily">{L("בשעה קבועה", "At a time")}</option>
              <option value="every">{L("כל כמה דקות", "Every few minutes")}</option>
              <option value="startup">{L("בכל הפעלה של KesherAI", "Each time KesherAI starts")}</option>
              <option value="page">{L("כשעמוד אינטרנט משתנה", "When a web page changes")}</option>
              <option value="folder">{L("כשקבצים משתנים בתיקייה", "When files change in a folder")}</option>
              <option value="download">{L("כשהורדה מסתיימת", "When a download finishes")}</option>
              <option value="once">{L("פעם אחת, בתאריך ושעה", "Once, at a date and time")}</option>
            </Select>
            {draft.schedule.kind === "once" ? (
              <input type="datetime-local" className="grow" value={draft.schedule.at} onChange={(e) => setDraft({ ...draft, schedule: { kind: "once", at: e.target.value } })} aria-label={L("תאריך ושעה", "Date and time")} title={L("אחרי הריצה השגרה מכבה את עצמה; אם KesherAI היה סגור, היא רצה זמן קצר אחרי ההפעלה", "It turns itself off after it ran; if KesherAI was closed, it runs soon after the next start")} />
            ) : draft.schedule.kind === "page" ? (
              <>
                <input className="grow" type="url" dir="ltr" placeholder="https://…" value={draft.schedule.url} onChange={(e) => setDraft({ ...draft, schedule: { ...(draft.schedule as Extract<Schedule, { kind: "page" }>), url: e.target.value } })} aria-label={L("כתובת העמוד", "The page's address")} />
                <label className="row">{L("בדיקה כל", "Check every")}<input type="number" min={15} value={draft.schedule.minutes} onChange={(e) => setDraft({ ...draft, schedule: { ...(draft.schedule as Extract<Schedule, { kind: "page" }>), minutes: Number(e.target.value) } })} style={{ width: 80 }} />{L("דקות", "minutes")}</label>
              </>
            ) : draft.schedule.kind === "folder" ? (
              <>
                <input className="grow" dir="ltr" placeholder={L("נתיב תיקייה במחשב", "A folder on this computer")} value={draft.schedule.path} onChange={(e) => setDraft({ ...draft, schedule: { kind: "folder", path: e.target.value } })} aria-label={L("התיקייה", "The folder")} />
                {desktop()?.pickFolder && <button type="button" onClick={() => void desktop()!.pickFolder().then((f) => f && setDraft({ ...draft, schedule: { kind: "folder", path: f } }))}>{L("בחירה…", "Choose…")}</button>}
              </>
            ) : draft.schedule.kind === "download" ? (
              <input className="grow" dir="auto" placeholder={L("רק כשהשם מכיל… (לא חובה, למשל gguf)", "Only when the name has… (optional, e.g. gguf)")} value={draft.schedule.match ?? ""} onChange={(e) => setDraft({ ...draft, schedule: e.target.value ? { kind: "download", match: e.target.value } : { kind: "download" } })} />
            ) : draft.schedule.kind === "startup" ? (
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
              <label className="row">{L("כל", "Every")}<input type="number" min={5} value={(draft.schedule as Extract<Schedule, { kind: "every" }>).minutes} onChange={(e) => setDraft({ ...draft, schedule: { kind: "every", minutes: Number(e.target.value) } })} style={{ width: 90 }} />{L("דקות", "minutes")}</label>
            )}
          </div>
          <div className="row">
            <Select value={draft.action.type} onChange={(e) => setDraft({ ...draft, action: newAction(e.target.value, pipelines) })}>
              <option value="prompt">{L("שאלה למודל (שיחה חדשה כל פעם)", "Ask a model (a new chat each time)")}</option>
              <option value="pipeline" disabled={!pipelines.length}>{L("הרצת צינור", "Run a pipeline")}</option>
              {WORK_ACTIONS.map(([v, he, en]) => <option key={v} value={v}>{L(he, en)}</option>)}
            </Select>
            {draft.action.type === "prompt" && personas.length > 0 && (
              <Select value={draft.action.personaId ?? ""} onChange={(e) => setDraft({ ...draft, action: { ...(draft.action as Extract<Action, { type: "prompt" }>), ...(e.target.value ? { personaId: e.target.value } : { personaId: undefined }) } })}>
                <option value="">{L("ללא פרסונה", "No persona")}</option>
                {personas.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            )}
            {draft.action.type === "prompt" && models.length > 0 && (
              <Select value={draft.action.modelId ?? ""} onChange={(e) => setPrompt({ modelId: e.target.value || undefined })} aria-label={L("מודל", "Model")} title={L("למשימה פשוטה מספיק מודל קטן ומהיר", "A small, fast model is enough for simple work")}>
                <option value="">{L("מודל הצ'אט הפעיל", "Active chat model")}</option>
                {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </Select>
            )}
            {draft.action.type === "pipeline" && (
              <Select value={draft.action.pipelineId} onChange={(e) => setDraft({ ...draft, action: { type: "pipeline", pipelineId: e.target.value } })}>
                {pipelines.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            )}
          </div>
          {draft.action.type === "self-work" && (
            <>
              <div className="row">
                <label className="row">{L("שעות", "Hours")}<input type="number" min={0.25} max={24} step={0.25} value={draft.action.hours} onChange={(e) => setWork({ hours: Number(e.target.value) })} style={{ width: 80 }} /></label>
                {models.length > 0 && (
                  <Select value={draft.action.modelId ?? ""} onChange={(e) => setWork({ modelId: e.target.value || undefined })} aria-label={L("מודל", "Model")}>
                    <option value="">{L("המודל הטוב ביותר לקוד", "Best coding model")}</option>
                    {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </Select>
                )}
              </div>
              <textarea rows={2} dir="auto" value={draft.action.goal ?? ""} placeholder={L("מה לעשות (לא חובה; ריק = משימות פתוחות ברשימת העבודה)", "What to do (optional; empty = the open tasks of the work list)")} onChange={(e) => setWork({ goal: e.target.value || undefined })} />
              <label className="check"><input type="checkbox" checked={!!draft.action.whenFree} onChange={(e) => setWork({ whenFree: e.target.checked })} /> {L("רק כשהמחשב פנוי (אין צ'אט, טעינת מודל או משחק; מחכה עד 4 שעות)", "Only when the computer is free (no chat, model load or game; waits up to 4 hours)")}</label>
              <p className="muted small">{L("הפרויקט ופקודת הבדיקה הם של הריצה האחרונה שהתחלת בדף הקוד במחשב.", "The project and check are the last run you started on the Code page on the computer.")}</p>
            </>
          )}
          {draft.action.type === "inbox-run" && (() => {
            const taskId = draft.action.taskId;
            return (
            <>
              <Select value={taskId} onChange={(e) => setWork({ taskId: e.target.value })} aria-label={L("משימה", "Task")}>
                <option value="">{L("בחר משימה…", "Choose a task…")}</option>
                {draft.action.taskId && !inboxTasks.some((t) => t.id === taskId) && <option value={draft.action.taskId}>{draft.action.taskId}</option>}
                {inboxTasks.map((t) => <option key={t.id} value={t.id}>{t.id} · {t.title.slice(0, 60)}</option>)}
              </Select>
              <p className="muted small">{L("משימת Antigravity לא מתחילה מעצמה: נשלחת שאלה \"להריץ ב-Antigravity?\" למחשב ולטלפון, ורק לחיצת Run שלך מתחילה אותה.", "An Antigravity task does not start by itself: the \"Run this task in Antigravity?\" ask goes to the PC and the phone, and only your Run starts it.")}</p>
            </>
            );
          })()}
          {draft.action.type === "loop" && (
            <Select value={draft.action.on ? "on" : "off"} onChange={(e) => setWork({ on: e.target.value === "on" })} aria-label={L("לולאת העבודה", "Work loop")}>
              <option value="on">{L("להפעיל את לולאת העבודה", "Turn the work loop on")}</option>
              <option value="off">{L("לכבות את לולאת העבודה", "Turn the work loop off")}</option>
            </Select>
          )}
          {draft.action.type === "digest" && <p className="muted small">{L("כותב את inbox-digest.md בתיקיית הנתונים (מה הסתיים, נכשל, חלקי וממתין לכל מבצע, ענפים, מכסות). בלי מודל.", "Writes inbox-digest.md in the data folder (what finished, failed, partly done or waits per executor, branches, quotas). No model.")}</p>}
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
      <ChatTimers />
    </section>
  );
}

/** "In 25 min" when it is within the hour, otherwise the weekday and time. */
function dueText(due: number): string {
  const min = Math.round((due - Date.now()) / 60_000);
  if (min < 1) return L("עוד רגע", "any moment");
  if (min < 60) return L(`בעוד ${min} דק׳`, `in ${min} min`);
  return when(new Date(due).toISOString());
}

/** The waiting chat timers ("remind me in an hour" in a chat), with Cancel. Hidden when there are none. */
function ChatTimers() {
  const [timers, setTimers] = useState<Array<{ id: string; convId: string; prompt: string; due: number }>>([]);
  const load = () => api<{ timers: Array<{ id: string; convId: string; prompt: string; due: number }> }>("/api/timers").then((r) => setTimers([...r.timers].sort((a, b) => a.due - b.due)), () => undefined);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, []);
  if (!timers.length) return null;
  return (
    <div className="stack">
      <h3>{L("טיימרים בצ'אטים", "Chat timers")}</h3>
      <ul className="key-list">
        {timers.map((x) => (
          <li key={x.id} className="row">
            <span className="muted small">{dueText(x.due)}</span>
            <a className="grow" href={`#/c/${x.convId}`} dir="auto">{x.prompt.length > 70 ? `${x.prompt.slice(0, 70)}…` : x.prompt}</a>
            <button type="button" onClick={() => void api(`/api/timers/${x.id}`, { method: "DELETE" }).then(load, (e: Error) => toast(e.message))}>{L("ביטול", "Cancel")}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
