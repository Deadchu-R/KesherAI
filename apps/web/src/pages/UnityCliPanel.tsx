import { useEffect, useState } from "react";
import { api, isRemote } from "../api";
import { getLocale } from "../i18n";
import { desktop, toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface CliInfo {
  cli: boolean;
  version?: string;
  editors: string[];
  job?: { name: string; path: string; state: "running" | "done" | "failed"; message?: string; startedAt: number };
}

/**
 * Unity's CLI with no project needed: whether it is installed, which
 * editors there are, a new project made through the CLI, and opening the
 * shown project in Unity.
 *
 * @param props.hasProject - Whether a project is on the list (shows "Open in Unity").
 * @param props.onMade - Called when a new project is ready (the page reloads its list).
 */
export function UnityCliPanel({ hasProject, onMade }: { hasProject: boolean; onMade: () => void }) {
  const [info, setInfo] = useState<CliInfo | null>(null);
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [editor, setEditor] = useState("");
  const [template, setTemplate] = useState("3d");
  const [open, setOpen] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const load = () => void api<CliInfo>("/api/unity/cli").then(setInfo, () => undefined);
  useEffect(load, []);
  const running = info?.job?.state === "running";
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => {
      void api<CliInfo>("/api/unity/cli").then((r) => {
        setInfo(r);
        if (r.job?.state === "done") {
          toast(r.job.message ?? L("הפרויקט מוכן", "The project is ready"));
          onMade();
        } else if (r.job?.state === "failed") toast(r.job.message ?? L("יצירת הפרויקט נכשלה", "Making the project failed"));
      }, () => undefined);
    }, 4000);
    return () => window.clearInterval(t);
  }, [running]);
  if (!info) return null;
  const local = !isRemote();
  const create = () =>
    void api<CliInfo>("/api/unity/create", { method: "POST", body: { name, parent, editor: editor || undefined, template, open } }).then((r) => {
      setInfo(r);
      setShowNew(false);
    }, (e: Error) => toast(e.message));

  return (
    <section className="card stack unity-cli">
      <div className="row">
        <h2 className="grow">{L("Unity CLI", "Unity CLI")}</h2>
        <span className={`pill ${info.cli ? "good" : ""}`}>{info.cli ? `🟢 ${L("מחובר", "Connected")}${info.version ? ` · ${info.version}` : ""}` : `⚪ ${L("לא מותקן", "Not installed")}`}</span>
      </div>
      {!info.cli ? (
        <p className="small">{L("ה-CLI של Unity חינמי. התקנה פעם אחת ב-PowerShell:", "Unity's CLI is free. Install it once in PowerShell:")} <code dir="ltr">irm https://unity.com/install.ps1 | iex</code> {L("ואז פתח מחדש את KesherAI.", "then restart KesherAI.")}</p>
      ) : (
        <>
          <p className="muted small">
            {info.editors.length ? `${L("עורכים מותקנים", "Installed editors")}: ${info.editors.join(", ")}` : L("אין עורך Unity מותקן. אפשר להתקין דרך Unity Hub או בפקודה unity install lts.", "No Unity editor installed: install one with Unity Hub or `unity install lts`.")}
          </p>
          <div className="row">
            <button type="button" className="primary" disabled={!local || running} onClick={() => setShowNew((v) => !v)}>＋ {L("פרויקט חדש", "New project")}</button>
            {info.version && /beta|alpha|preview/i.test(info.version) && (
              <button type="button" disabled={!local} onClick={() => void api<{ message: string }>("/api/unity/cli/update", { method: "POST" }).then((r) => { toast(r.message); load(); }, (e: Error) => toast(e.message))}>{L("עדכן את Unity CLI", "Update Unity CLI")}</button>
            )}
            {hasProject && <button type="button" disabled={!local} onClick={() => void api("/api/unity/open-editor", { method: "POST" }).then(() => toast(L("Unity נפתח…", "Opening Unity…")), (e: Error) => toast(e.message))}>{L("פתח ב-Unity", "Open in Unity")}</button>}
            {!local && <span className="muted small">{L("יצירה ופתיחה של פרויקט: רק במחשב עצמו.", "Making and opening projects: on the computer itself.")}</span>}
          </div>
          <p className="muted small">{L("אפשר גם לבקש בכל צ'אט: \"תוסיף ל-Unity קובייה אדומה\", \"תריץ את המשחק ותצלם\". המודל משתמש ב-CLI של Unity: בודק שהעורך פתוח, מוצא את הפקודה הנכונה, מריץ (אחרי אישור שלך) ומצלם כדי לבדוק.", "You can also ask in any chat: \"add a red cube in Unity\", \"run the game and take a picture\". The model uses Unity's CLI: checks the Editor is open, finds the right command, runs it (after you approve) and takes a picture to check.")}</p>
          {running && <p className="pill" aria-live="polite">⏳ {L(`יוצר את ${info.job!.name}… (כמה דקות)`, `Making ${info.job!.name}… (a few minutes)`)}</p>}
          {info.job?.state === "failed" && <p className="error small">{info.job.message}</p>}
          {showNew && (
            <div className="stack unity-new">
              <label>{L("שם הפרויקט", "Project name")}
                <input dir="ltr" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="MyGame" />
              </label>
              <label>{L("תיקייה", "Folder")}
                <span className="row">
                  <input className="grow" dir="ltr" value={parent} onChange={(e) => setParent(e.target.value)} placeholder="C:\Users\…\Unity Projects" />
                  {desktop() && <button type="button" onClick={() => void desktop()!.pickFolder().then((f) => f && setParent(f))}>{L("בחר…", "Choose…")}</button>}
                </span>
              </label>
              <div className="row">
                <label className="grow">{L("גרסת עורך", "Editor version")}
                  <select value={editor} onChange={(e) => setEditor(e.target.value)}>
                    <option value="">{L("ברירת המחדל של Unity", "Unity's default")}</option>
                    {info.editors.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </label>
                <label className="grow">{L("סוג", "Template")}
                  <select value={template} onChange={(e) => setTemplate(e.target.value)}>
                    <option value="3d">3D (URP)</option>
                    <option value="2d">2D (URP)</option>
                  </select>
                </label>
              </div>
              <label className="row small"><input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> {L("פתח ב-Unity כשמוכן", "Open in Unity when ready")}</label>
              <p className="muted small">{L("נוצר דרך ה-CLI של Unity, בלי קישור ל-Unity Cloud, עם חבילת Pipeline ו-KesherAI Bridge. צריך רישיון Unity פעיל (גם Personal החינמי).", "Made with Unity's CLI, without a Unity Cloud link, with the Pipeline and KesherAI Bridge packages. Needs an active Unity licence (the free Personal one is fine).")}</p>
              <div className="row"><button type="button" className="primary" disabled={!name.trim() || !parent.trim()} onClick={create}>{L("צור פרויקט", "Make the project")}</button></div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
