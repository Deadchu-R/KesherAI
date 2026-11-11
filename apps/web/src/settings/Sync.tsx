import { useEffect, useState } from "react";
import { api } from "../api";
import { desktop } from "../library";
import { t } from "../i18n";

interface Settings { activeModels: Record<string, string>; syncFolder: string | null }

/** "Chat folders": the local sync folder for the chats, and the clouds that keep a copy. */

export function Sync() {
  const [folder, setFolder] = useState("");
  const [current, setCurrent] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [clouds, setClouds] = useState<Array<{ service: string; folder: string }>>([]);
  useEffect(() => {
    void api<Settings>("/api/settings").then((s) => { setCurrent(s.syncFolder); setFolder(s.syncFolder ?? ""); });
    void api<Array<{ service: string; folder: string }>>("/api/sync/suggestions").then(setClouds, () => undefined);
  }, []);
  const save = async (value: string | null) => {
    setError("");
    setMsg("");
    try {
      const r = await api<Settings & { synced?: number }>("/api/settings", { method: "PUT", body: { syncFolder: value } });
      setCurrent(r.syncFolder);
      setMsg(r.synced !== undefined ? t("synced", { n: r.synced }) : t("saved"));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <section className="card stack">
      <h2>{t("sync")}</h2>
      <p className="muted">{t("syncHint")}</p>
      {clouds.length > 0 && (
        <div className="row">
          <span className="muted small">{t("syncFound")}</span>
          {clouds.map((c) => (
            <button key={c.folder} type="button" className={current === c.folder ? "primary" : ""} title={c.folder} onClick={() => { setFolder(c.folder); void save(c.folder); }}>
              {current === c.folder ? "✓ " : ""}{c.service}
            </button>
          ))}
        </div>
      )}
      <div className="row">
        <input className="grow" dir="ltr" value={folder} placeholder="G:\My Drive" onChange={(e) => setFolder(e.target.value)} aria-label={t("syncFolder")} />
        {desktop() && <button type="button" onClick={() => void desktop()!.pickFolder().then((f) => f && setFolder(f))}>{t("browse")}</button>}
        <button type="button" className="primary" disabled={!folder} onClick={() => void save(folder)}>{t("save")}</button>
        {current && <button type="button" onClick={() => { setFolder(""); void save(null); }}>{t("syncOff")}</button>}
      </div>
      {msg && <p className="pill good" style={{ alignSelf: "flex-start" }}>{msg}</p>}
      {error && <p className="error">{error}</p>}
    </section>
  );
}
