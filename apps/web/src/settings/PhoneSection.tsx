import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api, isRemote } from "../api";
import { AnywhereMode, type TunnelInfo } from "../AnywhereMode";
import { desktop } from "../library";
import { getLocale, t } from "../i18n";
import { StartupToggle } from "./StartupToggle";
import { HttpsCard } from "./HttpsCard";

/** The newest Android app, published by .github/workflows/android.yml. */
const APK_URL = "https://github.com/Deadchu-R/KesherAI/releases/download/android-latest/KesherAI-android.apk";

interface Remote {
  enabled: boolean; keepAwake: boolean; anywhere: boolean; token: string; port: number;
  tunnel: TunnelInfo & { message?: string };
  addresses: Array<{ address: string; tailscale: boolean; mac: string; broadcast: string }>;
}

/** Settings → Phone: pairing a phone (a QR per address with a deep link), the access-from-anywhere link, and the newest APK. */
export function PhoneSection() {
  const [remote, setRemote] = useState<Remote | null>(null);
  const [qr, setQr] = useState<Array<{ url: string; image: string; tailscale: boolean }>>([]);
  const [copied, setCopied] = useState("");
  const [restart, setRestart] = useState(false);
  const [apkQr, setApkQr] = useState("");
  const [note, setNote] = useState("");
  const [anyBusy, setAnyBusy] = useState(false);
  const [anyQr, setAnyQr] = useState("");
  const anywhereLink = remote?.tunnel.url ? `${remote.tunnel.url}/?token=${encodeURIComponent(remote.token)}` : "";
  useEffect(() => {
    if (!anywhereLink) return setAnyQr("");
    void QRCode.toDataURL(`kesherai://connect?server=${encodeURIComponent(anywhereLink)}`, { margin: 1, width: 220 }).then(setAnyQr);
  }, [anywhereLink]);
  const setAnywhere = async (on: boolean) => {
    if (!remote) return;
    setAnyBusy(true);
    setNote("");
    try {
      const tunnel = await api<Remote["tunnel"]>("/api/remote/anywhere", { method: "POST", body: { on } });
      setRemote({ ...remote, anywhere: on, tunnel });
    } catch (e) {
      setNote((e as Error).message);
      setRemote({ ...remote, anywhere: on, tunnel: { ...remote.tunnel, running: false } });
    } finally {
      setAnyBusy(false);
    }
  };
  useEffect(() => {
    // From the phone app: pairing, the internet link and the tokens are changed only on the computer (asking would only be refused).
    if (isRemote()) return;
    void QRCode.toDataURL(APK_URL, { margin: 1, width: 140 }).then(setApkQr);
    api<Remote>("/api/remote")
      .then(async (r) => {
        setRemote(r);
        if (!r.enabled) return;
        const sorted = [...r.addresses].sort((a, b) => Number(b.tailscale) - Number(a.tailscale));
        setQr(
          await Promise.all(
            sorted.map(async (a) => {
              // The link also carries the network card's address, so the Android app can wake this computer.
              const wake = a.tailscale || a.mac === "00:00:00:00:00:00" ? "" : `&wake=${a.mac}&bcast=${a.broadcast}`;
              const url = `http://${a.address}:${r.port}/?token=${encodeURIComponent(r.token)}${wake}`;
              // The code opens the KesherAI Android app and connects; the copied link works in any browser.
              const deep = `kesherai://connect?server=${encodeURIComponent(url)}`;
              return { url, image: await QRCode.toDataURL(deep, { margin: 1, width: 220 }), tailscale: a.tailscale };
            }),
          ),
        );
      })
      .catch(() => setRemote(null)); // not available from a phone itself
  }, []);
  if (!remote)
    return isRemote() ? (
      <section className="card stack">
        <h2>{getLocale() === "he" ? "חיבור מכשירים וגישה מכל מקום" : "Pairing and access from anywhere"}</h2>
        <p className="muted">{getLocale() === "he" ? "חיבור מכשיר חדש, קישור \"גישה מכל מקום\" והטוקנים משתנים רק במחשב עצמו, כדי שמי שמחזיק טלפון גנוב לא יוכל לפתוח את המחשב לאחרים. התראות ושאר ההגדרות עובדות גם מכאן." : "Pairing a new device, the access-from-anywhere link and the tokens are changed only on the computer itself, so a stolen phone cannot open the computer to others. Notifications and the other settings work from here too."}</p>
      </section>
    ) : null;
  const setRemote2 = async (patch: { enabled?: boolean; keepAwake?: boolean }) => {
    const res = await api<{ firewall?: string }>("/api/settings", { method: "PUT", body: { remote: patch } });
    setRemote({ ...remote, ...patch });
    if (res.firewall === "declined") setNote(t("firewallDeclined"));
    if (patch.enabled !== undefined) {
      // The server only starts listening for other devices after a restart; the desktop app does it right away.
      if (desktop()?.restart) void desktop()!.restart!();
      else setRestart(true);
    }
  };
  return (
    <section className="card stack">
      <h2>{t("phone")}</h2>
      <p className="muted">{t("phoneHint")}</p>
      <label className="check">
        <input type="checkbox" checked={remote.enabled} onChange={(e) => void setRemote2({ enabled: e.target.checked })} />
        {t("remoteEnable")}
      </label>
      {restart && <p className="pill warn" style={{ alignSelf: "flex-start" }}>{t("restartToApply")}</p>}
      <label className="check">
        <input type="checkbox" checked={remote.keepAwake} disabled={!remote.enabled} onChange={(e) => void setRemote2({ keepAwake: e.target.checked })} />
        {t("keepAwake")}
      </label>
      <StartupToggle />
      <HttpsCard />
      {note && <p className="error">{note}</p>}
      <div className="card stack anywhere">
        <label className="check">
          <input type="checkbox" checked={remote.anywhere} disabled={anyBusy} onChange={(e) => void setAnywhere(e.target.checked)} />
          <strong>{t("anywhere")}</strong>
        </label>
        <p className="muted">{t("anywhereHint")}</p>
        <AnywhereMode tunnel={remote.tunnel} onChange={(tunnel) => setRemote({ ...remote, tunnel })} />
        {anyBusy && <p className="muted">{remote.tunnel.installed ? t("anywhereConnecting") : t("anywhereDownloading")}</p>}
        {remote.anywhere && remote.tunnel.error && !anyBusy && <p className="error">{remote.tunnel.error}</p>}
        {anyQr && (
          <figure className="qr">
            <img src={anyQr} alt={t("scanToConnect")} width={220} height={220} />
            <figcaption className="mono muted" dir="ltr">{remote.tunnel.url}</figcaption>
            <button type="button" onClick={() => void navigator.clipboard?.writeText(anywhereLink).then(() => setCopied(anywhereLink))}>
              {copied === anywhereLink ? t("copied") : t("copyLink")}
            </button>
          </figure>
        )}
        {anyQr && <p className="muted small">{t("anywhereNote")}</p>}
      </div>
      <p className="muted">{t("wakeHint")} <a href="https://github.com/Deadchu-R/KesherAI/blob/main/docs/WAKE_ON_LAN.md" target="_blank" rel="noreferrer">docs/WAKE_ON_LAN.md</a></p>
      <div className="row" style={{ alignItems: "flex-start" }}>
        {qr.map((q) => (
          <figure key={q.url} className="qr">
            <img src={q.image} alt={t("scanToConnect")} width={220} height={220} />
            <figcaption className="mono muted" dir="ltr">{q.url.split("/?")[0]}{q.tailscale ? " · Tailscale" : ""}</figcaption>
            <button type="button" onClick={() => void navigator.clipboard?.writeText(q.url).then(() => setCopied(q.url))}>
              {copied === q.url ? t("copied") : t("copyLink")}
            </button>
          </figure>
        ))}
      </div>
      {qr.length > 0 && <p className="muted">{t("phoneApp")}</p>}
      {qr.length > 0 && <p className="muted">{t("firewallHint")}</p>}
      {qr.length > 0 && apkQr && (
        <figure className="qr">
          <img src={apkQr} alt={t("installApp")} width={140} height={140} />
          <figcaption className="muted">{t("installApp")}</figcaption>
          <a href={APK_URL} target="_blank" rel="noreferrer">{t("downloadApk")}</a>
        </figure>
      )}
    </section>
  );
}
