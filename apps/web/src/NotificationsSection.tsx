import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { api } from "./api";
import { getLocale } from "./i18n";
import { Select } from "./ui/Select";
import { PhoneAppNotifications } from "./PhoneAppNotifications";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);

interface Settings {
  ntfy: { enabled: boolean; server: string; topic?: string };
  desktop: boolean;
  minSeconds: number;
  includeText: boolean;
  waiting: boolean;
  approveButtons?: boolean;
  waitingSeconds?: number;
  subscribeUrl: string;
  recent: Array<{ title: string; at: number; channels: string[] }>;
}

/**
 * Notifications: on the phone through the free ntfy app, and on this
 * computer, when long work ends or an agent waits for the user.
 */
export function NotificationsSection() {
  const [s, setS] = useState<Settings | null>(null);
  const [qr, setQr] = useState("");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    api<Settings>("/api/notifications").then(setS, (e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    if (s?.subscribeUrl) void QRCode.toDataURL(s.subscribeUrl, { margin: 1, width: 168 }).then(setQr, () => setQr(""));
  }, [s?.subscribeUrl]);
  const put = async (body: Record<string, unknown>) => {
    setError("");
    try {
      setS(await api<Settings>("/api/notifications", { method: "PUT", body }));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const test = async () => {
    setMsg("");
    setError("");
    try {
      const r = await api<{ channels: string[] }>("/api/notifications/test", { method: "POST" });
      setMsg(r.channels.includes("app") ? L("נשלחה התראת בדיקה לאפליקציה בטלפון.", "A test notification went to the phone app.") : r.channels.includes("phone") ? L("נשלחה התראת בדיקה לטלפון.", "A test notification went to the phone.") : L("נשלח. אם הטלפון לא קיבל — בדקו שנרשמתם לנושא באפליקציית ntfy.", "Sent. If the phone got nothing, check you subscribed to the topic in the ntfy app."));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (!s) return error ? <section className="card stack"><h2>{L("התראות", "Notifications")}</h2><p className="muted">{error}</p></section> : null;
  return (
    <>
    <PhoneAppNotifications />
    <section className="card stack">
      <h2>{L("התראות", "Notifications")}</h2>
      <p className="muted">{L("הודעה כשעבודה ארוכה מסתיימת (צ׳אט, סוכן או הורדה), או כשסוכן מחכה לאישור שלכם — גם כשאתם רחוקים מהמחשב.", "A message when long work ends (a chat, an agent or a download), or when an agent waits for your approval — even away from the computer.")}</p>
      <label className="check"><input type="checkbox" checked={s.ntfy.enabled} onChange={(e) => void put({ ntfy: { enabled: e.target.checked } })} /> {L("לטלפון, דרך האפליקציה החינמית ntfy", "On the phone, through the free ntfy app")}</label>
      {s.ntfy.enabled && (
        <div className="notify-phone">
          {qr && <img src={qr} alt={L("קוד QR להרשמה", "QR code to subscribe")} width={168} height={168} />}
          <ol className="muted small">
            <li>{L("התקינו את ntfy מ-Google Play או F-Droid (או App Store).", "Install ntfy from Google Play or F-Droid (or the App Store).")}</li>
            <li>{L("באפליקציה: + ← Subscribe to topic, והדביקו את שם הנושא:", "In the app: + → Subscribe to topic, and paste the topic name:")}</li>
            <li className="notify-topic">
              <code dir="ltr">{s.ntfy.topic}</code>
              <button type="button" onClick={() => void navigator.clipboard?.writeText(s.ntfy.topic ?? "")}>{L("העתק", "Copy")}</button>
            </li>
            <li>{L("או סרקו את הקוד במצלמה של הטלפון.", "Or scan the code with the phone's camera.")}</li>
          </ol>
          <p className="muted small">{L("שם הנושא ארוך ואקראי, כך שרק מי שמכיר אותו מקבל את ההתראות. כברירת מחדל נשלחת רק כותרת השיחה, לא התוכן.", "The topic name is long and random, so only someone who knows it gets the notifications. By default only the chat's title is sent, not its content.")}</p>
        </div>
      )}
      <label className="check"><input type="checkbox" checked={s.desktop} onChange={(e) => void put({ desktop: e.target.checked })} /> {L("גם במחשב הזה, כשהחלון לא בחזית", "Also on this computer, when the window is not in front")}</label>
      <label className="check"><input type="checkbox" checked={s.waiting} onChange={(e) => void put({ waiting: e.target.checked })} /> {L("כשסוכן מחכה לאישור או לתשובה", "When an agent waits for an approval or an answer")}</label>
      {s.waiting && (
        <>
          <label className="row small" style={{ gap: 8, paddingInlineStart: 26 }}>
            {L("אחרי", "After")}
            <Select value={s.waitingSeconds ?? 60} onChange={(e) => void put({ waitingSeconds: Number(e.target.value) })}>
              {[0, 30, 60, 120, 300].map((n) => <option key={n} value={n}>{n === 0 ? L("מיד", "right away") : n < 60 ? L(`${n} שניות`, `${n} seconds`) : L(`${n / 60} דקות`, `${n / 60} min`)}</option>)}
            </Select>
          </label>
          <label className="check" style={{ paddingInlineStart: 26 }}><input type="checkbox" checked={s.approveButtons ?? true} onChange={(e) => void put({ approveButtons: e.target.checked })} /> {L("כפתורי אשר / דחה בהתראה, גם בשעון חכם (צריך גישה \"מכל מקום\")", "Approve / Deny buttons on the notification, on a smartwatch too (needs \"Access from anywhere\")")}</label>
        </>
      )}
      <label className="check"><input type="checkbox" checked={s.includeText} onChange={(e) => void put({ includeText: e.target.checked })} /> {L("לכלול את תחילת התשובה בהתראה (עוברת דרך שרת ntfy)", "Include the start of the answer (it passes through the ntfy server)")}</label>
      <label className="row notify-min">
        {L("רק לעבודה שלקחה לפחות", "Only for work that took at least")}
        <Select value={s.minSeconds} onChange={(e) => void put({ minSeconds: Number(e.target.value) })}>
          {[0, 30, 60, 120, 300, 600].map((n) => <option key={n} value={n}>{n === 0 ? L("תמיד", "always") : n < 60 ? `${n} ${L("שניות", "s")}` : `${n / 60} ${L("דק׳", "min")}`}</option>)}
        </Select>
      </label>
      <details>
        <summary className="muted small">{L("מתקדם", "Advanced")}</summary>
        <div className="stack">
          <label className="row">{L("שרת ntfy", "ntfy server")}<input dir="ltr" defaultValue={s.ntfy.server} onBlur={(e) => e.target.value !== s.ntfy.server && void put({ ntfy: { server: e.target.value } })} /></label>
          <div className="row"><button type="button" onClick={() => void put({ newTopic: true })}>{L("נושא חדש (הטלפון הישן יפסיק לקבל)", "New topic (the old phone stops getting them)")}</button></div>
        </div>
      </details>
      <div className="row">
        <button type="button" onClick={() => void test()} disabled={!s.ntfy.enabled && !s.desktop}>{L("שלח התראת בדיקה", "Send a test")}</button>
        {msg && <span className="muted small">{msg}</span>}
      </div>
      {error && <p className="error small">{error}</p>}
    </section>
    </>
  );
}
