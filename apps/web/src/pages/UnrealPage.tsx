import { useEffect, useMemo, useState } from "react";
import { UnityCliPanel } from "./UnityCliPanel";
import { api } from "../api";
import { getLocale } from "../i18n";
import { desktop, toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Status {
  connected: boolean;
  editor?: { project: string; engine: string; bridge: string };
  projects: string[];
  queued: number;
  /** Unity: whether Unity's CLI is installed, and the project shown. */
  cli?: boolean;
  active?: string;
  latestBridge: string;
  download: string;
}
interface BpItem { path: string; name: string; parent?: string; saved?: boolean }
interface Pin { name: string; label?: string; dir: "in" | "out"; type: string; default?: string; links?: string[] }
interface GNode { id: string; title: string; class: string; x: number; y: number; comment?: string; pins: Pin[] }
interface Blueprint { path: string; name: string; parent?: string; variables: Array<{ name: string; type: string }>; graphs: Array<{ name: string; kind: string; nodes: GNode[] }> }
interface Queued { id: string; path: string; graph: string; request?: string; at: string; ops: unknown[] }

/** Pin colors as in Unreal, so the picture reads the same. */
function pinColor(type: string): string {
  const t = type.split(":")[0]!.toLowerCase();
  return (
    { exec: "#f2f2f2", bool: "#9b1c1c", boolean: "#9b1c1c", single: "#9ee35a", int32: "#2ad3ba", vector3: "#f2c94c", vector2: "#f2c94c", gameobject: "#2d8bf0", transform: "#2d8bf0", real: "#9ee35a", float: "#9ee35a", double: "#9ee35a", int: "#2ad3ba", int64: "#2ad3ba", byte: "#0b6e5e", string: "#e93fe1", name: "#b38cf0", text: "#e8839b", object: "#2d8bf0", class: "#5d00c9", struct: "#1355b8", interface: "#f0f0a8", softobject: "#9edcff" } as Record<string, string>
  )[t] ?? "#9aa0a6";
}

const W = 230;
const HEAD = 26;
const ROW = 19;
const SCALE = 0.7;

/** Draws one graph the way the Blueprint editor does: nodes with pins, links between them. */
function GraphView({ nodes }: { nodes: GNode[] }) {
  const layout = useMemo(() => {
    if (!nodes.length) return null;
    const minX = Math.min(...nodes.map((n) => n.x)) * SCALE;
    const minY = Math.min(...nodes.map((n) => n.y)) * SCALE;
    const boxes = nodes.map((n) => {
      const ins = n.pins.filter((p) => p.dir === "in");
      const outs = n.pins.filter((p) => p.dir === "out");
      const h = HEAD + Math.max(ins.length, outs.length, 1) * ROW + 8;
      return { n, x: n.x * SCALE - minX + 20, y: n.y * SCALE - minY + 20, h, ins, outs };
    });
    const at = new Map<string, { x: number; y: number }>();
    for (const b of boxes) {
      b.ins.forEach((p, i) => at.set(`${b.n.id}:${p.name}`, { x: b.x, y: b.y + HEAD + i * ROW + ROW / 2 }));
      b.outs.forEach((p, i) => at.set(`${b.n.id}:${p.name}`, { x: b.x + W, y: b.y + HEAD + i * ROW + ROW / 2 }));
    }
    const links: Array<{ d: string; color: string }> = [];
    for (const b of boxes) {
      for (const p of b.outs) {
        const a = at.get(`${b.n.id}:${p.name}`)!;
        for (const l of p.links ?? []) {
          const z = at.get(l);
          if (!z) continue;
          const dx = Math.max(40, Math.abs(z.x - a.x) / 2);
          links.push({ d: `M${a.x},${a.y} C${a.x + dx},${a.y} ${z.x - dx},${z.y} ${z.x},${z.y}`, color: pinColor(p.type) });
        }
      }
    }
    const width = Math.max(...boxes.map((b) => b.x + W)) + 40;
    const height = Math.max(...boxes.map((b) => b.y + b.h)) + 40;
    return { boxes, links, width, height };
  }, [nodes]);
  if (!layout) return <p className="muted ue-empty">{L("הגרף ריק.", "This graph is empty.")}</p>;
  const pinRow = (p: Pin, i: number, x: number, y: number, side: "in" | "out") => (
    <g key={`${side}${i}`}>
      <circle cx={side === "in" ? x : x + W} cy={y + HEAD + i * ROW + ROW / 2} r={p.type === "exec" ? 4.5 : 4} fill={p.links?.length ? pinColor(p.type) : "none"} stroke={pinColor(p.type)} strokeWidth={1.6} />
      <text x={side === "in" ? x + 10 : x + W - 10} y={y + HEAD + i * ROW + ROW / 2 + 4} textAnchor={side === "in" ? "start" : "end"} className="ue-pin">
        {p.type === "exec" && !p.label ? "" : p.label ?? p.name}
        {side === "in" && p.default !== undefined && !p.links?.length ? ` = ${p.default.length > 18 ? `${p.default.slice(0, 18)}…` : p.default}` : ""}
      </text>
    </g>
  );
  return (
    <svg className="ue-graph" width={layout.width} height={layout.height} role="img" aria-label={L("גרף Blueprint", "Blueprint graph")}>
      {layout.links.map((l, i) => <path key={i} d={l.d} stroke={l.color} strokeWidth={2} fill="none" opacity={0.85} />)}
      {layout.boxes.map((b) => {
        const head = /Event/.test(b.n.class) ? "#7a1f1f" : /CallFunction/.test(b.n.class) ? "#1f4f7a" : /Variable/.test(b.n.class) ? "#2c5a2c" : "#3a3a44";
        return (
          <g key={b.n.id}>
            {b.n.comment && <text x={b.x} y={b.y - 6} className="ue-comment">💬 {b.n.comment}</text>}
            <rect x={b.x} y={b.y} width={W} height={b.h} rx={7} fill="#1b1c20" stroke="#000" opacity={0.96} />
            <path d={`M${b.x},${b.y + 7} a7,7 0 0 1 7,-7 h${W - 14} a7,7 0 0 1 7,7 v${HEAD - 7} h-${W} z`} fill={head} />
            <text x={b.x + 9} y={b.y + 17} className="ue-title">{b.n.title.split("\n")[0]!.slice(0, 30)}</text>
            {b.ins.map((p, i) => pinRow(p, i, b.x, b.y, "in"))}
            {b.outs.map((p, i) => pinRow(p, i, b.x, b.y, "out"))}
          </g>
        );
      })}
    </svg>
  );
}

interface Job { state: "building" | "copying" | "done" | "failed"; project: string; engine: string; log: string[]; message?: string }

/**
 * Install into a project (this computer, Windows): KesherAI builds the
 * plugin for the project's engine once and copies it in, so it works in
 * Blueprint-only projects too.
 */
function InstallIntoProject() {
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
  return (
    <div className="stack ue-install">
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
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<string[]>([]);
  const [queue, setQueue] = useState<Queued[]>([]);

  const loadStatus = () => void api<Status>(base).then(setSt, () => undefined);
  const loadList = () => void api<typeof list>(`${base}/blueprints`).then(setList, () => undefined);
  const loadQueue = () => void api<Queued[]>(`${base}/queue`).then(setQueue, () => undefined);
  const loadBp = (p: string) =>
    void api<NonNullable<typeof bp>>(`${base}/graph?path=${encodeURIComponent(p)}`).then(
      (r) => {
        setBp(r);
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
  const edit = async () => {
    setBusy(true);
    setReport([]);
    try {
      const r = await api<{ note: string; applied: boolean; queued?: string; result?: { results: Array<{ ok: boolean; error?: string; op: string }>; failed: number }; compile?: { ok: boolean; messages: Array<{ severity: string; text: string }> } }>(`${base}/edit`, { method: "POST", body: { path, graph: graphName, request } });
      const lines = [r.note || L("בוצע.", "Done.")];
      if (r.queued) lines.push(L(`⏳ ${app} סגור: השינוי ממתין ויוחל כשתפתח את הפרויקט.`, `⏳ ${app} is closed: the change waits and is applied when you open the project.`));
      r.result?.results.filter((x) => !x.ok).forEach((x) => lines.push(`⚠ ${x.error ?? x.op}`));
      if (r.applied) lines.push(L(`Ctrl+Z ב-${app} מבטל את השינוי. לא נשמר לדיסק עד שתלחץ שמור.`, `Ctrl+Z in ${app} undoes it. Not saved to disk until you press Save.`));
      r.compile?.messages.forEach((m) => lines.push(`${m.severity === "error" ? "⛔" : "⚠"} ${m.text}`));
      setReport(lines);
      setRequest("");
      loadQueue();
      if (r.applied) loadBp(path);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const outdated = st.editor && st.editor.bridge && st.editor.bridge !== st.latestBridge;
  const graph = bp?.graph.graphs.find((g) => g.name === graphName) ?? bp?.graph.graphs[0];
  const shown = (list?.blueprints ?? []).filter((b) => !filter || b.name.toLowerCase().includes(filter.toLowerCase()));
  const neverConnected = !st.connected && !st.projects.length;

  return (
    <div className="page ue-page">
      <div className="row ue-head">
        <h1 className="grow">{unity ? "Unity Visual Scripting" : "Unreal Blueprints"}</h1>
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
      {outdated && !unity && <p className="pill">{L(`יש גרסה חדשה של הפלאגין (${st.latestBridge}).`, `A newer plugin is out (${st.latestBridge}).`)} <a href={st.download}>{L("הורד", "Download")}</a></p>}

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
        <div className="ue-body">
          <aside className="ue-list card">
            <input dir="auto" placeholder={unity ? L("חיפוש גרף…", "Find a graph…") : L("חיפוש Blueprint…", "Find a Blueprint…")} value={filter} onChange={(e) => setFilter(e.target.value)} />
            <select className="ue-select" value={path} onChange={(e) => setPath(e.target.value)} aria-label="Blueprint">
              <option value="">{L("בחר Blueprint", "Choose a Blueprint")}</option>
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
              {!shown.length && <li className="muted small">{L("אין Blueprints עדיין.", "No Blueprints yet.")}</li>}
            </ul>
          </aside>

          <section className="ue-main card stack">
            {!bp ? (
              <p className="muted">{L("בחר Blueprint מהרשימה.", "Choose a Blueprint from the list.")}</p>
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
                <div className="ue-canvas">{graph && <GraphView nodes={graph.nodes} />}</div>
                <form className="row ue-ask" onSubmit={(e) => { e.preventDefault(); void edit(); }}>
                  <input className="grow" dir="auto" value={request} onChange={(e) => setRequest(e.target.value)} placeholder={unity ? L("מה לשנות? למשל: ב-Start תדפיס Hello ללוג, ואם open אמת תזיז את הדלת", "What to change? e.g. on Start log Hello, and if open is true move the door") : L("מה לשנות? למשל: ב-BeginPlay תדפיס Hello, ואם Open אמת תפעיל את OpenDoor", "What to change? e.g. on BeginPlay print Hello, and if Open is true call OpenDoor")} />
                  <button type="submit" className="primary" disabled={busy || !request.trim()}>{busy ? L("המודל עובד…", "Working…") : `✨ ${st.connected || unity ? L("שנה", "Change") : L("שנה כשיתחבר", "Change when it connects")}`}</button>
                </form>
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
