import { useEffect, useState } from "react";
import { api, isRemote } from "./api";
import { getLocale, he$ } from "./i18n";
import { desktop, toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** Each engine's words and addresses for the stand-in. */
const ENGINES = {
  godot: {
    name: "Godot",
    list: "/api/godot/scenes",
    open: (project: string, scene: string) => `#/p/model-editor/editor?gp=${encodeURIComponent(project)}&gs=${encodeURIComponent(scene)}`,
    label: (scene: string) => scene.replace(/^res:\/\//, ""),
    folder: ["תיקיית הפרויקט (עם project.godot)", "The project folder (with project.godot)"],
    how: ["פותחים סצנה בעורך התלת ממד כתחליף (עם הצורות האמיתיות), מזיזים, ושומרים חזרה לקובץ ה-.tscn כש-Godot סגור.", "Open a scene in the 3D editor as a stand-in (with the real shapes), move things, and save back into the .tscn while Godot is closed."],
  },
  unity: {
    name: "Unity",
    list: "/api/unity/scenes",
    open: (project: string, scene: string) => `#/p/model-editor/editor?up=${encodeURIComponent(project)}&us=${encodeURIComponent(scene)}`,
    label: (scene: string) => scene.replace(/^Assets\//, ""),
    folder: ["תיקיית הפרויקט (עם Assets)", "The project folder (with Assets)"],
    how: ["פותחים סצנה בעורך התלת ממד כתחליף, מזיזים, וחבילת KesherAI ב-Unity (0.2.9) מכניסה את השינויים כשהסצנה פתוחה, בצעד ביטול אחד.", "Open a scene in the 3D editor as a stand-in, move things, and the KesherAI package in Unity (0.2.9) brings the moves in when the scene is open, as one undo step."],
  },
} as const;

/**
 * A scene without its engine (SceneStandIn board): the project's scenes, each opened in the 3D editor as a stand-in.
 * Works from the phone too (the folder is typed there).
 *
 * @param props.engine - Which engine's scenes.
 * @param props.connectedProject - The project open in the engine now, to start from.
 */
export function StandInScenes({ engine, connectedProject }: { engine: keyof typeof ENGINES; connectedProject?: string }) {
  const e = ENGINES[engine];
  // The folder last used, per viewer (a convenience, not state).
  const key = `kesher-${engine}-standin-project`;
  const remembered = () => { try { return localStorage.getItem(key) ?? ""; } catch { return ""; } };
  const [project, setProject] = useState(remembered() || connectedProject || "");
  const [scenes, setScenes] = useState<string[] | null>(null);
  // The engine's projects found on the computer (its own project list, Unity Hub, the usual folders): one tap shows
  // their scenes, instead of typing a folder each time (asked 2026-11-18); a folder can still be typed below.
  const [found, setFound] = useState<Array<{ name: string; path: string; engine?: string }> | null>(null);
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    void api<{ projects: Array<{ kind: string; name: string; path: string; engine?: string }> }>("/api/game-projects").then((r) => setFound(r.projects.filter((p) => p.kind === engine)), () => setFound([]));
  }, [engine]);
  const list = (dir: string) => {
    if (!dir.trim()) return;
    try { localStorage.setItem(key, dir); } catch { /* private window: only remembered for next time */ }
    void api<{ scenes: string[] }>(`${e.list}?project=${encodeURIComponent(dir)}`).then((r) => setScenes(r.scenes), (er: Error) => { setScenes(null); toast(er.message); });
  };
  const pick = async () => {
    const dir = await desktop()?.pickFolder();
    if (dir) { setProject(dir); list(dir); }
  };
  return (
    <section className="card">
      <strong>{L(`סצנה בלי ${e.name}`, `A scene without ${e.name}`)}</strong>
      <p className="small muted">{L(e.how[0], e.how[1])}</p>
      {found && found.length > 0 && (
        <div className="standin-projects" role="list" aria-label={L("הפרויקטים במחשב", "Projects on the computer")}>
          {found.map((p) => (
            <button key={p.path} type="button" role="listitem" className={p.path === project ? "on" : ""} title={p.path} onClick={() => { setProject(p.path); list(p.path); }}>
              <b dir="auto">{p.name}</b>{p.engine && <span className="muted small" dir="ltr">{p.engine}</span>}
            </button>
          ))}
        </div>
      )}
      {found && !found.length && <p className="muted small">{isRemote() ? L(`לא מצאתי פרויקטים של ${e.name} במחשב. פתח אחד במחשב פעם אחת, והוא יופיע כאן.`, `No ${e.name} projects found on the computer. Open one there once and it shows here.`) : L(`לא מצאתי פרויקטים של ${e.name} במחשב. אפשר לכתוב תיקייה:`, `No ${e.name} projects found on the computer. Type a folder:`)}</p>}
      {/* From the phone only the projects found on the computer (the server checks too); a folder by path is for the computer. */}
      {isRemote() ? null : found && found.length > 0 && !typing ? <button type="button" className="link small" onClick={() => setTyping(true)}>{L("תיקייה אחרת…", "Another folder…")}</button> : (
      <div className="row wrap">
        <input className="grow" dir="ltr" value={project} onChange={(ev) => setProject(ev.target.value)} placeholder={L(e.folder[0], e.folder[1])} aria-label={L("תיקיית הפרויקט", "The project folder")} style={{ minWidth: 0 }} />
        {desktop() && !isRemote() && <button type="button" onClick={() => void pick()}>{L("בחירה…", "Pick…")}</button>}
        <button type="button" className="primary" onClick={() => list(project)}>{L("הצג סצנות", "Show scenes")}</button>
      </div>
      )}
      {scenes && (scenes.length ? (
        <div className="standin-scenes">
          {scenes.map((sc) => <a key={sc} className="button" dir="ltr" href={e.open(project, sc)}>{e.label(sc)}</a>)}
        </div>
      ) : <p className="muted small">{L("אין סצנות בפרויקט.", "No scenes in this project.")}</p>)}
    </section>
  );
}

/**
 * An Unreal level without Unreal: the Unreal projects on the computer, each with its plugin's version; a project with
 * the plugin shows its levels (read in a background editor when Unreal is closed, then kept), one without it offers
 * to install it. Each level opens in the 3D editor as a stand-in.
 */
export function StandInLevels() {
  const NEED = "0.1.23";
  const [projects, setProjects] = useState<Array<{ name: string; path: string; engine?: string; plugin: string | null }> | null>(null);
  const [chosen, setChosen] = useState("");
  const [levels, setLevels] = useState<string[] | null>(null);
  const [busy, setBusy] = useState("");
  const newer = (v: string | null) => !!v && v.split(".").map(Number).reduce((a, x, i) => a || (x !== Number(NEED.split(".")[i]) ? (x > Number(NEED.split(".")[i]) ? 1 : -1) : 0), 0) >= 0;
  const loadProjects = () => void api<{ projects: Array<{ name: string; path: string; engine?: string; plugin: string | null }> }>("/api/unreal/projects").then((r) => setProjects(r.projects), () => setProjects([]));
  useEffect(loadProjects, []);
  const open = (path: string) => {
    setChosen(path);
    setLevels(null);
    setBusy(path);
    void api<{ levels: string[] }>(`/api/unreal/levels?project=${encodeURIComponent(path)}`).then((r) => setLevels(r.levels), (er: Error) => toast(er.message)).finally(() => setBusy(""));
  };
  const install = (path: string) => {
    setBusy(path);
    void api("/api/unreal/install", { method: "POST", body: { project: path } }).then(() => toast(L("מתקין את התוסף… (הבנייה לוקחת כמה דקות, אפשר לראות בדף Unreal)", "Installing the plugin… (it builds for a few minutes; see the Unreal page)")), (er: Error) => toast(er.message)).finally(() => { setBusy(""); setTimeout(loadProjects, 5000); });
  };
  return (
    <section className="card">
      <strong>{L("רמה בלי Unreal", "A level without Unreal")}</strong>
      <p className="small muted">{L(`פותחים רמה בעורך התלת ממד כתחליף, עם הצורות האמיתיות, ומזיזים. כש-Unreal פתוח השינויים נכנסים בצעד ביטול אחד; כשהוא סגור, עורך ברקע שומר אותם (תוסף ${NEED}).`, `Open a level in the 3D editor as a stand-in, with the real shapes, and move things. With Unreal open the moves go in as one undo step; with it closed, a background editor saves them (plugin ${NEED}).`)}</p>
      {projects && projects.length > 0 && (
        <div className="standin-projects" role="list" aria-label={L("הפרויקטים במחשב", "Projects on the computer")}>
          {projects.map((p) => {
            const ok = newer(p.plugin);
            return (
              <button key={p.path} type="button" role="listitem" className={p.path === chosen ? "on" : ""} title={p.path} disabled={busy === p.path} onClick={() => (ok ? open(p.path) : install(p.path))}>
                <b dir="auto">{p.name}</b>
                <span className="muted small" dir="auto">{p.engine ? `Unreal ${p.engine} · ` : ""}{busy === p.path ? "…" : ok ? L(`תוסף ${p.plugin}`, `plugin ${p.plugin}`) : p.plugin ? L(`תוסף ${p.plugin} · לעדכן`, `plugin ${p.plugin} · update`) : L("להתקין את התוסף", "Install the plugin")}</span>
              </button>
            );
          })}
        </div>
      )}
      {projects && !projects.length && <p className="muted small">{L("לא מצאתי פרויקטים של Unreal במחשב.", "No Unreal projects found on the computer.")}</p>}
      {busy && busy === chosen && <p className="muted small">{L("קורא את הרמות… (כש-Unreal סגור זה מריץ אותו ברקע, עד דקה וחצי בפעם הראשונה)", "Reading the levels… (with Unreal closed it runs in the background, up to a minute and a half the first time)")}</p>}
      {levels && (levels.length ? (
        <div className="standin-scenes">
          {levels.map((l) => <a key={l} className="button" dir="ltr" href={`#/p/model-editor/editor?ul=${encodeURIComponent(l)}&upj=${encodeURIComponent(chosen)}`}>{l.replace(/^\/Game\//, "")}</a>)}
        </div>
      ) : <p className="muted small">{L("אין רמות בפרויקט.", "No levels in this project.")}</p>)}
    </section>
  );
}
