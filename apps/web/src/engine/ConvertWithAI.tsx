import { useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { LocalAgentNotice } from "../LocalAgentNotice";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** An engine version a plugin does not support, as the server reports it (`unsupported` in an error's body). */
export interface Unsupported {
  engine: "unity" | "unreal";
  version: string;
}

/**
 * Reads `unsupported` from an API error's body (POST /api/unreal/install, /api/unity/install).
 *
 * @param e - The caught error.
 * @returns The engine and version, or undefined.
 */
export function unsupportedOf(e: unknown): Unsupported | undefined {
  const u = (e as { body?: { unsupported?: Partial<Unsupported> } }).body?.unsupported;
  return u && (u.engine === "unity" || u.engine === "unreal") && typeof u.version === "string" ? { engine: u.engine, version: u.version } : undefined;
}

/**
 * "Convert with AI" (Roee, 2026-11-21): for an engine version the plugin does not support, or after it failed to
 * compile, a task in the task inbox converts a copy of the plugin (Antigravity with one Run tap, or the local model).
 * A clear warning first: it may not work well; a copy is made and the original plugin is untouched. Works from the
 * phone too (the task runs on the computer).
 *
 * @param props.engine - Unity or Unreal.
 * @param props.version - The target engine version.
 * @param props.project - The project's name (shown, and named in the task).
 * @param props.errors - The compiler's errors, when it was built and failed.
 */
export function ConvertWithAI({ engine, version, project, errors }: Unsupported & { project?: string; errors?: string[] }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ id: string; executor: string } | null>(null);
  const [error, setError] = useState("");
  const what = engine === "unity" ? L("חבילת KesherAI ל-Unity", "the KesherAI Unity package") : L("תוסף KesherAI ל-Unreal", "the KesherAI Unreal plugin");
  const label = `${engine === "unity" ? "Unity" : "Unreal"} ${version}`;
  const send = async (executor: "antigravity" | "local") => {
    setBusy(true);
    setError("");
    try {
      setDone(await api<{ id: string; executor: string }>("/api/engine-plugins/convert", { method: "POST", body: { engine, version, project, errors, executor } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (done)
    return (
      <>
      <p className="pill good convert-ai-done">
        ✅ {L(`משימה ${done.id} נוספה לתיבת המשימות`, `Task ${done.id} added to the task inbox`)}
        {" · "}
        {done.executor === "antigravity" ? L("לחצו Run במחשב כדי להתחיל", "Press Run on the computer to start") : L("המודל המקומי ייקח אותה מלוח המשימות", "The local model takes it from the task board")}
      </p>
      {/* A local task only runs while self-work does: say so, with a Start button (never started silently). */}
      {done.executor === "local" && <LocalAgentNotice />}
      </>
    );
  if (!open) return <button type="button" className="convert-ai-open" onClick={() => setOpen(true)}>✨ {L("המר עם AI", "Convert with AI")}</button>;
  return (
    <div className="convert-ai" role="alertdialog" aria-label={L("המרה עם AI", "Convert with AI")}>
      <strong>⚠ {L(`${label} לא נתמך עדיין`, `${label} is not supported yet`)}</strong>
      <p className="small">{L(`הקוד פתוח, אז AI יכול לנסות להמיר את ${what} ל-${label}. ייתכן שזה לא יעבוד טוב: ההמרה נעשית אוטומטית ולא נבדקה על הגרסה הזאת.`, `The code is open source, so AI can try to convert ${what} to ${label}. It may not work well: the conversion is automatic and has not been tested on this version.`)}</p>
      <ul className="small">
        <li>{L("נוצר עותק נפרד; התוסף המקורי לא משתנה.", "A separate copy is made; the original plugin is untouched.")}</li>
        <li>{L("התוצאה נשמרת בענף משלה לבדיקה לפני שמשתמשים בה.", "The result lands on its own branch for review before you use it.")}</li>
        {errors && errors.length > 0 && <li>{L(`שגיאות הקומפילציה (${errors.length}) נשלחות עם המשימה.`, `The ${errors.length} compile errors go with the task.`)}</li>}
      </ul>
      <div className="row wrap">
        <button type="button" className="primary" disabled={busy} onClick={() => void send("antigravity")}>{L("המר ב-Antigravity (לחיצת Run אחת)", "Convert in Antigravity (one Run tap)")}</button>
        <button type="button" disabled={busy} onClick={() => void send("local")}>{L("המר במודל המקומי", "Convert with the local model")}</button>
        <button type="button" className="link" disabled={busy} onClick={() => setOpen(false)}>{L("ביטול", "Cancel")}</button>
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
