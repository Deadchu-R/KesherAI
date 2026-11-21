/**
 * Archive instead of delete, and day separators in long chats (docs/FEATURE_REVIEW.md, 2026-11-21; as LM Studio's
 * agent app): an archived chat leaves the sidebar's lists and the palette's chats but keeps everything; the Archived
 * page (#/archived) restores it or deletes it for good.
 */

/** What this needs of a chat summary. */
type Chat = { id: string; updatedAt: string; archived?: boolean };

/**
 * Splits chats into the ones in the lists and the archived ones.
 *
 * @param chats - Every chat summary.
 * @returns `active` in the given order; `archived` newest first.
 */
export function splitArchived<T extends Chat>(chats: readonly T[]): { active: T[]; archived: T[] } {
  const active: T[] = [];
  const archived: T[] = [];
  for (const c of chats) (c.archived ? archived : active).push(c);
  archived.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return { active, archived };
}

/**
 * A time's local calendar day.
 *
 * @param iso - An ISO time.
 * @returns "YYYY-MM-DD", or `undefined` for a bad time.
 */
export function dayOf(iso: string): string | undefined {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Where a long chat crosses into a new day: the first message (the user's or an answer) of each day after the first
 * day gets a separator above it. A chat that stays within one day gets none.
 *
 * @param events - The events on screen, in order.
 * @returns The seq of each message that starts a new day, with that day ("YYYY-MM-DD", local time).
 */
export function dayBreaks(events: ReadonlyArray<{ type: string; seq: number; at?: string }>): Map<number, string> {
  const out = new Map<number, string>();
  let last: string | undefined;
  for (const e of events) {
    if ((e.type !== "user" && e.type !== "assistant") || !e.at) continue;
    const day = dayOf(e.at);
    if (!day) continue;
    if (last && day !== last) out.set(e.seq, day);
    last = day;
  }
  return out;
}

/**
 * A separator's words: Today, Yesterday, or the date in the app's language.
 *
 * @param day - "YYYY-MM-DD" (local).
 * @param now - The current time.
 * @param he - Hebrew (else English).
 * @returns The label.
 */
export function dayLabel(day: string, now: Date, he: boolean): string {
  const today = dayOf(now.toISOString())!;
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (day === today) return he ? "היום" : "Today";
  if (day === dayOf(y.toISOString())) return he ? "אתמול" : "Yesterday";
  const [yy, mm, dd] = day.split("-").map(Number) as [number, number, number];
  const date = new Date(yy, mm - 1, dd);
  return date.toLocaleDateString(he ? "he-IL" : "en-GB", { weekday: "long", day: "numeric", month: "long", ...(yy !== now.getFullYear() ? { year: "numeric" } : {}) });
}
