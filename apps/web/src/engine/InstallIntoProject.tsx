import { useEffect, useState } from "react";
import { api, isRemote } from "../api";
import { getLocale, he$ } from "../i18n";
import type { Job } from "./types";
import { desktop, toast } from "../library";
import { ConvertWithAI, unsupportedOf, type Unsupported } from "./ConvertWithAI";
import { ConvertedCopy } from "./ConvertedCopy";

/** One project in "Install in all projects" (packages/core/src/unreal-install.ts, BatchItem). */
interface BatchItem { name: string; path: string; engine?: string; state: "queued" | "installing" | "done" | "skipped" | "unsupported" | "failed"; message?: string; errors?: string[]; mcp?: boolean }

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/**
 * Install into a project (this computer, Windows): KesherAI builds the
 * plugin for the project's engine once and copies it in, so it works in
 * Blueprint-only projects too.
 */
export function InstallIntoProject() {
  const [mcpMsg, setMcpMsg] = useState("");
  const [info, setInfo] = useState<{ engines: Array<{ version: string; path: string }>; job: Job | null; batch?: { running: boolean; items: BatchItem[] } | null; windows: boolean } | null>(null);
  // An engine the plugin does not support, from the last single install (offers "Convert with AI").
  const [unsupported, setUnsupported] = useState<(Unsupported & { project?: string }) | null>(null);
  const [error, setError] = useState("");
  const load = () => void api<NonNullable<typeof info>>("/api/unreal/engines").then(setInfo, () => setInfo(null));
  useEffect(load, []);
  const running = info?.job?.state === "building" || info?.job?.state === "copying" || !!info?.batch?.running;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, [running]);
  // The Unreal projects found on this computer, with the plugin version in each: one click installs or updates it (from the phone too).
  const [found, setFound] = useState<{ latest: string; projects: Array<{ name: string; path: string; engine?: string; plugin: string | null; open: boolean; support?: { supported: boolean; full: boolean } }> } | null>(null);
  const loadFound = () => void api<NonNullable<typeof found>>("/api/unreal/projects").then(setFound, () => setFound(null));
  useEffect(loadFound, []);
  useEffect(() => {
    if (info?.job?.state === "done" || info?.batch?.running === false) loadFound();
  }, [info?.job?.state, info?.batch?.running]);
  const bridge = desktop();
  if (!info?.windows) return null;
  const installTo = async (folder: string) => {
    setError("");
    setUnsupported(null);
    try {
      await api("/api/unreal/install", { method: "POST", body: { project: folder } });
      load();
    } catch (e) {
      setError((e as Error).message);
      const u = unsupportedOf(e);
      if (u) setUnsupported({ ...u, project: folder.split(/[\\/]/).pop() });
    }
  };
  // "Install in all projects": one after another, each with its engine version and result (from the phone too).
  const installAll = async () => {
    setError("");
    try {
      await api("/api/unreal/install-all", { method: "POST" });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const mcpFor = async (folder: string) => {
    setError("");
    try {
      setMcpMsg((await api<{ message: string }>("/api/unreal/mcp-setup", { method: "POST", body: { project: folder } })).message);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const needing = found ? found.projects.filter((p) => p.plugin !== found.latest && !p.open && p.support?.supported !== false).length : 0;
  const batch = info.batch;
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
      {found && found.projects.length > 1 && (
        <div className="row wrap">
          <button type="button" className="primary" disabled={running || needing === 0} onClick={() => void installAll()}>⇊ {L("התקן בכל הפרויקטים", "Install in all projects")}</button>
          <span className="muted small">{needing ? L(`${needing} פרויקטים צריכים את הפלאגין ${found.latest}; פרויקטים שכבר מעודכנים מדולגים.`, `${needing} projects need plugin ${found.latest}; projects already on it are skipped.`) : L("כל הפרויקטים מעודכנים.", "Every project is up to date.")}</span>
        </div>
      )}
      {batch && batch.items.length > 0 && (
        <ul className="ue-found ue-batch" aria-label={L("התקנה בכל הפרויקטים", "Install in all projects")}>
          {batch.items.map((b) => (
            <li key={b.path} className="row">
              <span className="grow" dir="auto" title={b.path}>{({ queued: "…", installing: "⚙", done: "✅", skipped: "↷", unsupported: "⚠", failed: "⛔" } as const)[b.state]} {b.name}{b.engine ? <span className="muted small" dir="ltr"> UE {b.engine}</span> : null}</span>
              <span className="muted small">{({ queued: L("בתור", "Queued"), installing: L("בונה ומתקין…", "Building and installing…"), done: L("הותקן", "Installed"), skipped: L("דולג", "Skipped"), unsupported: L("גרסה לא נתמכת", "Version not supported"), failed: L("נכשל", "Failed") } as const)[b.state]}{b.message && b.state === "failed" ? ` · ${b.message}` : ""}</span>
              {(b.state === "unsupported" || (b.state === "failed" && b.errors?.length)) && b.engine && <ConvertWithAI engine="unreal" version={b.engine} project={b.name} {...(b.errors ? { errors: b.errors } : {})} />}
              {b.mcp && b.state === "done" && !isRemote() && <button type="button" onClick={() => void mcpFor(b.path)}>🤖 {L("חבר MCP (5.8+)", "Connect MCP (5.8+)")}</button>}
            </li>
          ))}
        </ul>
      )}
      {found && found.projects.length > 0 && (
        <ul className="ue-found">
          {found.projects.map((p) => {
            const current = p.plugin === found.latest;
            return (
              <li key={p.path} className="row">
                <span className="grow" dir="auto" title={p.path}>◆ {p.name}{p.engine ? <span className="muted small"> UE {p.engine}</span> : null}</span>
                <span className="muted small">{p.plugin ? (current ? `✅ ${L("מותקן", "Installed")} ${p.plugin}` : `${L("מותקן", "Installed")} ${p.plugin}`) : L("בלי הפלאגין", "No plugin")}</span>
                {!current && !p.open && p.support?.supported !== false && <button type="button" className="primary" disabled={running} onClick={() => void installTo(p.path)}>{p.plugin ? L("עדכן", "Update") : L("התקן בלחיצה", "Install")}</button>}
                {p.support?.supported === false && p.engine && <ConvertWithAI engine="unreal" version={p.engine} project={p.name} />}
                {p.support?.full && !isRemote() && <button type="button" onClick={() => void mcpFor(p.path)} title={L("שרת ה-MCP הרשמי של Unreal 5.8+", "Unreal 5.8+'s own MCP server")}>🤖 MCP</button>}
                {!p.open && !isRemote() && <button type="button" disabled={running} onClick={() => void api("/api/unreal/open-editor", { method: "POST", body: { project: p.path } }).then(() => toast(L("Unreal נפתח… (בפעם הראשונה זה לוקח דקה ומעלה)", "Opening Unreal… (a minute or more the first time)")), (e: Error) => toast(e.message))}>{L("פתח ב-Unreal", "Open in Unreal")}</button>}
                {!current && p.open && <span className="muted small">{p.plugin ? L("פתוח: \"עדכן אוטומטית\" למעלה", "Open: use \"Update automatically\" above") : L("סגרו את Unreal ואז התקינו", "Close Unreal, then install")}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {found && found.projects.length > 0 && <ConvertedCopy engine="unreal" projects={found.projects.filter((p) => !p.open)} />}
      <div className="row">
        {bridge && <button type="button" onClick={() => void pickMcp()}>🤖 {L("חבר את הצ'אטים ל-Unreal 5.8+ (MCP)…", "Connect chats to Unreal 5.8+ (MCP)…")}</button>}
        <span className="muted small">{L("מפעיל בפרויקט את שרת ה-MCP הרשמי של Unreal (כלים לשחקנים, Blueprints, חומרים, Niagara, Sequencer ועוד), כך שכל צ'אט יכול לעבוד בעורך הפתוח.", "Turns on Unreal's official MCP server in the project (tools for actors, Blueprints, materials, Niagara, Sequencer and more), so any chat can work in the open editor.")}</span>
      </div>
      {mcpMsg && <p className="pill">{mcpMsg}</p>}
      <div className="row">
        {bridge && <button type="button" disabled={running} onClick={() => void pick()}>📁 {L("התקן לתוך פרויקט אחר…", "Install into another project…")}</button>}
        <span className="muted small">{L("עובד גם בפרויקט Blueprint בלבד, בלי \u2066C++\u2069. ", "Works in Blueprint-only projects too, no C++. ")}{info.engines.length ? `${L("נמצאו", "Found")}: UE ${info.engines.map((e) => e.version).join(", ")}` : L("לא נמצא Unreal במחשב.", "No Unreal found on this computer.")}</span>
      </div>
      {job && (
        <div className="stack">
          <p className={job.state === "failed" ? "error" : job.state === "done" ? "pill good" : "muted"}>
            {job.state === "building" ? `⚙ ${L(`בונה את הפלאגין ל-Unreal ${job.engine} (פעם אחת לכל גרסה, כמה דקות)…`, `Building the plugin for Unreal ${job.engine} (once per version, a few minutes)…`)}` : job.state === "copying" ? L("מעתיק לפרויקט…", "Copying into the project…") : job.state === "done" ? `✅ ${job.message ?? ""}` : `⛔ ${job.message ?? ""}`}
          </p>
          {(running || job.state === "failed") && job.log.length > 0 && <pre className="ue-log" dir="ltr">{job.log.slice(-12).join("\n")}</pre>}
          {job.state === "failed" && !!job.errors?.length && !batch?.running && <ConvertWithAI engine="unreal" version={job.engine} errors={job.errors} project={job.project.split(/[\\/]/).pop()} />}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {unsupported && <ConvertWithAI {...unsupported} />}
    </div>
  );
}
