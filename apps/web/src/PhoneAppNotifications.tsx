import { useEffect, useState } from "react";
import { getLocale } from "./i18n";
import { phoneNotify, setPhoneNotify, type PhoneNotifyState } from "./phoneNotify";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

/**
 * In the Android app: its own notifications, the way phone apps notify (docs/RESEARCH_LOG.md, 2026-11-11).
 * Two ways to get them, both can be on: a live connection to the computer, and ntfy (UnifiedPush,
 * encrypted) when the computer cannot be reached. Each kind of notification can be muted in Android.
 */
export function PhoneAppNotifications() {
  const plugin = phoneNotify();
  const [s, setS] = useState<PhoneNotifyState | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!plugin) return;
    const load = () => void plugin.status().then(setS, () => undefined);
    load();
    const t = window.setInterval(() => !document.hidden && load(), 4000);
    return () => window.clearInterval(t);
  }, [plugin]);
  // The Android app from before its own notifications: say how to get them instead of showing nothing.
  const inApp = !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
  if (!plugin && inApp)
    return (
      <section className="card stack">
        <h2>{L("התראות באפליקציה הזו", "Notifications in this app")}</h2>
        <p className="muted">{L("הגרסה של האפליקציה בטלפון ישנה מדי להתראות משלה. עדכנו אותה (בדף העדכונים, "האפליקציה בטלפון"), פתחו אותה מחדש, והכרטיס הזה יציג את המתגים.", "This phone app is too old for its own notifications. Update it (the Updates page, "The phone app"), open it again, and this card shows the switches.")}</p>
        <a className="button" href="#/updates">{L("לעדכונים", "Go to updates")}</a>
      </section>
    );
  if (!plugin || !s) return null;
  const set = async (live: boolean, push: boolean) => {
    setError("");
    try {
      setS(await setPhoneNotify(live, push));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const pushNote =
    !s.push ? "" :
    s.distributors === 0 ? L("צריך להתקין את ntfy (מ-Google Play או F-Droid) ואז לסמן שוב.", "Install ntfy (Google Play or F-Droid), then turn this on again.") :
    s.pushState === "ok" ? L(`פעיל דרך ${s.distributor === "io.heckel.ntfy" ? "ntfy" : s.distributor ?? "ntfy"}. ההתראות מוצפנות, כך ש-ntfy לא רואה את התוכן.`, `On, through ${s.distributor === "io.heckel.ntfy" ? "ntfy" : s.distributor ?? "ntfy"}. Notifications are encrypted, so ntfy cannot read them.`) :
    s.pushState.startsWith("server:") ? L("המחשב לא קיבל את הכתובת של ntfy. נסו שוב.", "The computer did not accept ntfy's address. Try again.") :
    s.pushState.startsWith("failed") ? L("ntfy לא אישר את הרישום. פתחו את ntfy ונסו שוב.", "ntfy did not accept the registration. Open ntfy and try again.") :
    L("נרשם ב-ntfy…", "Registering with ntfy…");
  return (
    <section className="card stack">
      <h2>{L("התראות באפליקציה הזו", "Notifications in this app")}</h2>
      {!s.permission && (s.live || s.push) && <p className="error">{L("ההתראות של KesherAI כבויות באנדרואיד. הפעילו אותן כדי לקבל אותן.", "KesherAI's notifications are off in Android. Turn them on to get them.")}</p>}
      {s.live && <p className={s.connected ? "muted" : "muted small"}>{s.connected ? L("🟢 מחובר למחשב: התראות מגיעות ישירות.", "🟢 Connected to the computer: notifications arrive directly.") : L("⚪ מחפש את המחשב (ברשת הבית, ואז דרך הקישור מכל מקום).", "⚪ Looking for the computer (on the home network, then through the link from anywhere).")}</p>}
      <label className="check">
        <input type="checkbox" checked={s.live} onChange={(e) => void set(e.target.checked, s.push)} />
        <span>{L("חיבור ישיר למחשב", "A direct connection to the computer")}<br /><span className="muted small">{L("בבית וגם בחוץ (דרך הקישור \"גישה מכל מקום\" של המחשב), בלי שום אפליקציה נוספת. אנדרואיד מחייב הודעה קבועה קטנה (אפשר להסתיר אותה), וזה לוקח קצת סוללה.", "At home and away (through the computer's \"Access from anywhere\" link), with no other app. Android requires a small fixed notification (it can be hidden), and it uses some battery.")}</span></span>
      </label>
      <label className="check">
        <input type="checkbox" checked={s.push} onChange={(e) => void set(s.live, e.target.checked)} />
        <span>{L("גיבוי (לא חובה): דרך ntfy", "Backup (optional): through ntfy")}<br /><span className="muted small">{pushNote || L("ntfy מחזיק חיבור אחד לכל האפליקציות ומעביר ל-KesherAI. חסכוני בסוללה.", "ntfy keeps one connection for all apps and hands KesherAI its messages. Easy on the battery.")}</span></span>
      </label>
      <p className="muted small">{L("כל שיחה מקבלת התראה אחת שמתעדכנת. \"מחכה לך\" קופצת עם צליל ועם אשר/דחה (רק בטלפון פתוח), ונעלמת כשעונים במחשב.", "Each chat gets one notification that updates. \"Waiting for you\" pops up with sound and Approve/Deny (only on an unlocked phone), and goes away once answered on the computer.")}</p>
      <div className="row wrap">
        <button type="button" onClick={() => void plugin.openSettings()}>{L("איזה סוגים להציג (הגדרות אנדרואיד)", "Which kinds to show (Android settings)")}</button>
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
