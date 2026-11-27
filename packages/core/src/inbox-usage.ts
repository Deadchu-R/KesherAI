/**
 * Inbox usage meter (Roee, 2026-11-24): one compact line per provider at the top of the Task inbox, showing today's runs,
 * average duration and the remaining share against the provider's quota (OpenCode monthly %, OpenRouter daily count,
 * Antigravity per-model week %). Built from {@link UsageLog.totals} and {@link UsageLog.read}; no model needed for the
 * numbers, only the log's own counters.
 */
import type { UsageDay, UsageLog } from "./usage-log.js";

/** One provider's meter line for the inbox header. */
export interface ProviderMeter {
  /** The executor name as it appears in the log (e.g. "opencode", "ghostcli", "antigravity"). */
  executor: string;
  /** Runs that finished today. */
  runsToday: number;
  /** Average run length today, in minutes (0 when no runs). */
  avgMinutesToday: number;
  /** A short human label for the remaining share (e.g. "31% of the month", "44% week", "120/500 today"). */
  remainingLabel: string;
}

/** OpenCode Go: 100% of a calendar month is the quota unit we show. */
const OPENCODE_MONTHLY_QUOTA = 1;
/** Antigravity: weekly share per model, shown as %. */
const ANTI_WEEKLY_QUOTA = 100;
/** OpenRouter: daily request count cap (placeholder until the real cap is wired). */
const OPENROUTER_DAILY_CAP = 500;

/**
 * Builds the inbox meter lines from the usage log.
 *
 * @param log - The usage log to read.
 * @param now - The clock (default `Date.now`).
 * @returns One meter per executor that ran in the last 24 h, sorted by today's runs descending.
 */
export async function getInboxUsage(log: UsageLog, now: () => number = Date.now): Promise<ProviderMeter[]> {
  const t = now();
  const todayStr = new Date(t).toISOString().slice(0, 10);
   const dayMs = 24 * 60 * 60 * 1000;
   const sinceWeek = t - 7 * dayMs;

  const days = await log.totals(sinceWeek);
  const todayTotals = new Map<string, UsageDay>();
  const weekTotals = new Map<string, { runs: number; minutes: number }>();

  for (const d of days) {
    if (d.day === todayStr) todayTotals.set(d.executor, d);
    const w = weekTotals.get(d.executor) ?? { runs: 0, minutes: 0 };
    w.runs += d.runs;
    w.minutes += d.minutes;
    weekTotals.set(d.executor, w);
  }

  const meters: ProviderMeter[] = [];
  for (const [executor, td] of todayTotals) {
    const avg = td.runs > 0 ? Math.round(td.minutes / td.runs) : 0;
    meters.push({
      executor,
      runsToday: td.runs,
      avgMinutesToday: avg,
      remainingLabel: remainingFor(executor, td, weekTotals.get(executor)),
    });
  }
  return meters.sort((a, b) => b.runsToday - a.runsToday);
}

function remainingFor(
  executor: string,
  today: UsageDay,
  week: { runs: number; minutes: number } | undefined,
): string {
  const ex = executor.toLowerCase();
  if (ex.includes("opencode")) {
    // Monthly %: we only have daily data, so approximate with today's share of a 30-day month.
    const monthEstimate = today.runs * 30;
    const pct = Math.min(100, Math.round((monthEstimate / OPENCODE_MONTHLY_QUOTA) * 100));
    return `${pct}% of the month`;
  }
  if (ex.includes("antigravity") || ex.includes("claude")) {
    const pct = week ? Math.min(100, Math.round((week.runs / ANTI_WEEKLY_QUOTA) * 100)) : 0;
    return `${pct}% week`;
  }
  if (ex.includes("openrouter") || ex.includes("ghostcli")) {
    return `${today.requests}/${OPENROUTER_DAILY_CAP} today`;
  }
  // Fallback: just today's runs.
  return `${today.runs} today`;
}