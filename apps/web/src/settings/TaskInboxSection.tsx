import { useEffect, useState } from "react";
import { OPENCODE_DEFAULTS, OPENCODE_MONTHLY_REQUESTS, opencodeModelName, type InboxState } from "@kesher/shared";
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
 * Settings → Task inbox → OpenCode Go: the flat coding plan that takes S/M code tasks by itself while Antigravity is out
 * (its quota or today's cap). On/off, the model for small tasks and the one for medium and large ones (from the
 * connection's own list), its daily limit with today's count, and its plan's limit after a 429. Works from the phone.
 *
 * @param p - The inbox's state and the settings writer.
 */
function OpencodeSettings({ s, put }: { s: InboxState; put: (body: Record<string, unknown>) => void }) {
  const c = { ...OPENCODE_DEFAULTS, ...s.settings.opencode };
  const st = s.opencode;
  const models = [...new Set([...(st?.models ?? []), c.small, c.strong])];
  const set = (v: Record<string, unknown>) => put({ opencode: v });
  const pick = (key: "small" | "strong", he: string, en: string) => (
    <label className="row wrap small">
      <span className="grow">{L(he, en)}</span>
      <select dir="ltr" value={c[key]} disabled={!c.enabled} onChange={(e) => set({ [key]: e.target.value })} aria-label={L(he, en)}>
        {models.map((m) => <option key={m} value={m}>{opencodeModelName(m)}</option>)}
      </select>
    </label>
  );
  const cool = st?.cooldowns ?? {};
  const when = (ms: number) => new Date(ms).toLocaleString(getLocale() === "he" ? "he-IL" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  // Same day: just the time; later: the day too, so a weekly block is not read as today.
  const hhmm = (ms: number) => (new Date(ms).toDateString() === new Date().toDateString() ? new Date(ms).toLocaleTimeString(getLocale() === "he" ? "he-IL" : "en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }) : when(ms));
  return (
    <div className="stack tinbox-ocgo">
      <div className="row">
        <h3 className="grow">◈ OpenCode Go</h3>
        <label className="row small"><input type="checkbox" checked={c.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> {L("פעיל", "On")}</label>
      </div>
      <p className="small muted">{L("כש-Antigravity נגמר (מכסה או סף יומי), משימות קוד קטנות ובינוניות עוברות לכאן ורצות לבד. משימות גדולות נשארות ל-Claude. העבודה בענף ocgo/*, אף פעם לא ב-main, ומחכה לבדיקה של Claude.", "When Antigravity is out (quota or daily limit), small and medium code tasks come here and run by themselves. Big tasks stay with Claude. The work goes to an ocgo/* branch, never main, and waits for Claude's review.")}</p>
      {!st?.ready && <p className="small tinbox-err">{L("אין חיבור OpenCode Go עם מפתח: הוסף אותו בהגדרות › חיבורים.", "No OpenCode Go connection with a key: add it in Settings › Connections.")}</p>}
      {st?.until && <p className="small tinbox-err">⏸ {L(`הגעת למגבלה של OpenCode Go עד ${when(st.until)}`, `OpenCode Go limit reached until ${when(st.until)}`)}</p>}
      <ul className="small stack tinbox-ocmodels" dir="ltr">
        {OPENCODE_MONTHLY_REQUESTS.map((m) => (
          <li key={m.id} className="row wrap">
            <span className="grow">{m.name} <span className="muted">· ~{m.requests.toLocaleString("en-US")} {L("בקשות/חודש", "requests/month")}</span></span>
            {cool[m.id] !== undefined && <span className="tinbox-err">⏸ {L(`חסום עד ${hhmm(cool[m.id]!)}`, `blocked until ${hhmm(cool[m.id]!)}`)}</span>}
          </li>
        ))}
        {Object.entries(cool).filter(([id]) => !OPENCODE_MONTHLY_REQUESTS.some((m) => m.id === id)).map(([id, u]) => (
          <li key={id} className="row wrap"><span className="grow">{opencodeModelName(id)}</span><span className="tinbox-err">⏸ {L(`חסום עד ${hhmm(u)}`, `blocked until ${hhmm(u)}`)}</span></li>
        ))}
      </ul>
      <label className="row wrap small">
        <input type="checkbox" checked={c.useFree !== false} disabled={!c.enabled} onChange={(e) => set({ useFree: e.target.checked })} />
        <span className="grow">{L("קודם המודלים החינמיים (Beam Free): לא נספרים בסף היומי", "Free models first (Beam Free): they don't count toward the daily limit")}</span>
      </label>
      {pick("small", "מודל למשימות קטנות (S): זול ומהיר", "Model for small tasks (S): cheap and fast")}
      {pick("strong", "מודל למשימות בינוניות וגדולות (M/L): חזק", "Model for medium and large tasks (M/L): strong")}
      <label className="row wrap small">
        <span className="grow">{L(`סף יומי למודלים בתשלום (היום ${st?.used ?? 0})`, `Daily limit for paid models (today ${st?.used ?? 0})`)}</span>
        <select value={c.dailyCap} disabled={!c.enabled} onChange={(e) => set({ dailyCap: Number(e.target.value) })} aria-label={L("סף יומי ל-OpenCode Go", "OpenCode Go daily limit")}>
          {[...new Set([5, 10, 15, 20, 30, 50, c.dailyCap])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
    </div>
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
      <label className="row small">
        <input type="checkbox" checked={c.loop !== false} onChange={(e) => put({ loop: e.target.checked })} />
        <span>
          <b>{L("להשאיר את לולאת העבודה פועלת", "Keep the work loop running")}</b>
          <br />
          <span className="muted">{L("כל 5 דק׳: משימות ממחקרים ומ-docs/research/BACKLOG.md ממלאות את התורים (עד 3 בכל תור), שאלה \"להריץ את מה לחקור הבא?\" כשהרשימה ריקה (פעם ביום), עצירה עד שהמכסה מתאפסת, וסיכום לטלפון ב-21:00. משימות Antigravity ממתינות ללחיצת Run/Start שלך (הטלפון והמחשב שואלים); מחקר במפתח Gemini החינמי ומשימות OpenCode Go ומקומיות רצים מעצמם.", "Every 5 min: tasks from research reports and docs/research/BACKLOG.md fill the lines (up to 3 each), \"Run what to research next?\" when the list is empty (once a day), a pause until the quota resets, and a summary on the phone at 21:00. Antigravity tasks wait for your Run/Start tap (the phone and the PC ask); Gemini-key research and OpenCode Go/local tasks run by themselves.")}</span>
        </span>
      </label>
      <p className="small muted">{L('"כבה" עוצר גם את המשיכה מ-GitHub, מיד.', '"Off" also stops fetching from GitHub, at once.')}</p>

      <h3>✦ Antigravity</h3>
      <label className="row small"><input type="radio" checked readOnly /> <span><b>{L('רק כשאני לוחץ "הפעל"', "Only when I press Run")}</b><br /><span className="muted">{L("במחשב, או בתשובה לשאלה בטלפון. משימה אחת בכל לחיצה, בלי המשך אוטומטי, בלי ריצות במקביל.", "On the PC, or answering its ask on the phone. One task per tap, no automatic follow-up, no parallel runs.")}</span></span></label>
      <label className="row small locked"><input type="radio" disabled /> <span><b>{L("אוטומטי", "Automatic")}</b> 🔒<br /><span className="muted">{L("נעול: תנאי השימוש של Google לא מתירים זאת בתוכנית אישית. לעבודה בלי השגחה: מפתח API של AI Studio.", "Locked: Google's terms do not allow it on a personal plan. For unattended work: an AI Studio API key.")}</span></span></label>
      <label className="row wrap small">
        <span className="grow">{L("מודל (ריק: ברירת המחדל של Gemini)", "Model (empty: Gemini's default)")}</span>
        <input dir="ltr" defaultValue={c.model} placeholder="Gemini" maxLength={80} onBlur={(e) => e.target.value.trim() !== c.model && put({ model: e.target.value.trim() })} aria-label={L("מודל", "Model")} />
      </label>

      <OpencodeSettings s={s} put={put} />

      <h3>{L("מבצע לכל סוג משימה", "Who does each kind of task")}</h3>
      <div className="small stack">
        <span><span className="tinbox-ex local">{L("◆ מודל מקומי", "◆ Local model")}</span> {L("עבודה עצמית לוקחת אותן מלוח המשימות כשהמחשב פנוי.", "Self-work takes them from the task board when the PC is free.")}</span>
        <span><span className="tinbox-ex agy">✦ Antigravity</span> {L('רק ב"הפעל".', "Only on Run.")}</span>
        <span><span className="tinbox-ex ocgo">◈ OpenCode Go</span> {L("רץ לבד, משימות קוד קטנות ובינוניות כש-Antigravity נגמר.", "Runs by itself: small and medium code tasks while Antigravity is out.")}</span>
        <span><span className="tinbox-ex opus">{L("✷ סוכן Opus", "✷ Opus agent")}</span> {L("של Claude, לא רץ במחשב. Claude מחליט.", "Claude's own, not on this PC. Claude decides.")}</span>
      </div>

      <h3>Git</h3>
      <p className="small">{L(`KesherAI דוחף רק ענפי agy/* ו-ocgo/* ואת ${c.branch}.`, `KesherAI pushes only agy/* and ocgo/* branches and ${c.branch}.`)}</p>
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
