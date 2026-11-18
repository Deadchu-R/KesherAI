import { useState } from "react";
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
    how: ["פותחים סצנה בעורך התלת ממד כתחליף (כל אובייקט כקופסה), מזיזים, ושומרים חזרה לקובץ ה-.tscn כש-Godot סגור.", "Open a scene in the 3D editor as a stand-in (each object a box), move things, and save back into the .tscn while Godot is closed."],
  },
  unity: {
    name: "Unity",
    list: "/api/unity/scenes",
    open: (project: string, scene: string) => `#/p/model-editor/editor?up=${encodeURIComponent(project)}&us=${encodeURIComponent(scene)}`,
    label: (scene: string) => scene.replace(/^Assets\//, ""),
    folder: ["תיקיית הפרויקט (עם Assets)", "The project folder (with Assets)"],
    how: ["פותחים סצנה בעורך התלת ממד כתחליף, מזיזים, וחבילת KesherAI ב-Unity (0.2.8) מכניסה את השינויים כשהסצנה פתוחה, בצעד ביטול אחד.", "Open a scene in the 3D editor as a stand-in, move things, and the KesherAI package in Unity (0.2.8) brings the moves in when the scene is open, as one undo step."],
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
      <div className="row wrap">
        <input className="grow" dir="ltr" value={project} onChange={(ev) => setProject(ev.target.value)} placeholder={L(e.folder[0], e.folder[1])} aria-label={L("תיקיית הפרויקט", "The project folder")} style={{ minWidth: 0 }} />
        {desktop() && !isRemote() && <button type="button" onClick={() => void pick()}>{L("בחירה…", "Pick…")}</button>}
        <button type="button" className="primary" onClick={() => list(project)}>{L("הצג סצנות", "Show scenes")}</button>
      </div>
      {scenes && (scenes.length ? (
        <div className="standin-scenes">
          {scenes.map((sc) => <a key={sc} className="button" dir="ltr" href={e.open(project, sc)}>{e.label(sc)}</a>)}
        </div>
      ) : <p className="muted small">{L("אין סצנות בפרויקט.", "No scenes in this project.")}</p>)}
    </section>
  );
}
