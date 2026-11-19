import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** What this PC takes from the hub (its own opt-in). */
interface OptIn {
  appear: boolean;
  acceptTasks: boolean;
  acceptLocal: boolean;
  acceptAntigravity: boolean;
  reportLinks: boolean;
}

/** `GET /api/hub` (packages/core/src/hub-client.ts, HubStatus): no token, no key. */
interface HubStatus {
  enabled: boolean;
  url?: string;
  paired: boolean;
  connected: boolean;
  paused: boolean;
  optIn: OptIn;
  pairing?: { code: string; fingerprint: string; expiresAt: string };
  devices: Array<{ id: string; name: string; kind: string; online: boolean }>;
  lastError?: string;
}

/**
 * Settings → Phone and remote access → Kesher Cloud: this PC's link to the owner's own hub. The hub address, pairing
 * by code (the code and the 6-digit fingerprint are shown here and approved on the hub page), the status, what this
 * PC accepts (nothing until turned on), and disconnecting. Everything goes through `/api/hub`, so it works the same
 * from the phone (remote); the token and the key never leave this computer.
 */
export function CloudHubSection() {
  const [s, setS] = useState<HubStatus | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () =>
    void api<HubStatus>("/api/hub").then((x) => {
      setS(x);
      setUrl((u) => u || x.url || "");
    }, () => undefined);
  useEffect(() => {
    load();
    // Faster while a code waits for approval, so "paired" shows as soon as it happens.
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);
  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
      load();
    }
  };
  if (!s) return null;
  const put = (body: Record<string, unknown>) => run(() => api("/api/hub", { method: "PUT", body }));
  const minutesLeft = s.pairing ? Math.max(0, Math.ceil((Date.parse(s.pairing.expiresAt) - Date.now()) / 60_000)) : 0;
  const state = !s.paired ? L("לא מחובר למרכז", "Not paired with a hub") : !s.enabled ? L("כבוי", "Off") : s.paused ? L("המרכז מושהה", "The hub is paused") : s.connected ? L("מחובר", "Connected") : L("מתחבר…", "Connecting…");
  const opt = (key: keyof OptIn, he: string, en: string, disabled = false) => (
    <label className="row small">
      <input type="checkbox" checked={s.optIn[key]} disabled={busy || disabled} onChange={(e) => void put({ optIn: { [key]: e.target.checked } })} /> {L(he, en)}
    </label>
  );

  return (
    <section className="card stack cloud-hub" id="kesher-cloud">
      <div className="row">
        <h2 className="grow">{L("☁ ענן Kesher", "☁ Kesher Cloud")}</h2>
        {s.paired && (
          <label className="row small">
            <input type="checkbox" checked={s.enabled} disabled={busy} onChange={(e) => void put({ enabled: e.target.checked })} /> {L("פעיל", "On")}
          </label>
        )}
      </div>
      <p className="muted">{L("מרכז פרטי שלך (Cloudflare, בחינם) שמחבר את הטלפון והמחשבים: רואים מי דלוק, ושולחים משימות נעולות גם כשהמחשב כבוי. המרכז רק מעביר ולא יכול לקרוא אותן.", "Your own private hub (Cloudflare, free) that links your phone and PCs: see who is on, and send sealed tasks even when the PC is off. The hub only relays and cannot read them.")}</p>

      <label className="cloud-hub-url">
        <span className="small muted">{L("כתובת המרכז", "Hub address")}</span>
        <div className="row">
          <input className="grow" type="url" dir="ltr" inputMode="url" autoComplete="off" placeholder="https://hub.example.com" value={url} disabled={busy} onChange={(e) => setUrl(e.target.value)} aria-label={L("כתובת המרכז", "Hub address")} />
          <button type="button" disabled={busy || !url.trim() || url.trim() === s.url} onClick={() => void put({ url: url.trim() })}>{L("שמור", "Save")}</button>
        </div>
      </label>

      {s.url && (
        <div className="row wrap">
          <span className={`dot ${s.connected ? "on" : "off"}`} aria-hidden="true" />
          <span>{state}</span>
          {s.lastError && <span className="bad small">· {s.lastError}</span>}
          <a className="small" href={s.url} target="_blank" rel="noopener noreferrer">{L("פתח את דף המרכז ↗", "Open the hub page ↗")}</a>
        </div>
      )}

      {s.url && !s.paired && (s.pairing ? (
        <div className="tg-pair">
          <span>{L(`בדף המרכז (מחובר עם Google), בלשונית חיבור, הקלד את הקוד. הוא תקף עוד ${minutesLeft} דקות.`, `On the hub page (signed in with Google), in the Pair tab, type this code. It is valid for ${minutesLeft} more minutes.`)}</span>
          <code dir="ltr" className="tg-code">{s.pairing.code}</code>
          <span>{L("טביעת אצבע: ", "Fingerprint: ")}<bdi><b dir="ltr">{s.pairing.fingerprint}</b></bdi></span>
          <small className="muted">{L("אשר רק אם אותם 6 מספרים מופיעים גם בדף המרכז. ממתין לאישור…", "Approve only if the same 6 digits show on the hub page. Waiting for approval…")}</small>
          <div><a className="button" href={`${s.url}/#pair`} target="_blank" rel="noopener noreferrer">{L("פתח את לשונית החיבור ↗", "Open the Pair tab ↗")}</a></div>
        </div>
      ) : (
        <div><button type="button" className="primary" disabled={busy} onClick={() => void run(() => api("/api/hub/pair", { method: "POST" }))}>{L("חבר למרכז שלי", "Connect to my hub")}</button></div>
      ))}

      {s.paired && (
        <>
          <h3>{L("מה המחשב הזה מקבל מהמרכז", "What this PC takes from the hub")}</h3>
          {opt("acceptTasks", "לקבל משימות (נכנסות לתיבת המשימות)", "Take tasks (they go to the task board)")}
          {opt("acceptLocal", "משימות למודל המקומי", "Tasks for the local model", !s.optIn.acceptTasks)}
          {opt("acceptAntigravity", "משימות ל-Antigravity (מחכות ל\"הפעל\")", "Antigravity tasks (they wait for Run)", !s.optIn.acceptTasks)}
          {opt("appear", "להופיע ברשימת המכשירים במרכז", "Show in the hub's device list")}
          {opt("reportLinks", "לשתף קישורים לשיחות של סוכנים (למשל Claude Remote Control)", "Share agent session links (e.g. Claude Remote Control)")}
          <small className="muted">{L("מחשב חדש לא מקבל משימות עד שמסמנים כאן.", "A new PC takes no tasks until you tick it here.")}</small>
          {s.devices.length > 0 && (
            <>
              <h3>{L("מכשירים אחרים במרכז", "Other devices in the hub")}</h3>
              <ul className="device-list">
                {s.devices.map((d) => (
                  <li key={d.id} className="row"><span className={`dot ${d.online ? "on" : ""}`} aria-hidden="true" /> {d.kind === "pc" ? "🖥" : "📱"} {d.name} <span className="muted small">· {d.online ? L("מחובר", "Online") : L("כבוי", "Off")}</span></li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {(s.paired || s.pairing) && (
        <div className="row wrap">
          <button type="button" className="danger" disabled={busy} onClick={() => confirm(L("לנתק את המחשב הזה מהמרכז? המפתח שלו למרכז יימחק, ותצטרך קוד חדש כדי להתחבר שוב.", "Disconnect this PC from the hub? Its hub key is deleted and you need a new code to pair again.")) && void run(() => api("/api/hub", { method: "DELETE" }))}>{L("נתק מהמרכז", "Disconnect from the hub")}</button>
        </div>
      )}
    </section>
  );
}
