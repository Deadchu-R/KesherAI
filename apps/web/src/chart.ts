/**
 * Charts inside an answer (audit F18): a model writes a fenced ```chart block
 * with JSON, and the chat draws it as SVG. No library: bar, line and pie.
 *
 * ```chart
 * {"type": "bar", "title": "Sales", "labels": ["Jan", "Feb"], "series": [{"name": "2026", "values": [3, 5]}]}
 * ```
 */

/** A chart the chat can draw. */
export interface ChartSpec {
  type: "bar" | "line" | "pie";
  title?: string;
  labels: string[];
  series: Array<{ name: string; values: number[] }>;
  /** The unit shown on the values, e.g. "%" or "₪". */
  unit?: string;
}

/**
 * Reads a chart block. Anything that is not a complete, sensible chart gives undefined (the block is shown as code).
 * At most 8 series and 60 labels; values that are not numbers count as 0.
 *
 * @param text - The block's text.
 */
export function parseChart(text: string): ChartSpec | undefined {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!j || typeof j !== "object") return undefined;
  const o = j as Record<string, unknown>;
  const type = o.type === "line" || o.type === "pie" ? o.type : o.type === "bar" || o.type === undefined ? "bar" : undefined;
  if (!type || !Array.isArray(o.labels) || !o.labels.length) return undefined;
  const labels = o.labels.slice(0, 60).map((l) => String(l).slice(0, 40));
  // One series may come as plain "values".
  const raw = Array.isArray(o.series) ? o.series : Array.isArray(o.values) ? [{ name: "", values: o.values }] : [];
  const series = raw
    .slice(0, 8)
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object" && Array.isArray((s as Record<string, unknown>).values))
    .map((s) => ({
      name: String(s.name ?? "").slice(0, 40),
      values: labels.map((_, i) => {
        const v = Number((s.values as unknown[])[i]);
        return Number.isFinite(v) ? v : 0;
      }),
    }));
  if (!series.length) return undefined;
  return {
    type,
    labels,
    series: type === "pie" ? series.slice(0, 1) : series,
    ...(typeof o.title === "string" && o.title.trim() ? { title: o.title.trim().slice(0, 80) } : {}),
    ...(typeof o.unit === "string" && o.unit.trim() ? { unit: o.unit.trim().slice(0, 8) } : {}),
  };
}

/**
 * Round steps for an axis from 0 (or the lowest negative value) to the highest value.
 *
 * @param min - The lowest value.
 * @param max - The highest value.
 * @returns About five tick values, including the ends.
 */
export function ticks(min: number, max: number): number[] {
  const lo = Math.min(0, min);
  const hi = max > lo ? max : lo + 1;
  const raw = (hi - lo) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.floor(lo / step) * step; v < hi + step * 0.999; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

/**
 * A number short enough for an axis: 1200 → "1.2K".
 *
 * @param n - The number.
 */
export function shortNumber(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${+(n / 1e3).toFixed(1)}K`;
  return `${+n.toFixed(2)}`;
}
