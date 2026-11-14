import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";
import { toast } from "../library";
import { RichText } from "../RichText";
import { ReportDialog } from "../ReportDialog";
import { FixDialog } from "../FixDialog";
import { StorageSection } from "../StorageSection";

const L = (he: string, en: string) => (getLocale() === "he" ? he : en);
const GB = 1024 ** 3;
const gb = (b: number) => (b >= 10 * GB ? Math.round(b / GB) : Math.round((b / GB) * 10) / 10);

interface Reading {
  at: string;
  drives: Array<{ name: string; freeBytes: number; totalBytes: number }>;
  kesher: Array<{ name: string; bytes: number; partial?: boolean }>;
  temp?: { bytes: number; partial?: boolean };
  windowsOld: boolean;
  restartPending: boolean;
  startup: string[];
  ram: { usedBytes: number; totalBytes: number };
  cpu?: { percent: number; temp?: number };
  gpus: Array<{ name: string; temp: number; memUsedBytes: number; memTotalBytes: number }>;
  uptimeHours: number;
}
interface Item { level: "ok" | "warn" | "bad"; title: string; fix: string }

/** What the phone app's native side reads (Android's own APIs). */
interface PhoneReading { storageFree?: number; storageTotal?: number; ramFree?: number; ramTotal?: number; lowMemory?: boolean; batteryPercent?: number; batteryTempC?: number; batteryHealth?: string; charging?: boolean; modelsBytes?: number; model?: string; android?: string }
const phonePlugin = () => (window as unknown as { Capacitor?: { Plugins?: { KesherLlm?: { health?: () => Promise<PhoneReading> } } } }).Capacitor?.Plugins?.KesherLlm;

/** What to do about the phone, from fixed rules (like the computer's). */
export function phoneItems(p: PhoneReading): Item[] {
  const out: Item[] = [];
  const n = (t: string) => `\u2066${t}\u2069`;
  if (p.storageFree !== undefined && p.storageTotal) {
    const pct = p.storageFree / p.storageTotal;
    if (p.storageFree < 2 * GB || pct < 0.05) out.push({ level: "bad", title: L(`בטלפון נשארו רק ${n(`${gb(p.storageFree)} GB`)}`, `Only ${gb(p.storageFree)} GB left on the phone`), fix: L("הגדרות הטלפון ← אחסון: אפליקציות גדולות, תמונות וסרטונים כפולים, וקבצים שהורדו.", "Phone settings → Storage: big apps, duplicate photos and videos, downloaded files.") });
    else if (p.storageFree < 8 * GB || pct < 0.1) out.push({ level: "warn", title: L(`בטלפון נשארו ${n(`${gb(p.storageFree)} GB`)}`, `${gb(p.storageFree)} GB left on the phone`), fix: L("כדאי לפנות מקום לפני הורדת מודל לטלפון.", "Worth clearing space before downloading a model to the phone.") });
  }
  if ((p.modelsBytes ?? 0) > 3 * GB) out.push({ level: "warn", title: L(`מודלים בטלפון תופסים ${n(`${gb(p.modelsBytes!)} GB`)}`, `Models on the phone take ${gb(p.modelsBytes!)} GB`), fix: L("בעמוד המודלים של הטלפון: מחקו מודל שלא משתמשים בו.", "On the phone's models page: delete one you do not use.") });
  if ((p.batteryTempC ?? 0) >= 42) out.push({ level: "bad", title: L(`הסוללה חמה: ${n(`${p.batteryTempC}°C`)}`, `The battery is hot: ${p.batteryTempC}°C`), fix: L("עצרו מודל מקומי או משחק, הורידו כיסוי, ואל תטעינו בחום.", "Stop a local model or game, take off the case, and do not charge it hot.") });
  if (p.batteryHealth && p.batteryHealth !== "good" && p.batteryHealth !== "unknown") out.push({ level: "warn", title: L("מצב הסוללה לא תקין", "The battery's health is not good"), fix: L("כדאי לבדוק במעבדה מורשית.", "Worth checking at an authorised service.") });
  if (p.lowMemory) out.push({ level: "warn", title: L("הזיכרון בטלפון כמעט מלא", "The phone's memory is almost full"), fix: L("סגרו אפליקציות שרצות ברקע.", "Close apps running in the background.") });
  if (!out.length) out.push({ level: "ok", title: L("הטלפון נראה תקין", "The phone looks fine"), fix: L("אין מה לעשות כרגע.", "Nothing to do right now.") });
  return out;
}

/** A used/total bar with its numbers. */
function Meter({ label, used, total, note }: { label: string; used: number; total: number; note: string }) {
  const pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0;
  return (
    <div className="health-meter">
      <div className="row small"><strong className="grow" dir="auto">{label}</strong><span className="muted"><bdi>{note}</bdi></span></div>
      <div className={`health-bar${pct >= 95 ? " bad" : pct >= 90 ? " warn" : ""}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={label}><span style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

/**
 * PC Health, with AI (docs/VISION.md): what to do first (fixed rules, and the chat model's plain-words list on
 * request), then the numbers: drives, memory, processor and cards, KesherAI's own folders, startup programs. Only
 * reads; every fix is a step the user takes. Works from the phone too (it shows the computer).
 */
export function HealthPage() {
  const [data, setData] = useState<{ reading: Reading; items: Item[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [advice, setAdvice] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [phone, setPhone] = useState<PhoneReading | null>(null);
  const [faults, setFaults] = useState<Array<{ at: string; kind: string; where: string; message: string }>>([]);
  const load = (fresh = false) => {
    setBusy(true);
    void api<{ reading: Reading; items: Item[] }>(`/api/pc-health?lang=${getLocale()}${fresh ? "&fresh=1" : ""}`)
      .then(setData, (e: Error) => toast(e.message))
      .finally(() => setBusy(false));
    void api<typeof faults>("/api/faults").then(setFaults, () => undefined);
    // In the phone app: the phone's own health too (Android's APIs, through the app).
    void phonePlugin()?.health?.().then(setPhone, () => undefined);
  };
  useEffect(() => {
    load();
  }, []);
  const ask = () => {
    setThinking(true);
    void api<{ text: string }>("/api/pc-health/advice", { method: "POST", body: { lang: getLocale(), ...(phone ? { phone } : {}) } })
      .then((r) => setAdvice(r.text), (e: Error) => toast(e.message))
      .finally(() => setThinking(false));
  };
  const r = data?.reading;
  return (
    <div className="page health-page">
      {reporting && <ReportDialog onClose={() => setReporting(false)} />}
      {fixing && <FixDialog onClose={() => setFixing(false)} onDone={() => load(true)} />}
      <div className="row">
        <h1 className="grow">{L("בריאות המחשב", "PC Health")}</h1>
        <button type="button" className="primary" onClick={() => setFixing(true)}>{L("🛠 תקן לי", "🛠 Fix it for me")}</button>
        <button type="button" disabled={busy} onClick={() => load(true)}>{busy ? L("בודק…", "Checking…") : L("בדוק שוב", "Check again")}</button>
      </div>
      <p className="muted">{L("מה חסר למחשב ומה לעשות. \"תקן לי\" עושה בעצמו את מה שבטוח, רק בדברים של KesherAI ורק אחרי שתאשרו. כל השאר הם צעדים שאתם עושים.", "What the computer is short of and what to do. \"Fix it for me\" does the safe part itself, only with KesherAI's own things and only after you confirm; the rest are steps you take.")}</p>
      {!data && <p className="muted">{L("בודק את המחשב…", "Checking the computer…")}</p>}
      {data && (
        <section className="card stack">
          <h2>{L("מה לעשות", "What to do")}</h2>
          <ul className="health-items">
            {data.items.map((i, n) => (
              <li key={n} className={`health-item ${i.level}`}>
                <span className="health-dot" aria-label={i.level === "bad" ? L("דחוף", "Urgent") : i.level === "warn" ? L("כדאי", "Worth doing") : L("תקין", "Fine")} />
                <div className="stack"><strong dir="auto">{i.title}</strong><span className="muted small" dir="auto">{i.fix}</span></div>
              </li>
            ))}
          </ul>
          {advice === null ? (
            <button type="button" style={{ alignSelf: "start" }} disabled={thinking} onClick={ask}>{thinking ? L("המודל כותב…", "The model is writing…") : L("✨ הסבר במילים פשוטות", "✨ Explain in plain words")}</button>
          ) : (
            <div className="health-advice"><RichText text={advice} /></div>
          )}
        </section>
      )}
      <StorageSection />
      {phone && (
        <section className="card stack">
          <h2>{L(`הטלפון${phone.model ? ` (${phone.model})` : ""}`, `This phone${phone.model ? ` (${phone.model})` : ""}`)}</h2>
          <ul className="health-items">
            {phoneItems(phone).map((i, k) => (
              <li key={k} className={`health-item ${i.level}`}>
                <span className="health-dot" />
                <div className="stack"><strong dir="auto">{i.title}</strong><span className="muted small" dir="auto">{i.fix}</span></div>
              </li>
            ))}
          </ul>
          {phone.storageTotal ? <Meter label={L("אחסון", "Storage")} used={phone.storageTotal - (phone.storageFree ?? 0)} total={phone.storageTotal} note={L(`\u2066${gb(phone.storageFree ?? 0)} GB\u2069 פנויים`, `${gb(phone.storageFree ?? 0)} GB free`)} /> : null}
          {phone.ramTotal ? <Meter label={L("זיכרון", "Memory")} used={phone.ramTotal - (phone.ramFree ?? 0)} total={phone.ramTotal} note={`${gb(phone.ramTotal - (phone.ramFree ?? 0))} / ${gb(phone.ramTotal)} GB`} /> : null}
          {phone.batteryPercent !== undefined && phone.batteryPercent >= 0 && <p className="small">{L(`סוללה: \u2066${phone.batteryPercent}%\u2069${phone.charging ? " (בטעינה)" : ""} · \u2066${phone.batteryTempC}°C\u2069`, `Battery: ${phone.batteryPercent}%${phone.charging ? " (charging)" : ""} · ${phone.batteryTempC}°C`)}</p>}
        </section>
      )}
      {r && (
        <>
          <section className="card stack">
            <h2>{L("מקום בכוננים", "Drive space")}</h2>
            {r.drives.map((d) => <Meter key={d.name} label={d.name} used={d.totalBytes - d.freeBytes} total={d.totalBytes} note={L(`\u2066${gb(d.freeBytes)} GB\u2069 פנויים מתוך \u2066${gb(d.totalBytes)} GB\u2069`, `${gb(d.freeBytes)} GB free of ${gb(d.totalBytes)}`)} />)}
            {r.temp && <p className="muted small">{L(`קבצים זמניים: \u2066${gb(r.temp.bytes)} GB${r.temp.partial ? "+" : ""}\u2069`, `Temporary files: ${gb(r.temp.bytes)} GB${r.temp.partial ? "+" : ""}`)}{r.windowsOld ? L(" · Windows.old קיים", " · Windows.old is there") : ""}</p>}
          </section>
          <section className="card stack">
            <h2>{L("זיכרון, מעבד וכרטיסים", "Memory, processor and cards")}</h2>
            <Meter label={L("זיכרון (RAM)", "Memory (RAM)")} used={r.ram.usedBytes} total={r.ram.totalBytes} note={`${gb(r.ram.usedBytes)} / ${gb(r.ram.totalBytes)} GB`} />
            {r.cpu && <p className="small">{L(`מעבד: \u2066${r.cpu.percent}%\u2069`, `Processor: ${r.cpu.percent}%`)}{r.cpu.temp !== undefined ? ` · ${r.cpu.temp}°C` : ""}</p>}
            {r.gpus.map((g, i) => <Meter key={i} label={`${g.name} · ${g.temp}°C`} used={g.memUsedBytes} total={g.memTotalBytes} note={L(`זיכרון \u2066${gb(g.memUsedBytes)} / ${gb(g.memTotalBytes)} GB\u2069`, `Memory ${gb(g.memUsedBytes)} / ${gb(g.memTotalBytes)} GB`)} />)}
            <p className="muted small">{L(`פועל ${r.uptimeHours} שעות מאז ההפעלה האחרונה`, `Up ${r.uptimeHours} hours since the last restart`)}{r.restartPending ? L(" · עדכון מחכה להפעלה מחדש", " · an update waits for a restart") : ""}</p>
          </section>
          {r.kesher.length > 0 && (
            <section className="card stack">
              <h2>{L("התיקיות של KesherAI", "KesherAI's folders")}</h2>
              <ul className="health-folders">{r.kesher.map((f) => <li key={f.name} className="row small"><span className="grow" dir="ltr">{f.name}</span><span dir="ltr">{gb(f.bytes)} GB{f.partial ? "+" : ""}</span></li>)}</ul>
            </section>
          )}
          {faults.length > 0 && (
            <details className="card">
              <summary>{L(`תקלות אחרונות של KesherAI (${faults.length})`, `KesherAI's recent faults (${faults.length})`)}</summary>
              <ul className="health-folders">{faults.map((f, i) => <li key={i} className="small" dir="auto"><span className="muted">{new Date(f.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" })} · {f.where}</span><br />{f.message}</li>)}</ul>
              <button type="button" style={{ alignSelf: "start" }} onClick={() => setReporting(true)}>{L("📮 דווח למפתחים", "📮 Report to the developers")}</button>
              <p className="muted small">{L("בצ'אט שנכשל יש כפתור \"🔎 חקור\", והמודל יכול לבדוק את התקלות האלה בעצמו.", "A chat that failed has a \"🔎 Investigate\" button; the model can look into these faults itself.")}</p>
            </details>
          )}
          {r.startup.length > 0 && (
            <details className="card">
              <summary>{L(`${r.startup.length} תוכנות שעולות עם המחשב`, `${r.startup.length} programs start with the computer`)}</summary>
              <ul className="health-folders">{r.startup.map((n) => <li key={n} className="small" dir="auto">{n}</li>)}</ul>
              <p className="muted small">{L("לכבות: מנהל המשימות ← אפליקציות הפעלה.", "To turn off: Task Manager → Startup apps.")}</p>
            </details>
          )}
        </>
      )}
    </div>
  );
}
