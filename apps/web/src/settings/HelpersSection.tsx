/**
 * Settings > Agents (boards SettingsHelpers and HelperEdit; docs/RESEARCH_LOG.md, "Helper agents in the chat"): the
 * model per built-in sub-agent type with what Auto picks on this computer and why, steps per type, how many run at
 * once, the time cap, the once-per-project question for cloud agents, and the user's own agents (agent files in a
 * project's `.kesher/agents/`, Claude Code's format) with a form to add or change one.
 *
 * Wording (Roee, 2026-11-19): "סוכנים" / agents; the chat's model is the lead agent ("סוכן ראשי").
 */
import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { Select } from "../ui/Select";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

type Kind = "lookup" | "research" | "build";
interface Why { he: string; en: string }
interface Pick { how: "inherit" | "beside" | "swap" | "id"; why: Why; name?: string; modelId?: string }
interface Mine { name: string; description: string; source: "persona" | "project"; project?: string; projectName?: string; file?: string; model: string; icon?: string; instructions?: string; tools?: string[]; background?: boolean; maxTurns?: number; maxMinutes?: number }
interface State {
  settings: { models: Record<Kind, string>; steps: Record<Kind, number>; atOnce: number | null; minutes: number; cloudProjects: number };
  explain: { vramGiB: number; lead: string; atOnce: number; picks: Record<Kind, Pick> };
  models: string[];
  mine: Mine[];
  projects: Array<{ id: string; name: string }>;
}

const TYPES: Array<{ kind: Kind; icon: string; he: string; en: string; dhe: string; den: string }> = [
  { kind: "lookup", icon: "🔎", he: "סוכן חיפוש", en: "Lookup agent", dhe: "למצוא איפה משהו בקוד, לקרוא קבצים ולצטט. קריאה בלבד.", den: "Finds where something is in the code, reads files and quotes them. Read only." },
  { kind: "research", icon: "📚", he: "סוכן מחקר", en: "Research agent", dhe: "קריאה בקוד וברשת, סיכום עם מקורות. קריאה בלבד.", den: "Reads code and the web, sums up with sources. Read only." },
  { kind: "build", icon: "🛠️", he: "סוכן בנייה", en: "Build agent", dhe: "עורך קבצים בעותק נפרד של הפרויקט (worktree) ומחזיר שינויים לבדיקה. רק בפרויקט git.", den: "Edits files in its own copy of the project (a worktree) and returns the changes to review. Only in a git project." },
];

/** The tier names a model choice may be. */
const TIER_LABEL = (v: string) =>
  v === "auto" ? L("אוטומטי (לפי כרטיס המסך)", "Auto (by the graphics card)")
  : v === "inherit" ? L("כמו הצ׳אט", "Same as the chat")
  : v === "small" ? L("קטן", "Small")
  : v === "strong" ? L("חזק", "Strong")
  : v.split("/").pop() ?? v;

const short = (id: string) => (id.split("/").pop() ?? id).replace(/\.gguf$/i, "");

/** The section. */
export function HelpersSection() {
  const [st, setSt] = useState<State | null>(null);
  const [err, setErr] = useState("");
  const [edit, setEdit] = useState<Mine | "new" | null>(null);
  const load = () => void api<State>("/api/helpers/settings").then(setSt, (e: Error) => setErr(e.message));
  useEffect(load, []);
  if (!st) return <section className="card"><h2>🤖 {L("סוכנים", "Agents")}</h2>{err ? <p className="error small">{err}</p> : <p className="muted small">…</p>}</section>;
  const save = (body: Record<string, unknown>) => void api("/api/helpers/settings", { method: "PUT", body }).then(load, (e: Error) => setErr(e.message));
  const s = st.settings;
  const e = st.explain;
  const vram = e.vramGiB ? `${Math.round(e.vramGiB)} GB` : L("בלי כרטיס מסך", "no graphics card");
  if (edit) return <HelperEdit agent={edit === "new" ? undefined : edit} projects={st.projects} models={st.models} onDone={() => { setEdit(null); load(); }} />;
  return (
    <section className="card stack helpers-settings">
      <h2>🤖 {L("סוכנים", "Agents")}</h2>
      <p className="muted small">{L("סוכן משנה הוא מודל שמקבל משימה אחת, עובד בהקשר נקי, ומחזיר דוח קצר לצ׳אט. הסוכן הראשי (המודל של הצ׳אט) מחליט, ורק הוא מדבר איתך.", "A sub-agent is a model that gets one task, works in a clean context and brings a short report back to the chat. The lead agent (the chat's model) decides, and only it talks to you.")}</p>

      <div className="hs-sec">
        <div className="hs-head"><h3>{L("סוגים מובנים", "Built-in types")}</h3><span className="muted small">🖥 {L(`במחשב הזה: ${vram} · סוכן ראשי ${short(e.lead) || "—"}`, `On this computer: ${vram} · lead agent ${short(e.lead) || "—"}`)}</span></div>
        {TYPES.map((t) => {
          const p = e.picks[t.kind];
          const choice = s.models[t.kind];
          return (
            <div key={t.kind} className="hs-type">
              <span className="hs-icon" aria-hidden>{t.icon}</span>
              <div className="hs-what"><b>{L(t.he, t.en)}</b><div className="muted small">{L(t.dhe, t.den)}</div></div>
              <div className="hs-model">
                <Select aria-label={L(`מודל ל${t.he}`, `Model for the ${t.en.toLowerCase()}`)} value={choice} onChange={(ev) => save({ models: { [t.kind]: ev.target.value } })}>
                  {["auto", "inherit", "small", "strong"].map((v) => <option key={v} value={v}>{TIER_LABEL(v)}</option>)}
                  {[...new Set([...st.models, ...(["auto", "inherit", "small", "strong"].includes(choice) ? [] : [choice])])].map((m) => <option key={m} value={m}>{short(m)}</option>)}
                </Select>
                <span className="small hs-why">{getLocale() === "he" ? he$(p.why.he) : p.why.en}</span>
              </div>
              <label className="hs-steps small"><span className="muted">{L("צעדים", "Steps")}</span>
                <Select value={s.steps[t.kind]} onChange={(ev) => save({ steps: { [t.kind]: Number(ev.target.value) } })}>
                  {[...new Set([4, 8, 12, 20, 30, 40, 60, s.steps[t.kind]])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n}</option>)}
                </Select>
              </label>
            </div>
          );
        })}
        <p className="muted small">{L("ענן: רק כשבחרת מודל בענן כאן (עם מפתח שהגדרת). אוטומטי לא שולח לענן לעולם. סוכן חיפוש לא מחליף מודל לעולם; סוכן בנייה מחליף פעם אחת, עם הודעה, ומחזיר בסוף.", "Cloud: only when you choose a cloud model here (with a key you set). Auto never sends to the cloud. A lookup agent never swaps the model; a build agent swaps once, with a notice, and swaps back after.")}</p>
      </div>

      <div className="hs-sec">
        <h3>{L("כמה סוכנים בבת אחת", "How many at once")}</h3>
        <label className="row">
          <Select value={s.atOnce ?? 0} onChange={(ev) => save({ atOnce: Number(ev.target.value) || null })}>
            <option value={0}>{L(`אוטומטי (${e.atOnce})`, `Auto (${e.atOnce})`)}</option>
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
          </Select>
        </label>
        <span className="muted small">{L(`${e.vramGiB > 8 ? 2 : 1} מומלץ ל-${vram} (עד 8 GB: אחד בכל פעם). כל סוכן מקבל חלק מההקשר של המודל הטעון, אז השאר נכנסים לתור ("ממתין"). סוכנים בענן לא תופסים מקום בכרטיס, עד 4.`, `${e.vramGiB > 8 ? 2 : 1} is right for ${vram} (8 GB or less: one at a time). Each agent gets a share of the loaded model's context, so the rest wait in a queue. Cloud agents take no room on the card, up to 4.`)}</span>
      </div>

      <div className="hs-sec">
        <h3>{L("גבולות", "Limits")}</h3>
        <label className="row hs-line"><span className="grow">{L("זמן מקסימלי לסוכן", "Longest time for an agent")}</span>
          <Select value={s.minutes} onChange={(ev) => save({ minutes: Number(ev.target.value) })}>
            {[...new Set([3, 5, 10, 15, 20, 30, 60, s.minutes])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{L(`${n} דק׳`, `${n} min`)}</option>)}
          </Select>
        </label>
        <div className="row hs-line"><span className="grow">{L("בצעד האחרון: בלי כלים, רק לכתוב דוח", "On the last step: no tools, only the report")}</span><span className="good small">✓ {L("תמיד", "always")}</span></div>
        <div className="row hs-line"><span className="grow">{L("סוכן בענן רואה קבצים מהפרויקט", "A cloud agent sees the project's files")} <span className="muted small">{L("(רק אחרי שאלה, פעם אחת לכל פרויקט)", "(only after asking, once per project)")}</span></span>
          {s.cloudProjects > 0 && <button type="button" className="small" onClick={() => save({ forgetCloud: true })}>{L(`לשאול שוב (${s.cloudProjects} פרויקטים)`, `Ask again (${s.cloudProjects} projects)`)}</button>}
        </div>
        <span className="muted small">{L("סוכן משנה לא מפעיל סוכנים אחרים. \"עצור\" בצ׳אט עוצר גם את כל סוכני המשנה שלו.", "A sub-agent never starts other agents. Stop in the chat stops all its sub-agents too.")}</span>
      </div>

      <div className="hs-sec">
        <div className="hs-head"><h3>{L("הסוכנים שלי", "My agents")}</h3><span className="muted small">{L("כתוב @שם בצ׳אט כדי להפעיל סוכן מסוים", "Type @name in the chat to use a specific agent")}</span><span className="grow" /><button type="button" className="primary" onClick={() => setEdit("new")} disabled={!st.projects.length} title={st.projects.length ? undefined : L("צריך פרויקט עם תיקייה", "Needs a project with a folder")}>＋ {L("סוכן חדש", "New agent")}</button></div>
        {st.mine.map((m) => (
          <div key={`${m.source}:${m.project ?? ""}:${m.name}`} className="hs-mine">
            <span aria-hidden>{m.icon ?? (m.source === "persona" ? "👤" : "🧩")}</span>
            <b>@{m.name}</b>
            <span className="grow muted small hs-desc">{m.description}</span>
            {m.file && <span className="mono small muted hs-file" dir="ltr">{m.file}</span>}
            <span className="hmodel">{TIER_LABEL(m.model)}</span>
            {m.source === "project" && m.file?.startsWith(".kesher/") && <button type="button" className="small" onClick={() => setEdit(m)}>{L("ערוך", "Edit")}</button>}
          </div>
        ))}
        {!st.mine.length && <p className="muted small">{L("עוד אין. סוכן הוא קובץ ב-.kesher/agents (או .claude/agents) של פרויקט, או דמות עם \"מתי להשתמש\".", "None yet. An agent is a file in a project's .kesher/agents (or .claude/agents), or a persona with \"when to use\".")}</p>}
        <div className="hs-mine"><span aria-hidden>🛰️</span><b>@antigravity</b><span className="grow muted small">{L("Antigravity CLI כסוכן חיצוני בעותק נפרד של הפרויקט. רץ רק כשאתה כותב @antigravity בצ׳אט קוד, אף פעם לא לבד.", "Antigravity CLI as an outside agent in its own copy of the project. Runs only when you type @antigravity in a code chat, never by itself.")}</span></div>
      </div>
      {err && <p className="error small">{err}</p>}
    </section>
  );
}

/** Tools an agent may get (KesherAI's names; the file gets Claude Code's). */
const TOOLS: Array<{ id: string; he: string; en: string }> = [
  { id: "read_file", he: "קריאת קבצים בפרויקט", en: "Read the project's files" },
  { id: "search", he: "חיפוש בקוד", en: "Search the code" },
  { id: "web_search", he: "חיפוש באינטרנט", en: "Search the web" },
  { id: "web_fetch", he: "קריאת דפים מהאינטרנט", en: "Read web pages" },
  { id: "edit_file", he: "עריכת קבצים (בעותק נפרד, worktree)", en: "Edit files (in its own copy, a worktree)" },
];

/**
 * New or changed agent (board HelperEdit): name (used with @), when to use it, instructions, tools, model, background,
 * steps and time; saved as a file in the project's `.kesher/agents/`, shown as it will be written.
 *
 * @param p.agent - The agent to change, or none for a new one.
 * @param p.projects - Projects with a folder (the file goes there).
 * @param p.models - Model ids to choose from.
 * @param p.onDone - Back to the list.
 */
export function HelperEdit({ agent, projects, models, onDone }: { agent?: Mine; projects: Array<{ id: string; name: string }>; models: string[]; onDone: () => void }) {
  const [f, setF] = useState({
    project: agent?.project ?? projects[0]?.id ?? "",
    name: agent?.name ?? "",
    description: agent?.description ?? "",
    instructions: agent?.instructions ?? "",
    tools: agent?.tools?.length ? agent.tools.filter((t) => TOOLS.some((x) => x.id === t)) : ["read_file", "search"],
    model: agent?.model ?? "auto",
    background: agent?.background ?? false,
    maxTurns: agent?.maxTurns ?? 12,
    maxMinutes: agent?.maxMinutes ?? 5,
  });
  const [err, setErr] = useState("");
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const slug = (f.name || "agent").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  const file = agent?.file ?? `.kesher/agents/${slug}.md`;
  const claude: Record<string, string> = { read_file: "Read", search: "Grep", web_search: "WebSearch", web_fetch: "WebFetch", edit_file: "Edit" };
  const preview = ["---", `name: ${f.name || "…"}`, `description: ${(f.description || "…").replace(/\s+/g, " ").slice(0, 60)}${f.description.length > 60 ? "…" : ""}`, `tools: ${f.tools.map((t) => claude[t] ?? t).join(", ")}`, `model: ${f.model}`, ...(f.background ? ["background: true"] : []), `maxTurns: ${f.maxTurns}`, `maxMinutes: ${f.maxMinutes}`, "---"].join("\n");
  const save = () =>
    void api("/api/helpers/agents", { method: "POST", body: { ...f, ...(agent?.file ? { file: agent.file } : {}) } }).then(onDone, (e: Error) => setErr(e.message));
  const remove = () => void api("/api/helpers/agents", { method: "DELETE", body: { project: f.project, file: agent?.file } }).then(onDone, (e: Error) => setErr(e.message));
  return (
    <section className="card stack helper-edit">
      <h2>🎨 {agent ? L(`עריכת @${agent.name}`, `Edit @${agent.name}`) : L("סוכן חדש", "New agent")}</h2>
      <span className="muted small">{L("הגדרות › סוכנים › ", "Settings › Agents › ")}{agent ? agent.name : L("סוכן חדש", "New agent")}</span>
      <div className="he-grid">
        <div className="stack">
          <label className="stack"><span className="small">{L("שם (מופעל ב-@)", "Name (used with @)")}</span><input dir="auto" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder={L("בודק-עיצוב", "design-check")} /></label>
          <label className="stack"><span className="small">{L("מתי להשתמש בו", "When to use it")} <span className="muted">{L("(הסוכן הראשי קורא את זה כדי להחליט)", "(the lead agent reads this to decide)")}</span></span><textarea dir="auto" rows={3} value={f.description} onChange={(e) => set("description", e.target.value)} /></label>
          <label className="stack"><span className="small">{L("הוראות לסוכן", "Instructions for the agent")}</span><textarea dir="auto" rows={6} value={f.instructions} onChange={(e) => set("instructions", e.target.value)} /></label>
          <div className="stack"><b className="small">{L("כלים", "Tools")}</b>
            {TOOLS.map((t) => (
              <label key={t.id} className="row small"><input type="checkbox" checked={f.tools.includes(t.id)} onChange={(e) => set("tools", e.target.checked ? [...f.tools, t.id] : f.tools.filter((x) => x !== t.id))} />{L(t.he, t.en)}</label>
            ))}
            <span className="muted small">{L("בלי עריכת קבצים הסוכן הוא \"קריאה בלבד\". סוכן משנה אף פעם לא מפעיל סוכנים.", "Without editing files the agent is read only. A sub-agent never starts agents.")}</span>
          </div>
        </div>
        <div className="stack">
          <label className="stack"><span className="small">{L("פרויקט (הקובץ נשמר בו)", "Project (the file is saved in it)")}</span>
            <Select value={f.project} onChange={(e) => set("project", e.target.value)} disabled={!!agent}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select>
          </label>
          <label className="stack"><span className="small">{L("מודל", "Model")}</span>
            <Select value={f.model} onChange={(e) => set("model", e.target.value)}>
              {["auto", "inherit", "small", "strong"].map((v) => <option key={v} value={v}>{TIER_LABEL(v)}</option>)}
              {models.map((m) => <option key={m} value={m}>{short(m)}</option>)}
            </Select>
          </label>
          <label className="row"><input type="checkbox" checked={f.background} onChange={(e) => set("background", e.target.checked)} /><span><b className="small">{L("ברקע", "In the background")}</b><div className="muted small">{L("הצ׳אט ממשיך לעבוד, והדוח מגיע כשהסוכן מסיים", "The chat goes on, and the report comes when the agent ends")}</div></span></label>
          <label className="row small"><span className="grow">{L("צעדים מקסימום", "Most steps")}</span><Select value={f.maxTurns} onChange={(e) => set("maxTurns", Number(e.target.value))}>{[4, 8, 12, 20, 30, 40, 60].map((n) => <option key={n} value={n}>{n}</option>)}</Select></label>
          <label className="row small"><span className="grow">{L("זמן מקסימום", "Longest time")}</span><Select value={f.maxMinutes} onChange={(e) => set("maxMinutes", Number(e.target.value))}>{[3, 5, 10, 15, 20, 30].map((n) => <option key={n} value={n}>{L(`${n} דק׳`, `${n} min`)}</option>)}</Select></label>
          <div className="stack"><div className="row small"><b>{L("נשמר כקובץ", "Saved as a file")}</b><span className="grow" /><span className="mono muted" dir="ltr">{file}</span></div>
            <pre className="he-preview" dir="ltr">{preview}</pre>
            <span className="muted small">{L("אותו פורמט כמו ‎.claude/agents, כך שהקובץ עובד גם ב-Claude Code.", "The same format as .claude/agents, so the file works in Claude Code too.")}</span>
          </div>
          <div className="row">
            {agent?.file && <button type="button" className="bad" onClick={remove}>{L("מחק", "Delete")}</button>}
            <span className="grow" />
            <button type="button" onClick={onDone}>{L("ביטול", "Cancel")}</button>
            <button type="button" className="primary" onClick={save} disabled={!f.name.trim() || !f.description.trim() || !f.instructions.trim() || !f.project}>{L("שמור סוכן", "Save agent")}</button>
          </div>
          {err && <p className="error small">{err}</p>}
        </div>
      </div>
    </section>
  );
}
