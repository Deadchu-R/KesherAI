/**
 * The Settings page: categories on the side (chips on a phone), one search over all of them, and the sections
 * they hold. `SETTINGS_CATS` is the map of what lives where; most sections are their own components, in this
 * file or next to it (GuardSection, NotificationsSection…). Research behind the order: docs/RESEARCH_LOG.md.
 */
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
import { BrowserSection } from "../BrowserSection";
import { ApiKeysSection } from "../ApiKeysSection";
import { PermissionsSection } from "../settings/PermissionsSection";
import { PhoneSection } from "../settings/PhoneSection";
import { useEffect, useState } from "react";
import type { CategoryDefinition, ModelInfo } from "@kesher/shared";
import { api, isRemote, type ModelListing } from "../api";
import { desktop } from "../library";
import { getLocale, t } from "../i18n";
import { Select } from "../ui/Select";
import { ChatsAtOnce } from "../ChatsAtOnce";

interface Settings { activeModels: Record<string, string>; syncFolder: string | null }

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


/**
 * The settings in categories; only the open one is drawn (and asks the computer anything). Ordered from research
 * (Open WebUI 0.11, LM Studio, Msty, Jan; see docs/RESEARCH_LOG.md): everyday choices first, one category per
 * subject (notifications and privacy got their own instead of "General" holding everything), data and reset
 * last, and one search over every setting by its words.
 */
const SETTINGS_CATS: Array<{ id: string; icon: string; en: string; he: string; words: string; render: () => React.ReactNode }> = [
  { id: "general", icon: "⚙", en: "General", he: "כללי", words: "model models default chat image voice speech microphone read aloud מודל מודלים ברירת מחדל צאט קול דיבור הקראה מיקרופון", render: () => <><ActiveModels /><SpeechSection /></> },
  { id: "notifications", icon: "🔔", en: "Notifications", he: "התראות", words: "notifications phone push ntfy approve deny waiting done התראות פוש אישור דחייה מחכה הסתיים טלפון", render: () => <NotificationsSection /> },
  { id: "appearance", icon: "🎨", en: "Appearance and accessibility", he: "מראה ונגישות", words: "theme dark light colors font size language rtl accessibility contrast motion ערכת נושא כהה בהיר צבעים גופן גודל שפה נגישות ניגודיות תנועה", render: () => <><AppearanceSection /><AccessibilitySection /></> },
  { id: "computer", icon: "🖥", en: "Computer and graphics card", he: "המחשב וכרטיס המסך", words: "parallel chats at once slots context במקביל צאטים שיחות הקשר gpu graphics card vram temperature unload idle minutes ram cpu limit guard performance כרטיס מסך טמפרטורה פריקה לפרוק דקות זיכרון מעבד הגבלה ביצועים עומס", render: () => <><GpuSection /><ChatsAtOnce card /><GuardSection /></> },
  { id: "privacy", icon: "🛡", en: "Privacy and permissions", he: "פרטיות והרשאות", words: "permissions always allow approve rules computer control screen mouse access log privacy הרשאות תמיד לאשר כללים שליטה במחשב מסך עכבר יומן גישה פרטיות", render: () => <><PermissionsSection /><ComputerSection /></> },
  { id: "phone", icon: "📱", en: "Phone and remote access", he: "טלפון וגישה מרחוק", words: "phone remote anywhere tunnel qr pair device keys tailscale telegram computers start with computer access log טלפון מרחוק מכל מקום מנהרה קוד סריקה מכשירים מפתחות טלגרם מחשבים הפעלה עם המחשב יומן גישה", render: () => <><PhoneSection /><DeviceKeysSection /><ComputersSection /><TelegramSection /><AccessLogSection /></> },
  { id: "accounts", icon: "☁", en: "Accounts, backup and data", he: "חשבונות, גיבוי ונתונים", words: "google drive onedrive sync backup import chats chatgpt claude reset delete data גוגל דרייב סנכרון גיבוי ייבוא שיחות איפוס מחיקה נתונים", render: () => <><GoogleDriveSection /><OneDriveSection /><Sync /><ImportChats /><ResetSection /></> },
  { id: "business", icon: "🏢", en: "Organisation", he: "ארגון", words: "business organisation copilot team policy ארגון עסקי צוות מדיניות", render: () => <><CopilotSection /><BusinessSection /></> },
  { id: "developers", icon: "🔧", en: "For developers", he: "למפתחים", words: "developer mcp server api keys browser extension phone targets מפתחים שרת מפתחות api תוסף דפדפן", render: () => <><McpServerSection /><PhoneTargetsSection /><BrowserSection /><ApiKeysSection />{isRemote() && <section className="card"><p className="muted small">{getLocale() === "he" ? "מפתחות גישה לאפליקציות ומפתח התוסף לדפדפן מוצגים רק במחשב עצמו: הם סודות שפותחים את KesherAI." : "App access keys and the browser extension's key are shown only on the computer itself: they are secrets that open KesherAI."}</p></section>}</> },
];
/** Old links keep working after the reorganisation. */
const MOVED: Record<string, string> = { accessibility: "appearance" };

/** Settings: categories on the side (chips on a phone), `#/settings/<category>`, and a search over all of them. */
export function SettingsPage() {
  const he = getLocale() === "he";
  const fromHash = () => {
    const id = location.hash.replace(/^#\/settings\/?/, "").split(/[/?#]/)[0] || "general";
    return MOVED[id] ?? id;
  };
  const [cat, setCat] = useState(fromHash);
  const [q, setQ] = useState("");
  useEffect(() => {
    const on = () => setCat(fromHash());
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const current = SETTINGS_CATS.find((c) => c.id === cat) ?? SETTINGS_CATS[0]!;
  // Every word typed must appear in a category's name or words (Hebrew or English).
  const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const found = terms.length ? SETTINGS_CATS.filter((c) => terms.every((w) => `${c.he} ${c.en} ${c.words}`.toLowerCase().includes(w))) : [];
  return (
    <div className="page settings-page">
      <div className="row"><h1 className="grow">{t("settings")}</h1><button type="button" onClick={openWelcome}>{he ? "הצג את מסך הפתיחה שוב" : "Show the welcome again"}</button></div>
      <div className="settings-search">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={he ? "חיפוש בהגדרות (למשל: פריקה, התראות, טלפון)" : "Search settings (e.g. unload, notifications, phone)"} aria-label={he ? "חיפוש בהגדרות" : "Search settings"} />
        {terms.length > 0 && (
          <div className="settings-found" role="list">
            {found.length === 0 && <p className="muted small">{he ? "לא נמצאה הגדרה כזו. נסו מילה אחרת." : "No setting matches. Try another word."}</p>}
            {found.map((c) => (
              <a key={c.id} role="listitem" href={`#/settings/${c.id}`} onClick={() => setQ("")}>
                <span aria-hidden="true">{c.icon}</span> {he ? c.he : c.en}
              </a>
            ))}
          </div>
        )}
      </div>
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



