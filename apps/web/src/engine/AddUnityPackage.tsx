import { useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";
import { desktop } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/** "Add to a project…" (this computer): copies the package into the project's Packages folder. */
export function AddUnityPackage({ compact = false, project }: { compact?: boolean; /** The project shown: its package can be updated in one click. */ project?: string }) {
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const bridge = desktop();
  if (!bridge) return null;
  const pick = async (given?: string) => {
    setError("");
    setMsg("");
    const folder = given ?? (await bridge.pickFolder());
    if (!folder) return;
    try {
      setMsg((await api<{ message: string }>("/api/unity/install", { method: "POST", body: { project: folder } })).message);
      dispatchEvent(new Event("kesher-unity-added"));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="stack ue-install">
      <div className="row">
        {project && <button type="button" onClick={() => void pick(project)} title={L("מעתיק את הגרסה החדשה של חבילת KesherAI לפרויקט הזה", "Copies the newest KesherAI package into this project")}>⟳ {L(`עדכן את החבילה ב-${project.split(/[\\/]/).pop()}`, `Update the package in ${project.split(/[\\/]/).pop()}`)}</button>}
        <button type="button" className={compact ? "" : "primary"} onClick={() => void pick()}>📁 {L("הוסף לפרויקט…", "Add to a project…")}</button>
        {!compact && <span className="muted small">{L("בחר את תיקיית הפרויקט (זו שיש בה Assets ו-Packages).", "Pick the project folder (the one with Assets and Packages).")}</span>}
      </div>
      {msg && <p className="pill good">✅ {msg}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
