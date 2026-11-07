import { useEffect, useState } from "react";
import { api } from "./api";
import { desktop } from "./library";
import { getLocale } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Info { connected: boolean; browser?: string; key: string; folder: string | null }

/** Settings → Browser: the extension that lets the agent work in the user's own browser. */
export function BrowserSection() {
  const [info, setInfo] = useState<Info | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const load = () => void api<Info>("/api/browser").then(setInfo, () => undefined);
    load();
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, []);
  if (!info) return null;
  return (
    <section className="card stack">
      <h2>{L("הדפדפן שלך", "Your browser")}</h2>
      <p className="muted">{L("עם התוסף של KesherAI הסוכן יכול לעבוד בדפדפן שלך, איפה שאתה כבר מחובר: לפתוח דפים, לקרוא, ללחוץ ולמלא. הוא שואל לפני כל פעולה (אלא אם בחרת מצב אוטומטי), ולעולם לא מקליד סיסמאות.", "With the KesherAI extension the agent can work in your own browser, where you are already signed in: open pages, read, click and fill in. It asks before each action (unless you chose the automatic mode) and never types passwords.")}</p>
      <p>
        {info.connected ? (
          <span className="pill good">{L(`מחובר${info.browser ? ` · ${info.browser}` : ""}`, `Connected${info.browser ? ` · ${info.browser}` : ""}`)}</span>
        ) : (
          <span className="pill">{L("התוסף לא מחובר", "The extension is not connected")}</span>
        )}
      </p>
      {!info.connected && (
        <ol className="small">
          <li>{L("פתח בדפדפן (Chrome, ‏Edge או Brave) את ", "In Chrome, Edge or Brave open ")}<code dir="ltr">chrome://extensions</code>{L(" והדלק את Developer mode.", " and turn on Developer mode.")}</li>
          <li>{L("לחץ Load unpacked ובחר את תיקיית התוסף.", "Click Load unpacked and choose the extension's folder.")} {info.folder && <code dir="ltr">{info.folder}</code>}</li>
          <li>{L("לחץ על הסמל של KesherAI בסרגל, הדבק את המפתח ולחץ Connect.", "Click the KesherAI icon in the toolbar, paste the key and press Connect.")}</li>
        </ol>
      )}
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <span className="muted small">{L("מפתח חיבור:", "Connection key:")}</span>
        <code dir="ltr">{info.key}</code>
        <button type="button" onClick={() => void navigator.clipboard?.writeText(info.key).then(() => setCopied(true))}>{copied ? L("הועתק", "Copied") : L("העתק", "Copy")}</button>
        {info.folder && desktop()?.openPath && <button type="button" onClick={() => void desktop()!.openPath!(info.folder!)}>{L("פתח את תיקיית התוסף", "Open the extension folder")}</button>}
      </div>
    </section>
  );
}
