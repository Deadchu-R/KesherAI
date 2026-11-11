/**
 * Self-work as its own page (`#/self-work`, in the sidebar): the self-work panel already open, for the project it
 * runs on now, else the folder last used on the Code page. The same panel as on the Code page.
 */
import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";
import { SelfWorkPanel } from "../SelfWorkPanel";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/** The page. */
export function SelfWorkPage() {
  const [folder, setFolder] = useState<string | null>(null);
  useEffect(() => {
    let last = "";
    try {
      last = localStorage.getItem("kesher.codeFolder") ?? "";
    } catch {
      last = "";
    }
    void api<{ run?: { repo?: string } | null }>("/api/self-work").then((r) => setFolder(r.run?.repo || last), () => setFolder(last));
  }, []);
  return (
    <div className="page stack">
      <h1>🤖 {L("עבודה עצמית", "Self-work")}</h1>
      {folder === null ? null : folder ? (
        <>
          <p className="muted small" dir="ltr">{folder}</p>
          <SelfWorkPanel folder={folder} startOpen />
          <p className="muted small"><a href="#/code">{L("לפרויקט אחר: בחרו תיקייה בדף הקוד", "Another project: pick a folder on the Code page")}</a></p>
        </>
      ) : (
        <p className="muted">{L("עוד לא נבחר פרויקט. בדף הקוד בחרו את תיקיית הפרויקט, ואז חזרו לכאן.", "No project yet. Pick the project's folder on the Code page, then come back here.")} <a href="#/code">{L("לדף הקוד", "To the Code page")}</a></p>
      )}
    </div>
  );
}
