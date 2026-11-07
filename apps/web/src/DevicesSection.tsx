import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Device { id: string; name: string; platform: string; gpu?: string; me: boolean; online: boolean; url?: string; models: number; lastSeen: string; providerId?: string }
interface Status { connected: boolean; share: boolean; syncSettings: boolean; me: { id: string; name: string }; devices: Device[]; lastRun: string | null; error: string | null }

const os = (p: string) => (p === "win32" ? "Windows" : p === "darwin" ? "Mac" : p === "linux" ? "Linux" : p);

/**
 * Connections → My devices: computers signed in to the same Google account.
 * A strong computer can do the work for a weak one (its models appear in
 * every chat's model list), and API keys and MCP servers follow the user.
 */
export function DevicesSection() {
  const [st, setSt] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api<Status>("/api/devices").then(setSt, () => undefined);
  useEffect(() => {
    void load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, []);
  if (!st) return null;
  const set = async (body: Record<string, boolean>) => {
    setBusy(true);
    await api("/api/devices", { method: "PUT", body }).catch((e: Error) => toast(e.message));
    setBusy(false);
    await load();
  };
  const others = st.devices.filter((d) => !d.me);
  return (
    <section className="card stack devices">
      <h2>{L("המכשירים שלי", "My devices")}</h2>
      <p className="muted small">{L("מחשבים שמחוברים לאותו חשבון Google מוצאים זה את זה. מחשב חזק יכול לעשות את העבודה בשביל לפטופ חלש: המודלים שלו מופיעים ברשימת המודלים בכל צ'אט, העבודה רצה על כרטיס המסך שלו והתשובה חוזרת אליך. הקבצים והכלים (למשל Unity) נשארים במחשב שלך.", "Computers signed in to the same Google account find each other. A strong computer can do the work for a weak laptop: its models appear in every chat's model list, the work runs on its graphics card and the answer comes back to you. Your files and tools (Unity, say) stay on your computer.")}</p>
      {!st.connected ? (
        <p className="small">{L("קודם מתחברים עם Google (בכרטיסים למטה או בהגדרות ← Google Drive), ואז המכשירים מופיעים כאן.", "First connect with Google (the cards below, or Settings → Google Drive); then your devices show up here.")}</p>
      ) : (
        <>
          <label className="row">
            <input type="checkbox" checked={st.share} disabled={busy} onChange={(e) => void set({ share: e.target.checked })} />
            <span>
              <strong>{L(`לאפשר למכשירים שלי להשתמש במחשב הזה (${st.me.name})`, `Let my other devices use this computer (${st.me.name})`)}</strong>
              <span className="muted small block">{L("מפעיל גישה מרחוק מוגנת בסיסמה (כולל \"גישה מכל מקום\"). הכתובת והסיסמה נשמרות רק ב-Drive שלך, בתיקיית KesherAI. מומלץ במחשב החזק.", "Turns on password-protected remote access (with \"access from anywhere\"). The address and password are kept only in your Drive, in the KesherAI folder. Turn it on for the strong computer.")}</span>
            </span>
          </label>
          <label className="row">
            <input type="checkbox" checked={st.syncSettings} disabled={busy} onChange={(e) => void set({ syncSettings: e.target.checked })} />
            <span>
              <strong>{L("לסנכרן מפתחות API ושרתי MCP בין המחשבים שלי", "Sync API keys and MCP servers between my computers")}</strong>
              <span className="muted small block">{L("מה שמחברים במחשב אחד מופיע בשני. שינוי חדש גובר; מחיקה במחשב אחד לא מוחקת בשאר.", "What you connect on one computer appears on the others. The newer change wins; deleting on one computer does not delete on the others.")}</span>
            </span>
          </label>
          {others.length ? (
            <ul className="device-list">
              {others.map((d) => (
                <li key={d.id}>
                  <span className={`dot ${d.online ? "on" : ""}`} aria-hidden />
                  <span className="grow">
                    <strong>{d.name}</strong>
                    <span className="muted small"> · {os(d.platform)}{d.gpu ? ` · ${d.gpu}` : ""}</span>
                    <span className="muted small block">{d.online ? L(`מחובר · ${d.models} מודלים זמינים בצ'אט (תחת "${d.name} (your computer)")`, `Online · ${d.models} models in the chat's model list (under "${d.name} (your computer)")`) : L(`לא זמין כרגע · נראה לאחרונה ${new Date(d.lastSeen).toLocaleString()}`, `Not reachable now · last seen ${new Date(d.lastSeen).toLocaleString()}`)}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">{L("עוד אין מכשירים אחרים. במחשב החזק: מתחברים עם אותו חשבון Google ומסמנים \"לאפשר למכשירים שלי להשתמש במחשב הזה\".", "No other devices yet. On the strong computer: connect the same Google account and tick \"Let my other devices use this computer\".")}</p>
          )}
          <div className="row small">
            <button type="button" disabled={busy} onClick={() => { setBusy(true); void api<Status>("/api/devices/sync", { method: "POST" }).then(setSt).finally(() => setBusy(false)); }}>{busy ? L("בודק…", "Checking…") : L("בדוק עכשיו", "Check now")}</button>
            {st.lastRun && <span className="muted">{L("נבדק", "Checked")} {new Date(st.lastRun).toLocaleTimeString()}</span>}
            {st.error && <span className="error">{st.error}</span>}
          </div>
        </>
      )}
    </section>
  );
}
