import { useEffect, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";

interface OneDriveStatus { configured: boolean; connected: boolean; email: string | null; lastSync: string | null; lastError: string | null; customClient: boolean }

/** "Connect OneDrive": the Microsoft twin of {@link GoogleDriveSection}. */

export function OneDriveSection() {
  const [o, setO] = useState<OneDriveStatus | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [clientId, setClientId] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const load = () => void api<OneDriveStatus>("/api/onedrive").then(setO).catch(() => setO(null));
  useEffect(load, []);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      void api<OneDriveStatus>("/api/onedrive").then((s) => {
        setO(s);
        if (s.connected) setWaiting(false);
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [waiting]);
  if (!o) return null;

  const run = async (f: () => Promise<void>) => {
    setError("");
    setMsg("");
    try {
      await f();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const connect = () => run(async () => {
    const { url } = await api<{ url: string }>("/api/onedrive/connect", { method: "POST" });
    window.open(url, "_blank", "noopener");
    setWaiting(true);
  });
  const syncNow = () => run(async () => {
    const r = await api<{ downloaded: number; uploaded: number }>("/api/onedrive/sync", { method: "POST" });
    setMsg(t("driveSynced", { down: r.downloaded, up: r.uploaded }));
    load();
  });

  return (
    <section className="card stack">
      <h2>OneDrive</h2>
      <p className="muted">{t("oneHint")}</p>
      {o.connected ? (
        <>
          <p>{t("driveConnected", { email: o.email ?? "" })}{o.lastSync ? ` · ${t("driveLastSync", { time: new Date(o.lastSync).toLocaleString() })}` : ""}</p>
          {o.lastError && <p className="error">{o.lastError}</p>}
          <div className="row">
            <button type="button" className="primary" onClick={() => void syncNow()}>{t("driveSyncNow")}</button>
            <button type="button" onClick={() => void api("/api/onedrive/disconnect", { method: "POST" }).then(load)}>{t("driveDisconnect")}</button>
          </div>
        </>
      ) : o.configured ? (
        <div className="row">
          <button type="button" className="primary" onClick={() => void connect()}>{t("oneConnect")}</button>
          {waiting && <span className="muted">{t("driveWaiting")}</span>}
          {o.customClient && <button type="button" onClick={() => void run(async () => { await api("/api/onedrive/client", { method: "PUT", body: {} }); load(); })}>{t("oneChangeId")}</button>}
        </div>
      ) : (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api("/api/onedrive/client", { method: "PUT", body: { clientId } }); load(); }); }}>
          <p>{t("oneNeedsClient")} <a href="https://github.com/Deadchu-R/KesherAI/blob/main/docs/ONEDRIVE.md" target="_blank" rel="noreferrer">docs/ONEDRIVE.md</a></p>
          <label>Application (client) ID<input dir="ltr" value={clientId} placeholder="0a1b2c3d-…" onChange={(e) => setClientId(e.target.value)} /></label>
          <button type="submit" className="primary" disabled={!clientId.trim()} style={{ alignSelf: "flex-start" }}>{t("save")}</button>
        </form>
      )}
      {msg && <p className="pill good" style={{ alignSelf: "flex-start" }}>{msg}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
