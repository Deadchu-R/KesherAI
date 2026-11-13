/**
 * The phone's own settings, reachable while it is connected to a computer (Roee, 2026-11-13): a phone-with-gear
 * button next to the ≡ menu, shown only on a device that came in from outside (the Android app or a paired
 * browser). Everything here belongs to this phone, not to the computer: its notifications, the model on the
 * phone, the app's updates, which computer it is connected to. Remote-desktop apps (Chrome Remote Desktop,
 * Moonlight, Steam Link) keep "this device" apart from "the computer" the same way.
 */
import { api, appHome, deviceKey, disconnectComputer, isRemote } from "./api";
import { phoneNotify, setPhoneNotify, type PhoneNotifyState } from "./phoneNotify";
import { getLocale, setLocale, t } from "./i18n";
import { PhoneAppUpdates } from "./pages/UpdatesPage";
import { BarPopover } from "./ui/BarPopover";
import { useEffect, useState } from "react";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/** A phone with a small gear on its corner. */
const ICON = (
  <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
    <rect x="4.5" y="4.5" width="9" height="13.5" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" />
    <path d="M8 15.5h2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <circle cx="14.5" cy="5" r="3.6" fill="var(--panel)" />
    <circle cx="14.5" cy="5" r="1.5" stroke="currentColor" strokeWidth="1.3" fill="none" />
    <path d="M14.5 1.8v1.1M14.5 7.1v1.1M11.3 5h1.1M16.6 5h1.1M12.2 2.7l.8.8M16 6.5l.8.8M12.2 7.3l.8-.8M16 3.5l.8-.8" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
  </svg>
);

/**
 * This phone's notifications: always says where things stand, and has the switch. Turning it on makes Android
 * ask for its permission (when it has not been given); turning it off stops the connection. When something is
 * missing (an old app, no key for this phone) it says what, instead of showing nothing.
 *
 * @param props.inApp - Whether the page runs inside the Android app.
 */
function PhoneNotifications({ inApp }: { inApp: boolean }) {
  const plugin = phoneNotify();
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean; Plugins?: Record<string, unknown> } }).Capacitor;
  const [s, setS] = useState<PhoneNotifyState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!plugin) return;
    const load = () => void plugin.status().then(setS, (e: Error) => setError(e?.message || String(e)));
    load();
    const t = window.setInterval(() => !document.hidden && load(), 4000);
    return () => window.clearInterval(t);
  }, [plugin]);

  if (!plugin) {
    const native = !!cap?.isNativePlatform?.();
    return (
      <>
        <p className="phone-set-line" dir="auto">
          {native || inApp
            ? L("האפליקציה בטלפון לא כוללת את רכיב ההתראות. עדכנו אותה: מסך הבית של האפליקציה ← \"בדוק עדכונים לאפליקציה\".", "The app on this phone has no notifications part. Update it: the app's home screen → \"Check for app updates\".")
            : L("התראות למכשיר הזה מגיעות דרך אפליקציית KesherAI לאנדרואיד. בדפדפן אין התראות.", "Notifications for this device come through the KesherAI Android app. A browser gets none.")}
        </p>
        <p className="muted small" dir="ltr">app: {String(inApp)} · native: {String(native)} · plugins: {cap?.Plugins ? Object.keys(cap.Plugins).join(", ") || "none" : "no bridge"}</p>
      </>
    );
  }
  const on = !!s?.live && !!s?.permission;
  const set = async (want: boolean) => {
    setBusy(true);
    setError("");
    try {
      let now = s ?? (await plugin.status());
      // Android's own question first (it needs no computer).
      if (want && !now.permission && plugin.askPermission) now = await plugin.askPermission();
      if (deviceKey()) now = await setPhoneNotify(want, want ? now.push : false);
      else if (plugin.setLive) now = await plugin.setLive({ live: want });
      else throw new Error(L("לטלפון הזה אין מפתח משלו. חברו אותו שוב: במחשב, הגדרות ← טלפון.", "This phone has no key of its own. Pair it again: on the computer, Settings → Phone."));
      setS(now);
      // Android stops asking after two refusals: its own settings are the way then.
      if (want && !now.permission) void plugin.openSettings();
    } catch (e) {
      setError((e as Error).message || String(e));
    } finally {
      setBusy(false);
    }
  };
  const state = !s ? L("בודק…", "Checking…")
    : !s.permission ? L("אנדרואיד עוד לא מרשה ל-KesherAI להציג התראות.", "Android does not let KesherAI show notifications yet.")
    : !s.live ? L("כבויות.", "Off.")
    : s.connected ? L("🟢 פעילות: מחובר למחשב.", "🟢 On: connected to the computer.")
    : L("פעילות: מתחבר למחשב…", "On: connecting to the computer…");
  return (
    <>
      <p className="phone-set-line" dir="auto">{state}</p>
      <label className="check phone-set-switch">
        <input type="checkbox" checked={on} disabled={busy} onChange={(e) => void set(e.target.checked)} />
        <span>{L("קבל התראות מהמחשב בטלפון הזה", "Get the computer's notifications on this phone")}</span>
      </label>
      {s && !s.permission && <button type="button" className="primary" disabled={busy} onClick={() => void set(true)}>{L("אשר התראות", "Allow notifications")}</button>}
      <button type="button" onClick={() => void plugin.openSettings()}>🔔 {L("הגדרות ההתראות באנדרואיד (סוגים, צליל)", "Android notification settings (kinds, sound)")}</button>
      {!deviceKey() && <p className="muted small" dir="auto">{L("לטלפון הזה אין מפתח משלו, ולכן החיבור הישיר למחשב לא יעבוד עד שתחברו אותו שוב (במחשב: הגדרות ← טלפון).", "This phone has no key of its own, so the direct connection will not work until you pair it again (on the computer: Settings → Phone).")}</p>}
      {error && <p className="error" dir="auto">{error}</p>}
    </>
  );
}

/**
 * @param props.onLocale - Called after the language changes.
 */
export function PhoneSettings({ onLocale }: { onLocale: () => void }) {
  const home = appHome()?.replace(/\/$/, "");
  const [host, setHost] = useState("");
  useEffect(() => {
    void api<{ name?: string }>("/api/remote/links").then((r) => setHost(r.name ?? ""), () => undefined);
  }, []);
  if (!home && !isRemote()) return null;
  const go = (path: string) => () => (location.href = `${home}${path}`);
  return (
    <BarPopover className="phone-settings-btn" label={L("הגדרות הטלפון", "Phone settings")} title={L("הגדרות הטלפון", "Phone settings")} icon={ICON}>
      {(close) => (
        <>
          <div className="row inbox-pop-head">
            <strong className="grow">{L("הגדרות הטלפון", "Phone settings")}</strong>
            <button type="button" className="icon-btn" aria-label={L("סגור", "Close")} onClick={close}>✕</button>
          </div>
          <p className="muted small phone-set-note">{L("מה שכאן שייך למכשיר הזה בלבד. הגדרות המחשב נמצאות ב\"הגדרות\".", "What is here belongs to this device only. The computer's settings are under \"Settings\".")}</p>
          <p className="phone-set-line" dir="auto">🟢 {L("מחובר אל", "Connected to")} <strong>{host || location.hostname}</strong> <span className="muted small" dir="ltr">{location.host}</span></p>
          <div className="phone-set-group">
            <div className="side-edit-title">{L("התראות", "Notifications")}</div>
            <PhoneNotifications inApp={!!home} />
          </div>
          {home && (
            <div className="phone-set-group">
              <div className="side-edit-title">{L("עדכוני האפליקציה", "App updates")}</div>
              {/* Checked and installed here: the connection to the computer stays. */}
              <PhoneAppUpdates />
            </div>
          )}
          <div className="phone-set-group">
            <div className="side-edit-title">{L("תצוגה", "Display")}</div>
            <button type="button" onClick={() => { setLocale(getLocale() === "he" ? "en" : "he"); onLocale(); }}>🌐 {getLocale() === "he" ? "English" : "עברית"}</button>
            <a className="button" href="#/settings/appearance" onClick={close}>🎨 {L("מראה (משותף עם המחשב)", "Appearance (shared with the computer)")}</a>
          </div>
          {/* Nothing above leaves the computer. What does is folded here and says so. */}
          <details className="phone-set-leave">
            <summary>{L("יציאה מהמחשב הזה", "Leaving this computer")}</summary>
            <div className="phone-set-group">
              <p className="muted small phone-set-line">{L("הכפתורים האלה סוגרים את המסך של המחשב. העבודה במחשב ממשיכה, וחוזרים אליו מרשימת המחשבים.", "These close the computer's screen. Work on the computer goes on, and you come back from the list of computers.")}</p>
              {home && <button type="button" onClick={go("/?switch=1")}>⇄ {t("switchComputer")}</button>}
              {home && <button type="button" onClick={go("/local.html?chat=1")}>📱 {t("phoneChat")}</button>}
              <button type="button" className="danger" onClick={() => confirm(t("disconnectSure")) && disconnectComputer()}>⏏ {t("disconnectComputer")}</button>
            </div>
          </details>
        </>
      )}
    </BarPopover>
  );
}
