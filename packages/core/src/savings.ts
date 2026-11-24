/**
 * The savings finder (Roee, 2026-11-24): a pass over the usage log that looks for ways to reach the same result with
 * less quota. Code-based detectors write `suggestion` entries with the evidence and an estimated saving; a small model
 * may then word each in one plain sentence. Suggestions are only shown (usage log page, daily digest), never applied.
 *
 * Detectors:
 * - free first: a kind of task (executor family and size) that succeeded on free or local models while paid runs of the
 *   same kind burned more requests;
 * - the same failure again and again for one task (retries that always fail the same way);
 * - the reviewer rejected a run after many requests (a smaller task or a better spec saves them);
 * - heavy steps repeated (the same big input sent again and again within runs).
 */
import { median, type UsageEntry } from "./usage-log.js";

/** A suggestion before it gets a time. */
export type Saving = Omit<UsageEntry, "at">;

/** Failures of one task with the same reason that make a retry loop. */
const SAME_FAILURE = 3;
/** Heavy steps flagged this many times in the window are a pattern. */
const HEAVY_REPEATS = 3;

const sentence = (s: string): string => s.replace(/\s+/g, " ").trim();

/**
 * Runs the detectors over log entries (any order).
 *
 * @param entries - The entries of the window (a day or a week).
 * @returns Suggestions, each with `numbers.saved` (the estimated requests saved over the window) and the evidence in `why`.
 */
export function findSavings(entries: readonly UsageEntry[]): Saving[] {
  const out: Saving[] = [];
  const ends = entries.filter((e) => e.event === "run-end" && e.numbers?.requests !== undefined);

  // Free first: per size, paid runs vs free/local runs that both ended well.
  for (const size of [...new Set(ends.map((e) => e.size).filter((s): s is string => !!s))]) {
    const ok = ends.filter((e) => e.size === size && e.numbers?.ok === 1);
    const free = ok.filter((e) => e.numbers?.paid === 0);
    const paid = ok.filter((e) => e.numbers?.paid === 1);
    if (free.length >= 2 && paid.length >= 2) {
      const f = median(free.map((e) => e.numbers!.requests!));
      const p = median(paid.map((e) => e.numbers!.requests!));
      if (p > f) out.push({ level: "suggestion", executor: paid[0]!.executor, size, event: "saving", numbers: { saved: Math.round((p - f) * paid.length), free: free.length, paid: paid.length }, why: sentence(`Size ${size} tasks ended well on free or local models (${free.length} runs, about ${f} requests); ${paid.length} paid runs used about ${p}. Route this kind to a free model first.`) });
    }
  }

  // The same failure again and again for one task.
  const failed = new Map<string, UsageEntry[]>();
  for (const e of ends.filter((x) => x.numbers?.ok === 0 && x.task && x.why)) {
    const key = `${e.task}|${e.why!.slice(0, 60)}`;
    failed.set(key, [...(failed.get(key) ?? []), e]);
  }
  for (const runs of failed.values()) {
    if (runs.length >= SAME_FAILURE) out.push({ level: "suggestion", executor: runs[0]!.executor, task: runs[0]!.task!, event: "saving", numbers: { saved: runs.slice(1).reduce((n, r) => n + (r.numbers?.requests ?? 0), 0), attempts: runs.length }, why: sentence(`${runs.length} attempts failed the same way ("${runs[0]!.why!.slice(0, 80)}"). Stop retrying until the cause is fixed.`) });
  }

  // Rejected by the reviewer after many requests.
  for (const r of entries.filter((e) => e.event === "review" && e.why?.startsWith("reject"))) {
    const end = ends.find((e) => e.task === r.task && e.at <= r.at + 60_000 && e.at >= r.at - 60_000);
    const used = end?.numbers?.requests ?? 0;
    if (end && used >= 40) out.push({ level: "suggestion", executor: r.executor, ...(r.task ? { task: r.task } : {}), event: "saving", numbers: { saved: Math.round(used / 2) }, why: sentence(`The reviewer rejected a run after ${used} requests. A smaller task or a clearer spec would save most of them.`) });
  }

  // Heavy steps again and again.
  const heavy = entries.filter((e) => e.event === "anomaly" && e.why?.startsWith("Heavy step"));
  if (heavy.length >= HEAVY_REPEATS) out.push({ level: "suggestion", executor: heavy[0]!.executor, event: "saving", numbers: { saved: heavy.length }, why: sentence(`${heavy.length} requests sent very large input (a whole file or log). Read only the part that is needed, or send a summary.`) });
  return out;
}
