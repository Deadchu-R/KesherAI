/**
 * The phone's own settings, reachable while it is connected to a computer (Roee, 2026-11-13): a phone-with-gear
 * button next to the ≡ menu, shown only on a device that came in from outside (the Android app or a paired
 * browser). Everything here belongs to this phone, not to the computer: its notifications, the model on the
 * phone, the app's updates, which computer it is connected to. Remote-desktop apps (Chrome Remote Desktop,
 * Moonlight, Steam Link) keep "this device" apart from "the computer" the same way.
 */
import { api, appHome, disconnectComputer, isRemote } from "./api";
import { getLocale, setLocale, t } from "./i18n";
import { PhoneAppNotifications } from "./PhoneAppNotifications";
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
          <div className="phone-set-group">
            <div className="side-edit-title">{L("החיבור", "Connection")}</div>
            <p className="phone-set-line" dir="auto">🟢 {L("מחובר אל", "Connected to")} <strong>{host || location.hostname}</strong> <span className="muted small" dir="ltr">{location.host}</span></p>
            {home && <button type="button" onClick={go("/?switch=1")}>⇄ {t("switchComputer")}</button>}
            <button type="button" className="danger" onClick={() => confirm(t("disconnectSure")) && disconnectComputer()}>⏏ {t("disconnectComputer")}</button>
          </div>
          <div className="phone-set-group">
            <div className="side-edit-title">{L("התראות", "Notifications")}</div>
            <PhoneAppNotifications />
            {!home && <p className="muted small phone-set-line">{L("התראות למכשיר הזה מגיעות דרך אפליקציית KesherAI לאנדרואיד.", "Notifications for this device come through the KesherAI Android app.")}</p>}
          </div>
          {home && (
            <div className="phone-set-group">
              <div className="side-edit-title">{L("האפליקציה", "The app")}</div>
              <button type="button" onClick={go("/local.html?chat=1")}>📱 {t("phoneChat")}</button>
              <button type="button" onClick={go("/?switch=1&update=1")}>⬆ {t("appUpdates")}</button>
            </div>
          )}
          <div className="phone-set-group">
            <div className="side-edit-title">{L("תצוגה", "Display")}</div>
            <button type="button" onClick={() => { setLocale(getLocale() === "he" ? "en" : "he"); onLocale(); }}>🌐 {getLocale() === "he" ? "English" : "עברית"}</button>
            <a className="button" href="#/settings/appearance" onClick={close}>🎨 {L("מראה (משותף עם המחשב)", "Appearance (shared with the computer)")}</a>
          </div>
        </>
      )}
    </BarPopover>
  );
}
