import { useEffect, useState } from "react";
import { api, isRemote, withToken } from "../api";
import { getLocale, he$ } from "../i18n";
import { desktop, toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

interface GodotNode { name: string; type: string; script?: string; children?: GodotNode[] }
interface GodotState { connected: boolean; editor?: { project: string; engine: string; csharp?: boolean; projectFile?: string }; editors: Array<{ path: string; csharp: boolean; version: string }> }

/** One line of the scene tree, with its children indented. */
function TreeLines({ n, depth = 0 }: { n: GodotNode; depth?: number }) {
  return (
    <>
      <div style={{ paddingInlineStart: depth * 16 }}>{n.name} <span className="muted">({n.type}){n.script ? ` · ${n.script.replace(/^res:\/\//, "")}` : ""}</span></div>
      {n.children?.map((c, i) => <TreeLines key={i} n={c} depth={depth + 1} />)}
    </>
  );
}

/** Godot: the connected editor, its open scene, running the game, and connecting a project (the addon). */
export function GodotPage() {
  const [st, setSt] = useState<GodotState | null>(null);
  const [tree, setTree] = useState<{ scene: string | null; root?: GodotNode } | null>(null);
  const [shot, setShot] = useState("");
  const [log, setLog] = useState("");
  const load = () => {
    void api<GodotState>("/api/godot").then((s) => {
      setSt(s);
      if (s.connected) void api<{ scene: string | null; root?: GodotNode }>("/api/godot/tree").then(setTree, () => setTree(null));
    }, (e: Error) => toast(e.message));
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  const connect = async (csharp: boolean) => {
    const dir = await desktop()?.pickFolder();
    if (!dir) return;
    await api("/api/godot/connect", { method: "POST", body: { project: dir, csharp } }).then(() => toast(L("התוסף נוסף, Godot נפתח…", "The addon is in; Godot is opening…")), (e: Error) => toast(e.message));
  };
  const play = (action: "run" | "stop") => void api("/api/godot/play", { method: "POST", body: { action } }).catch((e: Error) => toast(e.message));
  if (!st) return <div className="page"><h1>Godot</h1><p className="muted">…</p></div>;
  const e = st.editor;
  return (
    <div className="page godot-page">
      <h1>Godot</h1>
      <section className="card">
        <div className="row">
          <span className={`hub-led ${st.connected ? "ok" : "off"}`} aria-hidden />
          <strong className="grow" dir="auto">{st.connected && e ? L(`מחובר: ${e.project} · Godot ${e.engine}${e.csharp ? " · C#" : ""}`, `Connected: ${e.project} · Godot ${e.engine}${e.csharp ? " · C#" : ""}`) : L("Godot לא מחובר", "Godot is not connected")}</strong>
        </div>
        <p className="muted small">{L("כל שינוי שהצ׳אט עושה בעורך הוא צעד אחד ב-Ctrl+Z של Godot.", "Every change the chat makes in the editor is one Ctrl+Z step in Godot.")}</p>
      </section>
      {st.connected && (
        <section className="card">
          <strong>{tree?.scene ? L(`הסצנה הפתוחה: ${tree.scene.replace(/^res:\/\//, "")}`, `Open scene: ${tree.scene.replace(/^res:\/\//, "")}`) : L("אין סצנה פתוחה", "No scene is open")}</strong>
          {tree?.root && <div className="mono small godot-tree" dir="ltr"><TreeLines n={tree.root} /></div>}
          <div className="row wrap">
            <button type="button" className="primary" onClick={() => play("run")}>{L("הרץ את המשחק", "Run the game")}</button>
            <button type="button" onClick={() => play("stop")}>{L("עצור", "Stop")}</button>
            <button type="button" onClick={() => setShot(withToken(`/api/godot/screenshot?t=${Date.now()}`))}>{L("צילום מסך", "Screenshot")}</button>
            <button type="button" onClick={() => void api<{ text: string }>("/api/godot/log").then((r) => setLog(r.text || L("(ריק)", "(empty)")), (er: Error) => toast(er.message))}>{L("הלוג של המשחק", "The game's log")}</button>
            <a className="button" href="#/">{L("לשאול בצ׳אט על הסצנה", "Ask the chat about the scene")}</a>
          </div>
          {shot && <img src={shot} alt={L("תצוגת העורך", "The editor view")} className="godot-shot" />}
          {log && <pre className="mono small godot-log" dir="ltr">{log}</pre>}
        </section>
      )}
      <section className="card">
        <strong>{L("לחבר פרויקט", "Connect a project")}</strong>
        <p className="small">{L("KesherAI מוסיף לפרויקט את התוסף addons/kesher_bridge ומפעיל אותו. אפשר להסיר אותו מתי שרוצים, והפרויקט עובד גם בלעדיו.", "KesherAI adds the addon addons/kesher_bridge to the project and turns it on. Remove it any time; the project works without it.")}</p>
        {desktop() && !isRemote() ? (
          <div className="row wrap">
            <button type="button" className="primary" onClick={() => void connect(false)}>{L("בחירת תיקיית פרויקט (GDScript)", "Pick a project folder (GDScript)")}</button>
            <button type="button" onClick={() => void connect(true)}>{L("פרויקט C# (.NET)", "A C# (.NET) project")}</button>
          </div>
        ) : (
          <p className="muted small">{L("חיבור פרויקט נעשה במחשב עצמו. מכאן אפשר לבקש מהצ׳אט: \"חבר את הפרויקט ב-…\".", "Connecting a project is done on the computer itself; from here, ask the chat: \"connect the project in …\".")}</p>
        )}
        <p className="muted small">{st.editors.length ? L(`Godot במחשב: ${st.editors.map((g) => `${g.version}${g.csharp ? " (.NET)" : ""}`).join(", ")}`, `Godot here: ${st.editors.map((g) => `${g.version}${g.csharp ? " (.NET)" : ""}`).join(", ")}`) : L("לא נמצא Godot במחשב.", "No Godot was found on this computer.")}</p>
      </section>
    </div>
  );
}
