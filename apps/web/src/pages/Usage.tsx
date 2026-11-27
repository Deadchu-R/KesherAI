import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { getLocale, he$, t } from "../i18n";

const L = (he: string, en: string) => (getLocale() === "he" ? he$(he) : en);

/** One entry from GET /api/usage-log (packages/core/src/usage-log.ts). */
interface UsageEntry {
  at: number;
  level: "info" | "warn" | "error";
  executor?: string;
  provider?: string;
  task?: string;
  run?: string;
  why?: string;
  requests?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  finished?: boolean;
  failed?: boolean;
  agQuota?: number;
  opencodeMonthlyPct?: number;
}

interface UsageQuery {
  level?: string;
  executor?: string;
  task?: string;
  limit?: number;
  since?: number;
}

interface DailyTotals {
  runs: number;
  finished: number;
  failed: number;
  minutes: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  quotaLeft?: string;
}

const PROVIDERS = [
  "ghostcli",
  "opencode-go",
  "opencode-free",
  "antigravity",
  "gemini",
  "free-cloud",
  "local",
] as const;

const EXECUTORS = ["claude", "opencode", "ghostcli", "codex", "helper"] as const;

/** Formats a token count as K/M when large, keeps small numbers intact. */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/** Builds a 7-day ASCII bar chart for a provider's daily request counts. */
function sevenDayChart(days: Array<{ day: string; requests: number }>): string {
  const max = Math.max(1, ...days.map((d) => d.requests));
  return days
    .map((d) => {
      const len = Math.round((d.requests / max) * 20);
      const bar = "█".repeat(len) + "░".repeat(20 - len);
      return `${d.day.slice(5)} ${bar} ${d.requests}`;
    })
    .join("\n");
}

/** Aggregates entries into daily totals per executor or provider. */
function aggregate(entries: UsageEntry[], key: "executor" | "provider"): Map<string, DailyTotals> {
  const map = new Map<string, DailyTotals>();
  for (const e of entries) {
    const k = (key === "executor" ? e.executor : e.provider) ?? "unknown";
    let t = map.get(k);
    if (!t) {
      t = { runs: 0, finished: 0, failed: 0, minutes: 0, requests: 0, inputTokens: 0, outputTokens: 0 };
      map.set(k, t);
    }
    t.runs += 1;
    if (e.finished) t.finished += 1;
    if (e.failed) t.failed += 1;
    t.minutes += (e.durationMs ?? 0) / 60_000;
    t.requests += e.requests ?? 0;
    t.inputTokens += e.inputTokens ?? 0;
    t.outputTokens += e.outputTokens ?? 0;
    if (k === "antigravity" && e.agQuota !== undefined) t.quotaLeft = `${Math.round(e.agQuota * 100)}%`;
    if (k === "opencode-go" && e.opencodeMonthlyPct !== undefined) t.quotaLeft = `${Math.round(e.opencodeMonthlyPct)}%`;
  }
  return map;
}

/** Suggests actions based on usage patterns (warnings, high failure rate, quota pressure). */
function buildSuggestions(entries: UsageEntry[]): string[] {
  const out: string[] = [];
  const fails = entries.filter((e) => e.failed).length;
  const total = entries.length || 1;
  if (fails / total > 0.2) out.push(L("שיעור כשלונות גבוה (>20%): בדוק לוגים של executor שנכשל.", "High failure rate (>20%): check failing executor logs."));
  const warns = entries.filter((e) => e.level === "warn").length;
  if (warns > 5) out.push(L("הרבה אזהרות בלוג: ייתכן ש-quota מתקרב או שיש בעיית רשת.", "Many warnings in log: quota may be near or network issue."));
  for (const e of entries) {
    if (e.agQuota !== undefined && e.agQuota < 0.1) {
      out.push(L("Antigravity quota נמוך מאוד (<10%). שקול מעבר ל-provider אחר.", "Antigravity quota very low (<10%). Consider switching provider."));
      break;
    }
  }
  if (out.length === 0) out.push(L("אין הצעות כרגע. הכל תקין.", "No suggestions right now. All looks good."));
  return out;
}

export function UsagePage() {
  const [entries, setEntries] = useState<UsageEntry[]>([]);
  const [query, setQuery] = useState<UsageQuery>({ limit: 500 });
  const [view, setView] = useState<"log" | "suggestions">("log");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams();
    if (query.level) params.set("level", query.level);
    if (query.executor) params.set("executor", query.executor);
    if (query.task) params.set("task", query.task);
    if (query.limit) params.set("limit", String(query.limit));
    if (query.since) params.set("since", String(query.since));
    api<UsageEntry[]>(`/api/usage-log?${params}`)
            .then((data) => {
              if (!cancelled) setEntries(Array.isArray(data) ? data : []);
            })
      .catch(() => {
        if (!cancelled) setEntries([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  const executorTotals = useMemo(() => aggregate(entries, "executor"), [entries]);
  const providerTotals = useMemo(() => aggregate(entries, "provider"), [entries]);
  const suggestions = useMemo(() => buildSuggestions(entries), [entries]);

  const sevenDayProvider = useMemo(() => {
    const days = new Map<string, number>();
    for (const e of entries) {
      if (!e.provider) continue;
      const day = new Date(e.at).toISOString().slice(0, 10);
      days.set(day, (days.get(day) ?? 0) + (e.requests ?? 0));
    }
    const arr = Array.from(days.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-7)
      .map(([day, requests]) => ({ day, requests }));
    return arr.length ? sevenDayChart(arr) : L("אין נתונים ל-7 ימים אחרונים.", "No data for last 7 days.");
  }, [entries]);

  return (
    <section className="page usage-page">
      <h1>{L("יומן שימוש", "Usage log")}</h1>
      <nav className="tabs">
        <button className={view === "log" ? "active" : ""} onClick={() => setView("log")}>
          {L("לוג", "Log")}
        </button>
        <button className={view === "suggestions" ? "active" : ""} onClick={() => setView("suggestions")}>
          {L("הצעות", "Suggestions")}
        </button>
      </nav>

      {view === "log" && (
        <>
          <div className="filters">
            <label>
              {L("רמה", "Level")}
              <select value={query.level ?? ""} onChange={(e) => setQuery({ ...query, level: e.target.value || undefined })}>
                <option value="">{L("הכל", "All")}</option>
                <option value="info">info</option>
                <option value="warn">warn</option>
                <option value="error">error</option>
              </select>
            </label>
            <label>
              {L("Executor", "Executor")}
              <select value={query.executor ?? ""} onChange={(e) => setQuery({ ...query, executor: e.target.value || undefined })}>
                <option value="">{L("הכל", "All")}</option>
                {EXECUTORS.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {L("משימה", "Task")}
              <input
                type="text"
                placeholder="c-20261127-…"
                value={query.task ?? ""}
                onChange={(e) => setQuery({ ...query, task: e.target.value.trim() || undefined })}
              />
            </label>
          </div>

          {loading && <p className="muted">{L("טוען…", "Loading…")}</p>}

          <h3 className="small">{L("סיכום יומי לפי executor", "Daily totals by executor")}</h3>
          <table className="compact">
            <thead>
              <tr>
                <th>{L("Executor", "Executor")}</th>
                <th>{L("ריצות", "Runs")}</th>
                <th>{L("הושלמו", "Finished")}</th>
                <th>{L("נכשלו", "Failed")}</th>
                <th>{L("דקות", "Min")}</th>
                <th>{L("בקשות", "Reqs")}</th>
                <th>{L("Input", "Input")}</th>
                <th>{L("Output", "Output")}</th>
              </tr>
            </thead>
            <tbody>
              {Array.from(executorTotals.entries()).map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{v.runs}</td>
                  <td>{v.finished}</td>
                  <td>{v.failed}</td>
                  <td>{v.minutes.toFixed(1)}</td>
                  <td>{v.requests}</td>
                  <td>{fmtTokens(v.inputTokens)}</td>
                  <td>{fmtTokens(v.outputTokens)}</td>
                </tr>
              ))}
              {executorTotals.size === 0 && !loading && (
                <tr>
                  <td colSpan={8} className="muted">
                    {L("אין נתונים", "No data")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <h3 className="small">{L("סיכום יומי לפי provider", "Daily totals by provider")}</h3>
          <table className="compact">
            <thead>
              <tr>
                <th>{L("Provider", "Provider")}</th>
                <th>{L("ריצות", "Runs")}</th>
                <th>{L("הושלמו", "Finished")}</th>
                <th>{L("נכשלו", "Failed")}</th>
                <th>{L("דקות", "Min")}</th>
                <th>{L("בקשות", "Reqs")}</th>
                <th>{L("Input", "Input")}</th>
                <th>{L("Output", "Output")}</th>
                <th>{L("Quota נותר", "Quota left")}</th>
              </tr>
            </thead>
            <tbody>
              {PROVIDERS.map((p) => {
                const v = providerTotals.get(p);
                if (!v) return null;
                return (
                  <tr key={p}>
                    <td>{p}</td>
                    <td>{v.runs}</td>
                    <td>{v.finished}</td>
                    <td>{v.failed}</td>
                    <td>{v.minutes.toFixed(1)}</td>
                    <td>{v.requests}</td>
                    <td>{fmtTokens(v.inputTokens)}</td>
                    <td>{fmtTokens(v.outputTokens)}</td>
                    <td>{v.quotaLeft ?? "—"}</td>
                  </tr>
                );
              })}
              {PROVIDERS.every((p) => !providerTotals.has(p)) && !loading && (
                <tr>
                  <td colSpan={9} className="muted">
                    {L("אין נתונים", "No data")}
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <h3 className="small">{L("תרשים 7 ימים (בקשות)", "7-day chart (requests)")}</h3>
          <pre className="chart">{sevenDayProvider}</pre>

          <h3 className="small">{L("רשומות אחרונות", "Recent entries")}</h3>
          <ul className="usage-list">
            {entries.map((e, i) => (
              <li key={i} className={`level-${e.level}`}>
                <span className="time">{new Date(e.at).toLocaleTimeString()}</span>
                <span className="lvl">{e.level}</span>
                {e.executor && <span className="tag exec">{e.executor}</span>}
                {e.provider && <span className="tag prov">{e.provider}</span>}
                {e.task && <span className="tag task">{e.task}</span>}
                {e.why && <span className="why">{e.why}</span>}
                {e.requests !== undefined && <span className="num">{e.requests} req</span>}
              </li>
            ))}
            {entries.length === 0 && !loading && <li className="muted">{L("אין רשומות", "No entries")}</li>}
          </ul>
        </>
      )}

      {view === "suggestions" && (
        <ul className="suggestions">
          {suggestions.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      )}
    </section>
  );
}