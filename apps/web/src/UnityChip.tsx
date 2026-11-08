import { useEffect, useRef, useState } from "react";
import { api, isRemote } from "./api";
import { getLocale } from "./i18n";
import { desktop, toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);
const base = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/**
 * In the message box: which Unity project the chat works on (through
 * Unity's CLI). Pick one of the projects, add a folder, or make a new one;
 * the chat's Unity tools then work on it. Shown only when Unity's CLI is
 * installed.
 */
export function UnityChip({ onUse }: { onUse?: (text: string) => void }) {
  const [st, setSt] = useState<{ cli: boolean; projects: string[]; active?: string; connected: boolean } | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const load = () => void api<{ cli: boolean; projects: string[]; active?: string; connected: boolean }>("/api/unity").then(setSt, () => undefined);
  useEffect(load, []);
  useEffect(() => {
    if (!open) return;
    load();
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    addEventListener("mousedown", close);
    return () => removeEventListener("mousedown", close);
  }, [open]);
  if (!st?.cli) return null;
  const choose = (project: string) =>
    void api("/api/unity/project", { method: "PUT", body: { project } }).then(() => {
      load();
      setOpen(false);
      onUse?.(L(`עבוד על פרויקט ה-Unity ‏${base(project)}: `, `Work on the Unity project ${base(project)}: `));
    }, (e: Error) => toast(e.message));
  const addFolder = async () => {
    const folder = await desktop()?.pickFolder();
    if (folder) choose(folder);
  };
  const active = st.active ?? st.projects[0];
  return (
    <div className="model-menu unity-chip" ref={ref}>
      <button type="button" className="model-chip" aria-haspopup="menu" aria-expanded={open} title={L("פרויקט ה-Unity של הצ'אט", "The chat's Unity project")} onClick={() => setOpen(!open)}>
        <span className={`where-dot ${st.connected ? "local" : ""}`} aria-hidden="true" />
        🕹 {active ? base(active) : L("Unity: בחר פרויקט", "Unity: choose a project")}
      </button>
      {open && (
        <div className="model-pop" role="menu">
          <div className="model-group-head"><span>{L("פרויקט Unity לצ'אט", "Unity project for the chat")}</span><span className="muted small">{st.connected ? L("🟢 העורך פתוח", "🟢 Editor open") : L("העורך סגור", "Editor closed")}</span></div>
          <div className="model-pop-list">
            {st.projects.map((p) => (
              <button key={p} type="button" role="menuitem" className={p === active ? "on" : ""} onClick={() => choose(p)} title={p}>
                <span dir="ltr">{base(p)}</span>{p === active && <span aria-hidden="true">✓</span>}
              </button>
            ))}
            {!st.projects.length && <p className="muted small">{L("עוד אין פרויקטים.", "No projects yet.")}</p>}
          </div>
          {desktop()?.pickFolder && !isRemote() && <button type="button" className="model-pop-foot" onClick={() => void addFolder()}>📁 {L("הוסף תיקיית פרויקט…", "Add a project folder…")}</button>}
          <a className="model-pop-foot" href="#/unity" onClick={() => setOpen(false)}>＋ {L("פרויקט חדש / הגדרות Unity", "New project / Unity settings")}</a>
          {active && !st.connected && (
            <button type="button" className="model-pop-foot" onClick={() => void api("/api/unity/open-editor", { method: "POST" }).then(() => toast(L("Unity נפתח…", "Opening Unity…")), (e: Error) => toast(e.message))}>▶ {L("פתח ב-Unity", "Open in Unity")}</button>
          )}
        </div>
      )}
    </div>
  );
}
