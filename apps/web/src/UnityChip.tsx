import { useEffect, useState } from "react";
import { Menu, MenuItem, MenuLabel, MenuNote, MenuSeparator } from "./ui/Menu";
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
  const [st, setSt] = useState<{ cli: boolean; projects: string[]; active?: string; connected: boolean; packages?: { pipeline: boolean; bridge: boolean } } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [open, setOpen] = useState(false);
  const load = () => void api<NonNullable<typeof st>>("/api/unity").then(setSt, () => undefined);
  useEffect(() => {
    load();
    // A Unity project added through the message box's + menu.
    addEventListener("kesher-unity-added", load);
    return () => removeEventListener("kesher-unity-added", load);
  }, []);
  useEffect(() => {
    if (open) load();
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
    <Menu
      className="model-menu unity-chip"
      triggerClassName="model-chip"
      title={L("פרויקט ה-Unity של הצ'אט", "The chat's Unity project")}
      open={open}
      onOpenChange={setOpen}
      trigger={<><span className={`where-dot ${st.connected ? "local" : ""}`} aria-hidden="true" />🕹 {active ? base(active) : L("Unity: בחר פרויקט", "Unity: choose a project")}{st.packages && !st.packages.pipeline ? " ⚠" : ""}</>}
    >
      <MenuLabel end={<span className="muted small">{st.connected ? L("🟢 העורך פתוח", "🟢 Editor open") : L("העורך סגור", "Editor closed")}</span>}>{L("פרויקט Unity לצ'אט", "Unity project for the chat")}</MenuLabel>
      {st.projects.map((p) => (
        <MenuItem key={p} kind="radio" checked={p === active} dir="ltr" title={p} keepOpen onSelect={() => choose(p)}>{base(p)}</MenuItem>
      ))}
      {!st.projects.length && <MenuNote>{L("עוד אין פרויקטים.", "No projects yet.")}</MenuNote>}
      <MenuSeparator />
      {desktop()?.pickFolder && !isRemote() && <MenuItem icon="📁" keepOpen onSelect={() => void addFolder()}>{L("הוסף תיקיית פרויקט…", "Add a project folder…")}</MenuItem>}
      <MenuItem icon="＋" href="#/unity">{L("פרויקט חדש / הגדרות Unity", "New project / Unity settings")}</MenuItem>
      {active && st.packages && (!st.packages.pipeline || !st.packages.bridge) && (
        <div className="model-pop-foot stack">
          <span className="small">⚠ {!st.packages.pipeline ? L("חסרה בפרויקט חבילת Pipeline של Unity: בלעדיה ה-CLI לא מדבר עם העורך.", "The project lacks Unity's Pipeline package: without it the CLI cannot talk to the Editor.") : L("חסרה חבילת KesherAI Bridge (לגרפים).", "The KesherAI Bridge package (for graphs) is missing.")}</span>
          {!isRemote() && (
            <MenuItem keepOpen disabled={installing} onSelect={() => {
              setInstalling(true);
              void api<{ message: string }>("/api/unity/install", { method: "POST", body: { project: active } }).then((r) => { toast(r.message); load(); }, (e: Error) => toast(e.message)).finally(() => setInstalling(false));
            }}>{installing ? "…" : L("התקן עכשיו", "Install now")}</MenuItem>
          )}
        </div>
      )}
      {active && !st.connected && (
        <MenuItem icon="▶" onSelect={() => void api("/api/unity/open-editor", { method: "POST" }).then(() => toast(L("Unity נפתח…", "Opening Unity…")), (e: Error) => toast(e.message))}>{L("פתח ב-Unity", "Open in Unity")}</MenuItem>
      )}
    </Menu>
  );
}
