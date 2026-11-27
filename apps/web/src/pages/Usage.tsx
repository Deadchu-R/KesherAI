/**
 * Usage log page (Roee 24.11): reads GET /api/usage-log and shows what every executor and provider used per day.
 * Filters: level / executor / task. Highlights warnings and errors. Daily totals per executor and per provider,
 * with quota share when known. A small 7-day chart per provider. Suggestions view from POST /api/usage-log/savings.
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { getLocale, he$ } from "../i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

type UsageLevel = "info" | "warn" | "error";

interface UsageEntry {
  at: number;
  day: string;
  executor?: string;
  provider?: string;
  task?: string;
  level: UsageLevel;
  event: string;
  numbers?: Record<string, number>;
  why?: string;
}

interface SavingsSuggestion {
  id: string;
  title: string;
  detail?: string;
  saved?: number;
}

interface Totals {
  runs: number;
  finished: number;
  failed: number;
  minutes: number;
  requests: number;
  inputBytes: number;
  outputBytes: number;
  quotaLeft?: number;
}

/** Formats bytes to a short human string (KB/MB/GB). */
function fmtBytes(n: number): string {
  if (n <= 0) return "0";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Formats minutes to a short human string. */
function fmtMin(n: number): string {
  if (n <= 0) return "0m";
  if (n < 60) return `${Math.round(n)}m`;
  return `${Math.floor(n / 60)}h ${Math.round(n % 60)}m`;
}

/** Aggregates entries into daily totals per key (executor or provider). */
function aggregate(entries: UsageEntry[], keyFn: (e: UsageEntry) => string | undefined): Map<string, Map<string, Totals>> {
  const out = new Map<string, Map<string, Totals>>();
  for (const e of entries) {
    const k = keyFn(e);
    if (!k || e.event !== "run-end") continue;
    let dm = out.get(e.day);
    if (!dm) { dm = new Map(); out.set(e.day, dm); }
    const prev = dm.get(k) ?? { runs: 0, finished: 0, failed: 0, minutes: 0, requests: 0, inputBytes: 0, outputBytes: 0 };
    const nums = e.numbers ?? {};
    prev.runs += 1;
    if (nums.failed) prev.failed += 1; else prev.finished += 1;
    prev.minutes += nums.minutes ?? 0;
    prev.requests += nums.requests ?? 0;
    prev.inputBytes += nums.inputBytes ?? 0;
    prev.outputBytes += nums.outputBytes ?? 0;
    if (nums.agQuota !== undefined) prev.quotaLeft = nums.agQuota;
    if (nums.opencodeMonthlyPct !== undefined) prev.quotaLeft = nums.opencodeMonthlyPct;
    dm.set(k, prev);
  }
  return out;
}

/** Builds a 7-day sparkline SVG for one key's runs. */
function Sparkline({ days, values }: { days: string[]; values: number[] }) {
  const max = Math.max(...values, 1);
  const w = 120, h = 32;
  const pts = values.map((v, i) => `${(i / Math.max(values.length - 1, 1)) * w},${h - (v / max) * h}`).join(" ");
  return (
    <svg width={w} height={h} className="sparkline" aria-label={L("תרשים 7 ימים", "7-day chart")}>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" />
      <title>{days.map((d, i) => `${d}: ${values[i]}`).join("\n")}</title>
    </svg>
  );
}

/** The usage log page: filters, entries table, daily totals, suggestions. */
export function UsagePage() {
  const [entries, setEntries] = useState<UsageEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [level, setLevel] = useState<UsageLevel | "">("");
  const [executor, setExecutor] = useState("");
  const [task, setTask] = useState("");
  const [tab, setTab] = useState<"log" | "totals" | "suggestions">("log");
  const [suggestions, setSuggestions] = useState<SavingsSuggestion[]>([]);
  const [sugLoading, setSugLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const q = new URLSearchParams();
    if (level) q.set("level", level);
    if (executor) q.set("executor", executor);
    if (task) q.set("task", task);
    q.set("limit", "500");
    api<UsageEntry[]>(`/api/usage-log?${q}`)
      .then((r) => { if (!cancelled) setEntries(Array.isArray(r) ? r : []); })
      .catch(() => { if (!cancelled) setEntries([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [level, executor, task]);

  const loadSuggestions = () => {
    if (suggestions.length > 0) return;
    setSugLoading(true);
    api<{ suggestions: SavingsSuggestion[] }>("/api/usage-log/savings", { method: "POST" })
      .then((r) => setSuggestions(r?.suggestions ?? []))
      .catch(() => setSuggestions([]))
      .finally(() => setSugLoading(false));
  };

  useEffect(() => { if (tab === "suggestions") loadSuggestions(); }, [tab]);

  const execTotals = useMemo(() => aggregate(entries, (e) => e.executor), [entries]);
  const provTotals = useMemo(() => aggregate(entries, (e) => e.provider), [entries]);

  const last7 = useMemo(() => {
    const days = [...new Set(entries.map((e) => e.day))].sort().slice(-7);
    return days;
  }, [entries]);

  const providers = useMemo(() => [...new Set(entries.map((e) => e.provider).filter(Boolean))] as string[], [entries]);

  return (
    <div className="page narrow">
      <h1>{L("יומן שימוש", "Usage log")}</h1>
      <p className="muted">{L("מה כל מבצע וספק השתמשו, לפי יום", "What every executor and provider used, per day")}</p>

      <div className="filters row">
        <label>
          {L("רמה", "Level")}
          <select value={level} onChange={(e) => setLevel(e.target.value as UsageLevel | "")}>
            <option value="">{L("הכל", "All")}</option>
            <option value="info">Info</option>
            <option value="warn">Warn</option>
            <option value="error">Error</option>
          </select>
        </label>
        <label>
          {L("מבצע", "Executor")}
          <input value={executor} onChange={(e) => setExecutor(e.target.value)} placeholder={L("לדוגמה ghostcli", "e.g. ghostcli")} />
        </label>
        <label>
          {L("משימה", "Task")}
          <input value={task} onChange={(e) => setTask(e.target.value)} placeholder={L("מזהה משימה", "task id")} />
        </label>
      </div>

      <nav className="tabs">
        <button className={tab === "log" ? "active" : ""} onClick={() => setTab("log")}>{L("לוג", "Log")}</button>
        <button className={tab === "totals" ? "active" : ""} onClick={() => setTab("totals")}>{L("סיכומים", "Totals")}</button>
        <button className={tab === "suggestions" ? "active" : ""} onClick={() => setTab("suggestions")}>{L("הצעות", "Suggestions")}</button>
      </nav>

      {tab === "log" && (
        <section className="card">
          {loading && <p className="muted">{L("טוען…", "Loading…")}</p>}
          {!loading && entries.length === 0 && <p className="muted">{L("אין רשומות", "No entries")}</p>}
          <ul className="usage-list">
            {entries.map((e, i) => (
              <li key={i} className={`usage-entry level-${e.level}`}>
                <span className="time">{new Date(e.at).toLocaleTimeString()}</span>
                <span className="day">{e.day}</span>
                <span className="executor">{e.executor ?? "-"}</span>
                <span className="provider">{e.provider ?? "-"}</span>
                <span className="event">{e.event}</span>
                {e.why && <span className="why">{e.why}</span>}
                {e.numbers && (
                  <span className="nums muted small">
                    {Object.entries(e.numbers).map(([k, v]) => `${k}:${typeof v === "number" && k.includes("Bytes") ? fmtBytes(v) : v}`).join(" · ")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {tab === "totals" && (
        <section className="card">
          <h2>{L("סיכום יומי לפי מבצע", "Daily totals by executor")}</h2>
          {[...execTotals.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([day, m]) => (
            <div key={day}>
              <h3 className="small">{day}</h3>
              <table className="compact">
                <thead><tr><th>{L("מבצע", "Executor")}</th><th>{L("ריצות", "Runs")}</th><th>{L("הושלמו", "Finished")}</th><th>{L("נכשלו", "Failed")}</th><th>{L("זמן", "Time")}</th><th>{L("בקשות", "Requests")}</th><th>{L("קלט", "Input")}</th><th>{L("פלט", "Output")}</th></tr></thead>
                <tbody>
                  {[...m.entries()].sort((a, b) => b[1].runs - a[1].runs).map(([k, t]) => (
                    <tr key={k}>
                      <td>{k}</td>
                      <td>{t.runs}</td>
                      <td>{t.finished}</td>
                      <td>{t.failed}</td>
                      <td>{fmtMin(t.minutes)}</td>
                      <td>{t.requests}</td>
                      <td>{fmtBytes(t.inputBytes)}</td>
                      <td>{fmtBytes(t.outputBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          <h2>{L("סיכום יומי לפי ספק", "Daily totals by provider")}</h2>
          {[...provTotals.entries()].sort((a, b) => b[0].localeCompare(a[0])).map(([day, m]) => (
            <div key={day}>
              <h3 className="small">{day}</h3>
              <table className="compact">
                <thead><tr><th>{L("ספק", "Provider")}</th><th>{L("ריצות", "Runs")}</th><th>{L("הושלמו", "Finished")}</th><th>{L("נכשלו", "Failed")}</th><th>{L("זמן", "Time")}</th><th>{L("בקשות", "Requests")}</th><th>{L("קלט", "Input")}</th><th>{L("פלט", "Output")}</th><th>{L("יתרה", "Quota left")}</th></tr></thead>
                <tbody>
                  {[...m.entries()].sort((a, b) => b[1].runs - a[1].runs).map(([k, t]) => (
                    <tr key={k}>
                      <td>{k}</td>
                      <td>{t.runs}</td>
                      <td>{t.finished}</td>
                      <td>{t.failed}</td>
                      <td>{fmtMin(t.minutes)}</td>
                      <td>{t.requests}</td>
                      <td>{fmtBytes(t.inputBytes)}</td>
                      <td>{fmtBytes(t.outputBytes)}</td>
                      <td>{t.quotaLeft !== undefined ? `${Math.round(t.quotaLeft)}%` : "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          <h2>{L("תרשים 7 ימים לספק", "7-day chart per provider")}</h2>
          {providers.map((p) => {
            const vals = last7.map((d) => provTotals.get(d)?.get(p)?.runs ?? 0);
            return (
              <div key={p} className="row" style={{ gap: "0.5rem", alignItems: "center", marginBottom: "0.5rem" }}>
                <span style={{ minWidth: "8rem" }}>{p}</span>
                <Sparkline days={last7} values={vals} />
                <span className="muted small">{vals.reduce((a, b) => a + b, 0)} {L("ריצות", "runs")}</span>
              </div>
            );
          })}
          {providers.length === 0 && <p className="muted">{L("אין נתונים לתרשים", "No data for chart")}</p>}
        </section>
      )}

      {tab === "suggestions" && (
        <section className="card">
          {sugLoading && <p className="muted">{L("טוען הצעות…", "Loading suggestions…")}</p>}
          {!sugLoading && suggestions.length === 0 && <p className="muted">{L("אין הצעות כרגע", "No suggestions right now")}</p>}
          <ul className="suggestions">
            {suggestions.map((s) => (
              <li key={s.id}>
                <strong>{s.title}</strong>
                {s.detail && <p className="muted small">{s.detail}</p>}
                {s.saved !== undefined && <span className="badge">{L("חיסכון", "Saved")}: {fmtBytes(s.saved)}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}