import { useEffect, useState } from "react";
import { CLAUDE_DEFAULTS, cleanFailoverOrder, FAILOVER_DEFAULTS, type FailoverTarget, GHOSTCLI_DEFAULTS, OPENCODE_DEFAULTS, OPENCODE_MONTHLY_REQUESTS, opencodeModelName, type InboxState } from "@kesher/shared";
import { ClaudeQuotaLine, claudeWhen } from "../ClaudeCodeCard";
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
      {(s.free ?? []).length > 0 && (
        <ul className="small stack" dir="ltr">
          {(s.free ?? []).map((f) => (
            <li key={f.id} className="row wrap">
              <span className="grow">{f.name} ({L("חינם", "free")}): {f.used}{f.limit !== undefined ? `/${f.limit}` : ""} {L("היום", "today")}</span>
              {f.until !== undefined && <span className="tinbox-err">⏸ {L(`חסום עד ${hhmm(f.until)}`, `blocked until ${hhmm(f.until)}`)}</span>}
            </li>
          ))}
        </ul>
      )}
      <label className="row wrap small">
        <input type="checkbox" checked={c.freeTrainingOk !== false} disabled={!c.enabled} onChange={(e) => set({ freeTrainingOk: e.target.checked })} />
        <span className="grow">{L("אפשר שירותים חינמיים שעשויים לאמן על הקוד שלי (נשלחות רק משימות בסיכון נמוך ולא-אבטחתיות)", "Allow free services that may train on my code (only low-risk, non-security tasks are sent)")}</span>
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
 * Settings → Task inbox → GhostCLI: the flat-rate relay as its own executor (Roee, 27.11: not part of OpenCode Go).
 * On/off, heavy tasks to it, its daily limit with today's count, the model order (tap to move a model to the front, or
 * to take it out), its models cooling down after "too many requests", and whether its last check answered. Code and
 * research tasks, never sensitive ones. Works from the phone.
 *
 * @param p - The inbox's state and the settings writer.
 */
function GhostcliSettings({ s, put }: { s: InboxState; put: (body: Record<string, unknown>) => void }) {
  const c = { ...GHOSTCLI_DEFAULTS, ...s.settings.ghostcli };
  const st = s.ghostcli;
  const set = (v: Record<string, unknown>) => put({ ghostcli: v });
  const heavy = c.takeHeavy ?? s.settings.opencode?.useRelay !== false;
  const name = (m: string) => m.replace(/^ghostcli\//, "");
  const order = c.models.length ? c.models : (st?.models ?? []);
  const rest = (st?.models ?? []).filter((m) => !order.includes(m));
  const cool = st?.cooldowns ?? {};
  const hhmm = (ms: number) => new Date(ms).toLocaleTimeString(getLocale() === "he" ? "he-IL" : "en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  return (
    <div className="stack tinbox-gcli">
      <div className="row">
        <h3 className="grow">👻 GhostCLI</h3>
        <label className="row small"><input type="checkbox" checked={c.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> {L("פעיל", "On")}</label>
      </div>
      <p className="small muted">{L("ריליי בתשלום חודשי: משימות קוד ומחקר בלי מידע רגיש רצות עליו לבד, עם הסף והמונים שלו (לא של OpenCode Go). העבודה בענף gcli/*.", "A monthly-paid relay: code and research tasks without sensitive content run on it by themselves, with its own limit and counters (not OpenCode Go's). Work goes to gcli/* branches.")}</p>
      {!st?.ready && <p className="small tinbox-err">{L("אין חיבור GhostCLI עם מפתח: הוסף אותו בהגדרות › חיבורים.", "No GhostCLI connection with a key: add it in Settings › Connections.")}</p>}
      {st?.answering !== undefined && <p className={`small ${st.answering ? "" : "tinbox-err"}`}>● {st.answering ? L("עונה", "Answering") : L("לא עונה (נבדק כל 15 דק׳)", "Not answering (checked every 15 min)")}</p>}
      {st?.until && <p className="small tinbox-err">⏸ {L(`כל המודלים חסומים עד ${hhmm(st.until)}`, `Every model is blocked until ${hhmm(st.until)}`)}</p>}
      <label className="row wrap small">
        <input type="checkbox" checked={heavy} disabled={!c.enabled} onChange={(e) => set({ takeHeavy: e.target.checked })} />
        <span className="grow">{L("משימות קוד כבדות (M/L) בלי מידע רגיש עוברות מ-OpenCode Go ל-GhostCLI כשהוא עונה", "Heavy (M/L) code tasks without sensitive content move from OpenCode Go to GhostCLI while it answers")}</span>
      </label>
      <label className="row wrap small">
        <span className="grow">{L(`סף יומי (היום ${st?.used ?? 0})`, `Daily limit (today ${st?.used ?? 0})`)}</span>
        <select value={c.dailyCap} disabled={!c.enabled} onChange={(e) => set({ dailyCap: Number(e.target.value) })} aria-label={L("סף יומי ל-GhostCLI", "GhostCLI daily limit")}>
          {[...new Set([10, 20, 30, 50, 80, 120, c.dailyCap])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <span className="small muted">{L("סדר המודלים (הקש כדי להעביר לראש הרשימה)", "Model order (tap to move to the front)")}</span>
      <ul className="small stack tinbox-ocmodels" dir="ltr">
        {[...order, ...rest].map((m, i) => (
          <li key={m} className="row wrap">
            <button type="button" className="chip-text grow" disabled={!c.enabled || i === 0} onClick={() => set({ models: [m, ...[...order, ...rest].filter((x) => x !== m)].slice(0, 10) })}>
              {i + 1}. {name(m)}
            </button>
            {cool[m] !== undefined && <span className="tinbox-err">⏸ {L(`חסום עד ${hhmm(cool[m]!)}`, `blocked until ${hhmm(cool[m]!)}`)}</span>}
          </li>
        ))}
        {!order.length && !rest.length && <li className="muted">{L("עוד לא ידוע (צריך חיבור)", "Not known yet (needs the connection)")}</li>}
      </ul>
      {c.models.length > 0 && <button type="button" className="chip-text" disabled={!c.enabled} onClick={() => set({ models: [] })}>{L("חזרה לסדר של GhostCLI", "Back to GhostCLI's own order")}</button>}
    </div>
  );
}

/**
 * Settings → Task inbox → Claude Code: Claude Code on this PC with the user's own subscription (the same limits as
 * the Claude app). On/off, a Run tap per task (default on), the daily limit with today's count, the 5-hour and weekly
 * thresholds above which no task starts until the reset, and the model. Works from the phone.
 *
 * @param p - The inbox's state and the settings writer.
 */
function ClaudeSettingsCard({ s, put }: { s: InboxState; put: (body: Record<string, unknown>) => void }) {
  const c = { ...CLAUDE_DEFAULTS, ...s.settings.claude };
  const st = s.claude;
  const set = (v: Record<string, unknown>) => put({ claude: v });
  const pick = (key: "dailyCap" | "fiveHourMax" | "weekMax", options: number[], he: string, en: string, suffix = "") => (
    <label className="row wrap small">
      <span className="grow">{L(he, en)}</span>
      <select value={c[key]} disabled={!c.enabled} onChange={(e) => set({ [key]: Number(e.target.value) })} aria-label={L(he, en)}>
        {[...new Set([...options, c[key]])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n}{suffix}</option>)}
      </select>
    </label>
  );
  return (
    <div className="stack tinbox-claude">
      <div className="row">
        <h3 className="grow">✳ Claude Code</h3>
        <label className="row small"><input type="checkbox" checked={c.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> {L("פעיל", "On")}</label>
      </div>
      <p className="small muted">{L("משימות קוד רצות ב-Claude Code במחשב, עם המנוי שלך: אותן מגבלות Max כמו אפליקציית Claude. העבודה בענף claude/*, אף פעם לא ב-main, ומחכה לבדיקה.", "Code tasks run in Claude Code on this PC with your own subscription: the same Max limits as your Claude app. The work goes to a claude/* branch, never main, and waits for review.")}</p>
      {!st?.installed && <p className="small tinbox-err">{L("Claude Code לא מותקן או לא מחובר: הגדרות › חיבורים › Claude Code.", "Claude Code is not installed or not signed in: Settings › Connections › Claude Code.")} <a href="#/connections">{L("לחיבורים", "Connections")}</a></p>}
      {st && <ClaudeQuotaLine s={st} max={{ fiveHour: c.fiveHourMax, week: c.weekMax }} />}
      {st?.blocked && <p className="small tinbox-err" dir="auto">⏸ {st.blocked.why}{st.blocked.until ? L(` (עד ${claudeWhen(st.blocked.until)})`, ` (until ${claudeWhen(st.blocked.until)})`) : ""}</p>}
      <label className="row wrap small">
        <input type="checkbox" checked={c.askRun} disabled={!c.enabled} onChange={(e) => set({ askRun: e.target.checked })} />
        <span className="grow">{L('כל משימה מחכה ללחיצה שלי על "הפעל" (מומלץ)', "Each task waits for my Run tap (recommended)")}</span>
      </label>
      {pick("dailyCap", [1, 2, 3, 5, 8, 10, 15, 20], `סף יומי (היום ${st?.used ?? 0})`, `Daily limit (today ${st?.used ?? 0})`)}
      {pick("fiveHourMax", [50, 60, 70, 80, 90, 95], "לא להתחיל משימה כשחלון 5 השעות מעל", "Start no task while the 5-hour window is above", "%")}
      {pick("weekMax", [50, 60, 70, 80, 85, 90, 95], "לא להתחיל משימה כשהחלון השבועי מעל", "Start no task while the weekly window is above", "%")}
      <label className="row wrap small">
        <span className="grow">{L("מודל (ריק: ברירת המחדל של Claude Code)", "Model (empty: Claude Code's default)")}</span>
        <input dir="ltr" defaultValue={c.model} placeholder="sonnet / opus" maxLength={80} disabled={!c.enabled} onBlur={(e) => e.target.value.trim() !== c.model && set({ model: e.target.value.trim() })} aria-label={L("מודל ל-Claude Code", "Claude Code model")} />
      </label>
    </div>
  );
}

/** Names of the fallback executors, as the chips of the Tasks page show them. */
const TARGET_NAME: Record<FailoverTarget, () => string> = {
  ghostcli: () => "👻 GhostCLI",
  opencode: () => L("◈ OpenCode Go (חינמיים קודם)", "◈ OpenCode Go (free models first)"),
  antigravity: () => L("✦ Antigravity (ממתין להפעלה שלך)", "✦ Antigravity (waits for your Run)"),
  local: () => L("◆ מודל מקומי (משימות S)", "◆ Local model (S tasks)"),
  gemini: () => L("✧ Gemini (מפתח חינמי)", "✧ Gemini (free key)"),
};

/**
 * Settings → Task inbox → When a quota runs out (quota-failover.ts): move waiting tasks to an executor with quota left
 * (on by default), also the ones picked by hand (on by default; off: the PC asks), and the fallback order per kind with
 * up/down buttons (big enough to tap on a 390 px phone; works from the phone too). Safety is fixed and shown: nothing
 * sensitive goes to a relay or a service that may train, and nothing that costs extra.
 *
 * @param p - The inbox's state and the settings writer.
 */
function FailoverSettingsCard({ s, put }: { s: InboxState; put: (body: Record<string, unknown>) => void }) {
  const f = { ...FAILOVER_DEFAULTS, ...s.settings.failover };
  const set = (v: Record<string, unknown>) => put({ failover: v });
  const order = (kind: "code" | "research") => {
    const list = cleanFailoverOrder(kind, f[kind]);
    const move = (i: number, by: -1 | 1) => {
      const next = [...list];
      [next[i], next[i + by]] = [next[i + by]!, next[i]!];
      set({ [kind]: next });
    };
    return (
      <div className="stack">
        <span className="small muted">{kind === "code" ? L("סדר למשימות קוד", "Order for code tasks") : L("סדר למשימות מחקר", "Order for research tasks")}</span>
        <ol className="small stack tinbox-fo-order" aria-label={kind === "code" ? L("סדר למשימות קוד", "Order for code tasks") : L("סדר למשימות מחקר", "Order for research tasks")}>
          {list.map((x, i) => (
            <li key={x} className="row tinbox-fo-item">
              <span className="mono">{i + 1}.</span>
              <span className="grow" dir="auto">{TARGET_NAME[x]()}</span>
              <button type="button" className="chip-text" disabled={!f.enabled || i === 0} onClick={() => move(i, -1)} aria-label={L(`העבר למעלה: ${x}`, `Move up: ${x}`)}>▲</button>
              <button type="button" className="chip-text" disabled={!f.enabled || i === list.length - 1} onClick={() => move(i, 1)} aria-label={L(`העבר למטה: ${x}`, `Move down: ${x}`)}>▼</button>
            </li>
          ))}
        </ol>
      </div>
    );
  };
  return (
    <div className="stack tinbox-failover">
      <div className="row">
        <h3 className="grow">↪ {L("כשנגמרת מכסה", "When a quota runs out")}</h3>
        <label className="row small"><input type="checkbox" role="switch" checked={f.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> {L("פעיל", "On")}</label>
      </div>
      <p className="small muted">{L("משימה שממתינה למבצע שנגמרה לו המכסה (נגמרה, הגיעה לסף, הגבלת קצב, צינון) עוברת למבצע הבא בסדר שיש לו מכסה עכשיו, ורצה שם לפי הכללים הרגילים. משימה שכבר רצה לא זזה. כשהמכסה חוזרת, משימות חדשות הולכות שוב למבצע הראשון.", "A task waiting on an executor that ran out of quota (used up, at its cap, rate-limited, cooling down) moves to the next executor in the order that has quota now, and runs there by the usual rules. A running task never moves. When the quota is back, new tasks go to the first executor again.")}</p>
      <label className="row wrap small">
        <input type="checkbox" role="switch" checked={f.moveManual} disabled={!f.enabled} onChange={(e) => set({ moveManual: e.target.checked })} />
        <span className="grow">{L("להעביר גם משימות שבחרתי להן מבצע (כבוי: המחשב שואל)", "Move my tasks too (ones I gave an executor by hand; off: the PC asks)")}</span>
      </label>
      {order("code")}
      {order("research")}
      <p className="small muted">🔒 {L("תמיד: משימה עם מידע רגיש לא עוברת לריליי או לשירות שעשוי לאמן; משימת אבטחה רק ל-Antigravity; משימת L לא עוברת ל-OpenCode Go; שום מעבר לא עולה כסף מעבר למה שכבר משולם.", "Always: a task with sensitive content never moves to a relay or a service that may train; a security task only to Antigravity; an L task never to OpenCode Go; no move ever costs more than you already pay.")}</p>
      <label className="row wrap small tinbox-handoff-set">
        <input type="checkbox" role="switch" checked={s.settings.handoff !== false} onChange={(e) => put({ handoff: e.target.checked })} />
        <span className="grow">{L("להעביר עבודה חלקית לסוכן הבא", "Hand partial work to the next agent")}</span>
      </label>
      <p className="small muted">{L("ריצה שנעצרה באמצע (או נכשלה אחרי שינויים או דוח מועיל) עוברת לסוכן הבא בסדר עם פתק: מה נעשה, מה נשאר, מה השתבש, ומאיזה ענף להמשיך. שארית קטנה למודל המקומי או ל-OpenCode Go החינמי, גדולה ל-Antigravity או GhostCLI; לא לאותו סוכן אחרי שתי עצירות ברצף.", "A run that stopped part way (or failed after changes or a useful report) goes to the next agent in the order with a note: what was done, what is left, what went wrong and the branch to continue from. A small leftover goes to the local model or free OpenCode Go, a bigger one to Antigravity or GhostCLI; never the same agent after two stops in a row.")}</p>
    </div>
  );
}

/**
 * Settings → Task inbox (packages/core/src/inbox-runner.ts): on/off (the kill switch also stops fetching), the project
 * and its inbox branch, how often to look, the daily limit for Antigravity (default 10) and the minutes per task, the
 * model inside Antigravity (empty: Gemini's default), who does each kind of task, what KesherAI may push, the paths and
 * commands, the secrets scan, "not while the PC is busy" and the quota failover. Antigravity runs only on the user's Run: the automatic
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
      <div className="row wrap small"><span className="grow">{L("לעצור כשכלום לא משתנה במשך", "Stop when nothing changes for")}</span>{num("stallMinutes", c.stallMinutes ?? 10, [3, 5, 10, 15, 20, 30, 60], L("דק׳", "min"))}</div>
      <div className="row wrap small"><span className="grow">{L("תקציב בקשות למשימה", "Request budget per task")}</span>{num("maxRequests", c.maxRequests ?? 80, [20, 40, 80, 120, 200, 400], "")}</div>
      <p className="small muted">{L(`משימה ממשיכה כל עוד יש התקדמות (קובץ ששונה או צעד חדש). תקרת בטיחות: ${Math.max(c.maxMinutes, 120)} דק׳. עצירה בלי התקדמות שומרת את העבודה כענף חלקי, והניסיון הבא ממשיך ממנו.`, `A task keeps going while it makes progress (a changed file or a new step). Safety limit: ${Math.max(c.maxMinutes, 120)} min. A stop keeps the work as a partial branch, and the next attempt continues from it.`)}</p>
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

      <GhostcliSettings s={s} put={put} />

      <ClaudeSettingsCard s={s} put={put} />

      <FailoverSettingsCard s={s} put={put} />

      <h3>{L("מבצע לכל סוג משימה", "Who does each kind of task")}</h3>
      <div className="small stack">
        <span><span className="tinbox-ex local">{L("◆ מודל מקומי", "◆ Local model")}</span> {L("עבודה עצמית לוקחת אותן מלוח המשימות כשהמחשב פנוי.", "Self-work takes them from the task board when the PC is free.")}</span>
        <span><span className="tinbox-ex agy">✦ Antigravity</span> {L('רק ב"הפעל".', "Only on Run.")}</span>
        <span><span className="tinbox-ex ocgo">◈ OpenCode Go</span> {L("רץ לבד, משימות קוד קטנות ובינוניות כש-Antigravity נגמר.", "Runs by itself: small and medium code tasks while Antigravity is out.")}</span>
        <span><span className="tinbox-ex gcli">👻 GhostCLI</span> {L("רץ לבד: קוד ומחקר בלי מידע רגיש, עם הסף שלו.", "Runs by itself: code and research without sensitive content, with its own limit.")}</span>
        <span><span className="tinbox-ex claude">✳ Claude Code</span> {L('רק משימות שנשלחו אליו, ב"הפעל" (ברירת מחדל), עם המנוי שלך.', "Only tasks sent to it, on Run (default), with your subscription.")}</span>
        <span><span className="tinbox-ex opus">{L("✷ סוכן Opus", "✷ Opus agent")}</span> {L("של Claude, לא רץ במחשב. Claude מחליט.", "Claude's own, not on this PC. Claude decides.")}</span>
      </div>

      <h3>Git</h3>
      <p className="small">{L(`KesherAI דוחף רק ענפי agy/*, ocgo/*, gcli/* ו-claude/* ואת ${c.branch}.`, `KesherAI pushes only agy/*, ocgo/*, gcli/* and claude/* branches and ${c.branch}.`)}</p>
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
