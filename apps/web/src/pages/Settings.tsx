import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { CategoryDefinition, ModelInfo } from "@kesher/shared";
import { api, type ModelListing } from "../api";
import { desktop } from "../library";
import { getLocale, t } from "../i18n";

interface Settings { activeModels: Record<string, string>; syncFolder: string | null }
interface UpdateCheck { version: string; commit?: string; install: string; newCommits: Array<{ hash: string; subject: string }>; latestVersion?: string; localChanges: string[] }
interface UpdateProgress { running: boolean; step?: string; log: string[]; error?: string; restartRequired?: boolean; fromSource?: boolean; finishedAt?: string }
interface Remote {
  enabled: boolean; keepAwake: boolean; token: string; port: number;
  addresses: Array<{ address: string; tailscale: boolean; mac: string; broadcast: string }>;
}

function ActiveModels() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [categories, setCategories] = useState<CategoryDefinition[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void api<Settings>("/api/settings").then(setSettings);
    void api<CategoryDefinition[]>("/api/categories").then(setCategories);
    void api<ModelListing>("/api/models").then((l) => setModels(l.models));
  }, []);
  if (!settings) return null;

  const set = async (category: string, modelId: string) => {
    const activeModels = { ...settings.activeModels, [category]: modelId };
    if (!modelId) delete activeModels[category];
    const next = await api<Settings>("/api/settings", { method: "PUT", body: { activeModels } });
    setSettings(next);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <section className="card stack">
      <div className="row"><h2 className="grow">{t("activeModels")}</h2>{saved && <span className="pill good">{t("saved")}</span>}</div>
      <p className="muted">{t("activeModelsHint")}</p>
      <div className="grid-2">
        {categories.map((c) => {
          const options = models.filter((m) => m.category === c.id);
          const current = settings.activeModels[c.id] ?? "";
          return (
            <label key={c.id}>
              {c.label[getLocale()] ?? c.label.en}
              <select value={current} onChange={(e) => void set(c.id, e.target.value)}>
                <option value="">{t("none")}</option>
                {current && !options.some((m) => m.id === current) && <option value={current}>{current}</option>}
                {options.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.providerId}</option>)}
              </select>
            </label>
          );
        })}
      </div>
    </section>
  );
}

function Sync() {
  const [folder, setFolder] = useState("");
  const [current, setCurrent] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    void api<Settings>("/api/settings").then((s) => { setCurrent(s.syncFolder); setFolder(s.syncFolder ?? ""); });
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

interface GoogleStatus { configured: boolean; connected: boolean; email: string | null; lastSync: string | null; lastError: string | null; customClient: boolean }

function GoogleDriveSection() {
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

function Updates() {
  const [version, setVersion] = useState<{ version: string; commit?: string; install: string } | null>(null);
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    void api<{ version: string; commit?: string; install: string }>("/api/version").then(setVersion);
    void api<UpdateProgress>("/api/updates/progress").then((p) => p.running && setProgress(p));
  }, []);
  useEffect(() => {
    if (!progress?.running) return;
    // The server may restart during the update; keep polling through the gap.
    const timer = setInterval(() => void api<UpdateProgress>("/api/updates/progress").then(setProgress).catch(() => undefined), 1000);
    return () => clearInterval(timer);
  }, [progress?.running]);

  // When the update is done, open the new version by itself.
  const finished = !!progress && !progress.running && progress.step === "Done" && !progress.error;
  useEffect(() => {
    if (!finished || !progress) return;
    if (progress.restartRequired && desktop()?.restart) {
      void desktop()!.restart!();
      return;
    }
    if (progress.restartRequired) return; // started from the command line: the user restarts it
    // From source the server restarts itself; reload once it answers with the new commit.
    const before = version?.commit;
    const timer = setInterval(() => {
      void api<{ commit?: string }>("/api/version")
        .then((v) => {
          if (v.commit && v.commit !== before) location.reload();
        })
        .catch(() => undefined);
    }, 1500);
    const fallback = setTimeout(() => location.reload(), 20_000);
    return () => {
      clearInterval(timer);
      clearTimeout(fallback);
    };
  }, [finished]);

  const doCheck = async () => {
    setError("");
    setChecking(true);
    try {
      setCheck(await api<UpdateCheck>("/api/updates"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };
  const apply = async () => {
    setError("");
    try {
      setProgress(await api<UpdateProgress>("/api/updates/apply", { method: "POST" }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="card stack">
      <h2>{t("version")}</h2>
      <p className="mono">{version ? `KesherAI v${version.version}${version.commit ? ` (${version.commit})` : ""}` : "…"}</p>
      <div className="row">
        <button type="button" onClick={() => void doCheck()} disabled={checking || !!progress?.running}>{checking ? "…" : t("checkUpdates")}</button>
        {check && check.newCommits.length > 0 && !progress?.running && (
          <button type="button" className="primary" onClick={() => void apply()}>{t("installUpdate")}</button>
        )}
      </div>
      {check && check.newCommits.length === 0 && <p className="pill good" style={{ alignSelf: "flex-start" }}>{t("upToDate")}</p>}
      {check && check.newCommits.length > 0 && (
        <>
          <p>{t("updateAvailable", { n: check.newCommits.length })}{check.latestVersion && check.latestVersion !== check.version ? ` · v${check.latestVersion}` : ""}</p>
          <ul className="commits">
            {check.newCommits.map((c) => <li key={c.hash}><span className="mono muted">{c.hash}</span> {c.subject}</li>)}
          </ul>
          {check.localChanges.length > 0 && <p className="error">{t("localChanges", { files: check.localChanges.slice(0, 5).join(", ") })}</p>}
        </>
      )}
      {progress && (
        <>
          <p>{progress.running ? `${t("updating")} ${progress.step ?? ""}` : progress.error ? "" : progress.restartRequired && !desktop()?.restart ? t("updateRestart") : t("updateDone")}</p>
          {finished && progress.restartRequired && desktop()?.restart && <button type="button" className="primary" onClick={() => void desktop()!.restart!()}>{t("restartNow")}</button>}
          {progress.error && <p className="error">{progress.error}</p>}
          <details><summary>{t("output")}</summary><pre className="code" dir="ltr">{progress.log.join("\n")}</pre></details>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

/** The newest Android app, published by .github/workflows/android.yml. */
const APK_URL = "https://github.com/Deadchu-R/KesherAI/releases/download/android-latest/KesherAI-android.apk";

function Phone() {
  const [remote, setRemote] = useState<Remote | null>(null);
  const [qr, setQr] = useState<Array<{ url: string; image: string; tailscale: boolean }>>([]);
  const [copied, setCopied] = useState("");
  const [restart, setRestart] = useState(false);
  const [apkQr, setApkQr] = useState("");
  useEffect(() => {
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
  if (!remote) return null;
  const setRemote2 = async (patch: { enabled?: boolean; keepAwake?: boolean }) => {
    await api("/api/settings", { method: "PUT", body: { remote: patch } });
    setRemote({ ...remote, ...patch });
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

/** Settings: active models, cloud backup, version and updates, phone pairing. */
export function SettingsPage() {
  return (
    <div className="page">
      <h1>{t("settings")}</h1>
      <ActiveModels />
      <GoogleDriveSection />
      <Sync />
      <Updates />
      <Phone />
    </div>
  );
}
