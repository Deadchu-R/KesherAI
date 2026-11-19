import { useEffect, useState } from "react";
import type { InboxState } from "@kesher/shared";
import { api, isRemote } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** A list setting edited as one entry per line. */
function ListBox({ label, value, onSave }: { label: string; value: string[]; onSave: (v: string[]) => void }) {
  const [text, setText] = useState(value.join("\n"));
  const joined = value.join("\n");
  useEffect(() => {
    setText(joined);
  }, [joined]);
  const list = text.split("\n").map((x) => x.trim()).filter(Boolean);
  return (
    <label className="stack">
      <span className="small muted">{label}</span>
      <textarea dir="ltr" rows={Math.min(8, Math.max(3, list.length + 1))} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => list.join("\n") !== value.join("\n") && onSave(list)} />
    </label>
  );
}

/**
 * Settings → Task inbox (packages/core/src/inbox-runner.ts): on/off (the kill switch also stops fetching), the project
 * and its inbox branch, how often to look, the daily limit for Antigravity (default 10) and the minutes per task, the
 * model inside Antigravity (empty: Gemini's default), who does each kind of task, what KesherAI may push, the paths and
 * commands, the secrets scan, and "not while the PC is busy". Antigravity runs only on the user's Run: the automatic
 * mode stays locked. Works from the phone too, except choosing the project folder.
 */
export function TaskInboxSection() {
  const [s, setS] = useState<InboxState | null>(null);
  const [repo, setRepo] = useState("");
  const load = () =>
    void api<InboxState>("/api/task-inbox").then((x) => {
      setS(x);
      setRepo((r) => r || x.settings.repo || "");
    }, () => undefined);
  useEffect(() => {
    load();
  }, []);
  if (!s) return null;
  const c = s.settings;
  const put = (body: Record<string, unknown>) => void api<InboxState>("/api/task-inbox/settings", { method: "PUT", body }).then(setS, (e) => toast((e as Error).message));
  const num = (key: string, value: number, options: number[], suffix: string) => (
    <select value={value} onChange={(e) => put({ [key]: Number(e.target.value) })}>
      {[...new Set([...options, value])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n} {suffix}</option>)}
    </select>
  );
  const check = (key: "notWhileGame" | "notWhileEditor", he: string, en: string) => (
    <label className="row small"><input type="checkbox" checked={c[key]} onChange={(e) => put({ [key]: e.target.checked })} /> {L(he, en)}</label>
  );
  return (
    <section className="card stack tinbox tinbox-settings" id="task-inbox">
      <div className="row">
        <h2 className="grow">📥 {L("תיבת משימות", "Task inbox")}</h2>
        <label className="row small"><input type="checkbox" checked={c.enabled} onChange={(e) => put({ enabled: e.target.checked })} /> {L("פעילה", "On")}</label>
      </div>
      <p className="muted">{L(`Claude כותב משימות לענף ${c.branch}. KesherAI מושך אותן, מריץ, בודק, ומחזיר ענף לבדיקה של Claude.`, `Claude writes tasks to the ${c.branch} branch. KesherAI fetches them, runs them, checks the work, and returns a branch for Claude to review.`)}</p>

      <h3>{L("הפרויקט", "The project")}</h3>
      <label className="stack">
        <span className="small muted">{L("תיקיית הפרויקט (git, עם origin ב-GitHub)", "Project folder (git, with an origin on GitHub)")}</span>
        <div className="row">
          <input className="grow" dir="ltr" value={repo} disabled={isRemote()} onChange={(e) => setRepo(e.target.value)} aria-label={L("תיקיית הפרויקט", "Project folder")} />
          <button type="button" disabled={isRemote() || repo.trim() === (c.repo ?? "")} onClick={() => put({ repo: repo.trim() })}>{L("שמור", "Save")}</button>
        </div>
        {isRemote() && <span className="small muted">{L("את התיקייה בוחרים במחשב עצמו.", "The folder is chosen on the computer itself.")}</span>}
      </label>

      <h3>{L("התיבה", "The inbox")}</h3>
      <div className="row wrap small"><span className="grow">{L("בדיקת משימות חדשות", "Look for new tasks")}</span>{num("fetchMinutes", c.fetchMinutes, [1, 5, 10, 15, 30, 60], L("דק׳", "min"))}</div>
      <div className="row wrap small"><span className="grow">{L(`סף יומי ל-Antigravity (היום ${s.today.used})`, `Daily limit for Antigravity (today ${s.today.used})`)}</span>{num("dailyCap", c.dailyCap, [3, 5, 10, 15, 20, 30], "")}</div>
      <div className="row wrap small"><span className="grow">{L("זמן מקסימלי למשימה", "Most minutes per task")}</span>{num("maxMinutes", c.maxMinutes, [5, 10, 15, 20, 30, 45, 60], L("דק׳", "min"))}</div>
      <p className="small muted">{L('"כבה" עוצר גם את המשיכה מ-GitHub, מיד.', '"Off" also stops fetching from GitHub, at once.')}</p>

      <h3>✦ Antigravity</h3>
      <label className="row small"><input type="radio" checked readOnly /> <span><b>{L('רק כשאני לוחץ "הפעל"', "Only when I press Run")}</b><br /><span className="muted">{L("במחשב, או בתשובה לשאלה בטלפון. משימה אחת בכל לחיצה, בלי המשך אוטומטי, בלי ריצות במקביל.", "On the PC, or answering its ask on the phone. One task per tap, no automatic follow-up, no parallel runs.")}</span></span></label>
      <label className="row small locked"><input type="radio" disabled /> <span><b>{L("אוטומטי", "Automatic")}</b> 🔒<br /><span className="muted">{L("נעול: תנאי השימוש של Google לא מתירים זאת בתוכנית אישית. לעבודה בלי השגחה: מפתח API של AI Studio, או Jules (בהמשך).", "Locked: Google's terms do not allow it on a personal plan. For unattended work: an AI Studio API key, or Jules (later).")}</span></span></label>
      <label className="row wrap small">
        <span className="grow">{L("מודל (ריק: ברירת המחדל של Gemini)", "Model (empty: Gemini's default)")}</span>
        <input dir="ltr" defaultValue={c.model} placeholder="Gemini" maxLength={80} onBlur={(e) => e.target.value.trim() !== c.model && put({ model: e.target.value.trim() })} aria-label={L("מודל", "Model")} />
      </label>

      <h3>{L("מבצע לכל סוג משימה", "Who does each kind of task")}</h3>
      <div className="small stack">
        <span><span className="tinbox-ex local">{L("◆ מודל מקומי", "◆ Local model")}</span> {L("עבודה עצמית לוקחת אותן מלוח המשימות כשהמחשב פנוי.", "Self-work takes them from the task board when the PC is free.")}</span>
        <span><span className="tinbox-ex agy">✦ Antigravity</span> {L('רק ב"הפעל".', "Only on Run.")}</span>
        <span><span className="tinbox-ex opus">{L("✷ סוכן Opus", "✷ Opus agent")}</span> {L("של Claude, לא רץ במחשב. Claude מחליט.", "Claude's own, not on this PC. Claude decides.")}</span>
        <span className="locked"><span className="tinbox-ex">Jules</span> {L("בהמשך (API רשמי של Google לעבודה בלי השגחה).", "Later (Google's official API for unattended work).")}</span>
      </div>

      <h3>Git</h3>
      <p className="small">{L(`KesherAI דוחף רק ענפי agy/* ואת ${c.branch}.`, `KesherAI pushes only agy/* branches and ${c.branch}.`)}</p>
      <p className="small">✕ {L("אף פעם לא: main, תגיות, מחיקת ענפים, force push.", "Never: main, tags, deleting branches, force push.")}</p>
      <p className="small">✕ {L("לסוכן עצמו אין הרשאת push: רק KesherAI, אחרי הבדיקות.", "The agent itself cannot push: only KesherAI, after its checks.")}</p>

      <h3>{L("נתיבים ופקודות", "Paths and commands")}</h3>
      <ListBox label={L("מותר (שורה לכל נתיב)", "Allowed (one path per line)")} value={c.allowedPaths} onSave={(v) => put({ allowedPaths: v })} />
      <ListBox label={L("אסור", "Forbidden")} value={c.forbiddenPaths} onSave={(v) => put({ forbiddenPaths: v })} />
      <ListBox label={L("פקודות שהסוכן מריץ בלי לשאול (והיחידות ש-KesherAI מריץ כבדיקה)", "Commands the agent runs without asking (and the only ones KesherAI runs as a check)")} value={c.commands} onSave={(v) => put({ commands: v })} />
      <label className="row small"><input type="checkbox" checked disabled /> {L("סריקת סודות ופרטיות לפני כל קומיט (תמיד)", "Secrets and privacy scan before every commit (always)")}</label>

      <h3>{L("לא כשהמחשב עסוק", "Not while the PC is busy")}</h3>
      {check("notWhileGame", `לא בזמן משחק${s.busy.games ? ` (מזהה ${s.busy.games} משחקים מותקנים)` : ""}`, `Not while a game runs${s.busy.games ? ` (${s.busy.games} installed games found)` : ""}`)}
      {check("notWhileEditor", "לא כש-Unreal, Unity, Godot או Blender פתוחים", "Not while Unreal, Unity, Godot or Blender is open")}
      <label className="row small">
        <input type="checkbox" checked={c.gpuBusyPercent > 0} onChange={(e) => put({ gpuBusyPercent: e.target.checked ? 40 : 0 })} />
        {L("לא כשכרטיס המסך מעל", "Not while the graphics card is above")} {c.gpuBusyPercent > 0 ? num("gpuBusyPercent", c.gpuBusyPercent, [20, 30, 40, 50, 60, 80], "%") : "40%"} {L("במשך 2 דק׳", "for 2 min")}
      </label>
      <p className={`small ${s.busy.free ? "" : "tinbox-err"}`}>● {s.busy.free ? L("עכשיו: פנוי.", "Now: free.") : L("עכשיו: עסוק.", "Now: busy.")} {s.busy.reasons.join(", ")}{s.busy.gpu !== undefined ? ` GPU ${s.busy.gpu}%` : ""}</p>
    </section>
  );
}
