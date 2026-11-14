import { useEffect, useState } from "react";
import { api } from "../api";
import { getLocale } from "../i18n";
import { toast } from "../library";
import { RichText } from "../RichText";
import { ReportDialog } from "../ReportDialog";

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
  const [faults, setFaults] = useState<Array<{ at: string; kind: string; where: string; message: string }>>([]);
  const load = (fresh = false) => {
    setBusy(true);
    void api<{ reading: Reading; items: Item[] }>(`/api/pc-health?lang=${getLocale()}${fresh ? "&fresh=1" : ""}`)
      .then(setData, (e: Error) => toast(e.message))
      .finally(() => setBusy(false));
    void api<typeof faults>("/api/faults").then(setFaults, () => undefined);
  };
  useEffect(() => {
    load();
  }, []);
  const ask = () => {
    setThinking(true);
    void api<{ text: string }>("/api/pc-health/advice", { method: "POST", body: { lang: getLocale() } })
      .then((r) => setAdvice(r.text), (e: Error) => toast(e.message))
      .finally(() => setThinking(false));
  };
  const r = data?.reading;
  return (
    <div className="page health-page">
      {reporting && <ReportDialog onClose={() => setReporting(false)} />}
      <div className="row">
        <h1 className="grow">{L("בריאות המחשב", "PC Health")}</h1>
        <button type="button" disabled={busy} onClick={() => load(true)}>{busy ? L("בודק…", "Checking…") : L("בדוק שוב", "Check again")}</button>
      </div>
      <p className="muted">{L("מה חסר למחשב ומה לעשות. KesherAI רק קורא כאן ולא מוחק שום דבר: כל תיקון הוא צעד שאתם עושים.", "What the computer is short of and what to do. KesherAI only reads here and deletes nothing: every fix is a step you take.")}</p>
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
