import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";
import type { Job } from "./types";
import { desktop } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/**
 * Install into a project (this computer, Windows): KesherAI builds the
 * plugin for the project's engine once and copies it in, so it works in
 * Blueprint-only projects too.
 */
export function InstallIntoProject() {
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
  // The Unreal projects found on this computer, with the plugin version in each: one click installs or updates it (from the phone too).
  const [found, setFound] = useState<{ latest: string; projects: Array<{ name: string; path: string; engine?: string; plugin: string | null; open: boolean }> } | null>(null);
  const loadFound = () => void api<NonNullable<typeof found>>("/api/unreal/projects").then(setFound, () => setFound(null));
  useEffect(loadFound, []);
  useEffect(() => {
    if (info?.job?.state === "done") loadFound();
  }, [info?.job?.state]);
  const bridge = desktop();
  if (!info?.windows) return null;
  const installTo = async (folder: string) => {
    setError("");
    try {
      await api("/api/unreal/install", { method: "POST", body: { project: folder } });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const pick = async () => {
    const folder = await bridge?.pickFolder();
    if (folder) await installTo(folder);
  };
  const job = info.job;
  // Unreal 5.8+: the engine's own MCP server (hundreds of editor tools) for every chat.
  const pickMcp = async () => {
    setError("");
    const folder = await bridge?.pickFolder();
    if (!folder) return;
    try {
      setMcpMsg((await api<{ message: string }>("/api/unreal/mcp-setup", { method: "POST", body: { project: folder } })).message);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="stack ue-install">
      {found && found.projects.length > 0 && (
        <ul className="ue-found">
          {found.projects.map((p) => {
            const current = p.plugin === found.latest;
            return (
              <li key={p.path} className="row">
                <span className="grow" dir="auto" title={p.path}>◆ {p.name}{p.engine ? <span className="muted small"> UE {p.engine}</span> : null}</span>
                <span className="muted small">{p.plugin ? (current ? `✅ ${L("מותקן", "Installed")} ${p.plugin}` : `${L("מותקן", "Installed")} ${p.plugin}`) : L("בלי הפלאגין", "No plugin")}</span>
                {!current && !p.open && <button type="button" className="primary" disabled={running} onClick={() => void installTo(p.path)}>{p.plugin ? L("עדכן", "Update") : L("התקן בלחיצה", "Install")}</button>}
                {!current && p.open && <span className="muted small">{p.plugin ? L("פתוח: \"עדכן אוטומטית\" למעלה", "Open: use \"Update automatically\" above") : L("סגרו את Unreal ואז התקינו", "Close Unreal, then install")}</span>}
              </li>
            );
          })}
        </ul>
      )}
      <div className="row">
        {bridge && <button type="button" onClick={() => void pickMcp()}>🤖 {L("חבר את הצ'אטים ל-Unreal 5.8+ (MCP)…", "Connect chats to Unreal 5.8+ (MCP)…")}</button>}
        <span className="muted small">{L("מפעיל בפרויקט את שרת ה-MCP הרשמי של Unreal (כלים לשחקנים, Blueprints, חומרים, Niagara, Sequencer ועוד), כך שכל צ'אט יכול לעבוד בעורך הפתוח.", "Turns on Unreal's official MCP server in the project (tools for actors, Blueprints, materials, Niagara, Sequencer and more), so any chat can work in the open editor.")}</span>
      </div>
      {mcpMsg && <p className="pill">{mcpMsg}</p>}
      <div className="row">
        {bridge && <button type="button" disabled={running} onClick={() => void pick()}>📁 {L("התקן לתוך פרויקט אחר…", "Install into another project…")}</button>}
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
