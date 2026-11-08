import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface ResetInfo { settings: string[]; folders: string[]; pending: boolean; justReset?: string; canRestart: boolean; canReinstall: boolean }

/**
 * Settings → General → Reset: settings back to default, start over like a
 * first install, or install the latest version again. Every reset keeps a
 * backup; nothing is deleted.
 */
export function ResetSection() {
  const [info, setInfo] = useState<ResetInfo | null>(null);
  const [keepModels, setKeepModels] = useState(true);
  const load = () => void api<ResetInfo>("/api/reset").then(setInfo, () => undefined);
  useEffect(load, []);
  if (!info) return null;
  const go = async (kind: "settings" | "everything" | "reinstall" | "cancel", ask?: string) => {
    if (ask && !confirm(ask)) return;
    try {
      const r = await api<{ restarting?: boolean }>("/api/reset", { method: "POST", body: { kind, keepModels } });
      if (kind === "reinstall") toast(L("מוריד את הגרסה האחרונה ומתקין מחדש… (רואים את ההתקדמות בדף העדכונים)", "Downloading the latest version and installing it again… (progress on the Updates page)"));
      else if (kind !== "cancel") toast(r.restarting ? L("מפעיל מחדש…", "Restarting…") : L("הפעל מחדש את KesherAI כדי לסיים.", "Restart KesherAI to finish."));
      load();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <section className="card stack reset">
      <h2>{L("איפוס והתקנה מחדש", "Reset and reinstall")}</h2>
      {info.justReset && <p className="good small">{L("KesherAI התחיל מאפס. הגיבוי של מה שהיה נמצא ב:", "KesherAI started over. The backup of what was there is in:")} <code dir="ltr">{info.justReset}</code></p>}
      <p className="muted small">{L("כל איפוס שומר גיבוי, ושום דבר לא נמחק.", "Every reset keeps a backup; nothing is deleted.")}</p>

      <div className="reset-row">
        <div>
          <b>{L("איפוס הגדרות", "Reset the settings")}</b>
          <p className="muted small">{L("ההגדרות חוזרות לברירת מחדל. הצ'אטים, המודלים והקבצים נשארים. נוצר טוקן חדש, אז צריך לחבר שוב את הטלפון.", "Settings go back to default; chats, models and files stay. A new token is made, so phones pair again.")}</p>
        </div>
        <button type="button" onClick={() => void go("settings", L("לאפס את ההגדרות? הטלפון יצטרך להתחבר מחדש. ההגדרות הישנות נשמרות בגיבוי.", "Reset the settings? Phones will need to pair again. The old settings are kept in a backup."))}>{L("אפס הגדרות", "Reset settings")}</button>
      </div>

      <div className="reset-row">
        <div>
          <b>{L("להתחיל מאפס", "Start over")}</b>
          <p className="muted small">{L("כמו התקנה ראשונה. כל התיקייה הנוכחית (צ'אטים, הגדרות, קבצים) עוברת לגיבוי ליד, ואפשר להחזיר אותה.", "Like a first install. The whole current folder (chats, settings, files) moves to a backup next to it, and can be put back.")}</p>
          <label className="row small"><input type="checkbox" checked={keepModels} onChange={(e) => setKeepModels(e.target.checked)} /> {L("לשמור את המודלים שהורדו (הם גדולים)", "Keep the downloaded models (they are big)")}</label>
        </div>
        {info.pending ? (
          <button type="button" onClick={() => void go("cancel")}>{L("בטל (עוד לא קרה)", "Cancel (not done yet)")}</button>
        ) : (
          <button type="button" className="danger" onClick={() => void go("everything", L("להתחיל מאפס? KesherAI יופעל מחדש כמו בהתקנה ראשונה. כל מה שיש עכשיו נשמר בגיבוי.", "Start over? KesherAI restarts like a first install. Everything there now is kept in a backup."))}>{L("התחל מאפס", "Start over")}</button>
        )}
      </div>

      {info.canReinstall && (
        <div className="reset-row">
          <div>
            <b>{L("התקנה מחדש", "Install again")}</b>
            <p className="muted small">{L("מוריד את הגרסה האחרונה ומתקין אותה מעל הקיימת, גם אם היא כבר מותקנת. מתאים כשמשהו נשבר. הצ'אטים וההגדרות נשארים.", "Downloads the latest version and installs it over this one, even if it is already installed — for when something broke. Chats and settings stay.")}</p>
          </div>
          <button type="button" onClick={() => void go("reinstall", L("להוריד ולהתקין מחדש את הגרסה האחרונה?", "Download and install the latest version again?"))}>{L("התקן מחדש", "Install again")}</button>
        </div>
      )}

      {(info.settings.length > 0 || info.folders.length > 0) && (
        <details>
          <summary className="small">{L("גיבויים קודמים", "Earlier backups")}</summary>
          <ul className="small" dir="ltr">{[...info.folders, ...info.settings].slice(0, 10).map((b) => <li key={b}><code>{b}</code></li>)}</ul>
          <p className="muted small">{L("כדי לשחזר: סגור את KesherAI, והחזר את הקובץ או התיקייה למקום (config.json, או התיקייה ‎.kesher).", "To restore: close KesherAI and put the file or folder back (config.json, or the .kesher folder).")}</p>
        </details>
      )}
    </section>
  );
}
