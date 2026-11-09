import { useEffect, useRef, useState } from "react";
import { UnityCliPanel } from "./UnityCliPanel";
import { BlueprintCanvas, type GNode } from "../BlueprintCanvas";
import { BlueprintCode } from "../BlueprintCode";
import { WidgetDesigner } from "../WidgetDesigner";
import { api } from "../api";
import { getLocale } from "../i18n";
import { createConversation, desktop, toast, useLibrary } from "../library";
import { openWithDraft } from "../phone";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Status {
  connected: boolean;
  editor?: { project: string; engine: string; bridge: string; projectFile?: string };
  projects: string[];
  queued: number;
  /** Unity: whether Unity's CLI is installed, and the project shown. */
  cli?: boolean;
  active?: string;
  latestBridge: string;
  download: string;
}
interface BpItem { path: string; name: string; parent?: string; saved?: boolean }
interface Blueprint { path: string; name: string; parent?: string; variables: Array<{ name: string; type: string }>; graphs: Array<{ name: string; kind: string; nodes: GNode[] }> }
interface Queued { id: string; path: string; graph: string; request?: string; at: string; ops: unknown[] }

interface Job { state: "building" | "waiting" | "copying" | "done" | "failed"; project: string; engine: string; log: string[]; message?: string }

/**
 * The plugin updates itself: one press builds the new version while Unreal
 * is open, Unreal asks to save and closes, the plugin is replaced, and the
 * project opens again (from the phone too; the save question shows on the computer).
 */
function PluginUpdate({ latest, now, download }: { latest: string; now: string; download: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const running = job?.state === "building" || job?.state === "waiting" || job?.state === "copying";
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => void api<{ job: Job | null }>("/api/unreal/engines").then((r) => setJob(r.job), () => undefined), 2000);
    return () => clearInterval(id);
  }, [running]);
  const start = () => void api<{ job: Job }>("/api/unreal/update-plugin", { method: "POST" }).then((r) => setJob(r.job), (e: Error) => toast(e.message));
  const step = job ? { building: L("בונה את הגרסה החדשה (Unreal נשאר פתוח)…", "Building the new version (Unreal stays open)…"), waiting: L("Unreal נסגר — אם הוא שואל אם לשמור, ענה במחשב…", "Closing Unreal — if it asks to save, answer on the computer…"), copying: L("מחליף את הפלאגין…", "Replacing the plugin…"), done: job.message ?? L("עודכן.", "Updated."), failed: job.message ?? L("נכשל.", "Failed.") }[job.state] : "";
  return (
    <div className="card row plugin-update">
      <span className="grow small">{L(`גרסה חדשה של הפלאגין: ${latest} (מותקנת ${now}).`, `A newer plugin: ${latest} (installed ${now}).`)} {step && <strong dir="auto">{step}</strong>}</span>
      {!running && job?.state !== "done" && <button type="button" className="primary" onClick={start}>{L("עדכן אוטומטית", "Update automatically")}</button>}
      <a className="small" href={download}>{L("הורדה ידנית", "Download")}</a>
    </div>
  );
}

/**
 * Install into a project (this computer, Windows): KesherAI builds the
 * plugin for the project's engine once and copies it in, so it works in
 * Blueprint-only projects too.
 */
function InstallIntoProject() {
  const [mcpMsg, setMcpMsg] = useState("");
  const [info, setInfo] = useState<{ engines: Array<{ version: string; path: string }>; job: Job | null; windows: boolean } | null>(null);
  const [error, setError] = useState("");
  const load = () => void api<NonNullable<typeof info>>("/api/unreal/engines").then(setInfo, () => setInfo(null));
  useEffect(load, []);
  const running = info?.job?.state === "building" || info?.job?.state === "copying";
  useEffect(() => {
    if (!running) return;
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, [running]);
  const bridge = desktop();
  if (!info?.windows || !bridge) return null;
  const pick = async () => {
    setError("");
    const folder = await bridge.pickFolder();
    if (!folder) return;
    try {
      await api("/api/unreal/install", { method: "POST", body: { project: folder } });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const job = info.job;
  // Unreal 5.8+: the engine's own MCP server (hundreds of editor tools) for every chat.
  const pickMcp = async () => {
    setError("");
    const folder = await bridge.pickFolder();
    if (!folder) return;
    try {
      setMcpMsg((await api<{ message: string }>("/api/unreal/mcp-setup", { method: "POST", body: { project: folder } })).message);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="stack ue-install">
      <div className="row">
        <button type="button" onClick={() => void pickMcp()}>🤖 {L("חבר את הצ'אטים ל-Unreal 5.8+ (MCP)…", "Connect chats to Unreal 5.8+ (MCP)…")}</button>
        <span className="muted small">{L("מפעיל בפרויקט את שרת ה-MCP הרשמי של Unreal (כלים לשחקנים, Blueprints, חומרים, Niagara, Sequencer ועוד), כך שכל צ'אט יכול לעבוד בעורך הפתוח.", "Turns on Unreal's official MCP server in the project (tools for actors, Blueprints, materials, Niagara, Sequencer and more), so any chat can work in the open editor.")}</span>
      </div>
      {mcpMsg && <p className="pill">{mcpMsg}</p>}
      <div className="row">
        <button type="button" className="primary" disabled={running} onClick={() => void pick()}>📁 {L("התקן לתוך פרויקט…", "Install into a project…")}</button>
        <span className="muted small">{L("עובד גם בפרויקט Blueprint בלבד, בלי C++. ", "Works in Blueprint-only projects too, no C++. ")}{info.engines.length ? `${L("נמצאו", "Found")}: UE ${info.engines.map((e) => e.version).join(", ")}` : L("לא נמצא Unreal במחשב.", "No Unreal found on this computer.")}</span>
      </div>
      {job && (
        <div className="stack">
          <p className={job.state === "failed" ? "error" : job.state === "done" ? "pill good" : "muted"}>
            {job.state === "building" ? `⚙ ${L(`בונה את הפלאגין ל-Unreal ${job.engine} (פעם אחת לכל גרסה, כמה דקות)…`, `Building the plugin for Unreal ${job.engine} (once per version, a few minutes)…`)}` : job.state === "copying" ? L("מעתיק לפרויקט…", "Copying into the project…") : job.state === "done" ? `✅ ${job.message ?? ""}` : `⛔ ${job.message ?? ""}`}
          </p>
          {(running || job.state === "failed") && job.log.length > 0 && <pre className="ue-log" dir="ltr">{job.log.slice(-12).join("\n")}</pre>}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** "Add to a project…" (this computer): copies the package into the project's Packages folder. */
function AddUnityPackage({ compact = false }: { compact?: boolean }) {
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const bridge = desktop();
  if (!bridge) return null;
  const pick = async () => {
    setError("");
    setMsg("");
    const folder = await bridge.pickFolder();
    if (!folder) return;
    try {
      setMsg((await api<{ message: string }>("/api/unity/install", { method: "POST", body: { project: folder } })).message);
      dispatchEvent(new Event("kesher-unity-added"));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="stack ue-install">
      <div className="row">
        <button type="button" className={compact ? "" : "primary"} onClick={() => void pick()}>📁 {L("הוסף לפרויקט…", "Add to a project…")}</button>
        {!compact && <span className="muted small">{L("בחר את תיקיית הפרויקט (זו שיש בה Assets ו-Packages).", "Pick the project folder (the one with Assets and Packages).")}</span>}
      </div>
      {msg && <p className="pill good">✅ {msg}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/**
 * Unreal: your project's Blueprints, seen and changed in words, through the
 * KesherAI Bridge plugin. With Unreal closed, the copy saved here is shown
 * and changes wait until the editor connects.
 */
export function UnrealPage({ kind = "unreal" }: { kind?: "unreal" | "unity" }) {
  const base = `/api/${kind}`;
  const unity = kind === "unity";
  const app = unity ? "Unity" : "Unreal";
  const [st, setSt] = useState<Status | null>(null);
  const [list, setList] = useState<{ blueprints: BpItem[]; offline: boolean; project?: string } | null>(null);
  const [path, setPath] = useState("");
  const [bp, setBp] = useState<{ graph: Blueprint; offline: boolean; savedAt?: string } | null>(null);
  const [graphName, setGraphName] = useState("");
  const [filter, setFilter] = useState("");
  const [request, setRequest] = useState("");
  // Which model makes the change (remembered here): a big model can be slow or stuck, a small one is often enough.
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [model, setModel] = useState(() => {
    try {
      return localStorage.getItem("kesher.graphModel") ?? "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    void api<{ models: Array<{ id: string; name: string; category: string }> }>("/api/models").then((r) => setModels(r.models.filter((m) => m.category === "chat")), () => undefined);
  }, []);
  const chooseModel = (id: string) => {
    setModel(id);
    try {
      localStorage.setItem("kesher.graphModel", id);
    } catch {
      // private window: not remembered
    }
  };
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<string[]>([]);
  // The AI bubble over the node view: a short chat about the Blueprint shown (follow-ups know what came before).
  const [bubble, setBubble] = useState(false);
  // Graph, code, or both side by side (remembered); a line clicked in the code flashes its node.
  const [view, setView] = useState<"graph" | "code" | "both" | "design">(() => {
    try {
      const v = localStorage.getItem("kesher.bpView");
      return v === "code" || v === "both" ? v : "graph";
    } catch {
      return "graph";
    }
  });
  const chooseView = (v: "graph" | "code" | "both" | "design") => {
    setView(v);
    try {
      localStorage.setItem("kesher.bpView", v);
    } catch {
      // private window: not remembered
    }
  };
  const [flash, setFlash] = useState<{ id: string; n: number }>();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [chat, setChat] = useState<Array<{ who: "you" | "ai"; lines: string[] }>>([]);
  const chatEnd = useRef<HTMLDivElement>(null);
  useEffect(() => chatEnd.current?.scrollIntoView({ block: "nearest" }), [chat, busy]);
  const [queue, setQueue] = useState<Queued[]>([]);

  const loadStatus = () => void api<Status>(base).then(setSt, () => undefined);
  const loadList = () => void api<typeof list>(`${base}/blueprints`).then(setList, () => undefined);
  const loadQueue = () => void api<Queued[]>(`${base}/queue`).then(setQueue, () => undefined);
  const loadBp = (p: string) =>
    void api<NonNullable<typeof bp>>(`${base}/graph?path=${encodeURIComponent(p)}`).then(
      (r) => {
        // Opening another Blueprint: a Widget Blueprint starts in the Designer.
        setBp((was) => {
          if (was?.graph.path !== r.graph.path && /UserWidget|Widget$/.test(r.graph.parent ?? "")) setView("design");
          return r;
        });
        setGraphName((g) => (r.graph.graphs.some((x) => x.name === g) ? g : r.graph.graphs[0]?.name ?? ""));
      },
      (e: Error) => {
        setBp(null);
        toast(e.message);
      },
    );

  useEffect(() => {
    loadStatus();
    loadList();
    loadQueue();
    const added = () => { loadStatus(); loadList(); };
    addEventListener("kesher-unity-added", added);
    const id = setInterval(loadStatus, unity ? 8000 : 5000);
    return () => {
      clearInterval(id);
      removeEventListener("kesher-unity-added", added);
    };
  }, []);
  // When the editor connects or leaves, read again (live or the saved copy).
  const connected = st?.connected ?? false;
  useEffect(() => {
    loadList();
    loadQueue();
    if (path) loadBp(path);
  }, [connected]);
  useEffect(() => {
    if (path) loadBp(path);
    setChat([]);
  }, [path]);

  if (!st) return <div className="page"><p className="muted">{L("בודק…", "Checking…")}</p></div>;

  const call = async (cmd: "open" | "compile" | "save") => {
    try {
      const r = await api<{ ok?: boolean; messages?: Array<{ severity: string; text: string }> }>(`${base}/${cmd}`, { method: "POST", body: { path } });
      if (cmd === "compile") setReport(r.messages?.length ? r.messages.map((m) => `${m.severity === "error" ? "⛔" : "⚠"} ${m.text}`) : [L("✅ קומפל בלי שגיאות.", "✅ Compiled with no errors.")]);
      else toast(cmd === "save" ? L("נשמר.", "Saved.") : L(`נפתח ב-${app}.`, `Opened in ${app}.`));
    } catch (e) {
      toast((e as Error).message);
    }
  };
  /** A change in words (the bubble), or a full request from the code view (shown in the bubble by its short name). */
  const edit = async (given?: string, shown?: string) => {
    const asked = (given ?? request).trim();
    if (!asked) return;
    setBusy(true);
    setReport([]);
    if (given) setBubble(true);
    // Earlier requests in this bubble, so "now make it red" knows what "it" is (they are already applied).
    const earlier = chat.filter((c) => c.who === "you").slice(-4).map((c) => c.lines[0]);
    const full = !given && earlier.length ? `${asked}\n\n(Earlier in this conversation, already applied: ${earlier.map((e, i) => `${i + 1}) ${e}`).join(" ")})` : asked;
    setChat((c) => [...c, { who: "you", lines: [shown ?? asked] }]);
    if (!given) setRequest("");
    try {
      const r = await api<{ note: string; applied: boolean; queued?: string; result?: { results: Array<{ ok: boolean; error?: string; op: string }>; failed: number }; compile?: { ok: boolean; messages: Array<{ severity: string; text: string }> } }>(`${base}/edit`, { method: "POST", body: { path, graph: graphName, request: full, ...(model ? { model } : {}) } });
      const lines = [r.note || L("בוצע.", "Done.")];
      if (r.queued) lines.push(L(`⏳ ${app} סגור: השינוי ממתין ויוחל כשתפתח את הפרויקט.`, `⏳ ${app} is closed: the change waits and is applied when you open the project.`));
      r.result?.results.filter((x) => !x.ok).forEach((x) => lines.push(`⚠ ${x.error ?? x.op}`));
      if (r.applied) lines.push(L(`Ctrl+Z ב-${app} מבטל את השינוי. לא נשמר לדיסק עד שתלחץ שמור.`, `Ctrl+Z in ${app} undoes it. Not saved to disk until you press Save.`));
      r.compile?.messages.forEach((m) => lines.push(`${m.severity === "error" ? "⛔" : "⚠"} ${m.text}`));
      setChat((c) => [...c, { who: "ai", lines }]);
      loadQueue();
      if (r.applied) loadBp(path);
    } catch (e) {
      setChat((c) => [...c, { who: "ai", lines: [`⛔ ${(e as Error).message}`] }]);
    } finally {
      setBusy(false);
    }
  };

  const outdated = st.editor && st.editor.bridge && st.editor.bridge !== st.latestBridge;
  const graph = bp?.graph.graphs.find((g) => g.name === graphName) ?? bp?.graph.graphs[0];
  // A Widget Blueprint (UMG) opens in the Designer; "design" means graph for any other Blueprint.
  const isWidget = /UserWidget|Widget$/.test(bp?.graph.parent ?? "");
  const shownView = view === "design" && !(isWidget && !unity) ? "graph" : view;
  const shown = (list?.blueprints ?? []).filter((b) => !filter || b.name.toLowerCase().includes(filter.toLowerCase()));
  const neverConnected = !st.connected && !st.projects.length;

  return (
    <div className="page ue-page">
      <div className="row ue-head">
        <h1 className="grow">{unity ? "Unity" : "Unreal Blueprints"}</h1>
        <OpenInChat line={unity ? (st.active ? `[Unity project: ${st.active.split(/[\\/]/).pop()} — ${st.active}] ` : "") : list?.project ? `[Unreal project: ${list.project}${st.editor?.projectFile ? ` — ${st.editor.projectFile}${st.connected ? "; the editor is connected" : ""}` : st.connected ? " — the editor is connected" : ""}] ` : ""} />
        <span className={`pill ${st.connected ? "good" : ""}`}>
          {st.connected ? `🟢 ${L("מחובר", "Connected")} · ${st.editor!.project} · ${unity ? "Unity" : "UE"} ${st.editor!.engine}` : `⚪ ${L(`${app} לא מחובר`, `${app} not connected`)}${list?.project ? ` · ${L("מציג עותק שמור של", "showing the saved copy of")} ${list.project}` : ""}`}
        </span>
      </div>
      {unity && <UnityCliPanel hasProject={st.projects.length > 0} onMade={() => { loadStatus(); loadList(); }} />}
      {unity && st.projects.length > 0 && (
        <div className="row ue-projects">
          <select value={st.active ?? ""} onChange={(e) => void api("/api/unity/project", { method: "PUT", body: { project: e.target.value } }).then(() => { loadStatus(); loadList(); })} aria-label={L("פרויקט", "Project")}>
            {st.projects.map((p) => <option key={p} value={p}>{p.split(/[\\/]/).pop()}</option>)}
          </select>
          <AddUnityPackage compact />
          {!st.connected && <span className="muted small">{L("Unity סגור: כל פעולה תריץ את Unity ברקע (איטי יותר).", "Unity is closed: each action runs Unity in the background (slower).")}</span>}
        </div>
      )}
      {outdated && !unity && <PluginUpdate latest={st.latestBridge} now={st.editor!.bridge} download={st.download} />}

      {(neverConnected || (!st.connected && !unity)) && (
        <section className="card stack">
          <h2>{L(`חיבור ${app}`, `Connect ${app}`)}</h2>
          {unity ? (
            <>
              <AddUnityPackage />
              <ol className="ue-steps">
                <li>{L("Unity 6 ומעלה, עם Visual Scripting.", "Unity 6 or newer, with Visual Scripting.")}</li>
                <li>{L("\"הוסף לפרויקט\" מעתיק את חבילת KesherAI Bridge לפרויקט ומוסיף את חבילת ה-Pipeline של Unity דרך ה-CLI. Unity מקמפל לבד — בלי Visual Studio.", "“Add to a project” copies the KesherAI Bridge package into the project and adds Unity's Pipeline package through the CLI. Unity compiles it by itself — no Visual Studio.")}</li>
                <li>{L("כש-Unity פתוח, השינויים קורים בו מיד (Ctrl+Z מבטל). כשהוא סגור, KesherAI מריץ את Unity ברקע, משנה ושומר — לוקח קצת יותר זמן.", "With Unity open, changes happen in it at once (Ctrl+Z undoes them). With it closed, KesherAI runs Unity in the background, changes and saves — a little slower.")}</li>
              </ol>
            </>
          ) : (
            <>
          <InstallIntoProject />
          <p className="muted small">{L("או ידנית:", "Or by hand:")}</p>
          <ol className="ue-steps">
            <li>{L("הורד את הפלאגין:", "Download the plugin:")} <a className="button primary" href={st.download}>⬇ KesherAIBridge.zip</a></li>
            <li>{L("חלץ אותו לתיקייה Plugins בתוך הפרויקט (YourProject/Plugins/KesherAIBridge).", "Unzip it into your project's Plugins folder (YourProject/Plugins/KesherAIBridge).")}</li>
            <li>{L("פתח את הפרויקט. בפרויקט C++, Unreal יבנה את הפלאגין בפעם הראשונה (צריך Visual Studio). לפרויקט Blueprint בלבד — השתמש ב\"התקן לתוך פרויקט\" למעלה.", "Open the project. In a C++ project Unreal builds the plugin the first time (needs Visual Studio). For a Blueprint-only project, use “Install into a project” above.")}</li>
            <li>{L("זהו: כש-KesherAI פתוח, Unreal מתחבר לבד ויופיע כאן 🟢.", "That's it: while KesherAI runs, Unreal connects by itself and shows 🟢 here.")}</li>
          </ol>
            </>
          )}
          <p className="muted small">{L(`החיבור הוא רק בתוך המחשב הזה. כל גרף שנפתח כאן נשמר כעותק, כדי שתוכל לראות אותו ולבקש שינויים גם כש-${app} סגור.`, `The connection stays on this computer. Every graph opened here is kept as a copy, so you can see it and ask for changes with ${app} closed too.`)} <a href={`https://github.com/Deadchu-R/KesherAI/blob/main/docs/${unity ? "UNITY" : "UNREAL"}.md`} target="_blank" rel="noreferrer">{`docs/${unity ? "UNITY" : "UNREAL"}.md`}</a></p>
        </section>
      )}

      {!neverConnected && (
        <div className={`ue-body${view === "both" || view === "design" ? " wide" : ""}`}>
          <aside className="ue-list card">
            <input dir="auto" placeholder={unity ? L("חיפוש גרף…", "Find a graph…") : L("חיפוש Blueprint…", "Find a Blueprint…")} value={filter} onChange={(e) => setFilter(e.target.value)} />
            <select className="ue-select" value={path} onChange={(e) => setPath(e.target.value)} aria-label={unity ? "Script Graph" : "Blueprint"}>
              <option value="">{unity ? L("בחר Script Graph או State Graph", "Choose a Script Graph or State Graph") : L("בחר Blueprint", "Choose a Blueprint")}</option>
              {shown.map((b) => <option key={b.path} value={b.path} disabled={!st.connected && !b.saved}>{b.name}</option>)}
            </select>
            <ul>
              {shown.map((b) => (
                <li key={b.path}>
                  <button type="button" className={b.path === path ? "on" : ""} disabled={!st.connected && !b.saved} onClick={() => setPath(b.path)} title={b.path}>
                    <span className="grow">{b.name}</span>
                    {b.parent && <span className="muted small">{b.parent}</span>}
                  </button>
                </li>
              ))}
              {!shown.length && <li className="muted small">{unity ? L("אין עדיין Script Graphs או State Graphs.", "No Script Graphs or State Graphs yet.") : L("אין Blueprints עדיין.", "No Blueprints yet.")}</li>}
            </ul>
          </aside>

          <section className="ue-main card stack">
            {!bp ? (
              <p className="muted">{unity ? L("בחר גרף (Script Graph או State Graph) מהרשימה.", "Choose a graph (Script Graph or State Graph) from the list.") : L("בחר Blueprint מהרשימה.", "Choose a Blueprint from the list.")}</p>
            ) : (
              <>
                <div className="row ue-tools">
                  <strong className="grow">{bp.graph.name}{bp.graph.parent ? <span className="muted small"> · {bp.graph.parent}</span> : null}</strong>
                  {bp.offline && bp.savedAt && <span className="muted small">{L("עותק מ-", "Copy from ")}{new Date(bp.savedAt).toLocaleString()}</span>}
                  <button type="button" disabled={!st.connected} onClick={() => void call("open")}>{L(`פתח ב-${app}`, `Open in ${app}`)}</button>
                  <button type="button" disabled={!st.connected} onClick={() => void call("compile")}>{unity ? L("בדוק", "Check") : L("קמפל", "Compile")}</button>
                  <button type="button" disabled={!st.connected} onClick={() => void call("save")}>{L("שמור", "Save")}</button>
                </div>
                <div className="ue-tabs" role="tablist">
                  {bp.graph.graphs.map((g) => (
                    <button key={g.name} type="button" role="tab" aria-selected={g.name === graph?.name} className={g.name === graph?.name ? "on" : ""} onClick={() => setGraphName(g.name)}>
                      {g.kind === "function" ? "ƒ " : g.kind === "macro" ? "⧉ " : ""}{g.name}
                    </button>
                  ))}
                </div>
                <div className="ue-views" role="tablist" aria-label={L("תצוגה", "View")}>
                  {(isWidget && !unity ? (["design", "graph", "code", "both"] as const) : (["graph", "code", "both"] as const)).map((v) => (
                    <button key={v} type="button" role="tab" aria-selected={shownView === v} className={shownView === v ? "on" : ""} onClick={() => chooseView(v)}>
                      {v === "design" ? L("עיצוב", "Designer") : v === "graph" ? L("גרף", "Graph") : v === "code" ? L("קוד", "Code") : L("זה לצד זה", "Side by side")}
                    </button>
                  ))}
                </div>
                {shownView === "design" && <WidgetDesigner path={path} editable={st.connected && !bp.offline} {...(model ? { model } : {})} />}
                <div className={`ue-split${shownView === "both" ? " both" : ""}`} hidden={shownView === "design"}>
                {shownView !== "graph" && shownView !== "design" && graph && (
                  <BlueprintCode
                    nodes={graph.nodes}
                    selected={picked}
                    editable={st.connected || unity}
                    busy={busy}
                    onPick={(id) => {
                      if (shownView === "code") chooseView("both");
                      setFlash((f) => ({ id, n: (f?.n ?? 0) + 1 }));
                    }}
                    onApply={(code, before) => void edit(`Change this graph so it does exactly what this code says. The code is the graph written as text (one line per node, in the order the exec wires run; "x = Node(...)" names a node's outputs; indented blocks under "then:" / "else:" are those exec outputs). Make only the differences.\n\nBEFORE:\n${before.slice(0, 3000)}\n\nAFTER:\n${code.slice(0, 3000)}`, L("עדכון הגרף לפי הקוד", "Update the graph from the code"))}
                  />
                )}
                <div className="ue-stage" hidden={shownView === "code"}>
                  <div className="ue-canvas">{graph && <BlueprintCanvas unity={unity} nodes={graph.nodes} path={path} graph={graph.name} editable={!unity && st.connected && !bp.offline} onChanged={() => loadBp(path)} flash={flash} onSelect={setPicked} />}</div>
                  {!bubble && (
                    <button type="button" className="ue-ai-fab primary" onClick={() => setBubble(true)} aria-label={L("עריכה עם AI", "Edit with AI")} title={L("עריכה עם AI", "Edit with AI")}>✨</button>
                  )}
                  {bubble && (
                    <div className="ue-bubble" role="dialog" aria-label={L("עריכה עם AI", "Edit with AI")}>
                      <div className="row ue-bubble-head">
                        <strong className="grow" dir="auto">✨ {bp?.graph.name ?? ""}{graph ? ` · ${graph.name}` : ""}</strong>
                        {models.length > 1 && (
                          <select value={model} onChange={(e) => chooseModel(e.target.value)} aria-label={L("המודל שעושה את השינוי", "The model that makes the change")} title={L("המודל שעושה את השינוי", "The model that makes the change")}>
                            <option value="">{L("מודל הצ'אט הפעיל", "Active chat model")}</option>
                            {models.map((m) => <option key={m.id} value={m.id}>{models.filter((x) => x.name === m.name).length > 1 ? `${m.name} · ${m.id.split("/")[0]}` : m.name}</option>)}
                          </select>
                        )}
                        <button type="button" className="icon-btn" onClick={() => setBubble(false)} aria-label={L("סגור", "Close")}>✕</button>
                      </div>
                      <div className="ue-bubble-log" aria-live="polite">
                        {chat.length === 0 && <p className="muted small" dir="auto">{L("כתבו מה לשנות ב-Blueprint שמוצג. השינוי מוחל בעורך כצעד אחד (Ctrl+Z מבטל) ומקומפל; אפשר להמשיך: \"עכשיו גם…\".", "Say what to change in the Blueprint shown. It is applied in the editor as one step (Ctrl+Z undoes it) and compiled; you can follow up: \"now also…\".")}</p>}
                        {chat.map((c, i) => (
                          <div key={i} className={`ue-msg ${c.who}`} dir="auto">
                            {c.lines.map((l, k) => <div key={k}>{l}</div>)}
                          </div>
                        ))}
                        {busy && <div className="ue-msg ai muted">{L("המודל עובד…", "Working…")}</div>}
                        <div ref={chatEnd} />
                      </div>
                      <form className="row ue-ask" onSubmit={(e) => { e.preventDefault(); void edit(); }}>
                        <input className="grow" dir="auto" autoFocus value={request} onChange={(e) => setRequest(e.target.value)} placeholder={unity ? L("למשל: ב-Start תדפיס Hello ללוג", "e.g. on Start log Hello") : L("למשל: ב-BeginPlay תדפיס Hello", "e.g. on BeginPlay print Hello")} />
                        <button type="submit" className="primary" disabled={busy || !request.trim()} aria-label={st.connected || unity ? L("שנה", "Change") : L("שנה כשיתחבר", "Change when it connects")}>{busy ? "…" : "↑"}</button>
                      </form>
                    </div>
                  )}
                </div>
                </div>
                {report.length > 0 && <ul className="ue-report">{report.map((l, i) => <li key={i} dir="auto">{l}</li>)}</ul>}
              </>
            )}
          </section>
        </div>
      )}

      {queue.length > 0 && (
        <section className="card stack">
          <h2>{L(`ממתין ל-${app}`, `Waiting for ${app}`)} ({queue.length})</h2>
          <p className="muted small">{L("יוחלו לבד כשהפרויקט ייפתח עם הפלאגין.", "Applied by themselves when the project opens with the plugin.")}</p>
          <ul className="ue-queue">
            {queue.map((q) => (
              <li key={q.id} className="row">
                <span className="grow" dir="auto">{q.path.split(".").pop()} · {q.request ?? `${q.ops.length} ${L("פעולות", "operations")}`}</span>
                <span className="muted small">{new Date(q.at).toLocaleString()}</span>
                <button type="button" onClick={() => void api(`${base}/queue/${q.id}`, { method: "DELETE" }).then(loadQueue)}>{L("בטל", "Cancel")}</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * "Open in chat": the project goes into a chat, a new one or one you pick,
 * so you keep working on it in words (the chat's Unity or Unreal tools).
 *
 * @param props.line - What goes into the message box (empty: no project yet).
 */
function OpenInChat({ line }: { line: string }) {
  const { conversations } = useLibrary();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener("mousedown", close);
    return () => removeEventListener("mousedown", close);
  }, [open]);
  if (!line) return null;
  const newChat = () =>
    void createConversation({ kind: "chat" }).then((id) => id && openWithDraft(id, line), (e: Error) => toast(e.message));
  return (
    <div className="model-menu" ref={ref}>
      <button type="button" className="primary" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>💬 {L("פתח בצ'אט", "Open in chat")}</button>
      {open && (
        <div className="model-pop" role="menu">
          <button type="button" role="menuitem" onClick={() => { setOpen(false); newChat(); }}>＋ {L("צ'אט חדש", "New chat")}</button>
          <div className="model-group-head"><span>{L("או לצ'אט קיים", "Or into a chat")}</span></div>
          <div className="model-pop-list">
            {conversations.slice(0, 12).map((c) => (
              <button key={c.id} type="button" role="menuitem" onClick={() => { setOpen(false); openWithDraft(c.id, line); }}><span dir="auto">{c.title}</span></button>
            ))}
            {!conversations.length && <p className="muted small">{L("אין עדיין צ'אטים.", "No chats yet.")}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
