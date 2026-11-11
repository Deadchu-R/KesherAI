/**
 * Calibrating a model to this computer (t22; design: docs/RESEARCH_LOG.md, 2026-11-11). llama-bench measures
 * reading and writing speed with the context memory at 16 bits and at 8 bits, at the start of a chat and deep
 * into one (16K and 48K tokens already in the context), and KesherAI recommends one, so the engine starts with
 * what is measured on this card rather than a guess. LM Studio and Ollama have nothing like it (they only show
 * the live speed); outside tools measure but do not choose.
 */

/** One measured setup. */
export interface CalRow {
  /** Context memory type: 16 bits ("f16") or 8 bits ("q8_0"). */
  kv: "f16" | "q8_0";
  /** Tokens already in the context when measured. */
  depth: number;
  /** Reading the prompt, tokens per second. */
  read?: number;
  /** Writing the answer, tokens per second. */
  write?: number;
}

/** What KesherAI recommends from the rows. */
export interface CalAdvice {
  /** The setup to use. */
  kv: "f16" | "q8_0";
  /** Writing speed gained by 16 bits at the deepest depth both reached (percent; negative = slower). */
  f16Gain?: number;
  /** One sentence for the screen. */
  why: string;
  whyHe: string;
}

/**
 * Reads llama-bench's `-o json` rows (one for reading, one for writing, per setup and depth).
 *
 * @param json - Its output.
 * @returns The rows, merged per context type and depth.
 */
export function parseBench(json: string): CalRow[] {
  const start = json.indexOf("[");
  if (start < 0) return [];
  let list: Array<{ type_k?: string; n_depth?: number; n_prompt?: number; n_gen?: number; avg_ts?: number }>;
  try {
    list = JSON.parse(json.slice(start, json.lastIndexOf("]") + 1)) as typeof list;
  } catch {
    return [];
  }
  const rows = new Map<string, CalRow>();
  for (const r of list) {
    const kv = r.type_k === "f16" ? "f16" : r.type_k === "q8_0" ? "q8_0" : undefined;
    if (!kv || typeof r.avg_ts !== "number") continue;
    const depth = Number(r.n_depth ?? 0);
    const key = `${kv}@${depth}`;
    const row = rows.get(key) ?? { kv, depth };
    if ((r.n_gen ?? 0) > 0) row.write = Math.round(r.avg_ts * 10) / 10;
    else if ((r.n_prompt ?? 0) > 0) row.read = Math.round(r.avg_ts);
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => a.depth - b.depth || a.kv.localeCompare(b.kv));
}

/**
 * Chooses the context memory type. 8 bits holds twice the context in the same memory, so 16 bits is chosen only
 * when it writes clearly faster (10% or more) deep into a chat, where long coding chats spend their time.
 *
 * @param rows - The measurements.
 * @returns The advice.
 */
export function advise(rows: CalRow[]): CalAdvice {
  const depths = [...new Set(rows.map((r) => r.depth))].sort((a, b) => b - a);
  for (const d of depths) {
    const f = rows.find((r) => r.kv === "f16" && r.depth === d && r.write);
    const q = rows.find((r) => r.kv === "q8_0" && r.depth === d && r.write);
    if (!f || !q) continue;
    const gain = Math.round(((f.write! - q.write!) / q.write!) * 100);
    const k = Math.round(d / 1000);
    if (gain >= 10)
      return { kv: "f16", f16Gain: gain, why: `16-bit context writes ${gain}% faster at ${k}K tokens here; the context gets half as long.`, whyHe: `הקשר ב-16 ביט כותב מהר ב-${gain}% ב-${k}K טוקנים במחשב הזה; ההקשר נהיה קצר בחצי.` };
    return { kv: "q8_0", f16Gain: gain, why: `8-bit context: ${gain > 0 ? `only ${gain}% slower` : "as fast"} at ${k}K tokens, with twice the context in the same memory.`, whyHe: `הקשר ב-8 ביט: ${gain > 0 ? `איטי רק ב-${gain}%` : "מהיר באותה מידה"} ב-${k}K טוקנים, עם פי שניים הקשר באותו זיכרון.` };
  }
  return { kv: "q8_0", why: "Not enough measured to compare; keeping 8-bit context (twice the context in the same memory).", whyHe: "לא נמדד מספיק להשוואה; נשאר הקשר ב-8 ביט (פי שניים הקשר באותו זיכרון)." };
}
