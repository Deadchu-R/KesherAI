import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);
const when = (iso: string) => new Date(iso).toLocaleString(getLocale() === "he" ? "he-IL" : undefined, { dateStyle: "short", timeStyle: "short" });

interface Req { at: string; address: string; method: string; path: string; status: number; via: "tunnel" | "network"; device?: string; ms?: number }
interface Dev { id: string; name: string; createdAt: string; lastSeen?: string; lastAddress?: string }

interface Log {
  requests?: Req[];
  visitors: Array<{ address: string; first: string; last: string; count: number; via: "tunnel" | "network"; agent?: string }>;
  refused: Array<{ at: string; address: string; method: string; path: string; status: number; via: "tunnel" | "network"; device?: string }>;
}

/** Settings → Phone: who came in from outside, and who was refused. */
export function AccessLogSection() {
  const [log, setLog] = useState<Log | null>(null);
  const [filter, setFilter] = useState<"all" | "refused" | "tunnel">("all");
  const load = () => void api<Log>("/api/access-log").then(setLog, () => undefined);
  useEffect(load, []);
  if (!log) return null;
  const why = (s: number) => (s === 401 ? L("טוקן שגוי או חסר", "wrong or missing token") : s === 403 ? L("אתר אחר / לא מורשה", "another website / not allowed") : L("יותר מדי ניסיונות", "too many tries"));
  const via = (v: "tunnel" | "network") => (v === "tunnel" ? L("דרך האינטרנט", "through the internet") : L("ברשת הביתית", "on your network"));
  return (
    <section className="card stack access-log">
      <div className="row">
        <h2 className="grow">{L("מי נכנס מבחוץ", "Who came in from outside")}</h2>
        <button type="button" onClick={load}>{L("רענן", "Refresh")}</button>
        <button type="button" onClick={() => void api("/api/access-log", { method: "DELETE" }).then(load, (e: Error) => toast(e.message))}>{L("נקה", "Clear")}</button>
      </div>
      <p className="muted small">{L("כל מכשיר שהתחבר ל-KesherAI שלא מהמחשב הזה, וכל ניסיון שנחסם. לא נשמרים טוקנים או תוכן. על 5 ניסיונות שנחסמו תוך 10 דקות תקבל התראה.", "Every device that reached KesherAI from somewhere other than this computer, and every refused try. No tokens or contents are kept. Five refusals in 10 minutes send you an alert.")}</p>
      <h3>{L("נכנסו", "Got in")}</h3>
      {log.visitors.length ? (
        <ul className="al-list">
          {log.visitors.map((v) => (
            <li key={v.address}><b dir="ltr">{v.address}</b> <span className="muted">· {via(v.via)} · {L(`${v.count} פעמים`, `${v.count} times`)} · {L("אחרון:", "last:")} {when(v.last)}{v.agent ? ` · ${v.agent}` : ""}</span></li>
          ))}
        </ul>
      ) : <p className="muted">{L("אף אחד עדיין.", "Nobody yet.")}</p>}
      <h3>{L("נחסמו", "Refused")}</h3>
      {log.refused.length ? (
        <ul className="al-list bad-list">
          {log.refused.slice(0, 50).map((r, i) => (
            <li key={r.at + i}><b dir="ltr">{r.device ?? r.address}</b> <span className="muted">· {when(r.at)} · {via(r.via)} · {r.device && r.status === 403 ? L("המכשיר שלך: הגדרה שזמינה רק במחשב עצמו", "your device: a setting only the computer itself may change") : why(r.status)} · <span dir="ltr">{r.method} {r.path}</span></span></li>
          ))}
        </ul>
      ) : <p className="muted">{L("לא היו ניסיונות שנחסמו.", "No refused tries.")}</p>}

      <details className="al-requests">
        <summary>{L(`יומן בקשות מלא (${log.requests?.length ?? 0})`, `Full request log (${log.requests?.length ?? 0})`)}</summary>
        <div className="seg" role="group">
          {(["all", "refused", "tunnel"] as const).map((f) => (
            <button key={f} type="button" className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{f === "all" ? L("הכל", "All") : f === "refused" ? L("נחסמו", "Refused") : L("דרך האינטרנט", "Through the internet")}</button>
          ))}
        </div>
        <div className="al-table" role="table">
          {(log.requests ?? []).filter((r) => filter === "all" || (filter === "refused" ? r.status >= 400 : r.via === "tunnel")).slice(0, 300).map((r, i) => (
            <div key={r.at + i} role="row" className={r.status >= 400 ? "bad" : ""}>
              <span>{when(r.at)}</span>
              <b dir="ltr">{r.device ?? r.address}</b>
              <span dir="ltr">{r.method} {r.path}</span>
              <span dir="ltr">{r.status}{r.ms !== undefined ? ` · ${r.ms} ms` : ""}</span>
              <span className="muted">{via(r.via)}</span>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}

/**
 * Settings → Phone: each paired device has a key of its own (removable
 * alone), and how strictly the internet link lets devices in.
 */
export function DeviceKeysSection() {
  const [d, setD] = useState<{ devices: Dev[]; devicesOnly: boolean; idleDays: number } | null>(null);
  const load = () => void api<{ devices: Dev[]; devicesOnly: boolean; idleDays: number }>("/api/remote/devices").then(setD, () => undefined);
  useEffect(load, []);
  if (!d) return null;
  const put = (body: Record<string, unknown>) => void api<typeof d>("/api/remote/devices", { method: "PUT", body }).then(setD, (e: Error) => toast(e.message));
  return (
    <section className="card stack">
      <h2>{L("מכשירים מחוברים והגנה על הגישה מכל מקום", "Paired devices, and protecting access from anywhere")}</h2>
      <p className="muted small">{L("כל מכשיר שמתחבר מקבל מפתח משלו. אפשר לנתק מכשיר אחד בלי לגעת בשאר, והיומן מראה איזה מכשיר נכנס.", "Each device that pairs gets a key of its own: one can be removed without touching the others, and the log shows which device came in.")}</p>
      {d.devices.length ? (
        <ul className="al-list">
          {d.devices.map((x) => (
            <li key={x.id} className="row">
              <span className="grow"><b>{x.name}</b> <span className="muted">· {L("חובר", "paired")} {when(x.createdAt)}{x.lastSeen ? ` · ${L("נראה לאחרונה", "last seen")} ${when(x.lastSeen)}` : ""}{x.lastAddress ? ` · ${x.lastAddress}` : ""}</span></span>
              <button type="button" onClick={() => confirm(L(`לנתק את ${x.name}? המפתח שלו יפסיק לעבוד מיד.`, `Remove ${x.name}? Its key stops working at once.`)) && void api(`/api/remote/devices/${x.id}`, { method: "DELETE" }).then(load, (e: Error) => toast(e.message))}>{L("נתק", "Remove")}</button>
            </li>
          ))}
        </ul>
      ) : <p className="muted small">{L("עוד אין מכשירים עם מפתח משלהם. מכשיר שמתחבר מעכשיו (חיבור ברשת הביתית) יקבל אחד.", "No devices with their own key yet; a device that pairs from now on (on the home network) gets one.")}</p>}
      <label className="row small"><input type="checkbox" checked={d.devicesOnly} onChange={(e) => put({ devicesOnly: e.target.checked })} /> {L("דרך האינטרנט: רק מכשירים מחוברים עם מפתח משלהם (מומלץ). הטוקן המשותף והקוד QR יעבדו רק ברשת הביתית.", "Through the internet: only paired devices with their own key (recommended). The shared token and the QR code then work only on the home network.")}</label>
      <label className="row small">{L("מכשיר שלא היה בשימוש", "A device not used for")}
        <select value={d.idleDays} onChange={(e) => put({ idleDays: Number(e.target.value) })}>
          {[0, 7, 14, 30, 60, 90].map((n) => <option key={n} value={n}>{n === 0 ? L("אף פעם", "never") : L(`${n} ימים`, `${n} days`)}</option>)}
        </select>
        {L("לא ייכנס דרך האינטרנט עד שישתמשו בו ברשת הביתית.", "cannot come in through the internet until it is used on the home network.")}
      </label>
    </section>
  );
}
