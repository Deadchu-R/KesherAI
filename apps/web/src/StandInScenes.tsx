import { useEffect, useMemo, useRef, useState } from "react";
import { api, isRemote } from "./api";
import { getLocale, he$ } from "./i18n";
import { desktop, toast } from "./library";
import { cmpVersion, installOf, orderProjects, pluginAtLeast, type InstallPoll, type StandInProject } from "./standin-levels";

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
  // Why a project shows no scenes (the server says: empty Assets, no .unity files…).
  const [note, setNote] = useState("");
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
    void api<{ scenes: string[]; note?: string; reason?: "empty" | "none"; files?: number }>(`${e.list}?project=${encodeURIComponent(dir)}`).then((r) => { setScenes(r.scenes); setNote(r.reason === "empty" ? L("תיקיית Assets ריקה: ייתכן שהקבצים עוד יורדים, או שהם בתיקייה אחרת.", "Assets is empty: the files may still be downloading, or they are in another folder.") : r.reason === "none" ? L(`אין קובצי סצנה (.unity) ב-Assets או ב-Packages (נבדקו ${r.files ?? 0} קבצים). סצנה שלא נשמרה ב-Unity עדיין אין לה קובץ.`, `No .unity scene files under Assets or Packages (${r.files ?? 0} files looked at). A scene never saved in Unity has no file yet.`) : (r.note ?? "")); }, (er: Error) => { setScenes(null); setNote(""); toast(er.message); });
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
      {found && found.length > 0 && <p className="muted small">{L(`נמצאו ${found.length} פרויקטים במחשב`, `${found.length} projects found on the computer`)}</p>}
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
      ) : <p className="muted small">{L("אין סצנות בפרויקט.", "No scenes in this project.")}{note && <span dir="auto"> {note}</span>}</p>)}
    </section>
  );
}

/** How many levels each project is known to have, kept while the page is open (so the cards show it again, and sort by it). */
const knownLevels = new Map<string, number>();

/** "N levels" in both languages (Hebrew has its own one and two). */
const levelsWord = (n: number) => (n === 1 ? L("רמה אחת", "1 level") : n === 2 ? L("שתי רמות", "2 levels") : L(`${n} רמות`, `${n} levels`));

/**
 * An Unreal level without Unreal: the Unreal projects on the computer, each with its plugin's version. Tapping a
 * project always lists its levels (read in a background editor when the plugin is there, else from the .umap files
 * on disk); a separate small button on the card installs or updates the plugin. Each level opens in the 3D editor as
 * a stand-in; with the plugin missing or old it first offers the install and, when that finishes, the level.
 * From the phone the same, without paths.
 */
export function StandInLevels() {
  /** The plugin version that reads a level's contents. */
  const NEED = "0.1.23";
  const [projects, setProjects] = useState<StandInProject[] | null>(null);
  /** The newest plugin version the server has (the "Update to …" button). */
  const [latest, setLatest] = useState(NEED);
  const [chosen, setChosen] = useState("");
  const chosenRef = useRef("");
  const [levels, setLevels] = useState<string[] | null>(null);
  /** The levels came from the files on disk (no editor read them). */
  const [fromDisk, setFromDisk] = useState(false);
  /** How many assets a project with no levels has (the server counted them), when it said. */
  const [assets, setAssets] = useState<number | undefined>();
  const [busy, setBusy] = useState("");
  /** The project whose plugin is being installed now (the engines answer is polled until it finishes). */
  const [installing, setInstalling] = useState("");
  const [installFailed, setInstallFailed] = useState("");
  /** The level tapped while the plugin was missing or old: the prompt stays, and "Open the level" comes after the install. */
  const [need, setNeed] = useState("");
  /** Counts shown on the cards: a re-render when one is learned. */
  const [, bump] = useState(0);
  const loadProjects = () => void api<{ latest?: string; projects: StandInProject[] }>("/api/unreal/projects").then((r) => { setProjects(r.projects); if (r.latest) setLatest(r.latest); }, () => setProjects([]));
  useEffect(loadProjects, []);
  // The order is set when the list loads (what is known then), so cards do not jump under a finger as counts come in.
  const ordered = useMemo(() => orderProjects(projects ?? [], knownLevels, NEED), [projects]);
  const ready = (p: StandInProject | undefined) => pluginAtLeast(p?.plugin ?? null, NEED);
  const chosenProject = projects?.find((p) => p.path === chosen);
  const chosenReady = ready(chosenProject);
  const open = (path: string) => {
    chosenRef.current = path;
    setChosen(path);
    setLevels(null);
    setFromDisk(false);
    setAssets(undefined);
    setNeed("");
    setBusy(path);
    void api<{ levels: string[]; fromDisk?: boolean; assets?: number }>(`/api/unreal/levels?project=${encodeURIComponent(path)}`).then((r) => {
      // A slower answer for a project the person has left does not replace the one on screen.
      if (chosenRef.current === path) { setLevels(r.levels ?? []); setFromDisk(!!r.fromDisk); setAssets(r.assets); }
      knownLevels.set(path, r.levels?.length ?? 0);
      bump((n) => n + 1);
    }, (er: Error) => toast(er.message)).finally(() => setBusy((b) => (b === path ? "" : b)));
  };
  const install = (path: string) => {
    setInstallFailed("");
    setInstalling(path);
    void api("/api/unreal/install", { method: "POST", body: { project: path } }).then(() => toast(L("מתקין את התוסף… (הבנייה לוקחת כמה דקות)", "Installing the plugin… (it builds for a few minutes)")), (er: Error) => { setInstalling(""); setInstallFailed(er.message); toast(er.message); });
  };
  // While an install runs: ask the engines answer (a single job, or "install in all") until it ends, then reload the
  // projects, so the card shows the new plugin version and the waiting level can open.
  useEffect(() => {
    if (!installing) return;
    const timer = setInterval(() => void api<InstallPoll>("/api/unreal/engines").then((r) => {
      const st = installOf(r, installing);
      if (st.state === "running") return;
      setInstalling("");
      if (st.state === "failed") setInstallFailed(st.message ?? L("ההתקנה נכשלה.", "The install failed."));
      loadProjects();
    }, () => undefined), 3000);
    return () => clearInterval(timer);
  }, [installing]);
  const installLabel = (p: StandInProject) => (p.plugin ? L(`לעדכן לגרסה ${latest}`, `Update to ${latest}`) : L("להתקין תוסף", "Install plugin"));
  const levelHref = (l: string) => `#/p/model-editor/editor?ul=${encodeURIComponent(l)}&upj=${encodeURIComponent(chosen)}`;
  const installBar = (p: StandInProject) => (
    <button type="button" className="standin-install small" disabled={!!installing} onClick={() => install(p.path)}>
      {installing === p.path ? L("מתקין…", "Installing…") : installLabel(p)}
    </button>
  );
  return (
    <section className="card">
      <strong>{L("רמה בלי Unreal", "A level without Unreal")}</strong>
      <p className="small muted">{L(`פותחים רמה בעורך התלת ממד כתחליף, עם הצורות האמיתיות, ומזיזים. כש-Unreal פתוח השינויים נכנסים בצעד ביטול אחד; כשהוא סגור, עורך ברקע שומר אותם (תוסף ${NEED}).`, `Open a level in the 3D editor as a stand-in, with the real shapes, and move things. With Unreal open the moves go in as one undo step; with it closed, a background editor saves them (plugin ${NEED}).`)}</p>
      {projects && projects.length > 0 && (
        <div className="standin-projects" role="list" aria-label={L("הפרויקטים במחשב", "Projects on the computer")}>
          {ordered.map((p) => {
            const n = knownLevels.get(p.path);
            const status = [p.engine ? `Unreal ${p.engine}` : "", busy === p.path ? "…" : p.plugin ? (ready(p) ? L(`תוסף ${p.plugin}`, `plugin ${p.plugin}`) : L(`תוסף ${p.plugin} (ישן)`, `plugin ${p.plugin} (old)`)) : L("בלי תוסף", "no plugin"), n === undefined ? "" : n ? levelsWord(n) : L("בלי רמות", "no levels")].filter(Boolean).join(" · ");
            return (
              <div key={p.path} role="listitem" className="standin-card">
                {/* The path is the computer's own: not shown on the phone. */}
                <button type="button" className={`standin-open${p.path === chosen ? " on" : ""}`} {...(isRemote() ? {} : { title: p.path })} disabled={busy === p.path} onClick={() => open(p.path)}>
                  <b dir="auto">{p.name}</b>
                  <span className="muted small" dir="auto">{status}</span>
                </button>
                {(!p.plugin || p.plugin === "?" || cmpVersion(p.plugin, latest) < 0) && installBar(p)}
              </div>
            );
          })}
        </div>
      )}
      {projects && projects.length > 0 && <p className="muted small">{L(`נמצאו ${projects.length} פרויקטים במחשב`, `${projects.length} projects found on the computer`)}</p>}
      {projects && !projects.length && <p className="muted small">{L("לא מצאתי פרויקטים של Unreal במחשב.", "No Unreal projects found on the computer.")}</p>}
      {busy && busy === chosen && <p className="muted small">{chosenReady ? L("קורא את הרמות… (כש-Unreal סגור זה מריץ אותו ברקע, עד דקה וחצי בפעם הראשונה)", "Reading the levels… (with Unreal closed it runs in the background, up to a minute and a half the first time)") : L("קורא את הרמות מהקבצים…", "Reading the levels from the files…")}</p>}
      {installFailed && <p className="small" role="alert" dir="auto">{installFailed}</p>}
      {levels && (levels.length ? (
        <>
          {fromDisk && <p className="muted small standin-note">{L("מהקבצים · פתיחת רמה צריכה את התוסף", "from the files · opening a level needs the plugin")}</p>}
          <div className="standin-scenes">
            {levels.map((l) => (
              // Without the plugin (or an old one) the tap asks for the install instead of failing in the editor later.
              <a key={l} className="button" dir="ltr" href={levelHref(l)} onClick={(ev) => { if (!chosenReady) { ev.preventDefault(); setNeed(l); } }}>{l.replace(/^\/Game\//, "")}</a>
            ))}
          </div>
        </>
      ) : <p className="muted small standin-none" dir="auto">{L("אין קבצי רמה (.umap) בתיקיית Content — הפרויקט כולל רק נכסים", "No level files (.umap) in Content — this project only has assets")}{assets ? L(` (${assets} נכסים)`, ` (${assets} assets)`) : ""}</p>)}
      {need && chosenProject && (chosenReady ? (
        <div className="standin-need">
          <a className="button primary" dir="auto" href={levelHref(need)}>{L("לפתוח את הרמה", "Open the level")} · <span dir="ltr">{need.replace(/^\/Game\//, "")}</span></a>
        </div>
      ) : (
        <div className="standin-need" role="status">
          <p className="small" dir="auto">{L("כדי לראות מה יש ברמה הזו, KesherAI צריך את התוסף שלו בפרויקט.", "To see this level's contents KesherAI needs its plugin in this project.")}</p>
          <button type="button" className="primary" disabled={!!installing} onClick={() => install(chosenProject.path)}>
            {installing === chosenProject.path ? L("מתקין… (כמה דקות)", "Installing… (a few minutes)") : L("להתקין (כמה דקות)", "Install (a few minutes)")}
          </button>
        </div>
      ))}
    </section>
  );
}
