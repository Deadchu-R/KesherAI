import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** A finished "Convert with AI" task (packages/core/src/engine-conversion.ts, ReadyCopy). */
interface Ready {
  taskId: string;
  version: string;
  copy: string;
  filesChanged: number;
  added: number;
  removed: number;
  files: Array<{ path: string; added: number; removed: number }>;
  runBy: string;
}
/** GET /api/engine-plugins/converted. */
interface Info {
  ready: Ready[];
  installed: Array<{ path: string; name: string; marker: { taskId: string; version: string } }>;
  job: { project: string; taskId: string; state: "reading" | "installing" | "done" | "failed"; message?: string; errors?: string[] } | null;
}

/** "2020.3.48f1" / "4.27" → "2020.3" / "4.27". */
const majorMinor = (v?: string) => /(\d+)\.(\d+)/.exec(v ?? "")?.slice(1, 3).join(".");

/**
 * An AI-converted plugin copy, from ready to installed (Roee, 2026-11-21). "Convert with AI" only makes a branch; when
 * its task is done this shows "AI-converted plugin for <version> is ready", with "Review" (the diff summary and a
 * warning) and "Install this copy" (Unity: copied into Packages; Unreal: built for the project's engine, then copied).
 * Nothing is installed without the press. "Revert to none" removes the copy again. Only projects KesherAI found on
 * the computer are offered, so it works from the phone too (the install runs on the computer).
 *
 * @param props.engine - Unity or Unreal.
 * @param props.projects - The projects shown, with their engine versions (a copy is offered only to a project of its version).
 */
export function ConvertedCopy({ engine, projects }: { engine: "unity" | "unreal"; projects: Array<{ name: string; path: string; engine?: string | undefined }> }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [review, setReview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = () => void api<Info>(`/api/engine-plugins/converted?engine=${engine}`).then(setInfo, () => setInfo(null));
  useEffect(() => {
    load();
    const id = setInterval(load, info?.job && (info.job.state === "reading" || info.job.state === "installing") ? 3000 : 20000);
    return () => clearInterval(id);
  }, [engine, info?.job?.state]);
  if (!info) return null;
  const name = engine === "unity" ? "Unity" : "Unreal";
  const post = async (path: string, body: Record<string, string>, done: string) => {
    setBusy(true);
    setError("");
    try {
      await api(`/api/engine-plugins/converted/${path}`, { method: "POST", body: { engine, ...body } });
      toast(done);
      load();
      if (engine === "unity") dispatchEvent(new Event("kesher-unity-added"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const running = info.job?.state === "reading" || info.job?.state === "installing";
  const installed = info.installed.filter((i) => projects.some((p) => p.path === i.path));
  const ready = info.ready.filter((r) => projects.some((p) => majorMinor(p.engine) === majorMinor(r.version)));
  if (!installed.length && !ready.length && !info.job) return null;
  return (
    <div className="stack converted-copy">
      {installed.map((i) => (
        <div key={i.path} className="row wrap converted-installed">
          <span className="pill warn grow" dir="auto">⚠ {L(`מותקן עותק שהומר ב-AI ל-${name} ${i.marker.version} ב-${i.name}`, `An AI-converted copy for ${name} ${i.marker.version} is installed in ${i.name}`)}</span>
          <button type="button" disabled={busy || running} onClick={() => void post("revert", { project: i.path }, L("העותק שהומר הוסר", "The converted copy was removed"))}>↩ {L("חזרה לבלי (הסרה)", "Revert to none")}</button>
        </div>
      ))}
      {ready.map((r) => {
        const targets = projects.filter((p) => majorMinor(p.engine) === majorMinor(r.version));
        const open = review === r.taskId;
        return (
          <div key={r.taskId} className="convert-ai converted-ready" role="group" aria-label={L("עותק שהומר ב-AI", "AI-converted copy")}>
            <strong>✨ {L(`תוסף שהומר ב-AI ל-${name} ${majorMinor(r.version)} מוכן`, `AI-converted plugin for ${name} ${majorMinor(r.version)} is ready`)}</strong>
            <p className="small">{L(`${r.filesChanged} קבצים (+${r.added} −${r.removed}), ${r.runBy === "antigravity" ? "Antigravity" : "המודל המקומי"}.`, `${r.filesChanged} files (+${r.added} −${r.removed}), by ${r.runBy === "antigravity" ? "Antigravity" : "the local model"}.`)}</p>
            {!open && <div className="row"><button type="button" onClick={() => setReview(r.taskId)}>{L("סקירה", "Review")}</button></div>}
            {open && (
              <>
                <ul className="small" dir="ltr">
                  {r.files.map((f) => <li key={f.path}>{f.path} <span className="muted">+{f.added} −{f.removed}</span></li>)}
                  {r.filesChanged > r.files.length && <li className="muted">… {r.filesChanged - r.files.length}</li>}
                </ul>
                <p className="small">⚠ {L("הועתק אוטומטית על ידי AI ולא נבדק על הגרסה הזאת: ייתכן שזה לא יעבוד טוב. התוסף המקורי לא משתנה, וכל התקנה אפשר לבטל עם \"חזרה לבלי\". הקוד המלא בענף המשימה לסקירה.", "Converted automatically by AI and not tested on this version: it may not work well. The original plugin is untouched, and the install can be undone with “Revert to none”. The full code is on the task's branch for review.")}</p>
                {engine === "unreal" && <p className="small muted">{L("Unreal יבנה את העותק (כמה דקות, צריך Visual Studio). סגרו את Unreal לפני כן.", "Unreal builds the copy (a few minutes, needs Visual Studio). Close Unreal first.")}</p>}
                <div className="row wrap">
                  {targets.map((p) => (
                    <button key={p.path} type="button" className="primary" disabled={busy || running} onClick={() => void post("install", { taskId: r.taskId, project: p.path }, L("מתקין את העותק…", "Installing the copy…"))}>{L(`התקן עותק זה ב-${p.name}`, `Install this copy in ${p.name}`)}</button>
                  ))}
                  <button type="button" className="link" onClick={() => setReview(null)}>{L("סגור", "Close")}</button>
                </div>
              </>
            )}
          </div>
        );
      })}
      {info.job && (
        <p className={info.job.state === "failed" ? "error" : info.job.state === "done" ? "pill good" : "muted"} dir="auto">
          {info.job.state === "failed" ? "⛔" : info.job.state === "done" ? "✅" : "⚙"} {info.job.project}: {info.job.state === "reading" ? L("קורא את העותק…", "Reading the copy…") : info.job.state === "installing" ? (engine === "unreal" ? L("בונה ומתקין…", "Building and installing…") : L("מתקין…", "Installing…")) : info.job.message ?? ""}
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
