import { useEffect, useState } from "react";
import { api, isRemote } from "./api";
import { getLocale, he$ } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

type Name = "engines" | "worker" | "unreal" | "outputs";
interface Info {
  dir?: string;
  saved: boolean;
  folders: Array<{ name: Name; bytes: number; linked: boolean }>;
  pending: Array<{ name: Name; to: string }>;
  copy: { running: boolean; bytes: number; bytesDone: number; error?: string; ready: Name[] };
  canRestart: boolean;
}

const LABEL: Record<Name, [string, string]> = {
  engines: ["מנועים (Python, ComfyUI, קול, הנעת שפתיים)", "Engines (Python, ComfyUI, voice, lip sync)"],
  worker: ["עבודה עצמית", "Self-work"],
  unreal: ["Unreal (תוספים שנבנו)", "Unreal (built plugins)"],
  outputs: ["תוצרים (תמונות, סרטונים)", "Outputs (pictures, videos)"],
};

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;

/**
 * Settings → Computer: the folder for heavy things (heavy-folder.ts). Engines and other big folders move to another
 * drive; links keep the old paths working, and what is added later lands there. This computer only.
 */
export function HeavyFolderSection() {
  const [info, setInfo] = useState<Info | null>(null);
  const [dir, setDir] = useState("");
  const load = () => void api<Info>("/api/heavy").then((i) => { setInfo(i); setDir((d) => d || i.dir || ""); }, () => undefined);
  useEffect(load, []);
  useEffect(() => {
    if (!info?.copy.running) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [info?.copy.running]);
  if (isRemote() || !info) return null;
  const onC = info.folders.filter((f) => !f.linked && f.bytes > 0 && !info.pending.some((p) => p.name === f.name));
  const move = async () => {
    try {
      await api("/api/heavy", { method: "POST", body: { dir, names: onC.map((f) => f.name) } });
      load();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const c = info.copy;
  const restart = async (closeEditors: boolean) => {
    try {
      await api("/api/heavy/restart", { method: "POST", body: { closeEditors } });
    } catch (e) {
      const err = e as { code?: string; category?: string; message: string };
      if (err.code === "editors-open") {
        if (confirm(L(`כדי להעביר את המנועים צריך לסגור: ${err.category ?? ""}. שמור שם עבודה פתוחה, ואז לחץ אישור וקשר יסגור אותם.`, `To move the engines these must close: ${err.category ?? ""}. Save any open work there, then press OK and KesherAI closes them.`))) await restart(true);
      } else toast(err.message);
    }
  };
  return (
    <section className="card stack">
      <h2>{L("תיקייה לדברים כבדים", "Folder for heavy things")}</h2>
      <p className="muted small">{L("מנועים, הורדות ותוצרים גדולים נשמרים כאן, לא בכונן של Windows. הנתיבים הישנים ממשיכים לעבוד (קיצור דרך לתיקייה החדשה).", "Engines, downloads and big outputs are kept here, not on the Windows drive. The old paths keep working (a link to the new folder).")}</p>
      <input dir="ltr" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="E:\KesherAI" aria-label={L("התיקייה לדברים כבדים", "Folder for heavy things")} />
      <ul className="plain stack small">
        {info.folders.map((f) => {
          const waiting = info.pending.some((p) => p.name === f.name);
          return (
            <li key={f.name} className="row">
              <span className="grow">{L(...LABEL[f.name])}</span>
              <span className={f.linked ? "good" : "muted"}>{f.linked ? L("בתיקייה לדברים כבדים ✓", "In the heavy folder ✓") : waiting ? L("הועתק, מחכה להפעלה מחדש", "Copied, waiting for a restart") : f.bytes ? gb(f.bytes) : L("ריק", "Empty")}</span>
            </li>
          );
        })}
      </ul>
      {c.running && (
        <>
          <progress max={c.bytes || 1} value={c.bytesDone} />
          <span className="muted small">{L(`מעתיק… ${gb(c.bytesDone)} מתוך ${gb(c.bytes)}. KesherAI ממשיך לעבוד בזמן ההעתקה.`, `Copying… ${gb(c.bytesDone)} of ${gb(c.bytes)}. KesherAI keeps working meanwhile.`)}</span>
        </>
      )}
      {c.error && <p className="bad small">{c.error}</p>}
      <div className="row wrap">
        {!c.running && onC.length > 0 && <button type="button" className="primary" disabled={!dir.trim()} onClick={() => void move()}>{L(`העבר לשם (${gb(onC.reduce((n, f) => n + f.bytes, 0))})`, `Move there (${gb(onC.reduce((n, f) => n + f.bytes, 0))})`)}</button>}
        {c.running && <button type="button" onClick={() => void api("/api/heavy", { method: "DELETE" }).then(load)}>{L("עצור", "Stop")}</button>}
        {!c.running && info.pending.length > 0 && (info.canRestart
          ? <button type="button" onClick={() => void restart(false)}>{L("הפעל מחדש כדי לסיים", "Restart to finish")}</button>
          : <span className="muted small">{L("הפעל מחדש את KesherAI כדי לסיים.", "Restart KesherAI to finish.")}</span>)}
      </div>
    </section>
  );
}
