import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { CategoryDefinition, ModelInfo } from "@kesher/shared";
import { api, type ModelListing } from "../api";
import { desktop } from "../library";
import { getLocale, t } from "../i18n";

interface Settings { activeModels: Record<string, string>; syncFolder: string | null }
interface UpdateCheck { version: string; commit?: string; install: string; newCommits: Array<{ hash: string; subject: string }>; latestVersion?: string; localChanges: string[] }
interface UpdateProgress { running: boolean; step?: string; log: string[]; error?: string; restartRequired?: boolean; finishedAt?: string }
interface Remote { enabled: boolean; token: string; port: number; addresses: Array<{ address: string; tailscale: boolean }> }

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
    const timer = setInterval(() => void api<UpdateProgress>("/api/updates/progress").then(setProgress), 1000);
    return () => clearInterval(timer);
  }, [progress?.running]);

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
          <p>{progress.running ? `${t("updating")} ${progress.step ?? ""}` : progress.error ? "" : progress.restartRequired ? t("updateRestart") : t("updateDone")}</p>
          {progress.error && <p className="error">{progress.error}</p>}
          <details><summary>{t("output")}</summary><pre className="code" dir="ltr">{progress.log.join("\n")}</pre></details>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

function Phone() {
  const [remote, setRemote] = useState<Remote | null>(null);
  const [qr, setQr] = useState<Array<{ url: string; image: string; tailscale: boolean }>>([]);
  const [copied, setCopied] = useState("");
  useEffect(() => {
    api<Remote>("/api/remote")
      .then(async (r) => {
        setRemote(r);
        if (!r.enabled) return;
        const sorted = [...r.addresses].sort((a, b) => Number(b.tailscale) - Number(a.tailscale));
        setQr(
          await Promise.all(
            sorted.map(async (a) => {
              const url = `http://${a.address}:${r.port}/?token=${encodeURIComponent(r.token)}`;
              return { url, image: await QRCode.toDataURL(url, { margin: 1, width: 220 }), tailscale: a.tailscale };
            }),
          ),
        );
      })
      .catch(() => setRemote(null)); // not available from a phone itself
  }, []);
  if (!remote) return null;
  return (
    <section className="card stack">
      <h2>{t("phone")}</h2>
      <p className="muted">{t("phoneHint")}</p>
      {!remote.enabled && <p>{t("remoteOff")}</p>}
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
    </section>
  );
}

/** Settings: active models, cloud backup, version and updates, phone pairing. */
export function SettingsPage() {
  return (
    <div className="page">
      <h1>{t("settings")}</h1>
      <ActiveModels />
      <Sync />
      <Updates />
      <Phone />
    </div>
  );
}
