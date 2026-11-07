import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";
import { desktop } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Status { installed: boolean; folder?: string; managed: boolean; running: boolean; url: string; phase?: "installing" | "starting" | "error"; message?: string; log: string[]; autoStart: boolean; port: number; ownFolder: string | null }

/** Managed ComfyUI: install it, or use your own; start, stop, and start with KesherAI. */
export function ComfySection() {
  const [s, setS] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [showLog, setShowLog] = useState(false);
  const load = () => api<Status>("/api/comfy").then(setS, () => undefined);
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    if (!s?.phase || s.phase === "error") return;
    const id = setInterval(() => void load(), 1500);
    return () => clearInterval(id);
  }, [s?.phase]);
  if (!s) return null;
  const act = async (path: string, body?: unknown) => {
    setError("");
    try {
      setS(await api<Status>(`/api/comfy${path}`, { method: body === undefined ? "POST" : "PUT", ...(body === undefined ? {} : { body }) }));
      setTimeout(() => void load(), 1200);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const busy = s.phase === "installing" || s.phase === "starting";
  return (
    <section className="card stack">
      <div className="row">
        <h2 className="grow">ComfyUI</h2>
        {s.running ? <span className="pill good">{L("פועל", "Running")}</span> : s.installed ? <span className="pill">{L("מותקן", "Installed")}</span> : null}
      </div>
      <p className="muted">{L("ComfyUI הוא מנוע תמונות ווידאו חזק עם תהליכי עבודה. KesherAI יכול להתקין אותו בשבילכם (כמה GB), להפעיל ולכבות אותו, ולהשתמש בו ליצירת תמונות. הוא רואה גם את המודלים שבתיקיית המודלים של KesherAI.", "ComfyUI is a powerful image and video engine with workflows. KesherAI can install it for you (a few GB), start and stop it, and use it to make images. It also sees the models in KesherAI's models folder.")}</p>
      {s.installed && <p className="muted small" dir="ltr">{s.folder}</p>}
      <div className="row">
        {!s.installed && <button type="button" className="primary" disabled={busy} onClick={() => void act("/install")}>{L("התקנה (ComfyUI + Python + PyTorch)", "Install (ComfyUI + Python + PyTorch)")}</button>}
        {s.installed && !s.running && <button type="button" className="primary" disabled={busy} onClick={() => void act("/start")}>▶ {L("הפעלה", "Start")}</button>}
        {s.running && <button type="button" onClick={() => void act("/stop")}>■ {L("עצירה", "Stop")}</button>}
        {s.running && <a href={s.url} target="_blank" rel="noreferrer">{L("פתיחת ComfyUI", "Open ComfyUI")}</a>}
        {desktop() && (
          <button type="button" disabled={busy} onClick={() => void desktop()!.pickFolder().then((f) => { if (f) void act("", { folder: f }); })}>{L("יש לי ComfyUI — בחירת התיקייה", "I have ComfyUI — choose its folder")}</button>
        )}
        {s.ownFolder && <button type="button" className="as-link" onClick={() => void act("", { folder: null })}>{L("להשתמש בעותק של KesherAI", "Use KesherAI's copy")}</button>}
      </div>
      {s.installed && (
        <label className="check"><input type="checkbox" checked={s.autoStart} onChange={(e) => void act("", { autoStart: e.target.checked })} /> {L("להפעיל יחד עם KesherAI", "Start with KesherAI")}</label>
      )}
      {s.message && <p className={s.phase === "error" ? "error small" : "muted small"}>{s.message}</p>}
      {error && <p className="error small">{error}</p>}
      {s.log.length > 0 && (
        <details open={showLog} onToggle={(e) => setShowLog((e.target as HTMLDetailsElement).open)}>
          <summary className="muted small">{L("יומן", "Log")}</summary>
          <pre className="ctx-text" dir="ltr">{s.log.join("\n")}</pre>
        </details>
      )}
    </section>
  );
}
