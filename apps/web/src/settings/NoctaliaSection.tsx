import { useEffect, useState } from "react";
import { api, isRemote } from "../api";
import { getLocale } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Status { linux: boolean; found: boolean; installed: boolean }

/** Settings: "Connect to Noctalia" in one click (Linux with Noctalia): the bar button and its panel. */
export function NoctaliaSection() {
  const [st, setSt] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<Status>("/api/integrations/noctalia").then(setSt, () => undefined);
  }, []);
  if (!st?.linux) return null;
  return (
    <section className="card stack">
      <h2>{L("Noctalia (סרגל שולחן העבודה)", "Noctalia (the desktop bar)")}</h2>
      <p className="muted">{L("כפתור של KesherAI בבר: נדלק כשצ'אטים עובדים, וחלונית לשאול את ה-AI ולפתוח את התשובה כאן.", "A KesherAI button in the bar: lit while chats work, and a panel to ask the AI and open the answer here.")}</p>
      {!st.found ? (
        <p className="muted small">{L("Noctalia לא נמצא במחשב הזה.", "Noctalia was not found on this computer.")}</p>
      ) : (
        <>
          <button type="button" className="primary" style={{ alignSelf: "start" }} disabled={busy || isRemote()} onClick={() => { setBusy(true); void api<Status & { message: string }>("/api/integrations/noctalia/install", { method: "POST" }).then((r) => { setSt(r); toast(L("חובר ל-Noctalia. הפעילו מחדש את Noctalia והוסיפו את הווידג'ט KesherAI בהגדרות ← Bar.", "Connected to Noctalia. Restart Noctalia and add the KesherAI widget in Settings → Bar.")); }, (e: Error) => toast(e.message)).finally(() => setBusy(false)); }}>
            {st.installed ? L("עדכן את החיבור ל-Noctalia", "Update the Noctalia connection") : L("חבר ל-Noctalia", "Connect to Noctalia")}
          </button>
          {st.installed && <p className="muted small">{L("מחובר. אם הכפתור לא מופיע: הפעילו מחדש את Noctalia, ואז הגדרות ← Bar ← הוסיפו KesherAI.", "Connected. If the button is not there: restart Noctalia, then Settings → Bar → add KesherAI.")}</p>}
        </>
      )}
      <p className="muted small">{L("ברים אחרים (Waybar ועוד): הסקריפט ב-integrations/waybar בריפו.", "Other bars (Waybar and more): the script in integrations/waybar in the repository.")}</p>
    </section>
  );
}
