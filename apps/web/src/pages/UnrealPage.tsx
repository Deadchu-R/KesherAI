import { useEffect, useRef, useState } from "react";
import { UnityCliPanel } from "./UnityCliPanel";
import { BlueprintCanvas, type GNode } from "../BlueprintCanvas";
import { Fullscreen } from "../Fullscreen";
import { BlueprintCode, type Lang } from "../BlueprintCode";
import { ScriptNodes } from "../ScriptNodes";
import { FoundUnityProjects } from "../FoundUnityProjects";
import { WidgetDesigner } from "../WidgetDesigner";
import { api, withToken } from "../api";
import { getLocale } from "../i18n";
import { createConversation, toast, useLibrary } from "../library";
import { AddUnityPackage } from "../engine/AddUnityPackage";
import { ConnectSteps } from "../engine/ConnectSteps";
import { ConnectUnityAssistant } from "../engine/ConnectUnityAssistant";
import { NewBlueprint } from "../engine/NewBlueprint";
import { OpenInChat } from "../engine/OpenInChat";
import { PluginUpdate } from "../engine/PluginUpdate";

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
  // Unity: Visual Scripting graphs, or C# scripts shown as nodes.
  const [source, setSource] = useState<"graphs" | "scripts">("graphs");
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
  const [chat, setChat] = useState<Array<{ who: "you" | "ai"; lines: string[]; picture?: string; log?: string[]; link?: string }>>([]);
  // The bubble can be connected to a regular chat: then its messages go there (the chat's agent and tools, kept in the chat list).
  const { conversations } = useLibrary();
  const [linked, setLinked] = useState(() => {
    try {
      return localStorage.getItem("kesher.ue.chat") ?? "";
    } catch {
      return "";
    }
  });
  const link = (id: string) => {
    setLinked(id);
    try {
      localStorage.setItem("kesher.ue.chat", id);
    } catch {
      // private window: not remembered
    }
  };
  const linkedTitle = conversations.find((c) => c.id === linked)?.title;
  const [testing, setTesting] = useState(false);
  const chatEnd = useRef<HTMLDivElement>(null);
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ block: "nearest" });
  }, [chat, busy]);
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
    if (linked && !unity) {
      try {
        await viaChat(asked);
      } catch (e) {
        setChat((c) => [...c, { who: "ai", lines: [`⛔ ${(e as Error).message}`] }]);
      } finally {
        setBusy(false);
      }
      return;
    }
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

  /** Sends the request to the connected chat, with what is shown here, and shows the chat's answer in the bubble. */
  const viaChat = async (asked: string) => {
    type Conv = { session: { status: string }; events: Array<{ type: string; text?: string; seq?: number }> };
    const before = await api<Conv>(`/api/conversations/${linked}`);
    const last = before.events.at(-1)?.seq ?? 0;
    const context = `[From the Unreal Blueprints page: the user is looking at the Blueprint ${path}${graphName ? `, graph ${graphName}` : ""}. Use unreal_read_graph, unreal_change_graph and unreal_test_blueprint on it.]`;
    await api(`/api/conversations/${linked}/messages`, { method: "POST", body: { text: `${asked}\n\n${context}` } });
    const open = `#/c/${linked}`;
    for (let i = 0; i < 900; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      const c = await api<Conv>(`/api/conversations/${linked}`);
      const fresh = c.events.filter((e) => (e.seq ?? 0) > last);
      const said = fresh.filter((e) => e.type === "assistant" && e.text).map((e) => e.text!);
      if (c.session.status === "waiting") {
        setChat((x) => [...x, { who: "ai", lines: [...said, L("⏸ הצ'אט מחכה לאישור שלך — פתחו אותו לאשר.", "⏸ The chat is waiting for your approval — open it to approve.")], link: open }]);
        return;
      }
      if (fresh.length && c.session.status !== "running") {
        setChat((x) => [...x, { who: "ai", lines: said.length ? said : [L("בוצע.", "Done.")], link: open }]);
        loadBp(path);
        return;
      }
    }
  };

  /** "Test": plays the game in Unreal (or the scene in Unity's Play Mode) for a few seconds and a model says whether the Blueprint does what it should. */
  const test = async () => {
    if (!path || testing) return;
    const goal = request.trim();
    setBubble(true);
    setTesting(true);
    setRequest("");
    setChat((c) => [...c, { who: "you", lines: [goal ? `🧪 ${L("בדיקה", "Test")}: ${goal}` : `🧪 ${L("בדיקה", "Test")}`] }]);
    try {
      const r = await api<{ played: boolean; reason?: string; compile: string[]; log: Array<{ kind: string; category: string; text: string }>; pictureId?: string; placed?: string; seconds: number; verdict: string; summary: string }>(`${base}/test`, { method: "POST", body: { path, seconds: 6, goal, lang: getLocale(), ...(model ? { model } : {}) } });
      const lines = r.verdict ? r.verdict.split("\n").filter((l) => l.trim()) : [r.summary];
      if (!r.played && r.reason) lines.unshift(`⛔ ${r.reason}`);
      setChat((c) => [...c, { who: "ai", lines, ...(r.pictureId ? { picture: r.pictureId } : {}), log: [...r.compile.map((x) => `⚠ ${x}`), ...r.log.map((l) => `${l.kind === "error" ? "⛔ " : l.kind === "warning" ? "⚠ " : ""}${l.text}`)] }]);
    } catch (e) {
      setChat((c) => [...c, { who: "ai", lines: [`⛔ ${(e as Error).message}`] }]);
    } finally {
      setTesting(false);
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
      {unity && <FoundUnityProjects onAdded={() => { loadStatus(); loadList(); }} />}
      {unity && st.projects.length > 0 && (
        <div className="row ue-projects">
          <select value={st.active ?? ""} onChange={(e) => void api("/api/unity/project", { method: "PUT", body: { project: e.target.value } }).then(() => { loadStatus(); loadList(); })} aria-label={L("פרויקט", "Project")}>
            {st.projects.map((p) => <option key={p} value={p}>{p.split(/[\\/]/).pop()}</option>)}
          </select>
          <AddUnityPackage compact />
          <ConnectUnityAssistant />
          <span className="row bp-code-lang" role="tablist" aria-label={L("מה להציג", "What to show")}>
            <button type="button" role="tab" aria-selected={source === "graphs"} className={source === "graphs" ? "on" : ""} onClick={() => setSource("graphs")}>{L("גרפים", "Graphs")}</button>
            <button type="button" role="tab" aria-selected={source === "scripts"} className={source === "scripts" ? "on" : ""} onClick={() => setSource("scripts")} title={L("סקריפטי C# כנודים, לעבודה בלי קוד", "C# scripts as nodes, to work without code")}>{L("סקריפטים C#", "C# scripts")}</button>
          </span>
          {!st.connected && <span className="muted small">{L("Unity סגור: כל פעולה תריץ את Unity ברקע (איטי יותר).", "Unity is closed: each action runs Unity in the background (slower).")}</span>}
        </div>
      )}
      {outdated && !unity && <PluginUpdate latest={st.latestBridge} now={st.editor!.bridge} download={st.download} />}

      {(neverConnected || (!st.connected && !unity)) && (
        <ConnectSteps unity={unity} download={st.download} />
      )}

      {unity && source === "scripts" && st.active && <ScriptNodes key={st.active} />}
      {!neverConnected && !(unity && source === "scripts") && (
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
            {!unity && (st.connected || st.projects.length > 0) && <NewBlueprint connected={st.connected} onMade={(p) => { loadList(); loadQueue(); setPath(p); }} />}
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
                  <button type="button" className="primary" disabled={!st.connected || testing} onClick={() => void test()} title={unity ? L("מריץ את הסצנה ב-Play Mode כמה שניות, אוסף את ה-Console ותמונה, והמודל בודק אם הגרף עובד", "Plays the scene in Play Mode for a few seconds, collects the Console and a picture, and the model checks whether the graph works") : L("מריץ את המשחק ב-Unreal כמה שניות, אוסף את הלוג ותמונה, והמודל בודק אם ה-Blueprint עובד", "Plays the game in Unreal for a few seconds, collects the log and a picture, and the model checks whether the Blueprint works")}>{testing ? L("בודק…", "Testing…") : `🧪 ${L("בדיקה", "Test")}`}</button>
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
                    {...(bp ? { translate: { name: bp.graph.name, unity, run: (lang: Lang, draft: string) => api<{ code: string }>(`${base}/translate`, { method: "POST", body: { path, graph: graph.name, lang, draft, ...(model ? { model } : {}) } }).then((r) => r.code, (e: Error) => { toast(e.message); throw e; }) } } : {})}
                    onApply={(code, before) => void edit(`Change this graph so it does exactly what this code says. The code is the graph written as text (one line per node, in the order the exec wires run; "x = Node(...)" names a node's outputs; indented blocks under "then:" / "else:" are those exec outputs). Make only the differences.\n\nBEFORE:\n${before.slice(0, 3000)}\n\nAFTER:\n${code.slice(0, 3000)}`, L("עדכון הגרף לפי הקוד", "Update the graph from the code"))}
                  />
                )}
                <Fullscreen hidden={shownView === "code"} label={L("הגרף במסך מלא", "The graph, full screen")}>
                <div className="ue-stage">
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
                      {!unity && (
                        <div className="row ue-bubble-link">
                          <select value={linked} onChange={(e) => (e.target.value === "+" ? void createConversation({ kind: "chat" }).then((id) => id && link(id), (er: Error) => toast(er.message)) : link(e.target.value))} aria-label={L("לאן הבקשות הולכות", "Where requests go")} title={L("חיבור לצ'אט רגיל: הבקשות הולכות לצ'אט (עם כל הכלים שלו) ונשמרות ברשימת הצ'אטים", "Connect to a regular chat: requests go to that chat (with all its tools) and are kept in the chat list")}>
                            <option value="">{L("✨ עריכה מהירה (בלי צ'אט)", "✨ Quick edit (no chat)")}</option>
                            {linked && !linkedTitle && <option value={linked}>{L("💬 הצ'אט המחובר", "💬 The connected chat")}</option>}
                            {conversations.slice(0, 15).map((c) => <option key={c.id} value={c.id}>💬 {c.title}</option>)}
                            <option value="+">＋ {L("צ'אט חדש מחובר", "New connected chat")}</option>
                          </select>
                          {linked && <a className="small" href={`#/c/${linked}`}>{L("פתח", "Open")}</a>}
                        </div>
                      )}
                      <div className="ue-bubble-log" aria-live="polite">
                        {chat.length === 0 && <p className="muted small" dir="auto">{L("כתבו מה לשנות ב-Blueprint שמוצג. השינוי מוחל בעורך כצעד אחד (Ctrl+Z מבטל) ומקומפל; אפשר להמשיך: \"עכשיו גם…\".", "Say what to change in the Blueprint shown. It is applied in the editor as one step (Ctrl+Z undoes it) and compiled; you can follow up: \"now also…\".")}</p>}
                        {chat.map((c, i) => (
                          <div key={i} className={`ue-msg ${c.who}`} dir="auto">
                            {c.lines.map((l, k) => <div key={k}>{l}</div>)}
                            {c.picture && <a href={withToken(`/api/assets/${c.picture}`)} target="_blank" rel="noreferrer"><img className="ue-test-pic" src={withToken(`/api/assets/${c.picture}`)} alt={L("המשחק בסוף הבדיקה", "The game at the end of the test")} /></a>}
                            {c.log && c.log.length > 0 && (
                              <details className="ue-test-log">
                                <summary>{L(`הלוג (${c.log.length} שורות)`, `The log (${c.log.length} lines)`)}</summary>
                                <pre dir="ltr">{c.log.join("\n")}</pre>
                              </details>
                            )}
                            {c.link && <a className="small" href={c.link}>{L("פתח את הצ'אט", "Open the chat")}</a>}
                          </div>
                        ))}
                        {busy && <div className="ue-msg ai muted">{linked && !unity ? L("הצ'אט עובד…", "The chat is working…") : L("המודל עובד…", "Working…")}</div>}
                        {testing && <div className="ue-msg ai muted">{unity ? L("🧪 מריץ את הסצנה ב-Unity ובודק…", "🧪 Playing the scene in Unity and checking…") : L("🧪 מריץ את המשחק ב-Unreal ובודק…", "🧪 Playing the game in Unreal and checking…")}</div>}
                        <div ref={chatEnd} />
                      </div>
                      <form className="row ue-ask" onSubmit={(e) => { e.preventDefault(); void edit(); }}>
                        <input className="grow" dir="auto" autoFocus value={request} onChange={(e) => setRequest(e.target.value)} placeholder={unity ? L("למשל: ב-Start תדפיס Hello ללוג", "e.g. on Start log Hello") : L("למשל: ב-BeginPlay תדפיס Hello", "e.g. on BeginPlay print Hello")} />
                        <button type="button" disabled={!st.connected || testing || busy} onClick={() => void test()} aria-label={L("בדיקה: הטקסט (אם יש) הוא מה שאמור לקרות", "Test: the text (if any) is what should happen")} title={L("בדיקה: הטקסט (אם יש) הוא מה שאמור לקרות", "Test: the text (if any) is what should happen")}>🧪</button>
                        <button type="submit" className="primary" disabled={busy || !request.trim()} aria-label={st.connected || unity ? L("שנה", "Change") : L("שנה כשיתחבר", "Change when it connects")}>{busy ? "…" : "↑"}</button>
                      </form>
                    </div>
                  )}
                </div>
                </Fullscreen>
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
