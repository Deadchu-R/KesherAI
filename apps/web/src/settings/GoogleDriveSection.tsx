import { useEffect, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";

interface GoogleStatus { configured: boolean; connected: boolean; email: string | null; lastSync: string | null; lastError: string | null; customClient: boolean }

/** "Connect Google Drive": the folder the chats are mirrored to, with the app’s OAuth or your own client. */

export function GoogleDriveSection() {
  const [g, setG] = useState<GoogleStatus | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [client, setClient] = useState({ clientId: "", clientSecret: "" });
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const load = () => void api<GoogleStatus>("/api/google").then(setG).catch(() => setG(null));
  useEffect(load, []);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => {
      void api<GoogleStatus>("/api/google").then((s) => {
        setG(s);
        if (s.connected) setWaiting(false);
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [waiting]);
  if (!g) return null;

  const connect = async () => {
    setError("");
    try {
      const { url } = await api<{ url: string }>("/api/google/connect", { method: "POST" });
      window.open(url, "_blank", "noopener");
      setWaiting(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const syncNow = async () => {
    setError("");
    setMsg("");
    try {
      const r = await api<{ downloaded: number; uploaded: number }>("/api/google/sync", { method: "POST" });
      setMsg(t("driveSynced", { down: r.downloaded, up: r.uploaded }));
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="card stack">
      <h2>Google Drive</h2>
      <p className="muted">{t("driveHint")}</p>
      {g.connected ? (
        <>
          <p>{t("driveConnected", { email: g.email ?? "" })}{g.lastSync ? ` · ${t("driveLastSync", { time: new Date(g.lastSync).toLocaleString() })}` : ""}</p>
          {g.lastError && <p className="error">{g.lastError}</p>}
          <div className="row">
            <button type="button" className="primary" onClick={() => void syncNow()}>{t("driveSyncNow")}</button>
            <button type="button" onClick={() => void api("/api/google/disconnect", { method: "POST" }).then(load)}>{t("driveDisconnect")}</button>
          </div>
        </>
      ) : g.configured ? (
        <div className="row">
          <button type="button" className="primary" onClick={() => void connect()}>{t("driveConnect")}</button>
          {waiting && <span className="muted">{t("driveWaiting")}</span>}
        </div>
      ) : (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); void api("/api/google/client", { method: "PUT", body: client }).then(load); }}>
          <p>{t("driveNeedsClient")} <a href="https://github.com/Deadchu-R/KesherAI/blob/main/docs/GOOGLE_DRIVE.md" target="_blank" rel="noreferrer">docs/GOOGLE_DRIVE.md</a></p>
          <label>Client ID<input dir="ltr" value={client.clientId} onChange={(e) => setClient({ ...client, clientId: e.target.value })} /></label>
          <label>Client secret<input dir="ltr" type="password" value={client.clientSecret} onChange={(e) => setClient({ ...client, clientSecret: e.target.value })} /></label>
          <button type="submit" className="primary" disabled={!client.clientId} style={{ alignSelf: "flex-start" }}>{t("save")}</button>
        </form>
      )}
      {msg && <p className="pill good" style={{ alignSelf: "flex-start" }}>{msg}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
