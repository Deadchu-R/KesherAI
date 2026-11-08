import { useEffect, useState } from "react";
import { api } from "./api";
import { getLocale } from "./i18n";
import { toast } from "./library";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);
const when = (iso: string) => new Date(iso).toLocaleString(getLocale() === "he" ? "he-IL" : undefined, { dateStyle: "short", timeStyle: "short" });

interface Log {
  visitors: Array<{ address: string; first: string; last: string; count: number; via: "tunnel" | "network"; agent?: string }>;
  refused: Array<{ at: string; address: string; method: string; path: string; status: number; via: "tunnel" | "network" }>;
}

/** Settings → Phone: who came in from outside, and who was refused. */
export function AccessLogSection() {
  const [log, setLog] = useState<Log | null>(null);
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
            <li key={r.at + i}><b dir="ltr">{r.address}</b> <span className="muted">· {when(r.at)} · {via(r.via)} · {why(r.status)} · <span dir="ltr">{r.method} {r.path}</span></span></li>
          ))}
        </ul>
      ) : <p className="muted">{L("לא היו ניסיונות שנחסמו.", "No refused tries.")}</p>}
    </section>
  );
}
