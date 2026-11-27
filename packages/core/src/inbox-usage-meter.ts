import type { UsageDay } from "./usage-log.js";

/**
 * A single provider's meter reading for display in the Task Inbox header.
 */
export interface ProviderMeter {
  executor: string;
  runs: number;
  requests: number;
  tokens: number;
  minutes: number;
  errors: number;
  warnings: number;
  /** Human-readable one-line status, e.g. "12 runs · 4.2k tokens". */
  line: string;
}

const fmtK = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/**
 * Summarises today's usage per executor into compact meter lines.
 *
 * @param days - Today's `UsageDay` entries (already filtered to the current day).
 * @returns One meter per executor that had activity, sorted by runs descending.
 */
export function buildProviderMeters(days: UsageDay[]): ProviderMeter[] {
  const out: ProviderMeter[] = [];
  for (const d of days) {
    if (d.runs === 0 && d.requests === 0) continue;
    const parts: string[] = [];
    if (d.runs > 0) parts.push(`${d.runs} run${d.runs === 1 ? "" : "s"}`);
    if (d.tokens > 0) parts.push(`${fmtK(d.tokens)} tokens`);
    if (d.minutes > 0) parts.push(`${d.minutes} min`);
    if (d.errors > 0) parts.push(`${d.errors} err`);
    else if (d.warnings > 0) parts.push(`${d.warnings} warn`);
    out.push({
      executor: d.executor,
      runs: d.runs,
      requests: d.requests,
      tokens: d.tokens,
      minutes: d.minutes,
      errors: d.errors,
      warnings: d.warnings,
      line: parts.join(" · ") || "idle",
    });
  }
  out.sort((a, b) => b.runs - a.runs || b.tokens - a.tokens);
  return out;
}