import { useCallback, useEffect, useState } from "react";
import { api, isRemote } from "../api";
import { getLocale, he$ } from "../i18n";
import { toast } from "../library";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** One price watch as /api/travel lists it. */
interface WatchRow {
  id: string;
  kind: "flight" | "stay";
  label: string;
  maxIls: number | null;
  paused: boolean;
  expired: boolean;
  lastIls: number | null;
  firstIls: number | null;
  lowestIls: number | null;
  carrier: string;
  lastPollAt: number | null;
  pollsToday: number;
  lastError: string | null;
  history: Array<{ at: number; ils: number }>;
}

/** Everything Settings › Travel shows (never a key, only whether it is set). */
interface TravelState {
  keys: { amadeus: boolean; duffel: boolean };
  amadeusHost: "test" | "production";
  origin: string;
  everyHours: number;
  dropPercent: number;
  dropShekel: number;
  maxWatches: number;
  maxPollsPerDay: number;
  rate: { USD?: number; EUR?: number; date: string; source: string; stale?: boolean } | null;
  watches: WatchRow[];
}

/** @returns "₪1,380". */
const ils = (n: number | null): string => (n === null ? "-" : `₪${Math.round(n).toLocaleString("en-US")}`);

/** @returns A time as "14:20" or "28 Nov 14:20" in the interface language. */
function stamp(ms: number): string {
  const d = new Date(ms);
  const loc = getLocale() === "he" ? "he-IL" : undefined;
  const time = d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? `${L("היום", "today")} ${time}` : `${d.toLocaleDateString(loc, { day: "numeric", month: "short" })} ${time}`;
}

/** The last prices as a small line (no library: an inline SVG polyline; the lowest point is dotted). */
function Spark({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const w = 120;
  const h = 28;
  const lo = Math.min(...points);
  const hi = Math.max(...points);
  const span = hi - lo || 1;
  const xy = points.map((p, i) => [(i / (points.length - 1)) * w, h - 3 - ((p - lo) / span) * (h - 6)] as const);
  const low = xy[points.indexOf(lo)]!;
  return (
    <svg className="travel-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={L("מחירים אחרונים", "Recent prices")}>
      <polyline points={xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")} fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx={low[0]} cy={low[1]} r="2.6" fill="var(--accent)" />
    </svg>
  );
}

/**
 * Settings › Travel: the free keys for flight and hotel search (typed on the computer, kept encrypted, never shown again),
 * the Bank of Israel shekel rate, the defaults (home airport, how often watches look, when a drop alerts the phone) and
 * the price watches with Pause / Resume / Delete. The phone sees the same page; keys and defaults are changed on the computer.
 */
export function TravelSection() {
  const remote = isRemote();
  const [st, setSt] = useState<TravelState | null>(null);
  const [draft, setDraft] = useState({ amadeusKey: "", amadeusSecret: "", duffelToken: "" });
  const [sure, setSure] = useState<string>();
  const load = useCallback(() => void api<TravelState>("/api/travel").then(setSt, () => undefined), []);
  useEffect(() => {
    load();
    const t = window.setInterval(() => !document.hidden && load(), 30_000);
    return () => window.clearInterval(t);
  }, [load]);
  if (!st) return <section className="card travel-page"><h3>{L("טיסות ומלונות", "Travel")}</h3><p className="muted">…</p></section>;
  const put = (body: Record<string, unknown>, clear?: string[]) =>
    void api("/api/travel", { method: "PUT", body }).then(() => (setDraft((d) => ({ ...d, ...Object.fromEntries((clear ?? []).map((k) => [k, ""])) })), toast(L("נשמר.", "Saved.")), load()), (e: Error) => toast(e.message));
  const watchAct = (id: string, action: "pause" | "resume" | "delete") =>
    void (action === "delete" ? api(`/api/travel/watches/${encodeURIComponent(id)}`, { method: "DELETE" }) : api(`/api/travel/watches/${encodeURIComponent(id)}/${action}`, { method: "POST" })).then(load, (e: Error) => toast(e.message));
  return (
    <section className="card travel-page stack">
      <h3>{L("טיסות ומלונות", "Travel")}</h3>
      <p className="muted small">{L("חיפוש בלבד: KesherAI לא מזמין ולא משלם. המחירים מומרים ל-₪ לפי שער בנק ישראל, והחיפוש רץ על המחשב שלך עם המפתח החינמי שלך.", "Search only: KesherAI never books or pays. Prices are converted to ₪ at the Bank of Israel rate, and the search runs on your computer with your own free key.")}</p>

      <h4>{L("מפתחות חינמיים", "Free keys")}</h4>
      {([
        { k: "amadeus", title: "Amadeus Self-Service", note: L("טיסות ומלונות · developers.amadeus.com", "flights and hotels · developers.amadeus.com"), set: st.keys.amadeus, fields: ["amadeusKey", "amadeusSecret"] as const },
        { k: "duffel", title: "Duffel", note: L("טיסות (חיפוש בלבד) · duffel.com", "flights (search only) · duffel.com"), set: st.keys.duffel, fields: ["duffelToken"] as const },
      ]).map((p) => (
        <div key={p.k} className="stack small travel-key">
          <span><b>{p.title}</b> · {p.set ? L("מוגדר ✓", "set ✓") : L("לא מוגדר", "not set")} <span className="muted">({p.note})</span></span>
          {!remote && (
            <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
              {p.fields.map((f) => (
                <input key={f} dir="ltr" type="password" autoComplete="off" style={{ flex: "1 1 160px", minWidth: 0 }} value={draft[f]} onChange={(e) => setDraft({ ...draft, [f]: e.target.value })} placeholder={f === "amadeusKey" ? "API key" : f === "amadeusSecret" ? "API secret" : "Access token"} />
              ))}
              <button type="button" disabled={p.fields.some((f) => !draft[f].trim())} onClick={() => put(Object.fromEntries(p.fields.map((f) => [f, draft[f]])), [...p.fields])}>{L("שמור", "Save")}</button>
              {p.set && <button type="button" onClick={() => put(Object.fromEntries(p.fields.map((f) => [f, null])))}>{L("הסר", "Remove")}</button>}
            </div>
          )}
        </div>
      ))}
      {!st.keys.amadeus && !st.keys.duffel && <p className="small travel-nokey">{L("אין עדיין מפתח: הוסף מפתח חינמי כדי לחפש טיסות.", "No key yet: add a free key to search flights.")}</p>}
      <label className="row small" style={{ gap: 8, alignItems: "center" }}>
        {L("שרת Amadeus", "Amadeus host")}
        <select disabled={remote} value={st.amadeusHost} onChange={(e) => put({ amadeusHost: e.target.value })}>
          <option value="test">{L("מבחן (נתוני דוגמה)", "Test (sample data)")}</option>
          <option value="production">{L("אמיתי (מחירים אמיתיים)", "Production (real fares)")}</option>
        </select>
      </label>

      <h4>{L("שער ל-₪", "Shekel rate")}</h4>
      <p className="small" dir="auto">
        {st.rate ? <>
          {L("בנק ישראל", "Bank of Israel")} · {st.rate.date}{st.rate.stale ? ` · ${L("טבלה ישנה", "older table")}` : ""} · <bdi dir="ltr">USD ₪{st.rate.USD?.toFixed(3) ?? "-"} · EUR ₪{st.rate.EUR?.toFixed(3) ?? "-"}</bdi>
        </> : <span className="muted">{L("אין שער כרגע: המחירים יוצגו במטבע המקור.", "No rate right now: prices show in their own currency.")}</span>}
      </p>

      <h4>{L("ברירות מחדל", "Defaults")}</h4>
      <div className="row small" style={{ flexWrap: "wrap", gap: 12 }}>
        <label>{L("שדה תעופה מוצא", "Home airport")} <input dir="ltr" style={{ width: 70 }} maxLength={3} disabled={remote} defaultValue={st.origin} onBlur={(e) => e.target.value.toUpperCase() !== st.origin && put({ origin: e.target.value })} /></label>
        <label>{L("בדיקה כל", "Look every")} <input type="number" min={1} max={24} style={{ width: 64 }} disabled={remote} defaultValue={st.everyHours} onBlur={(e) => Number(e.target.value) !== st.everyHours && put({ everyHours: Number(e.target.value) })} /> {L("שעות", "h")}</label>
        <label>{L("התראה בירידה של", "Alert on a drop of")} <input type="number" min={1} max={90} style={{ width: 64 }} disabled={remote} defaultValue={st.dropPercent} onBlur={(e) => Number(e.target.value) !== st.dropPercent && put({ dropPercent: Number(e.target.value) })} /> %</label>
        <label>{L("או", "or")} ₪ <input type="number" min={10} max={5000} style={{ width: 80 }} disabled={remote} defaultValue={st.dropShekel} onBlur={(e) => Number(e.target.value) !== st.dropShekel && put({ dropShekel: Number(e.target.value) })} /></label>
      </div>
      <p className="muted small">{L(`עד ${st.maxPollsPerDay} בדיקות ביום לכל מעקב, עד ${st.maxWatches} מעקבים; התראה אחת ביום לכל מעקב, בטלפון.`, `At most ${st.maxPollsPerDay} looks a day per watch, ${st.maxWatches} watches; one alert a day per watch, on the phone.`)}</p>

      <h4>{L("מעקבי מחיר", "Price watches")} · {st.watches.length}/{st.maxWatches}</h4>
      {!st.watches.length && <p className="muted small">{L("אין מעקבים. בקש מצ'אט: \"תעקוב אחרי טיסה לרומא ב-12 במרץ\".", "No watches. Ask a chat: \"watch flights to Rome on 12 March\".")}</p>}
      {st.watches.map((w) => {
        const drop = w.firstIls !== null && w.lastIls !== null ? w.lastIls - w.firstIls : 0;
        return (
          <div key={w.id} className="scheduled-row travel-watch" data-paused={w.paused || w.expired ? "1" : undefined}>
            <div className="scheduled-main">
              <b dir="auto">{w.kind === "flight" ? "✈" : "🏨"} <bdi dir="ltr">{w.label}</bdi></b>
              <div className="small" dir="auto">
                <b>{ils(w.lastIls)}</b>{w.carrier ? ` · ${w.carrier}` : ""}
                {drop !== 0 && <span className={drop < 0 ? "travel-down" : "travel-up"}> · {drop < 0 ? "↓" : "↑"} {ils(Math.abs(drop))}</span>}
              </div>
              <div className="small muted" dir="auto">
                {w.maxIls ? `${L("עד", "under")} ${ils(w.maxIls)} · ` : ""}{L("הנמוך", "lowest")} {ils(w.lowestIls)} · {w.paused ? L("מושהה", "paused") : w.expired ? L("הטיול עבר", "trip over") : w.lastPollAt ? `${L("נבדק", "looked")} ${stamp(w.lastPollAt)}` : L("עוד לא נבדק", "not looked yet")}
              </div>
              {w.lastError && <div className="small travel-err" dir="auto">{w.lastError}</div>}
            </div>
            <Spark points={w.history.map((p) => p.ils)} />
            <div className="scheduled-actions">
              {!w.expired && <button type="button" onClick={() => watchAct(w.id, w.paused ? "resume" : "pause")}>{w.paused ? L("המשך", "Resume") : L("השהיה", "Pause")}</button>}
              <button type="button" className="danger" onClick={() => (sure === w.id ? (setSure(undefined), watchAct(w.id, "delete")) : setSure(w.id))}>{sure === w.id ? L("בטוח? מחיקה", "Sure? Delete") : L("מחיקה", "Delete")}</button>
            </div>
          </div>
        );
      })}
      {remote && <p className="muted small">{L("מפתחות וברירות מחדל משנים במחשב.", "Keys and defaults are changed on the computer.")}</p>}
    </section>
  );
}
