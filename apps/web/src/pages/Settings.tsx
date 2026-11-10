import { ImportChats } from "../ImportChats";
import { ComputersSection } from "../ComputersSection";
import { AppearanceSection } from "../AppearanceSection";
import { ResetSection } from "../ResetSection";
import { TelegramSection } from "../TelegramSection";
import { AccessLogSection, DeviceKeysSection } from "../AccessLogSection";
import { SpeechSection } from "../SpeechSection";
import { AccessibilitySection } from "../Speak";
import { ComputerSection } from "../ComputerSection";
import { GpuSection } from "../GpuSection";
import { GuardSection } from "../GuardSection";
import { BusinessSection, CopilotSection } from "../BusinessSection";
import { openWelcome } from "../Welcome";
import { NotificationsSection } from "../NotificationsSection";
import { McpServerSection } from "../McpServerSection";
import { PhoneTargetsSection } from "../PhoneTargetsSection";
import { AnywhereMode, type TunnelInfo } from "../AnywhereMode";
import { BrowserSection } from "../BrowserSection";
import { ApiKeysSection } from "../ApiKeysSection";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { CategoryDefinition, ModelInfo } from "@kesher/shared";
import { api, isRemote, type ModelListing } from "../api";
import { desktop, useLibrary } from "../library";
import { getLocale, t } from "../i18n";
import { Select } from "../ui/Select";

interface Settings { activeModels: Record<string, string>; syncFolder: string | null }
interface Remote {
  enabled: boolean; keepAwake: boolean; anywhere: boolean; token: string; port: number;
  tunnel: TunnelInfo & { message?: string };
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
              <Select value={current} onChange={(e) => void set(c.id, e.target.value)}>
                <option value="">{t("none")}</option>
                {current && !options.some((m) => m.id === current) && <option value={current}>{current.split(/[\\/]/).pop()}</option>}
                {options.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.providerId}</option>)}
              </Select>
            </label>
          );
        })}
        <label title={getLocale() === "he" ? "בזמן כתיבת קוד, המודל מציע את ההמשך באפור; Tab מכניס. מודל קוד קטן ומהיר הכי טוב." : "While you write code, the model suggests what comes next in grey; Tab inserts it. A small fast coder model works best."}>
          {getLocale() === "he" ? "הצעות קוד תוך כדי כתיבה (Inline)" : "Code suggestions while typing (inline)"}
          <Select value={settings.activeModels.codeInline ?? ""} onChange={(e) => void set("codeInline", e.target.value)}>
            <option value="">{getLocale() === "he" ? "כבוי" : "Off"}</option>
            {settings.activeModels.codeInline && !models.some((m) => m.id === settings.activeModels.codeInline) && <option value={settings.activeModels.codeInline}>{settings.activeModels.codeInline}</option>}
            {models.filter((m) => m.category === "chat").sort((a, b) => Number(/coder|code/i.test(b.name)) - Number(/coder|code/i.test(a.name))).map((m) => <option key={m.id} value={m.id}>{m.name} · {m.providerId}</option>)}
          </Select>
        </label>
      </div>
    </section>
  );
}

function Sync() {
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

interface OneDriveStatus { configured: boolean; connected: boolean; email: string | null; lastSync: string | null; lastError: string | null; customClient: boolean }

/** "Connect OneDrive": the Microsoft twin of {@link GoogleDriveSection}. */
function OneDriveSection() {
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

/** The newest Android app, published by .github/workflows/android.yml. */
const APK_URL = "https://github.com/Deadchu-R/KesherAI/releases/download/android-latest/KesherAI-android.apk";

function Phone() {
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

/** The settings in categories; only the open one is drawn (and asks the computer anything). */
const SETTINGS_CATS: Array<{ id: string; icon: string; en: string; he: string; render: () => React.ReactNode }> = [
  { id: "general", icon: "⚙", en: "General", he: "כללי", render: () => <><ActiveModels /><NotificationsSection /><SpeechSection /><ImportChats /><ResetSection /></> },
  { id: "appearance", icon: "🎨", en: "Appearance", he: "מראה", render: () => <AppearanceSection /> },
  { id: "accessibility", icon: "♿", en: "Accessibility", he: "נגישות", render: () => <AccessibilitySection /> },
  { id: "computer", icon: "🖥", en: "Computer and graphics card", he: "המחשב וכרטיס המסך", render: () => <><GpuSection /><GuardSection /><ComputerSection /><PermissionsSection /></> },
  { id: "phone", icon: "📱", en: "Phone and remote access", he: "טלפון וגישה מרחוק", render: () => <><Phone /><DeviceKeysSection /><ComputersSection /><TelegramSection /><AccessLogSection /></> },
  { id: "accounts", icon: "☁", en: "Accounts and backup", he: "חשבונות וגיבוי", render: () => <><GoogleDriveSection /><OneDriveSection /><Sync /></> },
  { id: "business", icon: "🏢", en: "Organisation", he: "ארגון", render: () => <><CopilotSection /><BusinessSection /></> },
  { id: "developers", icon: "🔧", en: "For developers", he: "למפתחים", render: () => <><McpServerSection /><PhoneTargetsSection /><BrowserSection /><ApiKeysSection />{isRemote() && <section className="card"><p className="muted small">{getLocale() === "he" ? "מפתחות גישה לאפליקציות ומפתח התוסף לדפדפן מוצגים רק במחשב עצמו: הם סודות שפותחים את KesherAI." : "App access keys and the browser extension's key are shown only on the computer itself: they are secrets that open KesherAI."}</p></section>}</> },
];

/** Settings: categories on the side (chips on a phone), `#/settings/<category>`. */
export function SettingsPage() {
  const he = getLocale() === "he";
  const fromHash = () => location.hash.replace(/^#\/settings\/?/, "").split(/[/?#]/)[0] || "general";
  const [cat, setCat] = useState(fromHash);
  useEffect(() => {
    const on = () => setCat(fromHash());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const current = SETTINGS_CATS.find((c) => c.id === cat) ?? SETTINGS_CATS[0]!;
  return (
    <div className="page settings-page">
      <div className="row"><h1 className="grow">{t("settings")}</h1><button type="button" onClick={openWelcome}>{he ? "הצג את מסך הפתיחה שוב" : "Show the welcome again"}</button></div>
      <div className="settings-layout">
        <nav className="settings-cats" aria-label={t("settings")}>
          {SETTINGS_CATS.map((c) => (
            <a key={c.id} href={`#/settings/${c.id}`} aria-current={c.id === current.id ? "page" : undefined}>
              <span aria-hidden="true">{c.icon}</span> {he ? c.he : c.en}
            </a>
          ))}
        </nav>
        <div className="settings-body" key={current.id}>{current.render()}</div>
      </div>
    </div>
  );
}

interface Rule { tool: string; scope: "conversation" | "model" | "everywhere"; conversationId?: string; modelId?: string; createdAt?: string; until?: string; command?: string }

/** Approvals the user gave for good: what runs without asking, and where. */
/** Desktop app: start with the computer, in the background (no window), so the phone and other computers can always reach it. */
function StartupToggle() {
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    void desktop()?.startup?.().then(setOn, () => undefined);
  }, []);
  if (on === null || !desktop()?.startup) return null;
  return (
    <label className="check">
      <input type="checkbox" checked={on} onChange={(e) => void desktop()!.startup!(e.target.checked).then(setOn)} />
      {t("startWithComputer")}
    </label>
  );
}

interface Https { installed: boolean; running: boolean; url?: string; on: boolean; hint?: string }

/** HTTPS for remote access through Tailscale: a real certificate at the computer's tailnet name. */
function HttpsCard() {
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

export function PermissionsSection() {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const { conversations } = useLibrary();
  useEffect(() => {
    void api<Rule[]>("/api/permissions").then(setRules).catch(() => setRules([]));
  }, []);
  if (!rules) return null;
  const where = (r: Rule) =>
    r.scope === "everywhere" ? t("scopeEverywhere") : r.scope === "model" ? t("scopeModel", { model: r.modelId ?? "" }) : t("scopeChat", { chat: conversations.find((c) => c.id === r.conversationId)?.title ?? "?" });
  return (
    <section className="card stack">
      <h2>{t("permissionsTitle")}</h2>
      <p className="muted">{t("permissionsHint")}</p>
      {rules.length === 0 && <p className="muted">{t("permissionsNone")}</p>}
      <div className="list">
        {rules.map((r, i) => (
          <div key={`${r.tool}-${r.scope}-${r.conversationId ?? r.modelId ?? ""}-${r.command ?? ""}`} className="row">
            <span className="mono">{r.tool}{r.command ? <> · <code dir="ltr">{r.command}…</code></> : null}</span>
            <span className="grow muted" dir="auto">{where(r)}{r.until ? ` · ${Date.parse(r.until) <= Date.now() ? (getLocale() === "he" ? "הסתיים" : "ended") : `${getLocale() === "he" ? "עד" : "until"} ${new Date(r.until).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`}` : ""}</span>
            <button type="button" onClick={() => void api<Rule[]>(`/api/permissions/${i}`, { method: "DELETE" }).then(setRules)}>{t("remove")}</button>
          </div>
        ))}
      </div>
    </section>
  );
}
