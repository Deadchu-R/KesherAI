/**
 * What a computer says about itself when it is about to sleep or shut down, and how every screen turns that and
 * "is it answering" into one status (online, asleep, offline) and one short line. Pure functions, shared by the
 * server, the computers menu and the hub page, so they never disagree.
 */

/** What is running on a computer that goes away (counts only, never names). */
export interface AwayNote {
  /** Downloads running, queued or paused. */
  downloads?: number;
  /** Task-inbox tasks running. */
  tasks?: number;
  /** Self-work was running. */
  selfWork?: boolean;
  /** It is restarting to install this version (e.g. "0.6.498"), not going to sleep: back in a minute or two. */
  update?: string;
}

/** One computer's status in a list. */
export type ComputerState = "online" | "asleep" | "offline";

const MAX_COUNT = 9999;

/**
 * Reads an away note from untrusted input (a request body or a hub frame): known fields only, counts clamped.
 *
 * @param x - The input.
 * @returns A clean note (empty when nothing valid).
 */
export function cleanAwayNote(x: unknown): AwayNote {
  const n = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
  const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.min(MAX_COUNT, Math.floor(v)) : undefined);
  const downloads = count(n.downloads);
  const tasks = count(n.tasks);
  const update = typeof n.update === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(n.update) ? n.update : undefined;
  return { ...(downloads ? { downloads } : {}), ...(tasks ? { tasks } : {}), ...(n.selfWork === true ? { selfWork: true } : {}), ...(update ? { update } : {}) };
}

/**
 * The status of a computer: answering is online; not answering but it said it was going to sleep is asleep; the
 * rest is offline. An older computer never says it sleeps, so it simply shows as offline.
 *
 * @param c - Whether it answers now, and when it said it went to sleep (if it did).
 */
export function computerState(c: { online: boolean; asleepSince?: string }): ComputerState {
  return c.online ? "online" : c.asleepSince ? "asleep" : "offline";
}

/**
 * "2 min ago": how long ago, in Hebrew or English.
 *
 * @param iso - The time.
 * @param now - Now (ms).
 * @param he - Hebrew (true) or English.
 * @returns The phrase, or "" when the time is unknown.
 */
export function agoText(iso: string | undefined, now: number, he: boolean): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(at)) return "";
  const min = Math.max(0, Math.floor((now - at) / 60_000));
  if (min < 1) return he ? "הרגע" : "just now";
  if (min < 60) return he ? `לפני ${min} דק'` : `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return he ? `לפני ${h} שע'` : `${h} h ago`;
  const d = Math.floor(h / 24);
  return he ? `לפני ${d} ימים` : `${d} days ago`;
}

/**
 * The line for a computer that went to sleep: "PC went to sleep · 2 min ago · 3 downloads paused" (or "PC restarting
 * for update 0.6.N · …" when it went away to install an update).
 *
 * @param away - When it said so, and what was running.
 * @param now - Now (ms).
 * @param he - Hebrew (true) or English.
 */
export function awayText(away: { at?: string; note?: AwayNote }, now: number, he: boolean): string {
  const n = away.note ?? {};
  // Restarting for an update is not sleep: say so, with the version, so nobody waits for a wake-up.
  const first = n.update ? (he ? `המחשב מופעל מחדש לעדכון ${n.update}` : `PC restarting for update ${n.update}`) : he ? "המחשב נכנס לשינה" : "PC went to sleep";
  const parts = [first, agoText(away.at, now, he)];
  if (n.downloads) parts.push(he ? `${n.downloads} ${n.downloads === 1 ? "הורדה מושהית" : "הורדות מושהות"}` : `${n.downloads} download${n.downloads === 1 ? "" : "s"} paused`);
  if (n.tasks) parts.push(he ? `${n.tasks} ${n.tasks === 1 ? "משימה נעצרה" : "משימות נעצרו"}` : `${n.tasks} task${n.tasks === 1 ? "" : "s"} stopped`);
  if (n.selfWork) parts.push(he ? "עבודה עצמית נעצרה" : "self-work stopped");
  return parts.filter(Boolean).join(" · ");
}
