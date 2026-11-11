import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";

interface Https { installed: boolean; running: boolean; url?: string; on: boolean; hint?: string }

/** HTTPS for remote access through Tailscale: a real certificate at the computer's tailnet name. */
export function HttpsCard() {
  const [h, setH] = useState<Https | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<Https>("/api/remote/https").then(setH, () => undefined);
  }, []);
  if (!h) return null;
  const he = getLocale() === "he";
  const set = async (on: boolean) => {
    setBusy(true);
    try {
      setH(await api<Https>("/api/remote/https", { method: "POST", body: { on } }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card stack">
      <label className="check">
        <input type="checkbox" checked={h.on} disabled={busy || !h.running} onChange={(e) => void set(e.target.checked)} />
        <strong>{he ? "HTTPS מוצפן דרך Tailscale" : "Encrypted HTTPS through Tailscale"}</strong>
      </label>
      <p className="muted">
        {!h.installed
          ? he ? "התקינו את Tailscale (חינמי) במחשב ובטלפון, ואז אפשר לקבל כתובת HTTPS עם תעודה אמיתית." : "Install Tailscale (free) on this computer and the phone; then you get an HTTPS address with a real certificate."
          : !h.running
            ? he ? "Tailscale מותקן אבל לא מחובר. התחברו אליו במחשב." : "Tailscale is installed but not connected. Sign in to it on this computer."
            : he ? "כתובת עם תעודה אמיתית לרשת הפרטית שלכם ב-Tailscale. רק המכשירים שלכם מגיעים אליה, ועדיין צריך את הטוקן." : "An address with a real certificate in your own Tailscale network. Only your devices reach it, and it still needs the token."}
      </p>
      {h.on && h.url && <code dir="ltr">{h.url}</code>}
      {h.hint && <p className="small" dir="auto">{h.hint.split(/(https:\/\/\S+)/).map((part, i) => (/^https:\/\//.test(part) ? <a key={i} href={part} target="_blank" rel="noreferrer">{part}</a> : part))}</p>}
    </div>
  );
}
