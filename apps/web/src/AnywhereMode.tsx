import { useState } from "react";
import { api } from "./api";
import { getLocale, he$ } from "./i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** The internet link's state, as /api/remote returns it under `tunnel`. */
export interface TunnelInfo {
  installed: boolean;
  running: boolean;
  url?: string;
  error?: string;
  mode?: "quick" | "cloudflare" | "tailscale";
  cloudflare?: { signedIn: boolean; hostname?: string; ready: boolean; loginUrl?: string };
}

/**
 * Which kind of "access from anywhere" link: quick (no account, a new address
 * each time it starts), the user's own Cloudflare (a fixed address in their
 * domain) or Tailscale (a fixed ts.net address; only the user's own devices in
 * Tailscale reach it, unless the user explicitly allows Funnel, with a warning).
 */
export function AnywhereMode({ tunnel, allowFunnel = false, onChange }: { tunnel: TunnelInfo; allowFunnel?: boolean; onChange: (t: TunnelInfo, allowFunnel?: boolean) => void }) {
  const mode = tunnel.mode ?? "quick";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [host, setHost] = useState(tunnel.cloudflare?.hostname ?? "");
  const [loginUrl, setLoginUrl] = useState(tunnel.cloudflare?.loginUrl ?? "");
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const setMode = (m: string) => void run(async () => onChange(await api<TunnelInfo>("/api/remote/anywhere-mode", { method: "PUT", body: { mode: m } })));
  const setFunnel = (on: boolean) => {
    // Funnel opens KesherAI to the whole internet: only after the user confirms the warning.
    if (on && !window.confirm(L("Funnel פותח את KesherAI לכל האינטרנט, לא רק למכשירים שלך ב-Tailscale. כל אחד יוכל לנסות להתחבר (עדיין צריך מפתח). להדליק?", "Funnel opens KesherAI to the whole internet, not only your devices in Tailscale. Anyone can try to connect (a key is still needed). Turn it on?"))) return;
    void run(async () => {
      const r = await api<TunnelInfo & { allowFunnel: boolean }>("/api/remote/allow-funnel", { method: "PUT", body: { on } });
      onChange(r, r.allowFunnel);
    });
  };
  const modes: Array<[TunnelInfo["mode"], string, string]> = [
    ["quick", L("מהיר (בלי חשבון)", "Quick (no account)"), L("כתובת חדשה בכל פעם שהקישור מתחיל מחדש.", "A new address each time the link starts again.")],
    ["tailscale", "Tailscale", L("כתובת קבועה https://<המחשב>.<הרשת>.ts.net, רק למכשירים שלך ב-Tailscale. צריך את Tailscale מותקן ומחובר במחשב ובטלפון.", "A fixed address https://<computer>.<tailnet>.ts.net, only for your devices in Tailscale. Needs Tailscale installed and signed in on the computer and the phone.")],
    ["cloudflare", L("Cloudflare שלך", "Your own Cloudflare"), L("כתובת קבועה בדומיין שלך (למשל kesher.example.com). צריך חשבון Cloudflare חינמי ודומיין שמנוהל בו.", "A fixed address in your domain (kesher.example.com, say). Needs a free Cloudflare account with the domain on it.")],
  ];
  return (
    <div className="stack">
      <p className="small"><strong>{L("סוג הקישור", "Kind of link")}</strong></p>
      {modes.map(([m, name, hint]) => (
        <label key={m} className="check">
          <input type="radio" name="anywhere-mode" checked={mode === m} disabled={busy} onChange={() => setMode(m!)} />
          <span>{name} <span className="muted small">— {hint}</span></span>
        </label>
      ))}
      {mode === "tailscale" && (
        <div className="stack">
          <p className="muted small">{L("פעם אחת: התקן את Tailscale מ-tailscale.com/download במחשב ובטלפון, התחבר באותו חשבון, ואז הדלק כאן את הגישה מכל מקום. אם Tailscale מבקש להפעיל HTTPS, יופיע כאן קישור לאישור.", "Once: install Tailscale from tailscale.com/download on the computer and the phone, sign in with the same account, then turn access from anywhere on here. If Tailscale asks to turn on HTTPS, a link to allow it shows here.")}</p>
          <label className="check">
            <input type="checkbox" checked={allowFunnel} disabled={busy} onChange={(e) => setFunnel(e.target.checked)} />
            <span>{L("לאפשר Funnel (פתוח לכל האינטרנט)", "Allow Funnel (open to the whole internet)")} <span className="muted small">— {L("לא מומלץ. כבוי, רק המכשירים שלך ב-Tailscale מגיעים למחשב.", "Not recommended. Off, only your devices in Tailscale reach the computer.")}</span></span>
          </label>
          {allowFunnel && <p className="error small">{L("⚠ Funnel דולק: KesherAI פתוח לכל האינטרנט.", "⚠ Funnel is on: KesherAI is open to the whole internet.")}</p>}
        </div>
      )}
      {mode === "cloudflare" && (
        <div className="stack">
          <p className="small">{tunnel.cloudflare?.signedIn ? L("✅ מחובר ל-Cloudflare.", "✅ Signed in to Cloudflare.") : L("1. התחבר ל-Cloudflare ובחר את הדומיין (אפשר לפתוח את הקישור גם בטלפון).", "1. Sign in to Cloudflare and pick the domain (the link opens on the phone too).")}</p>
          {!tunnel.cloudflare?.signedIn && (
            <button type="button" disabled={busy} onClick={() => void run(async () => {
              const r = await api<{ loginUrl?: string; signedIn: boolean }>("/api/remote/cloudflare/login", { method: "POST" });
              if (r.loginUrl) {
                setLoginUrl(r.loginUrl);
                window.open(r.loginUrl, "_blank", "noopener");
              }
            })}>{L("התחבר ל-Cloudflare", "Sign in to Cloudflare")}</button>
          )}
          {loginUrl && !tunnel.cloudflare?.signedIn && <p className="small" dir="ltr" style={{ wordBreak: "break-all" }}>{loginUrl}</p>}
          <p className="small">{L("2. הכתובת הקבועה (תת-דומיין בדומיין שבחרת):", "2. The fixed address (a subdomain of the domain you picked):")}</p>
          <div className="row">
            <input dir="ltr" value={host} placeholder="kesher.example.com" onChange={(e) => setHost(e.target.value)} />
            <button type="button" disabled={busy || !host.trim()} onClick={() => void run(async () => onChange(await api<TunnelInfo>("/api/remote/cloudflare/setup", { method: "POST", body: { hostname: host.trim() } })))}>{L("הגדר", "Set up")}</button>
          </div>
          {tunnel.cloudflare?.ready && <p className="small">✅ {L("מוכן:", "Ready:")} <code dir="ltr">https://{tunnel.cloudflare.hostname}</code></p>}
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
