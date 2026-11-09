import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";
import type { Job } from "./types";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/**
 * The plugin updates itself: one press builds the new version while Unreal
 * is open, Unreal asks to save and closes, the plugin is replaced, and the
 * project opens again (from the phone too; the save question shows on the computer).
 */
export function PluginUpdate({ latest, now, download }: { latest: string; now: string; download: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const running = job?.state === "building" || job?.state === "waiting" || job?.state === "copying";
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => void api<{ job: Job | null }>("/api/unreal/engines").then((r) => setJob(r.job), () => undefined), 2000);
    return () => clearInterval(id);
  }, [running]);
  const start = () => void api<{ job: Job }>("/api/unreal/update-plugin", { method: "POST" }).then((r) => setJob(r.job), (e: Error) => toast(e.message));
  const step = job ? { building: L("בונה את הגרסה החדשה (Unreal נשאר פתוח)…", "Building the new version (Unreal stays open)…"), waiting: L("ממתין ש-Unreal ייסגר — אם הוא שואל אם לשמור, ענו במחשב. (פלאגין ישן לא יודע לסגור: סגרו את Unreal כשנוח, והעדכון יסתיים לבד ויפתח אותו מחדש.)", "Waiting for Unreal to close — if it asks to save, answer on the computer. (An older plugin cannot close it: close Unreal when convenient and the update finishes by itself and opens it again.)"), copying: L("מחליף את הפלאגין…", "Replacing the plugin…"), done: job.message ?? L("עודכן.", "Updated."), failed: job.message ?? L("נכשל.", "Failed.") }[job.state] : "";
  return (
    <div className="card row plugin-update">
      <span className="grow small">{L(`גרסה חדשה של הפלאגין: ${latest} (מותקנת ${now}).`, `A newer plugin: ${latest} (installed ${now}).`)} {step && <strong dir="auto">{step}</strong>}</span>
      {!running && job?.state !== "done" && <button type="button" className="primary" onClick={start}>{L("עדכן אוטומטית", "Update automatically")}</button>}
      <a className="small" href={download}>{L("הורדה ידנית", "Download")}</a>
    </div>
  );
}
